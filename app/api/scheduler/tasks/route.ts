import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/scheduler/db';
import { createPublishTask, createInventoryTask, createPriceTask } from '@/lib/scheduler/core';

export async function GET() {
  const tasks = await sql`SELECT * FROM scheduled_tasks ORDER BY run_at DESC LIMIT 300`;
  return NextResponse.json({ ok: true, tasks });
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  try {
    if (body.action === 'schedule_publish') {
      let created = 0;
      for (const id of body.productCacheIds as number[]) {
        const rows = await sql`SELECT * FROM products_cache WHERE id = ${id} AND store_key = ${body.storeKey}`;
        if (rows.length) {
          await createPublishTask(body.storeKey, String(rows[0].product_id), rows[0].title as string, body.runAt);
          created++;
        }
      }
      return NextResponse.json({ ok: true, created });
    }

    if (body.action === 'schedule_inventory') {
      let created = 0;
      const errors: (string | number)[] = [];
      for (const item of body.items as { variantCacheId: number; label?: string; quantity: number }[]) {
        const rows = await sql`
          SELECT vc.*, pc.product_id AS shopify_product_id
          FROM variants_cache vc JOIN products_cache pc ON pc.id = vc.product_cache_id
          WHERE vc.id = ${item.variantCacheId} AND vc.store_key = ${body.storeKey}
        `;
        if (!rows.length || item.quantity <= 0) { errors.push(item.label ?? item.variantCacheId); continue; }
        const v = rows[0];
        await createInventoryTask(
          body.storeKey, String(v.shopify_product_id), String(v.variant_id),
          v.inventory_item_id ? String(v.inventory_item_id) : null,
          item.label || (v.title as string) || `Variante ${v.variant_id}`,
          item.quantity, body.mode, body.runAt
        );
        created++;
      }
      return NextResponse.json({ ok: true, created, errors });
    }

    if (body.action === 'schedule_price') {
      let created = 0;
      const errors: (string | number)[] = [];
      for (const item of body.items as { variantCacheId: number; label?: string; promoPrice: number; compareAtPrice: number }[]) {
        if (item.promoPrice <= 0 || item.compareAtPrice <= 0) { errors.push(item.label ?? item.variantCacheId); continue; }
        const rows = await sql`
          SELECT vc.*, pc.product_id AS shopify_product_id
          FROM variants_cache vc JOIN products_cache pc ON pc.id = vc.product_cache_id
          WHERE vc.id = ${item.variantCacheId} AND vc.store_key = ${body.storeKey}
        `;
        if (!rows.length) { errors.push(item.label ?? item.variantCacheId); continue; }
        const v = rows[0];
        await createPriceTask(
          body.storeKey, String(v.shopify_product_id), String(v.variant_id),
          item.label || (v.title as string) || `Variante ${v.variant_id}`,
          item.promoPrice, item.compareAtPrice, body.runAt, body.revertAt
        );
        created++;
      }
      return NextResponse.json({ ok: true, created, errors });
    }

    return NextResponse.json({ ok: false, error: 'Acción desconocida' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
