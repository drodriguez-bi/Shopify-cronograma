export type Store = {
  id: number;
  store_key: string;
  name: string;
  domain: string;
  access_token: string;
  api_version: string;
  location_id: string | null;
};

export function cleanDomain(domain: string): string {
  return domain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

async function shopifyRequest(
  store: Store,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ data: any; nextPageInfo: string | null }> {
  const domain = cleanDomain(store.domain);
  const url = `https://${domain}/admin/api/${store.api_version}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': store.access_token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* respuesta no-JSON */ }

  if (res.status === 401) {
    throw new Error(`Token inválido o vencido para ${domain}. Actualízalo en "Tiendas".`);
  }
  if (res.status >= 400) {
    throw new Error(`Shopify error ${res.status} (${method} ${path}): ${JSON.stringify(data)}`);
  }

  let nextPageInfo: string | null = null;
  const link = res.headers.get('link');
  if (link) {
    const match = link.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (match) nextPageInfo = decodeURIComponent(match[1]);
  }
  return { data, nextPageInfo };
}

export async function shopifyListProducts(store: Store, pageInfo?: string) {
  const path = pageInfo
    ? `/products.json?limit=250&page_info=${encodeURIComponent(pageInfo)}`
    : `/products.json?limit=250&fields=id,title,status,image,variants`;
  return shopifyRequest(store, 'GET', path);
}
export async function shopifySetProductStatus(store: Store, productId: string, status: string) {
  return shopifyRequest(store, 'PUT', `/products/${productId}.json`, { product: { id: Number(productId), status } });
}
export async function shopifyGetVariant(store: Store, variantId: string) {
  return shopifyRequest(store, 'GET', `/variants/${variantId}.json`);
}
export async function shopifyUpdateVariantPrice(store: Store, variantId: string, price: string | null, compareAtPrice: string | null) {
  const variant: Record<string, unknown> = { id: Number(variantId), compare_at_price: compareAtPrice };
  if (price !== null) variant.price = price;
  return shopifyRequest(store, 'PUT', `/variants/${variantId}.json`, { variant });
}
export async function shopifyAdjustInventory(store: Store, inventoryItemId: string, locationId: string, adjustment: number) {
  return shopifyRequest(store, 'POST', '/inventory_levels/adjust.json', {
    location_id: Number(locationId), inventory_item_id: Number(inventoryItemId), available_adjustment: adjustment,
  });
}
export async function shopifySetInventory(store: Store, inventoryItemId: string, locationId: string, available: number) {
  return shopifyRequest(store, 'POST', '/inventory_levels/set.json', {
    location_id: Number(locationId), inventory_item_id: Number(inventoryItemId), available,
  });
}
export async function shopifyListLocations(store: Store) {
  return shopifyRequest(store, 'GET', '/locations.json');
}
