import { NextRequest, NextResponse } from 'next/server';
import { listStores, createStore } from '@/lib/scheduler/core';

export async function GET() {
  const stores = await listStores();
  // No mandamos el access_token completo al frontend, solo si existe o no.
  const safe = stores.map(s => ({
    id: s.id, store_key: s.store_key, name: s.name, domain: s.domain,
    api_version: s.api_version, location_id: s.location_id, has_token: !!s.access_token,
  }));
  return NextResponse.json({ ok: true, stores: safe });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { storeKey, name, domain, accessToken, apiVersion, locationId } = body;
  if (!storeKey || !name || !domain || !accessToken) {
    return NextResponse.json({ ok: false, error: 'Faltan campos requeridos.' }, { status: 400 });
  }
  try {
    const id = await createStore({ storeKey, name, domain, accessToken, apiVersion: apiVersion || '2024-10', locationId });
    return NextResponse.json({ ok: true, id });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
