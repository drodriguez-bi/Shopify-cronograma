-- Corre esto UNA VEZ en el SQL Editor de Neon.
-- Permite las tareas de LOTE (una sola tarea con toda la lista de cambios).

ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS scheduled_tasks_type_check;
ALTER TABLE scheduled_tasks
  ADD CONSTRAINT scheduled_tasks_type_check
  CHECK (type IN ('publish','inventory','price','theme_publish','price_batch','inventory_batch','publish_batch'));
