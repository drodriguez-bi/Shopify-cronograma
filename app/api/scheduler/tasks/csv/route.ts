import { NextRequest, NextResponse } from 'next/server';
import {
  findVariantBySku, findProductByHandle,
  createPublishTask, createInventoryTask, createPriceTask,
} from '@/lib/scheduler/core';

export const maxDuration = 60;

/**
 * IMPORTADOR DE CSV
 *
 * La acción la decide el archivo: si trae precios -> price; si trae cantidades ->
 * inventory; si solo trae la lista de productos -> publish. Las fechas, el modo de
 * inventario y la sucursal se eligen en el panel UNA VEZ para todo el archivo.
 *
 * Precio: al iniciar, el precio pasa al "Variant Price" del archivo (con su tachado);
 * al terminar, el precio de comparación pasa a ser el precio real y se quita el tachado.
 *
 * El CSV solo necesita identificar cada producto y traer el valor:
 *
 *   Identificar (sin IDs):
 *     handle  +  variant        ej. eileen-latte  +  "Latte / 23"
 *       · Si no hay columna "variant", se arma con "Option1 Value", "Option2 Value"
 *         y "Option3 Value" (como el CSV que exporta Shopify).
 *       · variant = "*" aplica a todas las variantes del producto.
 *       · variant vacío solo vale si el producto tiene UNA sola variante.
 *     o bien  sku
 *
 *   Valores:
 *     price      -> "Variant Price" (precio promo) y "Variant Compare At Price" (tachado)
 *                   (también sirven promo_price / compare_at_price).
 *                   Si el tachado viene vacío se usa el precio actual de la variante.
 *     inventory  -> quantity
 *     publish    -> no necesita valor, basta el handle
 *
 * Las filas SIN valor (precio vacío en price, quantity vacío en inventory) se
 * omiten solas, así que no hace falta borrar filas de relleno.
 *
 * Columnas opcionales que, si existen, mandan sobre lo elegido en el panel:
 *   type, run_at, revert_at, mode, location_id, label
 *
 * Fechas escritas a mano en el CSV: "2026-12-01 09:00" (hora de México, UTC-06:00),
 * "2026-12-01T09:00:00-06:00" o "01/12/2026 09:00". La zona por defecto se cambia con
 * la variable de entorno SCHEDULER_TZ_OFFSET.
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

/** Compara variantes sin importar mayúsculas, acentos mal codificados, espacios ni el apóstrofo ('23). */
function norm(s: string): string {
  return s
    .normalize('NFC')
    .replace(/(^|\/\s*)'+/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s+/g, ' ');
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

/** Fecha que viene del panel (ya en ISO/UTC) */
function parsePanelDate(value: unknown, field: string): string | null {
  if (!value) return null;
  const d = new Date(String(value));
  if (isNaN(d.getTime())) throw new Error(`${field} inválida`);
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
  const body = await req.json();
  const { storeKey, csv, locationId: fallbackLocationId } = body;
  const dryRun = !!body.dryRun;
  if (!storeKey || !csv) return NextResponse.json({ ok: false, error: 'storeKey y csv requeridos' }, { status: 400 });

  let panelRunAt: string | null = null;
  let panelRevertAt: string | null = null;
  try {
    panelRunAt = parsePanelDate(body.runAt, 'La fecha de inicio');
    panelRevertAt = parsePanelDate(body.revertAt, 'La fecha de fin');
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }
  const panelAction = String(body.action || '').toLowerCase();
  const panelMode = body.mode === 'set' ? 'set' : 'add';

  const rows = parseCsv(csv);
  if (!rows.length) return NextResponse.json({ ok: false, error: 'El CSV no trae filas.' }, { status: 400 });

  // La acción la decide el archivo: con precios -> price; con cantidades -> inventory;
  // solo la lista de productos -> publish. (El panel puede forzarla.)
  const hasValue = (keys: string[]) => rows.some(r => keys.some(k => (r[k] ?? '').trim() !== ''));
  const detected: 'price' | 'inventory' | 'publish' =
    hasValue(['promo_price', 'variant price']) ? 'price'
    : hasValue(['quantity', 'variant inventory qty']) ? 'inventory'
    : 'publish';
  const effectiveAction = ['price', 'inventory', 'publish'].includes(panelAction) ? panelAction : detected;

  let created = 0;
  let skipped = 0;
  const errors: { row: number; error: string }[] = [];
  const preview: string[] = [];
  const addPreview = (line: string) => { if (dryRun && preview.length < 6) preview.push(line); };

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
      const type = (row.type || effectiveAction).toLowerCase();
      if (!['publish', 'inventory', 'price'].includes(type)) {
        throw new Error('falta indicar qué programar (elige "Precio promo", "Inventario" o "Publicar" en el panel)');
      }

      // ---- Valor de la fila: si viene vacío, la fila se omite (relleno / imágenes extra del export) ----
      const promoRaw = row.promo_price || row['variant price'] || '';
      const compareRaw = row.compare_at_price || row['variant compare at price'] || '';
      const quantityRaw = row.quantity || row['variant inventory qty'] || '';
      if (type === 'price' && !promoRaw.trim()) { skipped++; continue; }
      if (type === 'inventory' && !quantityRaw.trim()) { skipped++; continue; }
      if (!row.handle && !row.sku) { skipped++; continue; }

      // ---- Fechas ----
      const runAt: string = (row.run_at ? parseDate(row.run_at, 'run_at') : panelRunAt) ?? '';
      if (!runAt && !dryRun) throw new Error('falta la fecha (ponla en el panel o en la columna run_at)');

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
      } else {
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
            else throw new Error(`"${row.handle}" tiene ${all.length} variantes: falta indicar cuál (columna variant u Option Value, ej. "${all[0]?.title}") o "*" para todas`);
          } else {
            variants = all.filter(v => norm((v.title as string) || '') === norm(spec));
            if (!variants.length) {
              const sample = all.slice(0, 4).map(v => v.title).join(' | ');
              throw new Error(`"${row.handle}" no tiene la variante "${spec}". Ejemplos: ${sample}`);
            }
          }
        }
      }

      // ---- Crear tareas ----
      if (type === 'publish') {
        const key = `${productId}|${runAt}`;
        if (publishSeen.has(key)) { skipped++; continue; }
        publishSeen.add(key);
        if (!dryRun) await createPublishTask(storeKey, productId, row.label || productTitle, runAt, 'csv');
        addPreview(`Publicar: ${productTitle}`);
        created++;
        continue;
      }

      if (type === 'inventory') {
        const quantity = parseInt(quantityRaw, 10);
        const mode = (row.mode || panelMode) === 'set' ? 'set' : 'add';
        if (!quantity || quantity <= 0) throw new Error(`quantity inválido: "${quantityRaw}"`);
        for (const v of variants) {
          const label = row.label || `${productTitle} — ${v.title ?? ''}`.trim();
          if (!dryRun) {
            await createInventoryTask(
              storeKey, productId, String(v.variant_id),
              v.inventory_item_id ? String(v.inventory_item_id) : null,
              label, quantity, mode, runAt, row.location_id || fallbackLocationId || null, 'csv'
            );
          }
          addPreview(`${label}: ${mode === 'set' ? 'fijar en' : 'sumar'} ${quantity} (stock actual ${v.inventory_qty})`);
          created++;
        }
        continue;
      }

      // type === 'price'
      const revertAt: string = (row.revert_at ? parseDate(row.revert_at, 'revert_at') : panelRevertAt) ?? '';
      if (!revertAt && !dryRun) throw new Error('falta la fecha de fin (ponla en el panel o en la columna revert_at)');
      if (runAt && revertAt && new Date(revertAt) <= new Date(runAt)) throw new Error('la fecha de fin debe ser posterior a la de inicio');
      const promo = parseMoney(promoRaw);
      if (!promo || promo <= 0) throw new Error(`precio promocional inválido: "${promoRaw}"`);
      for (const v of variants) {
        const current = parseFloat(String(v.price));
        let compare = current;
        if (compareRaw.trim()) {
          const c = parseMoney(compareRaw);
          if (isNaN(c)) throw new Error(`precio de comparación inválido: "${compareRaw}"`);
          if (c > 0) compare = c; // 0 = sin precio de comparación -> se usa el precio actual como tachado
        }
        if (!compare || compare <= 0) throw new Error('no se pudo determinar el precio de comparación');
        const label = row.label || `${productTitle} — ${v.title ?? ''}`.trim();
        if (!dryRun) {
          await createPriceTask(storeKey, productId, String(v.variant_id), label, promo, compare, runAt, revertAt, 'csv', 'compare_to_price');
        }
        addPreview(`${label}: inicia en $${promo} con tachado $${compare} (ahora $${v.price}); al terminar: $${compare} sin tachado`);
        created++;
      }
    } catch (e: any) {
      errors.push({ row: i + 2, error: e.message }); // +2: fila 1 es el encabezado
    }
  }

  return NextResponse.json({ ok: true, dryRun, action: effectiveAction, created, skipped, errors, preview });
}
