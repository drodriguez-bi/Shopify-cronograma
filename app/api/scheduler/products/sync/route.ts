import { NextRequest, NextResponse } from 'next/server';
import { syncProducts } from '@/lib/scheduler/core';

export async function POST(req: NextRequest) {
  const { storeKey } = await req.json();
  if (!storeKey) return NextResponse.json({ ok: false, error: 'storeKey requerido' }, { status: 400 });
  try {
    const total = await syncProducts(storeKey);
    return NextResponse.json({ ok: true, synced: total });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
