import { sql } from './db';
import {
  Store, shopifyListProducts, shopifySetProductStatus, shopifyGetVariant,
  shopifyUpdateVariantPrice, shopifyAdjustInventory, shopifySetInventory,
} from './shopify';

// ---------------------------------------------------------
// Tiendas
// ---------------------------------------------------------

export async function listStores(): Promise<Store[]> {
  const rows = await sql`SELECT * FROM stores ORDER BY name`;
  return rows as unknown as Store[];
}

export async function getStore(storeKey: string): Promise<Store> {
  const rows = await sql`SELECT * FROM stores WHERE store_key = ${storeKey}`;
  if (!rows.length) throw new Error(`Tienda '${storeKey}' no encontrada.`);
  return rows[0] as unknown as Store;
}

export async function createStore(input: {
  storeKey: string; name: string; domain: string; clientId: string; clientSecret: string;
  apiVersion: string; locationId?: string;
}) {
  const rows = await sql`
    INSERT INTO stores (store_key, name, domain, client_id, client_secret, api_version, location_id)
    VALUES (${input.storeKey}, ${input.name}, ${input.domain}, ${input.clientId}, ${input.clientSecret}, ${input.apiVersion}, ${input.locationId || null})
    RETURNING id
  `;
  return rows[0].id as number;
}

export async function updateStore(id: number, input: {
  name: string; domain: string; clientId?: string; clientSecret?: string; apiVersion: string; locationId?: string;
}) {
  if (input.clientId && input.clientSecret) {
    await sql`
      UPDATE stores SET
        name = ${input.name}, domain = ${input.domain}, client_id = ${input.clientId}, client_secret = ${input.clientSecret},
        api_version = ${input.apiVersion}, location_id = ${input.locationId || null}, updated_at = now()
      WHERE id = ${id}
    `;
  } else {
    await sql`
      UPDATE stores SET
        name = ${input.name}, domain = ${input.domain},
        api_version = ${input.apiVersion}, location_id = ${input.locationId || null}, updated_at = now()
      WHERE id = ${id}
    `;
  }
}

export async function saveStoreToken(storeKey: string, accessToken: string, expiresAt: string | null) {
  await sql`
    UPDATE stores SET access_token = ${accessToken}, token_expires_at = ${expiresAt}, updated_at = now()
    WHERE store_key = ${storeKey}
  `;
}

export type ConnectionStatus = {
  id: number; key: string; name: string;
  state: 'connected' | 'expiring_soon' | 'expired' | 'not_connected';
  expiresAt: string | null; daysLeft: number | null;
};

export async function getConnectionStatus(): Promise<ConnectionStatus[]> {
  const stores = await listStores();
  const now = Date.now();
  return stores.map(s => {
    if (!s.access_token) {
      return { id: s.id, key: s.store_key, name: s.name, state: 'not_connected' as const, expiresAt: null, daysLeft: null };
    }
    let state: ConnectionStatus['state'] = 'connected';
    let daysLeft: number | null = null;
    if (s.token_expires_at) {
      daysLeft = Math.floor((new Date(s.token_expires_at).getTime() - now) / 86400000);
      if (daysLeft < 0) state = 'expired';
      else if (daysLeft <= 7) state = 'expiring_soon';
    }
    return { id: s.id, key: s.store_key, name: s.name, state, expiresAt: s.token_expires_at, daysLeft };
  });
}

export async function deleteStore(id: number) {
  await sql`DELETE FROM stores WHERE id = ${id}`;
}

// ---------------------------------------------------------
// Sincronización de catálogo
// ---------------------------------------------------------

export async function syncProducts(storeKey: string): Promise<number> {
  const store = await getStore(storeKey);
  let pageInfo: string | undefined;
  let total = 0;

  do {
    const { data, nextPageInfo } = await shopifyListProducts(store, pageInfo);
    const products = data.products ?? [];

    for (const p of products) {
      await sql`
        INSERT INTO products_cache (store_key, product_id, title, status, image_url)
        VALUES (${storeKey}, ${p.id}, ${p.title}, ${p.status ?? 'draft'}, ${p.image?.src ?? null})
        ON CONFLICT (store_key, product_id) DO UPDATE SET
          title = EXCLUDED.title, status = EXCLUDED.status, image_url = EXCLUDED.image_url, updated_at = now()
      `;
      const found = await sql`SELECT id FROM products_cache WHERE store_key = ${storeKey} AND product_id = ${p.id}`;
      const productCacheId = found[0].id as number;

      for (const v of p.variants ?? []) {
        await sql`
          INSERT INTO variants_cache
            (store_key, product_cache_id, variant_id, inventory_item_id, title, sku, price, compare_at_price, inventory_qty)
          VALUES (${storeKey}, ${productCacheId}, ${v.id}, ${v.inventory_item_id ?? null}, ${v.title ?? null},
                  ${v.sku ?? null}, ${v.price ?? 0}, ${v.compare_at_price ?? null}, ${v.inventory_quantity ?? 0})
          ON CONFLICT (store_key, variant_id) DO UPDATE SET
            title = EXCLUDED.title, sku = EXCLUDED.sku, price = EXCLUDED.price,
            compare_at_price = EXCLUDED.compare_at_price, inventory_qty = EXCLUDED.inventory_qty,
            inventory_item_id = EXCLUDED.inventory_item_id, updated_at = now()
        `;
      }
      total++;
    }
    pageInfo = nextPageInfo ?? undefined;
  } while (pageInfo);

  return total;
}

// ---------------------------------------------------------
// Buscar variante por SKU (usado por el import de CSV)
// ---------------------------------------------------------

export async function findVariantBySku(storeKey: string, sku: string) {
  const rows = await sql`
    SELECT vc.*, pc.product_id AS shopify_product_id, pc.title AS product_title
    FROM variants_cache vc
    JOIN products_cache pc ON pc.id = vc.product_cache_id
    WHERE vc.store_key = ${storeKey} AND vc.sku = ${sku}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------
// Crear tareas
// ---------------------------------------------------------

export async function createPublishTask(storeKey: string, productId: string, label: string, runAt: string, source: 'manual' | 'csv' = 'manual') {
  const rows = await sql`
    INSERT INTO scheduled_tasks (store_key, type, product_id, label, run_at, source)
    VALUES (${storeKey}, 'publish', ${productId}, ${label}, ${runAt}, ${source})
    RETURNING id
  `;
  return rows[0].id as number;
}

export async function createInventoryTask(
  storeKey: string, productId: string, variantId: string, inventoryItemId: string | null,
  label: string, quantity: number, mode: string, runAt: string,
  locationId: string | null = null, source: 'manual' | 'csv' = 'manual'
) {
  const payload = JSON.stringify({ quantity, mode });
  const rows = await sql`
    INSERT INTO scheduled_tasks (store_key, type, product_id, variant_id, inventory_item_id, label, payload, run_at, location_id, source)
    VALUES (${storeKey}, 'inventory', ${productId}, ${variantId}, ${inventoryItemId}, ${label}, ${payload}::jsonb, ${runAt}, ${locationId}, ${source})
    RETURNING id
  `;
  return rows[0].id as number;
}

export async function createPriceTask(
  storeKey: string, productId: string, variantId: string, label: string,
  promoPrice: number, compareAtPrice: number, runAt: string, revertAt: string, source: 'manual' | 'csv' = 'manual'
) {
  const payload = JSON.stringify({ promo_price: promoPrice.toFixed(2), compare_at_price: compareAtPrice.toFixed(2) });
  const rows = await sql`
    INSERT INTO scheduled_tasks (store_key, type, product_id, variant_id, label, payload, run_at, revert_at, source)
    VALUES (${storeKey}, 'price', ${productId}, ${variantId}, ${label}, ${payload}::jsonb, ${runAt}, ${revertAt}, ${source})
    RETURNING id
  `;
  return rows[0].id as number;
}

export async function cancelTask(taskId: number) {
  await sql`UPDATE scheduled_tasks SET status = 'cancelled' WHERE id = ${taskId} AND status IN ('pending','active')`;
}

// ---------------------------------------------------------
// Ejecutar tareas vencidas (cron)
// ---------------------------------------------------------

export async function runDueTasks(): Promise<{ ok: number; failed: number }> {
  const summary = { ok: 0, failed: 0 };
  const now = new Date().toISOString();

  const publishRows = await sql`SELECT * FROM scheduled_tasks WHERE type='publish' AND status='pending' AND run_at <= ${now}`;
  for (const t of publishRows) {
    try {
      const store = await getStore(t.store_key as string);
      await shopifySetProductStatus(store, String(t.product_id), 'active');
      await sql`UPDATE scheduled_tasks SET status='completed' WHERE id=${t.id}`;
      summary.ok++;
    } catch (e: any) {
      await sql`UPDATE scheduled_tasks SET status='failed', last_error=${e.message} WHERE id=${t.id}`;
      summary.failed++;
    }
  }

  const invRows = await sql`SELECT * FROM scheduled_tasks WHERE type='inventory' AND status='pending' AND run_at <= ${now}`;
  for (const t of invRows) {
    try {
      const store = await getStore(t.store_key as string);
      const locationId = (t.location_id as string | null) || store.location_id;
      if (!locationId) throw new Error('No hay location_id (ni en la tarea ni en la tienda).');
      const payload = t.payload as { quantity: number; mode: string };
      if (payload.mode === 'set') await shopifySetInventory(store, String(t.inventory_item_id), locationId, payload.quantity);
      else await shopifyAdjustInventory(store, String(t.inventory_item_id), locationId, payload.quantity);
      await sql`UPDATE scheduled_tasks SET status='completed' WHERE id=${t.id}`;
      summary.ok++;
    } catch (e: any) {
      await sql`UPDATE scheduled_tasks SET status='failed', last_error=${e.message} WHERE id=${t.id}`;
      summary.failed++;
    }
  }

  const priceStartRows = await sql`SELECT * FROM scheduled_tasks WHERE type='price' AND status='pending' AND run_at <= ${now}`;
  for (const t of priceStartRows) {
    try {
      const store = await getStore(t.store_key as string);
      const payload = t.payload as { promo_price: string; compare_at_price: string };
      const { data: current } = await shopifyGetVariant(store, String(t.variant_id));
      const originalPrice = current?.variant?.price ?? null;
      const originalCompare = current?.variant?.compare_at_price ?? null;
      if (originalPrice === null) throw new Error('No se pudo leer el precio original.');
      await shopifyUpdateVariantPrice(store, String(t.variant_id), payload.promo_price, payload.compare_at_price);
      const original = JSON.stringify({ price: originalPrice, compare_at_price: originalCompare });
      await sql`UPDATE scheduled_tasks SET status='active', original_data=${original}::jsonb WHERE id=${t.id}`;
      summary.ok++;
    } catch (e: any) {
      await sql`UPDATE scheduled_tasks SET status='failed', last_error=${e.message} WHERE id=${t.id}`;
      summary.failed++;
    }
  }

  const priceRevertRows = await sql`SELECT * FROM scheduled_tasks WHERE type='price' AND status='active' AND revert_at IS NOT NULL AND revert_at <= ${now}`;
  for (const t of priceRevertRows) {
    try {
      const store = await getStore(t.store_key as string);
      const original = t.original_data as { price: string; compare_at_price: string | null };
      if (!original?.price) throw new Error('Sin respaldo de precio original.');
      await shopifyUpdateVariantPrice(store, String(t.variant_id), original.price, original.compare_at_price);
      await sql`UPDATE scheduled_tasks SET status='completed' WHERE id=${t.id}`;
      summary.ok++;
    } catch (e: any) {
      await sql`UPDATE scheduled_tasks SET status='failed', last_error=${e.message} WHERE id=${t.id}`;
      summary.failed++;
    }
  }

  return summary;
}
