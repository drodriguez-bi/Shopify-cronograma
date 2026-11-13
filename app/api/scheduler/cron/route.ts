import { NextRequest, NextResponse } from 'next/server';
import { runDueTasks } from '@/lib/scheduler/core';

// runDueTasks trabaja ~50 s como máximo; esto le da margen a la función en Vercel.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const summary = await runDueTasks();
    // deferred = tareas vencidas que no alcanzaron en esta corrida; las toma la siguiente.
    return NextResponse.json({ ok: true, completed: summary.ok, failed: summary.failed, deferred: summary.deferred });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
