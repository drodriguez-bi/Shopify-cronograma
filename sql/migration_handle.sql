-- Corre esto UNA VEZ en el SQL Editor de Neon.
-- Guarda el handle de cada producto para poder importar CSV sin SKU ni IDs.
-- Después de correrlo, dale "Sincronizar productos" de nuevo en cada tienda
-- para que se llene el handle.

ALTER TABLE products_cache ADD COLUMN IF NOT EXISTS handle TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_products_handle ON products_cache (store_key, handle);
