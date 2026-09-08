import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, COOKIE_NAME } from '@/lib/scheduler/auth';

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Rutas públicas: login, sus endpoints de auth, y el endpoint de cron
  // (el cron se protege distinto, con el header Authorization: Bearer CRON_SECRET).
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/scheduler/auth/') ||
    pathname.startsWith('/api/scheduler/cron')
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!(await verifySessionToken(token))) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ ok: false, error: 'No has iniciado sesión.' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
