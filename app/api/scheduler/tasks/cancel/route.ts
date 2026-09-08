import { NextRequest, NextResponse } from 'next/server';
import { cancelTask } from '@/lib/scheduler/core';

export async function POST(req: NextRequest) {
  const { taskId } = await req.json();
  if (!taskId) return NextResponse.json({ ok: false, error: 'taskId requerido' }, { status: 400 });
  await cancelTask(taskId);
  return NextResponse.json({ ok: true });
}
