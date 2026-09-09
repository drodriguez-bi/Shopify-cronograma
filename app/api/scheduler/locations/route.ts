import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/scheduler/core';
import { shopifyListLocations } from '@/lib/scheduler/shopify';

export async function GET(req: NextRequest) {
  const storeKey = req.nextUrl.searchParams.get('storeKey') || '';
  if (!storeKey) return NextResponse.json({ ok: false, error: 'storeKey requerido' }, { status: 400 });

  try {
    const store = await getStore(storeKey);
    const { data } = await shopifyListLocations(store);
    const locations = (data.locations ?? []).map((l: any) => ({
      id: String(l.id), name: l.name as string, active: !!l.active,
    }));
    return NextResponse.json({ ok: true, locations });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
