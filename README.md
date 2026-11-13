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

## 6. Agregar tiendas (OAuth, igual que tu app de inventario)

Primero, en **Shopify Partners**, crea (o abre) la app para cada tienda y anota
su **Client ID** y **Client Secret**. Agrega esta URL a sus "Allowed
redirection URL(s)" (el panel de "Tiendas" te la muestra exacta, calculada
según tu dominio real de Vercel):

```
https://tuapp.vercel.app/api/scheduler/oauth/callback
```

Luego, en el panel → **Tiendas** → llena:
- Clave interna (slug, ej. `stanley`)
- Nombre para mostrar
- Dominio `.myshopify.com`
- Client ID / Client Secret (de Shopify Partners)
- API version, Location ID (opcional)

Guarda, y dale clic a **"Conectar"** en esa misma tienda — te manda al admin
de Shopify a aprobar los permisos, y regresa automáticamente con el token
guardado. Si el token vence, el panel te lo marca en amarillo/rojo y solo
repites el mismo botón (ahora dice "Reconectar").

No hay que pegar ningún access token a mano — eso es justo lo que resuelve el
flujo OAuth.

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

- Conexión a Shopify: OAuth real (Client ID/Secret guardados en la tabla
  `stores`, igual que tu app de inventario), no un token pegado a mano.
- Fechas: `TIMESTAMPTZ` de verdad (con zona horaria), y el frontend convierte
  el valor del `<input type="datetime-local">` a UTC real antes de mandarlo
  — evita el bug de UTC-vs-México que tuvimos con MySQL `DATETIME`.
- Import por CSV como alternativa al panel manual (no existía en la versión PHP).
- Sin la herramienta `diag.php` — si la necesitas, dímelo y hago el
  equivalente como ruta de API.


## 10. Publicar tema en fecha

Tarjeta "Publicar tema" en el panel (aparece al elegir tienda): eliges una copia
del tema (cualquiera que no sea el publicado), fecha y hora, y a esa hora el cron
lo publica. No hay regreso automático: el tema nuevo se queda como principal.

Para activarlo:
1. Corre `sql/migration_themes.sql` en Neon (permite el tipo `theme_publish` y
   hace `product_id` opcional).
2. En Shopify Partners, agrega los scopes `read_themes` y `write_themes` a la app
   (el código ya los pide en `oauth/install`).
3. En el panel, dale **Reconectar** a cada tienda para que tome los scopes nuevos.
4. La tienda debe usar una API version reciente (2024-10 o mayor) porque se usa
   GraphQL (`themes`, `themePublish`).


## 11. Importar por CSV (el archivo decide qué se programa)

Requisitos (una sola vez):
1. Corre `sql/migration_handle.sql` en Neon (agrega la columna `handle`).
2. En el panel, **Sincroniza productos** otra vez en cada tienda (así se llena el handle).

Flujo en el panel → **Importar CSV**:
1. Sube el archivo tal cual (o pega su contenido). El sistema decide la acción por sus columnas:
   - trae `Variant Price` (o `promo_price`) → **cambio de precios**
   - trae `quantity` (o `Variant Inventory Qty`) → **cambio de inventario**
   - solo trae la lista de productos (`Handle`) → **publicar**
   (Si un archivo trae precios y cantidades a la vez, gana precios; puedes forzar la acción en el selector.)
2. Elige las fechas aquí mismo (inicio y fin si es precio; una fecha en los demás casos; modo sumar/fijar en inventario).
3. **Revisar** muestra cuántas tareas se crearían, ejemplos y errores, sin crear nada. Después **Programar**.

Precio: al iniciar, el precio pasa a `Variant Price` y `Variant Compare At Price` queda como tachado
(si va vacío o en 0, se usa el precio actual de la variante como tachado). Al terminar, el precio de
comparación pasa a ser el precio real y el tachado se quita (sin precio de comparación). Las filas sin
precio se omiten, así que sirven tal cual los CSV exportados de Shopify con sus filas de imágenes extra.

Cómo se identifica cada variante (sin IDs): `Handle` + las columnas `Option1 Value`, `Option2 Value`,
`Option3 Value` (como el export de Shopify), o una columna `variant` con el texto tal como se ve en Shopify
(ej. `Latte / 23`; `*` = todas las variantes). También sirve `sku`.

Columnas opcionales por fila (mandan sobre el panel): `type`, `run_at`, `revert_at`, `mode`, `location_id`, `label`.
Fechas en CSV: `2026-12-01 09:00` (hora de México, UTC-06:00; cámbialo con `SCHEDULER_TZ_OFFSET`),
`2026-12-01T09:00:00-06:00` o `01/12/2026 09:00`.

Las plantillas del panel (precios / inventario / publicar) bajan tu catálogo ya listado. Acepta archivos de Excel
o Google Sheets (BOM, separador `;`, apóstrofo en tallas como `'23`). Un CSV muy grande puede tardar; si da
timeout, divídelo en partes.
