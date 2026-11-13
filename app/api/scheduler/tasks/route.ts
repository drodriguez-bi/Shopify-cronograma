import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/scheduler/db';
import {
  createPublishBatchTask, createInventoryBatchTask, createPriceBatchTask, createThemePublishTask,
  type PriceItem, type InventoryItem, type PublishItem,
} from '@/lib/scheduler/core';

export const maxDuration = 30;

export async function GET() {
  // Sin payload ni original_data (en los lotes pesan mucho); el detalle se pide por tarea.
  const tasks = await sql`
    SELECT id, store_key, type, product_id, variant_id, label, run_at, revert_at, status, last_error, source, created_at,
           CASE WHEN jsonb_typeof(payload->'items') = 'array' THEN jsonb_array_length(payload->'items') END AS item_count
    FROM scheduled_tasks ORDER BY run_at DESC LIMIT 300`;
  return NextResponse.json({ ok: true, tasks });
}

async function loadVariant(storeKey: string, variantCacheId: number) {
  const rows = await sql`
    SELECT vc.*, pc.product_id AS shopify_product_id
    FROM variants_cache vc JOIN products_cache pc ON pc.id = vc.product_cache_id
    WHERE vc.id = ${variantCacheId} AND vc.store_key = ${storeKey}`;
  return rows[0] as any | undefined;
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  try {
    // ---- Publicar productos: UNA tarea con todos ----
    if (body.action === 'schedule_publish') {
      const rows = await Promise.all((body.productCacheIds as number[]).map(async id => {
        const r = await sql`SELECT * FROM products_cache WHERE id = ${id} AND store_key = ${body.storeKey}`;
        return r[0] as any | undefined;
      }));
      const items: PublishItem[] = rows.filter(Boolean).map(r => ({ product_id: String(r.product_id), label: r.title as string }));
      if (!items.length) return NextResponse.json({ ok: false, error: 'No se encontraron los productos seleccionados.' }, { status: 400 });
      await createPublishBatchTask(body.storeKey, items, body.runAt);
      return NextResponse.json({ ok: true, created: items.length, batches: 1, errors: [] });
    }

    // ---- Inventario: UNA tarea con todas las variantes ----
    if (body.action === 'schedule_inventory') {
      const input = body.items as { variantCacheId: number; label?: string; quantity: number }[];
      const errors: (string | number)[] = [];
      const loaded = await Promise.all(input.map(async item => ({ item, v: await loadVariant(body.storeKey, item.variantCacheId) })));
      const items: InventoryItem[] = [];
      for (const { item, v } of loaded) {
        if (!v || !v.inventory_item_id || item.quantity <= 0) { errors.push(item.label ?? item.variantCacheId); continue; }
        items.push({
          product_id: String(v.shopify_product_id), variant_id: String(v.variant_id),
          inventory_item_id: String(v.inventory_item_id),
          label: item.label || (v.title as string) || `Variante ${v.variant_id}`, quantity: item.quantity,
        });
      }
      if (!items.length) return NextResponse.json({ ok: false, error: 'No hay variantes válidas para programar.' }, { status: 400 });
      await createInventoryBatchTask(body.storeKey, items, body.runAt, body.mode === 'set' ? 'set' : 'add', body.locationId || null);
      return NextResponse.json({ ok: true, created: items.length, batches: 1, errors });
    }

    // ---- Precio promo: UNA tarea con todas las variantes ----
    if (body.action === 'schedule_price') {
      const input = body.items as { variantCacheId: number; label?: string; promoPrice: number; compareAtPrice: number }[];
      const errors: (string | number)[] = [];
      const loaded = await Promise.all(input.map(async item => ({ item, v: await loadVariant(body.storeKey, item.variantCacheId) })));
      const items: PriceItem[] = [];
      for (const { item, v } of loaded) {
        if (!v || item.promoPrice <= 0 || item.compareAtPrice <= 0) { errors.push(item.label ?? item.variantCacheId); continue; }
        items.push({
          product_id: String(v.shopify_product_id), variant_id: String(v.variant_id),
          label: item.label || (v.title as string) || `Variante ${v.variant_id}`,
          promo_price: item.promoPrice.toFixed(2), compare_at_price: item.compareAtPrice.toFixed(2),
        });
      }
      if (!items.length) return NextResponse.json({ ok: false, error: 'No hay variantes válidas para programar.' }, { status: 400 });
      // Desde el panel: al terminar vuelve al precio que tenía antes (respaldo).
      await createPriceBatchTask(body.storeKey, items, body.runAt, body.revertAt, 'restore', 'manual');
      return NextResponse.json({ ok: true, created: items.length, batches: 1, errors });
    }

    // ---- Tema ----
    if (body.action === 'schedule_theme_publish') {
      if (!body.storeKey || !body.themeId || !body.runAt) {
        return NextResponse.json({ ok: false, error: 'storeKey, themeId y runAt requeridos' }, { status: 400 });
      }
      await createThemePublishTask(body.storeKey, body.themeId, body.themeName || body.themeId, body.runAt);
      return NextResponse.json({ ok: true, created: 1, batches: 1 });
    }

    return NextResponse.json({ ok: false, error: 'Acción desconocida' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
