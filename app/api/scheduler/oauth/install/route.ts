import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { getStore } from '@/lib/scheduler/core';
import { cleanDomain } from '@/lib/scheduler/shopify';

const APP_SCOPES = 'read_products,write_products,read_inventory,write_inventory,read_locations';

export async function GET(req: NextRequest) {
  const storeKey = req.nextUrl.searchParams.get('store') || '';

  let store;
  try {
    store = await getStore(storeKey);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 404 });
  }

  const state = randomBytes(16).toString('hex');
  const domain = cleanDomain(store.domain);
  // req.nextUrl.origin ya trae el dominio real de este deploy (funciona en cualquier
  // ambiente — producción, preview, local — sin necesitar una variable de entorno aparte).
  const redirectUri = `${req.nextUrl.origin}/api/scheduler/oauth/callback`;

  const authorizeUrl = `https://${domain}/admin/oauth/authorize?` + new URLSearchParams({
    client_id: store.client_id,
    scope: APP_SCOPES,
    redirect_uri: redirectUri,
    state: `${state}|${storeKey}`,
  }).toString();

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(`sched_oauth_state_${storeKey}`, state, {
    httpOnly: true, secure: true, maxAge: 600, path: '/',
  });
  return res;
}
