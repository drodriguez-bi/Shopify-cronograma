import { NextRequest, NextResponse } from 'next/server';
import { updateStore, deleteStore } from '@/lib/scheduler/core';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const { name, domain, clientId, clientSecret, apiVersion, locationId } = body;
  if (!name || !domain) {
    return NextResponse.json({ ok: false, error: 'Faltan campos requeridos.' }, { status: 400 });
  }
  try {
    await updateStore(Number(params.id), { name, domain, clientId, clientSecret, apiVersion: apiVersion || '2024-10', locationId });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteStore(Number(params.id));
  return NextResponse.json({ ok: true });
}
