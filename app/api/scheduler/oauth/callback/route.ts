import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { getStore, saveStoreToken } from '@/lib/scheduler/core';
import { cleanDomain } from '@/lib/scheduler/shopify';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get('code') || '';
  const shop = params.get('shop') || '';
  const hmac = params.get('hmac') || '';
  const rawState = params.get('state') || '';

  if (!code || !shop || !rawState || !rawState.includes('|')) {
    return new NextResponse('Petición inválida (faltan parámetros).', { status: 400 });
  }
  const [state, storeKey] = rawState.split('|', 2);

  let store;
  try {
    store = await getStore(storeKey);
  } catch {
    return new NextResponse('Tienda desconocida.', { status: 400 });
  }

  const expectedState = req.cookies.get(`sched_oauth_state_${storeKey}`)?.value;
  if (!expectedState || !safeEqual(expectedState, state)) {
    return new NextResponse('State inválido o expirado. Intenta conectar de nuevo desde el panel.', { status: 400 });
  }

  const configuredDomain = cleanDomain(store.domain);
  const receivedDomain = cleanDomain(shop);
  if (receivedDomain !== configuredDomain) {
    return new NextResponse(`El dominio recibido (${receivedDomain}) no coincide con el configurado (${configuredDomain}).`, { status: 400 });
  }

  const allParams: [string, string][] = [];
  params.forEach((value, key) => { if (key !== 'hmac' && key !== 'signature') allParams.push([key, value]); });
  allParams.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = allParams.map(([k, v]) => `${k}=${v}`).join('&');
  const computedHmac = createHmac('sha256', store.client_secret).update(message).digest('hex');

  if (!safeEqual(computedHmac, hmac)) {
    return new NextResponse('HMAC inválido: la petición no parece venir de Shopify.', { status: 400 });
  }

  const tokenRes = await fetch(`https://${configuredDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: store.client_id, client_secret: store.client_secret, code }),
  });
  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || !tokenData.access_token) {
    return new NextResponse('Shopify no regresó un token válido: ' + JSON.stringify(tokenData), { status: 400 });
  }

  let expiresAt: string | null = null;
  if (tokenData.expires_in) {
    expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
  }

  await saveStoreToken(storeKey, tokenData.access_token, expiresAt);

  const res = new NextResponse(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;">
      <h1>✅ ${store.name} conectada</h1>
      <p>${expiresAt ? 'El token vence el ' + expiresAt : 'Token guardado correctamente.'}</p>
      <a href="/stores">Ir a Tiendas</a>
    </body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
  res.cookies.delete(`sched_oauth_state_${storeKey}`);
  return res;
}
