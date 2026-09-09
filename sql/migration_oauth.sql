-- Corre esto UNA VEZ en el SQL Editor de Neon si ya habías creado la tabla
-- "stores" con el esquema anterior (access_token obligatorio, sin client_id/secret).

ALTER TABLE stores ALTER COLUMN access_token DROP NOT NULL;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS client_id TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS client_secret TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

-- Si ya habías guardado alguna tienda con la versión anterior (access_token
-- pegado a mano), esa fila se queda sin client_id/client_secret — bórrala y
-- vuelve a agregarla desde el panel con el flujo nuevo, o edítala a mano:
-- UPDATE stores SET client_id = '...', client_secret = '...' WHERE store_key = '...';

-- Si ya habías corrido schema.sql antes de este cambio, agrega también:
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS location_id TEXT NULL;
