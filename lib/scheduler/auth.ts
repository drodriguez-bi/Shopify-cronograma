import { createHmac, timingSafeEqual } from 'crypto';

const COOKIE_NAME = 'scheduler_session';
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 7; // 7 días

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('Falta SESSION_SECRET en las variables de entorno.');
  return s;
}

export function createSessionToken(): string {
  const expires = Date.now() + SESSION_DURATION_MS;
  const sig = createHmac('sha256', secret()).update(String(expires)).digest('hex');
  return `${expires}.${sig}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const [expiresStr, sig] = token.split('.');
  if (!expiresStr || !sig) return false;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;

  const expectedSig = createHmac('sha256', secret()).update(expiresStr).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export { COOKIE_NAME };
