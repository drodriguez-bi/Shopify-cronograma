import { NextRequest, NextResponse } from 'next/server';
import { retryTasks } from '@/lib/scheduler/core';

export async function POST(req: NextRequest) {
  const { taskId } = await req.json().catch(() => ({}));
  const retried = await retryTasks(taskId ? Number(taskId) : undefined);
  return NextResponse.json({ ok: true, retried });
}
