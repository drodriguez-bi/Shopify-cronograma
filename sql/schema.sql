-- Corre esto una vez contra tu base de Neon (Neon SQL Editor, o psql).

CREATE TABLE IF NOT EXISTS stores (
  id SERIAL PRIMARY KEY,
  store_key TEXT NOT NULL UNIQUE,   -- slug corto, ej. 'stanley', 'lalic', 'mathe'
  name TEXT NOT NULL,               -- nombre para mostrar, ej. 'Stanley 1913 MX'
  domain TEXT NOT NULL,             -- ej. stanley-1913-mx.myshopify.com
  client_id TEXT NOT NULL,          -- de tu app en Shopify Partners
  client_secret TEXT NOT NULL,      -- de tu app en Shopify Partners
  access_token TEXT NULL,           -- se llena solo al conectar (OAuth), no lo pegas a mano
  token_expires_at TIMESTAMPTZ NULL,
  api_version TEXT NOT NULL DEFAULT '2024-10',
  location_id TEXT NULL,            -- requerido solo para programar inventario
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products_cache (
  id SERIAL PRIMARY KEY,
  store_key TEXT NOT NULL,
  product_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  image_url TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_key, product_id)
);

CREATE TABLE IF NOT EXISTS variants_cache (
  id SERIAL PRIMARY KEY,
  store_key TEXT NOT NULL,
  product_cache_id INT NOT NULL REFERENCES products_cache(id) ON DELETE CASCADE,
  variant_id BIGINT NOT NULL,
  inventory_item_id BIGINT NULL,
  title TEXT NULL,
  sku TEXT NULL,
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  compare_at_price NUMERIC(10,2) NULL,
  inventory_qty INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_key, variant_id)
);
CREATE INDEX IF NOT EXISTS idx_variants_sku ON variants_cache (store_key, sku);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id SERIAL PRIMARY KEY,
  store_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('publish','inventory','price')),
  product_id BIGINT NOT NULL,
  variant_id BIGINT NULL,
  inventory_item_id BIGINT NULL,
  label TEXT NULL,
  payload JSONB NULL,
  original_data JSONB NULL,
  run_at TIMESTAMPTZ NOT NULL,
  revert_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','completed','failed','cancelled')),
  last_error TEXT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','csv')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_run ON scheduled_tasks (status, run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status_revert ON scheduled_tasks (status, revert_at);
