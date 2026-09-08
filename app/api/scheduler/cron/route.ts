import { NextRequest, NextResponse } from 'next/server';
import { runDueTasks } from '@/lib/scheduler/core';

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    const summary = await runDueTasks();
    return NextResponse.json({ ok: true, completed: summary.ok, failed: summary.failed });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
