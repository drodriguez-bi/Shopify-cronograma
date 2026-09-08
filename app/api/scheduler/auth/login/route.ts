import { NextRequest, NextResponse } from 'next/server';
import { createSessionToken, COOKIE_NAME } from '@/lib/scheduler/auth';

export async function POST(req: NextRequest) {
  const { password } = await req.json();

  if (!process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ ok: false, error: 'Falta ADMIN_PASSWORD en las variables de entorno.' }, { status: 500 });
  }
  if (password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ ok: false, error: 'Contraseña incorrecta.' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, createSessionToken(), {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
