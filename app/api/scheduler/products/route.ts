import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/scheduler/db';

export async function GET(req: NextRequest) {
  const storeKey = req.nextUrl.searchParams.get('storeKey') || '';
  if (!storeKey) return NextResponse.json({ ok: false, error: 'storeKey requerido' }, { status: 400 });

  const products = await sql`SELECT * FROM products_cache WHERE store_key = ${storeKey} ORDER BY title`;
  const result = [];
  for (const p of products) {
    const variants = await sql`SELECT * FROM variants_cache WHERE product_cache_id = ${p.id} ORDER BY id`;
    result.push({ ...p, variants });
  }
  return NextResponse.json({ ok: true, products: result });
}
