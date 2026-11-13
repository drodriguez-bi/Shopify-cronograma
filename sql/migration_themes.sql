-- Corre esto UNA VEZ en el SQL Editor de Neon (si ya tienes la base creada).
-- Permite el tipo 'theme_publish' y que product_id sea opcional (una tarea de
-- tema no apunta a un producto; el tema va en payload: {"theme_id","theme_name"}).

ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS scheduled_tasks_type_check;
ALTER TABLE scheduled_tasks
  ADD CONSTRAINT scheduled_tasks_type_check
  CHECK (type IN ('publish','inventory','price','theme_publish'));

ALTER TABLE scheduled_tasks ALTER COLUMN product_id DROP NOT NULL;
