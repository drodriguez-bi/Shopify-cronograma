import { NextRequest, NextResponse } from 'next/server';
import { listStoreThemes } from '@/lib/scheduler/core';

export async function GET(req: NextRequest) {
  const storeKey = req.nextUrl.searchParams.get('storeKey') || '';
  if (!storeKey) return NextResponse.json({ ok: false, error: 'storeKey requerido' }, { status: 400 });
  try {
    const themes = await listStoreThemes(storeKey);
    return NextResponse.json({ ok: true, themes });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
