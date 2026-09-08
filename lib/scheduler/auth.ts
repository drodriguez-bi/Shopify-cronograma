/**
 * Sesión firmada con HMAC-SHA256 usando Web Crypto (SubtleCrypto), NO el
 * módulo "crypto" de Node — así funciona tanto en Node.js como en el Edge
 * Runtime donde corre el middleware (Node's "crypto" no está disponible ahí).
 */

const COOKIE_NAME = 'scheduler_session';
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 7; // 7 días

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('Falta SESSION_SECRET en las variables de entorno.');
  return s;
}

async function hmacHex(message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export async function createSessionToken(): Promise<string> {
  const expires = Date.now() + SESSION_DURATION_MS;
  const sig = await hmacHex(String(expires));
  return `${expires}.${sig}`;
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [expiresStr, sig] = token.split('.');
  if (!expiresStr || !sig) return false;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;

  const expectedSig = await hmacHex(expiresStr);
  return timingSafeEqualStr(sig, expectedSig);
}

export { COOKIE_NAME };
