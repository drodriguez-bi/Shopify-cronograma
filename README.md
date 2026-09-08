# Shopify Scheduler — Next.js / Vercel / Neon

Proyecto **standalone** (separado de tu app de inventario). Publicar productos
en fecha, agregar inventario en fecha, y precio promocional con reversión
automática — con panel para agregar tiendas a mano (sin OAuth) y una forma de
cargar cambios en bloque por CSV, además del panel manual.

## ⚠️ Cron real vía GitHub Actions (tu cuenta de Vercel es Hobby)

Vercel Hobby solo permite cron jobs **una vez al día** — insuficiente para
precios/publicaciones a hora exacta. `vercel.json` deja un cron diario como
respaldo inofensivo, pero el disparo real cada 5 minutos lo hace un
**workflow de GitHub Actions** (`.github/workflows/scheduler-cron.yml`), que
no depende de Vercel para nada.

Configúralo así, una vez que tu repo esté en GitHub:

1. Ve a tu repo → **Settings → Secrets and variables → Actions**.
2. Agrega dos "Repository secrets":
   - `SCHEDULER_URL` → `https://tuapp.vercel.app` (sin slash al final)
   - `SCHEDULER_CRON_SECRET` → el mismo valor que pusiste como `CRON_SECRET`
     en las variables de entorno de Vercel
3. Listo — GitHub va a llamar tu endpoint cada 5 minutos automáticamente.

Puedes probarlo sin esperar: pestaña **Actions** de tu repo → selecciona el
workflow "Scheduler cron (cada 5 min)" → botón **Run workflow**.

Nota realista sobre GitHub Actions cron: no es preciso al segundo (puede
atrasarse varios minutos en horas pico de GitHub), y **se desactiva solo si
el repositorio pasa 60 días sin ningún commit** — si eso pasa, un commit
cualquiera lo reactiva.


## 1. Instalar

```bash
npm install
```

## 2. Base de datos (Neon)

Crea un proyecto en [neon.tech](https://neon.tech) (o usa uno que ya tengas —
las tablas no llevan prefijo, así que si comparte instancia con otra app,
revisa que no existan ya tablas con estos nombres: `stores`,
`products_cache`, `variants_cache`, `scheduled_tasks`).

Corre el esquema:
```bash
psql "$DATABASE_URL" -f sql/schema.sql
```
o pégalo directo en el SQL Editor de Neon.

## 3. Variables de entorno

Copia `.env.example` a `.env.local` para desarrollo local, y configura las
mismas 4 variables en Vercel (Project Settings → Environment Variables):

- `DATABASE_URL`
- `ADMIN_PASSWORD` — contraseña para entrar al panel
- `SESSION_SECRET` — genera con `openssl rand -hex 32`
- `CRON_SECRET` — genera con `openssl rand -hex 32`

## 4. Correr local

```bash
npm run dev
```
Entra a `http://localhost:3000`, inicia sesión con `ADMIN_PASSWORD`.

## 5. Desplegar a Vercel

```bash
npx vercel
```
o conecta el repo desde el dashboard de Vercel. El archivo `vercel.json` ya
trae el cron configurado.

## 6. Agregar tiendas

Ve a **Tiendas** en el panel (`/stores`) y agrega cada una con:
- Clave interna (slug corto, ej. `stanley`)
- Nombre para mostrar
- Dominio `tu-tienda.myshopify.com`
- Access token (Admin API) — el que ya obtienes manualmente para tu app de
  inventario: crea una app personalizada en Shopify Partners o en el admin
  de la tienda, instálala con los permisos `read_products, write_products,
  read_inventory, write_inventory, read_locations`, y copia el token.
- API version (ej. `2024-10`)
- Location ID (opcional, solo si vas a programar inventario — lo sacas de
  Configuración → Ubicaciones en el admin de esa tienda)

No hay flujo de OAuth — pegas el token directo, como ya haces en tu otra app.

## 7. Flujo de uso

1. Selecciona tienda → **Sincronizar productos** (trae catálogo + variantes
   de Shopify a la caché local, necesario para poder buscar por SKU en el CSV
   y para que el panel manual liste algo).
2. **Manual**: marca productos/variantes con checkbox → botón de la acción →
   completa fechas y valores (precio/cantidad individual por variante) →
   Programar.
3. **CSV**: botón "Importar CSV" → pega o sube un archivo con columnas:
   ```
   type,sku,run_at,revert_at,quantity,mode,promo_price,compare_at_price,label
   ```
   - `type`: `publish` | `inventory` | `price`
   - `sku`: debe existir en el catálogo ya sincronizado
   - `run_at`/`revert_at`: ISO con zona horaria, ej. `2026-07-10T15:00:00-06:00`
   - deja vacías las columnas que no apliquen a cada fila
4. Ambos caminos (manual y CSV) terminan en la misma tabla `scheduled_tasks`
   y se ejecutan igual vía el cron — puedes verlas juntas en "Tareas
   programadas", con una columna "Origen" (Manual/CSV) para distinguirlas.

## 8. Probar sin esperar al cron real

```bash
curl -H "Authorization: Bearer TU_CRON_SECRET" https://tuapp.vercel.app/api/scheduler/cron
```

## 9. Diferencias con la versión PHP/Hostinger

- Conexión a Shopify: token manual (sin OAuth), guardado en la tabla `stores`.
- Fechas: `TIMESTAMPTZ` de verdad (con zona horaria), y el frontend convierte
  el valor del `<input type="datetime-local">` a UTC real antes de mandarlo
  — evita el bug de UTC-vs-México que tuvimos con MySQL `DATETIME`.
- Import por CSV como alternativa al panel manual (no existía en la versión PHP).
- Sin la herramienta `diag.php` — si la necesitas, dímelo y hago el
  equivalente como ruta de API.
