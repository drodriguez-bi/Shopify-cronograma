import { NextRequest, NextResponse } from 'next/server';
import {
  findVariantBySku, findProductByHandle,
  createPublishTask, createInventoryTask, createPriceTask,
} from '@/lib/scheduler/core';

export const maxDuration = 60;

/**
 * FORMATO DEL CSV (los encabezados no distinguen mayúsculas; el orden da igual)
 *
 *   type, handle, variant, sku, run_at, revert_at, quantity, mode, location_id,
 *   promo_price, compare_at_price, label
 *
 * Cómo se identifica el producto (NO hace falta ningún ID de Shopify):
 *   - handle: el "Handle" del CSV que exporta Shopify (ej. eileen-latte).
 *   - variant: la variante tal como se ve en Shopify, ej. "Latte / 23".
 *       · "*" = todas las variantes del producto.
 *       · vacío = solo vale si el producto tiene UNA sola variante.
 *       · Si no pones la columna "variant" pero tu archivo trae las columnas
 *         "Option1 Value", "Option2 Value", "Option3 Value" (como el export de
 *         Shopify), la variante se arma sola con ellas.
 *   - sku: alternativa a handle+variant, si tus variantes tienen SKU.
 *
 * type: publish | inventory | price
 *   - publish: basta el handle (publica el producto completo; si repites el
 *     mismo producto en varias filas con la misma fecha, solo se crea una tarea).
 *   - inventory: quantity, mode (add|set), location_id (opcional).
 *   - price: promo_price, compare_at_price (si lo dejas vacío usa el precio actual
 *     de la variante como tachado) y revert_at.
 *
 * Fechas (run_at / revert_at), cualquiera de estas:
 *   2026-12-01 09:00          (se asume hora de México, UTC-06:00)
 *   2026-12-01T09:00:00-06:00 (con zona horaria explícita)
 *   01/12/2026 09:00          (día/mes/año)
 *   La zona por defecto se puede cambiar con la variable SCHEDULER_TZ_OFFSET.
 */

const DEFAULT_TZ_OFFSET = process.env.SCHEDULER_TZ_OFFSET || '-06:00';

// ---------------------------------------------------------
// Lectura del CSV
// ---------------------------------------------------------

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseCsv(raw: string): Record<string, string>[] {
  const text = raw.replace(/^\uFEFF/, ''); // BOM que mete Excel
  const delim = detectDelimiter(text);    // Excel en español suele guardar con ";"
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      record.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.some(f => f.trim() !== '')) records.push(record);
      record = [];
    } else field += ch;
  }
  record.push(field);
  if (record.some(f => f.trim() !== '')) records.push(record);
  if (!records.length) return [];

  const headers = records[0].map(h => h.trim().toLowerCase());
  return records.slice(1).map(values => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (values[i] ?? '').trim(); });
    return row;
  });
}

// ---------------------------------------------------------
// Utilidades
// ---------------------------------------------------------

/** Compara variantes sin importar mayúsculas, espacios ni el apóstrofo que mete Shopify/Excel ('23). */
function norm(s: string): string {
  return s.replace(/(^|\/\s*)'+/g, '$1').trim().toLowerCase().replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ');
}

function variantSpecFromRow(row: Record<string, string>): string {
  if (row.variant) return row.variant;
  const parts = [row['option1 value'], row['option2 value'], row['option3 value']]
    .map(p => (p ?? '').replace(/^'+/, '').trim())
    .filter(Boolean);
  return parts.join(' / ');
}

function parseDate(value: string, field: string): string {
  const v = (value || '').replace(/^'+/, '').trim();
  if (!v) throw new Error(`falta ${field}`);

  let d: Date | null = null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(v) && /T|\s/.test(v);
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  const latin = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s](\d{1,2}):(\d{2}))?$/);

  if (hasZone) {
    d = new Date(v.replace(' ', 'T'));
  } else if (iso) {
    const [, y, m, day, hh = '00', mm = '00', ss = '00'] = iso;
    d = new Date(`${y}-${m}-${day}T${hh.padStart(2, '0')}:${mm}:${ss}${DEFAULT_TZ_OFFSET}`);
  } else if (latin) {
    const [, day, m, y, hh = '00', mm = '00'] = latin;
    d = new Date(`${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:00${DEFAULT_TZ_OFFSET}`);
  }
  if (!d || isNaN(d.getTime())) throw new Error(`${field} inválida: "${value}"`);
  return d.toISOString();
}

function parseMoney(value: string): number {
  let v = (value || '').replace(/[$\s]/g, '');
  if (!v) return NaN;
  if (!v.includes('.') && /,\d{1,2}$/.test(v)) v = v.replace(',', '.'); // 2749,00 -> 2749.00
  else v = v.replace(/,/g, '');                                          // 2,749.00 -> 2749.00
  return parseFloat(v);
}

// ---------------------------------------------------------
// Handler
// ---------------------------------------------------------

type Found = NonNullable<Awaited<ReturnType<typeof findProductByHandle>>>;

export async function POST(req: NextRequest) {
  const { storeKey, csv, locationId: fallbackLocationId } = await req.json();
  if (!storeKey || !csv) return NextResponse.json({ ok: false, error: 'storeKey y csv requeridos' }, { status: 400 });

  const rows = parseCsv(csv);
  if (!rows.length) return NextResponse.json({ ok: false, error: 'El CSV no trae filas.' }, { status: 400 });

  let created = 0;
  let skipped = 0;
  const errors: { row: number; error: string }[] = [];

  const productCache = new Map<string, Found | null>();
  async function getProduct(handle: string) {
    const key = handle.toLowerCase();
    if (!productCache.has(key)) productCache.set(key, await findProductByHandle(storeKey, handle));
    return productCache.get(key) ?? null;
  }
  const publishSeen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const type = (row.type || '').toLowerCase();
      if (!['publish', 'inventory', 'price'].includes(type)) {
        throw new Error(`type inválido: "${row.type}" (usa publish, inventory o price)`);
      }
      const runAt = parseDate(row.run_at, 'run_at');

      // ---- Identificar producto / variantes ----
      let productId = '';
      let productTitle = '';
      let variants: any[] = [];

      if (row.sku) {
        const v = await findVariantBySku(storeKey, row.sku);
        if (!v) throw new Error(`no se encontró el SKU "${row.sku}" en el catálogo sincronizado`);
        productId = String(v.shopify_product_id);
        productTitle = (v.product_title as string) || '';
        variants = [v];
      } else if (row.handle) {
        const found = await getProduct(row.handle);
        if (!found) throw new Error(`no se encontró el handle "${row.handle}" (¿ya sincronizaste esta tienda después de la actualización?)`);
        productId = String(found.product.product_id);
        productTitle = found.product.title as string;

        if (type !== 'publish') {
          const spec = variantSpecFromRow(row);
          const all = found.variants;
          if (spec === '*' || norm(spec) === 'todas' || norm(spec) === 'all') {
            variants = all;
          } else if (!spec) {
            if (all.length === 1) variants = all;
            else throw new Error(`"${row.handle}" tiene ${all.length} variantes: indica la columna variant (ej. "${all[0]?.title}") o "*" para todas`);
          } else {
            variants = all.filter(v => norm((v.title as string) || '') === norm(spec));
            if (!variants.length) {
              const sample = all.slice(0, 4).map(v => v.title).join(' | ');
              throw new Error(`"${row.handle}" no tiene la variante "${spec}". Ejemplos: ${sample}`);
            }
          }
        }
      } else {
        throw new Error('falta handle (o sku) para identificar el producto');
      }

      // ---- Crear tareas ----
      if (type === 'publish') {
        const key = `${productId}|${runAt}`;
        if (publishSeen.has(key)) { skipped++; continue; }
        publishSeen.add(key);
        await createPublishTask(storeKey, productId, row.label || productTitle, runAt, 'csv');
        created++;
        continue;
      }

      if (type === 'inventory') {
        const quantity = parseInt(row.quantity, 10);
        const mode = row.mode === 'set' ? 'set' : 'add';
        if (!quantity || quantity <= 0) throw new Error(`quantity inválido: "${row.quantity}"`);
        for (const v of variants) {
          await createInventoryTask(
            storeKey, productId, String(v.variant_id),
            v.inventory_item_id ? String(v.inventory_item_id) : null,
            row.label || `${productTitle} — ${v.title ?? ''}`.trim(),
            quantity, mode, runAt, row.location_id || fallbackLocationId || null, 'csv'
          );
          created++;
        }
        continue;
      }

      // type === 'price'
      const revertAt = parseDate(row.revert_at, 'revert_at');
      if (new Date(revertAt) <= new Date(runAt)) throw new Error('revert_at debe ser posterior a run_at');
      const promo = parseMoney(row.promo_price);
      if (!promo || promo <= 0) throw new Error(`promo_price inválido: "${row.promo_price}"`);
      for (const v of variants) {
        const compare = row.compare_at_price ? parseMoney(row.compare_at_price) : parseFloat(String(v.price));
        if (!compare || compare <= 0) throw new Error(`compare_at_price inválido: "${row.compare_at_price}"`);
        await createPriceTask(
          storeKey, productId, String(v.variant_id),
          row.label || `${productTitle} — ${v.title ?? ''}`.trim(),
          promo, compare, runAt, revertAt, 'csv'
        );
        created++;
      }
    } catch (e: any) {
      errors.push({ row: i + 2, error: e.message }); // +2: fila 1 es el encabezado
    }
  }

  return NextResponse.json({ ok: true, created, skipped, errors });
}
