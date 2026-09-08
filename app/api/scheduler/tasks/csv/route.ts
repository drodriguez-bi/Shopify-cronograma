import { NextRequest, NextResponse } from 'next/server';
import { findVariantBySku, createPublishTask, createInventoryTask, createPriceTask } from '@/lib/scheduler/core';

/**
 * Formato esperado del CSV (encabezados exactos, en cualquier orden):
 *
 * type,sku,run_at,revert_at,quantity,mode,promo_price,compare_at_price,label
 *
 * - type: publish | inventory | price
 * - sku: el SKU de la variante en Shopify (se busca en el catálogo ya sincronizado)
 * - run_at: fecha/hora ISO CON zona horaria, ej. 2026-07-10T15:00:00-06:00
 *           (si no pones el offset, se asume la hora del servidor — evita ambigüedad
 *            poniendo siempre el -06:00 o el offset que corresponda)
 * - revert_at: solo para type=price, mismo formato que run_at
 * - quantity, mode (add|set): solo para type=inventory
 * - promo_price, compare_at_price: solo para type=price
 * - label: opcional, texto libre para identificar la tarea
 *
 * Deja vacías las columnas que no apliquen a cada fila.
 */

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h.trim()] = (values[i] ?? '').trim(); });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { result.push(cur); cur = ''; continue; }
    cur += ch;
  }
  result.push(cur);
  return result;
}

export async function POST(req: NextRequest) {
  const { storeKey, csv } = await req.json();
  if (!storeKey || !csv) return NextResponse.json({ ok: false, error: 'storeKey y csv requeridos' }, { status: 400 });

  const rows = parseCsv(csv);
  let created = 0;
  const errors: { row: number; error: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const type = row.type;
      if (!['publish', 'inventory', 'price'].includes(type)) {
        throw new Error(`type inválido: "${type}"`);
      }
      if (!row.sku) throw new Error('falta sku');

      const variant = await findVariantBySku(storeKey, row.sku);
      if (!variant) throw new Error(`no se encontró el SKU "${row.sku}" en el catálogo sincronizado`);

      const runAt = row.run_at;
      if (!runAt || isNaN(new Date(runAt).getTime())) throw new Error(`run_at inválido: "${runAt}"`);

      const label = row.label || (variant.title as string) || row.sku;

      if (type === 'publish') {
        await createPublishTask(storeKey, String(variant.shopify_product_id), label, runAt, 'csv');
      } else if (type === 'inventory') {
        const quantity = parseInt(row.quantity, 10);
        const mode = row.mode === 'set' ? 'set' : 'add';
        if (!quantity || quantity <= 0) throw new Error(`quantity inválido: "${row.quantity}"`);
        await createInventoryTask(
          storeKey, String(variant.shopify_product_id), String(variant.variant_id),
          variant.inventory_item_id ? String(variant.inventory_item_id) : null,
          label, quantity, mode, runAt, 'csv'
        );
      } else if (type === 'price') {
        const revertAt = row.revert_at;
        const promo = parseFloat(row.promo_price);
        const compare = parseFloat(row.compare_at_price);
        if (!revertAt || isNaN(new Date(revertAt).getTime())) throw new Error(`revert_at inválido: "${revertAt}"`);
        if (!promo || !compare) throw new Error('promo_price o compare_at_price inválido');
        await createPriceTask(
          storeKey, String(variant.shopify_product_id), String(variant.variant_id),
          label, promo, compare, runAt, revertAt, 'csv'
        );
      }
      created++;
    } catch (e: any) {
      errors.push({ row: i + 2, error: e.message }); // +2: fila 1 es encabezado, index base 0
    }
  }

  return NextResponse.json({ ok: true, created, errors });
}
