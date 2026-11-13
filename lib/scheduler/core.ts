import { sql } from './db';
import {
  Store, shopifyListProducts, shopifySetProductStatus, shopifyGetVariant,
  shopifyUpdateVariantPrice, shopifyAdjustInventory, shopifySetInventory,
  shopifyListThemes, shopifyPublishTheme,
  shopifyReadVariantPrices, shopifyUpdateVariantPricesBulk,
  shopifyInventoryAdjustBulk, shopifyInventorySetBulk, shopifyProductsActivate,
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
        INSERT INTO products_cache (store_key, product_id, title, handle, status, image_url)
        VALUES (${storeKey}, ${p.id}, ${p.title}, ${p.handle ?? null}, ${p.status ?? 'draft'}, ${p.image?.src ?? null})
        ON CONFLICT (store_key, product_id) DO UPDATE SET
          title = EXCLUDED.title, handle = EXCLUDED.handle, status = EXCLUDED.status,
          image_url = EXCLUDED.image_url, updated_at = now()
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

/** Cuántos productos hay sincronizados en la tienda y a cuántos ya se les guardó el handle. */
export async function catalogStats(storeKey: string) {
  const rows = await sql`
    SELECT count(*)::int AS total, count(handle)::int AS with_handle
    FROM products_cache WHERE store_key = ${storeKey}
  `;
  return { total: rows[0].total as number, withHandle: rows[0].with_handle as number };
}

/** Producto + todas sus variantes, buscado por handle (el que trae el CSV exportado de Shopify). */
export async function findProductByHandle(storeKey: string, handle: string) {
  const products = await sql`
    SELECT * FROM products_cache WHERE store_key = ${storeKey} AND lower(handle) = ${handle.toLowerCase()} LIMIT 1
  `;
  if (!products.length) return null;
  const variants = await sql`
    SELECT * FROM variants_cache WHERE product_cache_id = ${products[0].id} ORDER BY id
  `;
  return { product: products[0], variants };
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
  promoPrice: number, compareAtPrice: number, runAt: string, revertAt: string, source: 'manual' | 'csv' = 'manual',
  // 'restore': al terminar vuelve al precio que tenía antes (respaldo leído al iniciar).
  // 'compare_to_price': al terminar el precio de comparación pasa a ser el precio real y se quita el tachado.
  endMode: 'restore' | 'compare_to_price' = 'restore'
) {
  const payload = JSON.stringify({ promo_price: promoPrice.toFixed(2), compare_at_price: compareAtPrice.toFixed(2), end_mode: endMode });
  const rows = await sql`
    INSERT INTO scheduled_tasks (store_key, type, product_id, variant_id, label, payload, run_at, revert_at, source)
    VALUES (${storeKey}, 'price', ${productId}, ${variantId}, ${label}, ${payload}::jsonb, ${runAt}, ${revertAt}, ${source})
    RETURNING id
  `;
  return rows[0].id as number;
}

export async function createThemePublishTask(storeKey: string, themeGid: string, themeName: string, runAt: string) {
  const payload = JSON.stringify({ theme_id: themeGid, theme_name: themeName });
  const rows = await sql`
    INSERT INTO scheduled_tasks (store_key, type, label, payload, run_at)
    VALUES (${storeKey}, 'theme_publish', ${'Tema: ' + themeName}, ${payload}::jsonb, ${runAt})
    RETURNING id
  `;
  return rows[0].id as number;
}

export async function listStoreThemes(storeKey: string) {
  const store = await getStore(storeKey);
  return shopifyListThemes(store);
}

// ---------------------------------------------------------
// Tareas de LOTE: una sola tarea con toda la lista de cambios
// ---------------------------------------------------------

export type PriceItem = { product_id: string; variant_id: string; label: string; promo_price: string; compare_at_price: string };
export type InventoryItem = { product_id: string; variant_id: string; inventory_item_id: string; label: string; quantity: number };
export type PublishItem = { product_id: string; label: string };

const countProducts = (items: { product_id: string }[]) => new Set(items.map(i => i.product_id)).size;

export async function createPriceBatchTask(
  storeKey: string, items: PriceItem[], runAt: string, revertAt: string,
  endMode: 'restore' | 'compare_to_price', source: 'manual' | 'csv' = 'manual'
) {
  const label = `Precio promo: ${items.length} variante(s) en ${countProducts(items)} producto(s)`;
  const payload = JSON.stringify({ items, end_mode: endMode });
  const rows = await sql`
    INSERT INTO scheduled_tasks (store_key, type, label, payload, run_at, revert_at, source)
    VALUES (${storeKey}, 'price_batch', ${label}, ${payload}::jsonb, ${runAt}, ${revertAt}, ${source})
    RETURNING id`;
  return rows[0].id as number;
}

export async function createInventoryBatchTask(
  storeKey: string, items: InventoryItem[], runAt: string, mode: 'add' | 'set',
  locationId: string | null, source: 'manual' | 'csv' = 'manual'
) {
  const label = `Inventario (${mode === 'set' ? 'fijar' : 'sumar'}): ${items.length} variante(s) en ${countProducts(items)} producto(s)`;
  const payload = JSON.stringify({ items, mode });
  const rows = await sql`
    INSERT INTO scheduled_tasks (store_key, type, label, payload, run_at, location_id, source)
    VALUES (${storeKey}, 'inventory_batch', ${label}, ${payload}::jsonb, ${runAt}, ${locationId}, ${source})
    RETURNING id`;
  return rows[0].id as number;
}

export async function createPublishBatchTask(
  storeKey: string, items: PublishItem[], runAt: string, source: 'manual' | 'csv' = 'manual'
) {
  const label = `Publicar: ${items.length} producto(s)`;
  const payload = JSON.stringify({ items });
  const rows = await sql`
    INSERT INTO scheduled_tasks (store_key, type, label, payload, run_at, source)
    VALUES (${storeKey}, 'publish_batch', ${label}, ${payload}::jsonb, ${runAt}, ${source})
    RETURNING id`;
  return rows[0].id as number;
}

export async function cancelTask(taskId: number) {
  await sql`UPDATE scheduled_tasks SET status = 'cancelled' WHERE id = ${taskId} AND status IN ('pending','active')`;
}

// ---------------------------------------------------------
// Ejecutar tareas vencidas (cron)
// ---------------------------------------------------------

type BatchState = {
  snapshot?: Record<string, { price: string; compare: string | null }>;
  started?: boolean;
  todo?: { start?: number[]; revert?: number[] };
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function groupByProduct<T extends { product_id: string }>(items: T[]): T[][] {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(i.product_id, [...(m.get(i.product_id) ?? []), i]);
  return [...m.values()];
}

/**
 * Ejecuta una tarea de lote. El avance se guarda en original_data (lista de bloques pendientes):
 * - si se acaba el tiempo de la corrida, devuelve 'deferred' y la siguiente corrida sigue donde se quedó;
 * - si algún bloque falla, se queda en la lista y la tarea pasa a 'failed'; "Reintentar" solo repite esos bloques.
 */
async function runBatchTask(t: any, store: Store, deadline: number): Promise<'done' | 'deferred' | 'failed'> {
  const payload = t.payload as any;
  const state: BatchState = (t.original_data as BatchState | null) ?? {};
  const save = () => sql`UPDATE scheduled_tasks SET original_data=${JSON.stringify(state)}::jsonb WHERE id=${t.id}`;

  async function runPhase(phase: 'start' | 'revert', chunks: any[][], apply: (items: any[]) => Promise<void>) {
    state.todo = state.todo ?? {};
    const todo: number[] = state.todo[phase] ?? chunks.map((_, i) => i);
    const stillTodo: number[] = [];
    const errors: string[] = [];
    let timedOut = false;
    for (let k = 0; k < todo.length; k++) {
      const idx = todo[k];
      if (timedOut || Date.now() > deadline) { timedOut = true; stillTodo.push(idx); continue; }
      try { await apply(chunks[idx]); } catch (e: any) { errors.push(e.message); stillTodo.push(idx); }
      state.todo[phase] = [...stillTodo, ...todo.slice(k + 1)];
      await save();
    }
    state.todo[phase] = stillTodo;
    if (!stillTodo.length) delete state.todo[phase];
    await save();
    if (timedOut) return 'deferred' as const;
    if (stillTodo.length) {
      const msg = `${stillTodo.length} de ${chunks.length} bloque(s) fallaron: ${errors[0]}`;
      await sql`UPDATE scheduled_tasks SET status='failed', last_error=${msg} WHERE id=${t.id}`;
      return 'failed' as const;
    }
    return 'done' as const;
  }
  const complete = () => sql`UPDATE scheduled_tasks SET status='completed', last_error=NULL WHERE id=${t.id}`;

  if (t.type === 'publish_batch') {
    const r = await runPhase('start', chunk(payload.items as any[], 10),
      items => shopifyProductsActivate(store, items.map(i => i.product_id)));
    if (r === 'done') await complete();
    return r;
  }

  if (t.type === 'inventory_batch') {
    const locationId = (t.location_id as string | null) || store.location_id;
    if (!locationId) throw new Error('No hay location_id (ni en la tarea ni en la tienda).');
    const r = await runPhase('start', chunk(payload.items as any[], 100), items =>
      payload.mode === 'set'
        ? shopifyInventorySetBulk(store, locationId, items.map(i => ({ inventoryItemId: i.inventory_item_id, quantity: i.quantity })))
        : shopifyInventoryAdjustBulk(store, locationId, items.map(i => ({ inventoryItemId: i.inventory_item_id, delta: i.quantity }))));
    if (r === 'done') await complete();
    return r;
  }

  // price_batch
  const groups = groupByProduct(payload.items as PriceItem[]);
  if (t.status === 'pending') {
    // 'restore': se respalda el precio actual de todas las variantes (una consulta por cada 100)
    if (payload.end_mode !== 'compare_to_price' && !state.snapshot) {
      state.snapshot = await shopifyReadVariantPrices(store, (payload.items as PriceItem[]).map(i => i.variant_id));
      await save();
    }
    const r = await runPhase('start', groups, items =>
      shopifyUpdateVariantPricesBulk(store, items[0].product_id,
        items.map(i => ({ variantId: i.variant_id, price: i.promo_price, compareAtPrice: i.compare_at_price }))));
    if (r === 'done') {
      state.started = true;
      await save();
      await sql`UPDATE scheduled_tasks SET status='active' WHERE id=${t.id} AND status='pending'`;
    }
    return r;
  }

  // status 'active' y ya llegó la fecha de fin: termina la promo
  const r = await runPhase('revert', groups, async (items) => {
    const variants = items.map(i => {
      if (payload.end_mode === 'compare_to_price') {
        // el precio de comparación pasa a ser el precio real y se quita el tachado
        return { variantId: i.variant_id, price: i.compare_at_price, compareAtPrice: null as string | null };
      }
      const snap = state.snapshot?.[i.variant_id];
      return snap ? { variantId: i.variant_id, price: snap.price, compareAtPrice: snap.compare } : null;
    }).filter(Boolean) as { variantId: string; price: string; compareAtPrice: string | null }[];
    if (variants.length) await shopifyUpdateVariantPricesBulk(store, items[0].product_id, variants);
  });
  if (r === 'done') await complete();
  return r;
}

/**
 * Ejecuta las tareas vencidas. Trabaja con un presupuesto de tiempo (por defecto 50 s, para
 * caber en el límite de la función en Vercel): lo que no alcance a procesar se queda
 * "pendiente" y lo toma la siguiente corrida del cron (ver `deferred`).
 */
export async function runDueTasks(budgetMs = 50_000): Promise<{ ok: number; failed: number; deferred: number }> {
  const summary = { ok: 0, failed: 0, deferred: 0 };
  const now = new Date().toISOString();
  const deadline = Date.now() + budgetMs;

  // Una consulta de tienda por corrida (no una por tarea)
  const storeCache = new Map<string, Store>();
  const storeFor = async (key: string) => {
    if (!storeCache.has(key)) storeCache.set(key, await getStore(key));
    return storeCache.get(key)!;
  };

  async function run(rows: any[], fn: (t: any) => Promise<void>) {
    for (const t of rows) {
      if (Date.now() > deadline) { summary.deferred++; continue; }
      try {
        await fn(t);
        summary.ok++;
      } catch (e: any) {
        await sql`UPDATE scheduled_tasks SET status='failed', last_error=${e.message} WHERE id=${t.id}`;
        summary.failed++;
      }
    }
  }

  // Primero lo más urgente y barato: el tema (1 llamada) y las publicaciones.
  const themeRows = await sql`SELECT * FROM scheduled_tasks WHERE type='theme_publish' AND status='pending' AND run_at <= ${now} ORDER BY run_at`;
  await run(themeRows, async (t) => {
    const store = await storeFor(t.store_key as string);
    const payload = t.payload as { theme_id: string; theme_name: string };
    await shopifyPublishTheme(store, payload.theme_id);
    await sql`UPDATE scheduled_tasks SET status='completed' WHERE id=${t.id}`;
  });

  // Lotes: UNA tarea con muchos cambios (precio, inventario o publicar).
  const batchRows = await sql`
    SELECT * FROM scheduled_tasks
    WHERE (type IN ('publish_batch','inventory_batch','price_batch') AND status='pending' AND run_at <= ${now})
       OR (type = 'price_batch' AND status='active' AND revert_at IS NOT NULL AND revert_at <= ${now})
    ORDER BY run_at`;
  for (const t of batchRows) {
    if (Date.now() > deadline) { summary.deferred++; continue; }
    try {
      const store = await storeFor(t.store_key as string);
      const r = await runBatchTask(t, store, deadline);
      if (r === 'done') summary.ok++;
      else if (r === 'deferred') summary.deferred++;
      else summary.failed++;
    } catch (e: any) {
      await sql`UPDATE scheduled_tasks SET status='failed', last_error=${e.message} WHERE id=${t.id}`;
      summary.failed++;
    }
  }

  const publishRows = await sql`SELECT * FROM scheduled_tasks WHERE type='publish' AND status='pending' AND run_at <= ${now} ORDER BY run_at`;
  await run(publishRows, async (t) => {
    const store = await storeFor(t.store_key as string);
    await shopifySetProductStatus(store, String(t.product_id), 'active');
    await sql`UPDATE scheduled_tasks SET status='completed' WHERE id=${t.id}`;
  });

  const invRows = await sql`SELECT * FROM scheduled_tasks WHERE type='inventory' AND status='pending' AND run_at <= ${now} ORDER BY run_at`;
  await run(invRows, async (t) => {
    const store = await storeFor(t.store_key as string);
    const locationId = (t.location_id as string | null) || store.location_id;
    if (!locationId) throw new Error('No hay location_id (ni en la tarea ni en la tienda).');
    const payload = t.payload as { quantity: number; mode: string };
    if (payload.mode === 'set') await shopifySetInventory(store, String(t.inventory_item_id), locationId, payload.quantity);
    else await shopifyAdjustInventory(store, String(t.inventory_item_id), locationId, payload.quantity);
    await sql`UPDATE scheduled_tasks SET status='completed' WHERE id=${t.id}`;
  });

  const priceStartRows = await sql`SELECT * FROM scheduled_tasks WHERE type='price' AND status='pending' AND run_at <= ${now} ORDER BY run_at`;
  await run(priceStartRows, async (t) => {
    const store = await storeFor(t.store_key as string);
    const payload = t.payload as { promo_price: string; compare_at_price: string; end_mode?: string };
    let original: string;
    if (payload.end_mode === 'compare_to_price') {
      // Al terminar se usa el precio de comparación, así que no hace falta leer ni respaldar el precio
      // actual: una sola llamada a Shopify por variante (importa por el límite de 2 llamadas/segundo).
      await shopifyUpdateVariantPrice(store, String(t.variant_id), payload.promo_price, payload.compare_at_price);
      original = JSON.stringify({ started: true });
    } else {
      const { data: current } = await shopifyGetVariant(store, String(t.variant_id));
      const originalPrice = current?.variant?.price ?? null;
      const originalCompare = current?.variant?.compare_at_price ?? null;
      if (originalPrice === null) throw new Error('No se pudo leer el precio original.');
      await shopifyUpdateVariantPrice(store, String(t.variant_id), payload.promo_price, payload.compare_at_price);
      original = JSON.stringify({ price: originalPrice, compare_at_price: originalCompare });
    }
    // "AND status='pending'": si dos corridas se cruzaran, no pisa el respaldo de la primera.
    await sql`UPDATE scheduled_tasks SET status='active', original_data=${original}::jsonb WHERE id=${t.id} AND status='pending'`;
  });

  const priceRevertRows = await sql`SELECT * FROM scheduled_tasks WHERE type='price' AND status='active' AND revert_at IS NOT NULL AND revert_at <= ${now} ORDER BY revert_at`;
  await run(priceRevertRows, async (t) => {
    const store = await storeFor(t.store_key as string);
    const payload = t.payload as { compare_at_price?: string; end_mode?: string } | null;
    if (payload?.end_mode === 'compare_to_price') {
      // El precio de comparación pasa a ser el precio real y el tachado se quita (null = sin precio de comparación).
      if (!payload.compare_at_price) throw new Error('La tarea no trae precio de comparación.');
      await shopifyUpdateVariantPrice(store, String(t.variant_id), payload.compare_at_price, null);
    } else {
      const original = t.original_data as { price: string; compare_at_price: string | null };
      if (!original?.price) throw new Error('Sin respaldo de precio original.');
      await shopifyUpdateVariantPrice(store, String(t.variant_id), original.price, original.compare_at_price);
    }
    await sql`UPDATE scheduled_tasks SET status='completed' WHERE id=${t.id}`;
  });

  return summary;
}

/**
 * Reintenta tareas fallidas (por ejemplo las que fallaron por el límite de llamadas de Shopify).
 * Un precio que ya había iniciado (tiene respaldo) vuelve a "activa" para reintentar solo el término;
 * todo lo demás vuelve a "pendiente". Sin taskId reintenta todas las fallidas.
 */
export async function retryTasks(taskId?: number): Promise<number> {
  const rows = taskId
    ? await sql`
        UPDATE scheduled_tasks
        SET status = CASE
          WHEN type = 'price' AND original_data IS NOT NULL THEN 'active'
          WHEN type = 'price_batch' AND original_data->>'started' = 'true' THEN 'active'
          ELSE 'pending' END, last_error = NULL
        WHERE id = ${taskId} AND status = 'failed' RETURNING id`
    : await sql`
        UPDATE scheduled_tasks
        SET status = CASE
          WHEN type = 'price' AND original_data IS NOT NULL THEN 'active'
          WHEN type = 'price_batch' AND original_data->>'started' = 'true' THEN 'active'
          ELSE 'pending' END, last_error = NULL
        WHERE status = 'failed' RETURNING id`;
  return rows.length;
}
