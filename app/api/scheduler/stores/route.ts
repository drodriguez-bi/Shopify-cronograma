import { NextRequest, NextResponse } from 'next/server';
import { createStore, getConnectionStatus } from '@/lib/scheduler/core';

export async function GET() {
  const stores = await getConnectionStatus();
  return NextResponse.json({ ok: true, stores });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { storeKey, name, domain, clientId, clientSecret, apiVersion, locationId } = body;
  if (!storeKey || !name || !domain || !clientId || !clientSecret) {
    return NextResponse.json({ ok: false, error: 'Faltan campos requeridos.' }, { status: 400 });
  }
  try {
    const id = await createStore({ storeKey, name, domain, clientId, clientSecret, apiVersion: apiVersion || '2024-10', locationId });
    return NextResponse.json({ ok: true, id });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
