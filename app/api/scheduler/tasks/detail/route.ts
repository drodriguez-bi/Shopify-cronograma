import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/scheduler/db';

/** Detalle de una tarea: para los lotes, la lista de cambios que lleva adentro. */
export async function GET(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get('id'));
  if (!id) return NextResponse.json({ ok: false, error: 'id requerido' }, { status: 400 });
  const rows = await sql`SELECT id, store_key, type, label, payload, original_data, run_at, revert_at, status, last_error, location_id FROM scheduled_tasks WHERE id = ${id}`;
  if (!rows.length) return NextResponse.json({ ok: false, error: 'Tarea no encontrada' }, { status: 404 });
  const t = rows[0] as any;
  const state = (t.original_data ?? {}) as { todo?: { start?: number[]; revert?: number[] }; started?: boolean };
  return NextResponse.json({
    ok: true,
    task: {
      id: t.id, store_key: t.store_key, type: t.type, label: t.label, status: t.status, last_error: t.last_error,
      run_at: t.run_at, revert_at: t.revert_at, location_id: t.location_id,
      mode: t.payload?.mode ?? null, end_mode: t.payload?.end_mode ?? null,
      started: !!state.started,
      pending_blocks: (state.todo?.start?.length ?? 0) + (state.todo?.revert?.length ?? 0),
    },
    items: Array.isArray(t.payload?.items) ? t.payload.items : [],
  });
}
