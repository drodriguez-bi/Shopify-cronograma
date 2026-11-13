export type Store = {
  id: number;
  store_key: string;
  name: string;
  domain: string;
  client_id: string;
  client_secret: string;
  access_token: string | null;
  token_expires_at: string | null;
  api_version: string;
  location_id: string | null;
};

export function cleanDomain(domain: string): string {
  return domain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Shopify limita las llamadas REST (2 por segundo sostenido, con un "cubo" de 40 de ráfaga).
 * - Si responde 429, espera lo que indica Retry-After y reintenta (hasta 6 veces).
 * - Si el cubo está casi lleno (header X-Shopify-Shop-Api-Call-Limit, ej. "38/40"), hace una
 *   pausa corta para no llegar al 429 en la siguiente llamada.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= 6) {
      if (res.status !== 429) {
        const limit = res.headers.get('x-shopify-shop-api-call-limit');
        if (limit) {
          const [used, cap] = limit.split('/').map(Number);
          if (cap && used >= cap - 4) await sleep(600);
        }
      }
      return res;
    }
    const retryAfter = Number(res.headers.get('retry-after')) || 1;
    await sleep(Math.min(retryAfter, 10) * 1000 + attempt * 250);
  }
}

async function shopifyRequest(
  store: Store,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ data: any; nextPageInfo: string | null }> {
  if (!store.access_token) {
    throw new Error(`La tienda '${store.name}' todavía no está conectada. Ve a "Tiendas" y dale clic en "Conectar".`);
  }
  const domain = cleanDomain(store.domain);
  const url = `${baseUrl(domain)}/admin/api/${store.api_version}${path}`;

  const res = await fetchWithRetry(url, {
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
    : `/products.json?limit=250&fields=id,title,handle,status,image,variants`;
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

// ---------------------------------------------------------
// Temas (Admin GraphQL). Requiere scopes read_themes / write_themes
// y una api_version reciente (2024-10 o mayor) en la tienda.
// ---------------------------------------------------------

/** Solo para pruebas locales: apunta las llamadas a un servidor simulado en vez de Shopify. */
function baseUrl(domain: string) {
  return process.env.SHOPIFY_TEST_BASE || `https://${domain}`;
}

export const gid = (type: 'Product' | 'ProductVariant' | 'InventoryItem' | 'Location', id: string | number) =>
  `gid://shopify/${type}/${id}`;
const idOf = (g: string) => String(g).split('/').pop() as string;

async function shopifyGraphql(store: Store, query: string, variables: Record<string, unknown> = {}) {
  if (!store.access_token) {
    throw new Error(`La tienda '${store.name}' todavía no está conectada. Ve a "Tiendas" y dale clic en "Conectar".`);
  }
  const domain = cleanDomain(store.domain);
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithRetry(`${baseUrl(domain)}/admin/api/${store.api_version}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': store.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401) {
      throw new Error(`Token inválido o vencido para ${domain}. Reconecta la tienda.`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Shopify GraphQL error ${res.status}: ${JSON.stringify(json)}`);
    if (json.errors?.length) {
      // GraphQL limita por "costo": si se llena el cupo responde THROTTLED; se espera y se reintenta.
      const throttled = json.errors.some((e: any) => e?.extensions?.code === 'THROTTLED');
      if (throttled && attempt < 5) { await sleep(1000 + attempt * 500); continue; }
      const msg = JSON.stringify(json.errors);
      if (/access denied|scope|themes/i.test(msg)) {
        throw new Error(`Sin permiso (falta un scope: reconecta la tienda). Detalle: ${msg}`);
      }
      throw new Error(`Shopify GraphQL: ${msg}`);
    }
    return json.data;
  }
}

function throwUserErrors(name: string, errors: { message: string }[] | undefined | null) {
  if (errors?.length) throw new Error(`${name}: ${errors.map(e => e.message).join('; ')}`);
}

// ---------------------------------------------------------
// Operaciones por lote (GraphQL): muchas variantes/productos en pocas llamadas
// ---------------------------------------------------------

/** Precio y tachado actuales de muchas variantes (100 por llamada). */
export async function shopifyReadVariantPrices(store: Store, variantIds: string[]) {
  const out: Record<string, { price: string; compare: string | null }> = {};
  for (let i = 0; i < variantIds.length; i += 100) {
    const ids = variantIds.slice(i, i + 100).map(v => gid('ProductVariant', v));
    const data = await shopifyGraphql(
      store,
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price compareAtPrice } } }`,
      { ids }
    );
    for (const n of data.nodes ?? []) {
      if (n?.id) out[idOf(n.id)] = { price: n.price, compare: n.compareAtPrice ?? null };
    }
  }
  return out;
}

/** Cambia precio y precio de comparación de TODAS las variantes de un producto en una sola llamada. */
export async function shopifyUpdateVariantPricesBulk(
  store: Store, productId: string,
  variants: { variantId: string; price: string; compareAtPrice: string | null }[]
) {
  const data = await shopifyGraphql(
    store,
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         productVariants { id price compareAtPrice }
         userErrors { field message code }
       }
     }`,
    {
      productId: gid('Product', productId),
      variants: variants.map(v => ({ id: gid('ProductVariant', v.variantId), price: v.price, compareAtPrice: v.compareAtPrice })),
    }
  );
  throwUserErrors('productVariantsBulkUpdate', data.productVariantsBulkUpdate?.userErrors);
}

/** Suma (o resta) inventario de muchas variantes en una sola llamada. */
export async function shopifyInventoryAdjustBulk(
  store: Store, locationId: string, changes: { inventoryItemId: string; delta: number }[]
) {
  const data = await shopifyGraphql(
    store,
    `mutation($input: InventoryAdjustQuantitiesInput!) {
       inventoryAdjustQuantities(input: $input) { inventoryAdjustmentGroup { id } userErrors { field message code } }
     }`,
    {
      input: {
        reason: 'correction', name: 'available',
        changes: changes.map(c => ({ delta: c.delta, inventoryItemId: gid('InventoryItem', c.inventoryItemId), locationId: gid('Location', locationId) })),
      },
    }
  );
  throwUserErrors('inventoryAdjustQuantities', data.inventoryAdjustQuantities?.userErrors);
}

/** Fija el inventario de muchas variantes en una sola llamada. */
export async function shopifyInventorySetBulk(
  store: Store, locationId: string, quantities: { inventoryItemId: string; quantity: number }[]
) {
  const data = await shopifyGraphql(
    store,
    `mutation($input: InventorySetQuantitiesInput!) {
       inventorySetQuantities(input: $input) { inventoryAdjustmentGroup { id } userErrors { field message code } }
     }`,
    {
      input: {
        reason: 'correction', name: 'available', ignoreCompareQuantity: true,
        quantities: quantities.map(q => ({ inventoryItemId: gid('InventoryItem', q.inventoryItemId), locationId: gid('Location', locationId), quantity: q.quantity })),
      },
    }
  );
  throwUserErrors('inventorySetQuantities', data.inventorySetQuantities?.userErrors);
}

/** Publica (status ACTIVE) varios productos; las llamadas GraphQL van en paralelo. */
export async function shopifyProductsActivate(store: Store, productIds: string[]) {
  await Promise.all(productIds.map(async (id) => {
    const data = await shopifyGraphql(
      store,
      `mutation($productId: ID!) {
         productChangeStatus(productId: $productId, status: ACTIVE) { product { id status } userErrors { field message } }
       }`,
      { productId: gid('Product', id) }
    );
    throwUserErrors('productChangeStatus', data.productChangeStatus?.userErrors);
  }));
}

export type ShopifyTheme = { id: string; name: string; role: string };

export async function shopifyListThemes(store: Store): Promise<ShopifyTheme[]> {
  const data = await shopifyGraphql(store, `query { themes(first: 50) { nodes { id name role } } }`);
  return (data.themes?.nodes ?? []) as ShopifyTheme[];
}

export async function shopifyPublishTheme(store: Store, themeGid: string) {
  const data = await shopifyGraphql(
    store,
    `mutation themePublish($id: ID!) {
       themePublish(id: $id) { theme { id name role } userErrors { field message code } }
     }`,
    { id: themeGid }
  );
  const errors = data.themePublish?.userErrors ?? [];
  if (errors.length) throw new Error(`themePublish: ${errors.map((e: any) => e.message).join('; ')}`);
  return data.themePublish.theme as ShopifyTheme;
}
