# Monitor de competencia — Mercado Libre

Pegás los links de las publicaciones de la competencia que te importan.
Una vez por día la app las revisa una por una y te avisa por mail si algo
cambió.

Detecta, para cada producto que sigas:

- **Precio** — el mejor precio del producto, con monto y porcentaje del cambio
- **Vendedor ganador** — cuando otro vendedor pasa a tener el mejor precio
- **Competencia** — cuando entra o sale un vendedor de ese producto
- **Bajas** — cuando el producto se queda sin ofertas activas
- **Cuotas y stock** — cuando el dato está disponible (ver más abajo)

Y guarda el historial de precios, para ver la evolución.

---

## Lo que se puede y lo que no

Esto importa entenderlo, porque define la forma de la herramienta.

**Mercado Libre cerró la búsqueda pública de su API** para aplicaciones no
certificadas, **y también el detalle de publicaciones de otros vendedores.**
Verificado el 28/08/2026 contra la API real, con un token válido:

| Endpoint | Resultado |
|---|---|
| `/sites/MLA/search?q=...` (buscar por marca) | **403** `forbidden` |
| `/sites/MLA/search?seller_id=...` | **403** `forbidden` |
| `/highlights/MLA/category/...` | **403** `forbidden` |
| `/items/{id de otro vendedor}` | **403** `access_denied` |
| `/items?ids={id de otro vendedor}` | 200 en el sobre, **`code: 403`** adentro |
| `/items/{id propio}` | 200 OK |
| `/products/{catalog_id}` | **200 OK** |
| `/products/{catalog_id}/items` | **200 OK** — todas las ofertas que compiten |
| `/products/search` | 200 OK |

Tampoco sirve leer las páginas de Mercado Libre directamente: bloquea la
navegación automatizada — las páginas de resultados devuelven el cascarón sin
las publicaciones, y redirigen a una pantalla de verificación anti-bots.

**Consecuencia, y es la que define la herramienta:** no se puede seguir la
publicación de un vendedor puntual, pero **sí se puede seguir la ficha de
catálogo del producto**. Y eso resulta mejor: `/products/{id}/items` devuelve
*todas* las ofertas que compiten por ese producto, cada una con su vendedor y
su precio. De ahí sale el mejor precio del mercado, quién lo tiene, y cuántos
están peleándolo.

> Una advertencia sobre cómo verificar esto. Probar `/items/MLA1` (un ID
> inventado) devuelve 404 y parece indicar que el endpoint está disponible.
> No lo indica: con un ID **real de otro vendedor** devuelve 403. Un 404 sobre
> algo que no existe no dice nada sobre el permiso para leer algo que sí
> existe. `/api/ml/diag` acepta `?item=` y `?product=` justamente para
> probar con IDs reales.

### Detalles de la respuesta real de catálogo

- `buy_box_winner` puede venir en **null**: el ganador se calcula como la
  oferta más barata de la lista.
- `permalink` viene **vacío**: se conserva el link que pegó el usuario.
- La lista de ofertas **no trae stock ni precio de lista**.
- Las **cuotas no se pueden leer** en fichas de catálogo, porque requieren el
  detalle de la publicación ganadora, que es de otro vendedor y está
  bloqueado. La app lo deja en "desconocido" y lo avisa, en vez de inventar
  un "no ofrece cuotas".

---

## Puesta en marcha

### 1. Subir el código a GitHub y conectarlo a Vercel

Si trabajás con Git:

```bash
git init
git add .
git commit -m "Monitor de competencia Mercado Libre"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

También se puede subir arrastrando los archivos en github.com
(**Add file → Upload files**). En ese caso arrastrá **el contenido** de esta
carpeta, no la carpeta: si queda anidada, Vercel no reconoce el proyecto.

En Vercel: **Add New → Project → Import** ese repo. Verificá que el
**Framework Preset** diga **Next.js**.

### 2. Crear la base de datos

En el proyecto de Vercel: **Storage → Create Database → Postgres (Neon)**.
Dejá **Auth apagado** (no se usa). Al vincularla al proyecto, Vercel carga la
variable de conexión sola.

### 3. Registrar la aplicación en Mercado Libre

1. Entrá a <https://developers.mercadolibre.com.ar/devcenter> con tu cuenta y
   creá una aplicación.
2. **Redirect URI**, exactamente así y sin barra al final:
   `https://TU-PROYECTO.vercel.app/api/ml/callback`
3. **Scopes**: marcá **`read`** y **`offline_access`**.

   > `offline_access` es obligatorio. Es el scope que hace que Mercado Libre
   > entregue un `refresh_token`; sin él el permiso dura 6 horas y el sistema
   > no puede renovarse solo.

4. Guardá y copiá el **App ID** (`client_id`) y el **Secret Key**
   (`client_secret`).

### 4. Cargar las variables de entorno en Vercel

**Settings → Environment Variables**. Obligatorias:

| Variable | Qué es |
|---|---|
| `ML_CLIENT_ID` | El App ID del paso 3 |
| `ML_CLIENT_SECRET` | El Secret Key del paso 3 |
| `INGEST_SECRET` | Una clave larga al azar. Sirve para el diagnóstico y para correr el control a mano |
| `CRON_SECRET` | Otra clave larga al azar. La usa el cron de Vercel |
| `DASHBOARD_PASSWORD` | La contraseña para entrar al tablero |
| `NEXT_PUBLIC_APP_URL` | `https://TU-PROYECTO.vercel.app` (tipo **Config**, no Secret) |

Opcionales, para los mails de alerta. Sin esto todo funciona igual, solo que
los cambios se ven únicamente en el tablero:

| Variable | Qué es |
|---|---|
| `RESEND_API_KEY` | API key gratuita de <https://resend.com> |
| `ALERT_EMAIL_TO` | Tu mail. Varios separados por coma |
| `ALERT_EMAIL_FROM` | `onboarding@resend.dev` sirve para arrancar |

Para generar las claves: `openssl rand -hex 32`.

Después de cargarlas, **Deployments → Redeploy**. Las variables nuevas no
entran en un deploy ya hecho.

### 5. Crear las tablas

Entrá a `https://TU-PROYECTO.vercel.app` con tu contraseña. La primera vez el
tablero avisa que faltan las tablas y muestra un botón **Crear las tablas**.
Se puede repetir sin riesgo.

> Por línea de comandos, si preferís:
> ```bash
> curl -X POST https://TU-PROYECTO.vercel.app/api/setup \
>   -H "Authorization: Bearer TU_INGEST_SECRET"
> ```
> En PowerShell usá `curl.exe`, no `curl` (que ahí es otro comando).
>
> `GET /api/setup` dice qué tablas existen, sin crear nada.

### 6. Autorizar Mercado Libre

Abrí `https://TU-PROYECTO.vercel.app/api/ml/auth` y aceptá el permiso. Los
tokens quedan guardados y el sistema los renueva solo.

### 7. Cargar la primera publicación

En el tablero, pegá el link de una publicación de la competencia y
**Agregar**. Se verifica al instante contra Mercado Libre, así sabés en el
momento si el link está bien, y queda guardada la foto inicial de precio.

Al día siguiente (o apretando **Controlar ahora**) ya compara y avisa.

---

## Cómo agregar o quitar publicaciones

Pestaña **Qué se monitorea**:

- **Agregar**: pegás el link y listo.

**Pegá la URL completa**, tal como sale de la barra de direcciones del
navegador: buscás el producto en Mercado Libre, entrás al resultado, copiás.
Lo que viene después del `?` no es basura — sirve para identificar exactamente
qué producto y qué variante estás mirando.

| Forma de URL | Cómo se resuelve |
|---|---|
| `.../p/MLA67012657` | Ficha de catálogo, directo ✅ |
| `.../up/MLAU…?product_trigger_id=MLA749…` | Ficha de catálogo, vía el `product_trigger_id` ✅ |
| `.../up/MLAU…?pdp_filters=item_id:MLA351…` | Se busca el producto por el nombre de la URL, y el `item_id` elige la variante exacta ✅ |
| `.../up/MLAU…` pelado | Se busca por el nombre; si hay varias variantes parecidas, la app te muestra las opciones para que elijas |
| `articulo.mercadolibre.com.ar/MLA-123…` | ML la bloquea; se intenta resolver como ficha de catálogo |

Dos cosas que importan de esta lista:

**Los resultados de búsqueda de ML hoy llevan a `/up/`, no a `/p/`.** Las
primeras versiones de este README decían "buscá y hacé click para obtener un
link `/p/`" — está mal, y por eso los `/up/` son el caso principal, no la
excepción.

**El `item_id` de `pdp_filters` es el desambiguador preciso.** No se puede leer
esa publicación (403), pero el producto de catálogo correcto es el único cuya
lista de ofertas la contiene. Sin ese dato, entre "Autoseal Negro" y "Autoseal
Blanco" habría que preguntar; con él se resuelve solo y sin riesgo de seguir el
producto equivocado.

El `?wid=MLA…` se ignora a propósito: apunta a una publicación bloqueada.

- **Dejar de seguir**: un click. No se borra el historial: si la volvés a
  agregar, la serie de precios sigue estando.

Cada ficha de catálogo son dos pedidos a la API (el producto y sus ofertas),
así que seguir 50 productos son 100 pedidos por control: cómodo dentro de los
límites.

---

## Cuándo corre

Todos los días a las **9:00 de Argentina** (`vercel.json`, en UTC:
`0 12 * * *`).

Para cambiar el horario, editá `vercel.json` y volvé a deployar. El plan
gratuito de Vercel permite **un cron por día**; para más seguido hace falta
el plan Pro.

A mano, sin esperar: el botón **Controlar ahora** del tablero, o

```bash
curl -X POST https://TU-PROYECTO.vercel.app/api/cron/scan \
  -H "Authorization: Bearer TU_INGEST_SECRET"
```

---

## Si algo no funciona

`GET /api/ml/diag` prueba, uno por uno, los endpoints de Mercado Libre que
este proyecto podría usar, y reporta cuál responde y cuál da 403. Se puede
pasar `?item=MLA123...` con una publicación real para probar los endpoints de
detalle.

Es la herramienta para distinguir "está mal configurado" de "Mercado Libre
cambió las reglas otra vez". Esa distinción costó una tarde entera de
diagnóstico, así que quedó automatizada.

---

## Trabajar en el código localmente

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # verifica que compila antes de subir
```

Para local necesitás las variables en `.env.local` (copiá `.env.example`; la
cadena de conexión la saca de Vercel → Storage → tu base → `.env.local`).

### Tests

Hay **123 tests**. Necesitan un Postgres local:

```bash
npm test
```

Por defecto apunta a `postgresql://postgres@localhost:5433/postgres`;
se cambia con la variable `PGURL`.

Los tests no son decorativos: cubren específicamente las formas en que este
sistema puede mentirle al usuario, que es el único error grave que puede
cometer una herramienta de monitoreo.

- **Si la API falla, no se marca nada de baja.** Un error de red de un día no
  debe generar un mail avisando que la competencia dio de baja 20
  publicaciones que siguen ahí. Se verifica en tres niveles: el multiget que
  falla, el orquestador, y la ingesta.
- **Si no se pueden leer las cuotas, quedan en "desconocido", no en "no".**
  Un `false` inventado dispararía una alerta falsa de "dejó de ofrecer
  cuotas".
- **Una baja real sí se detecta**, y también la reaparición.
- `tests/setup.test.mjs` ejecuta el `schema.sql` **sentencia por sentencia**,
  que es como lo corre el driver de Neon. Está separado a propósito: la
  primera versión de `/api/setup` tenía un bug que descartaba en silencio
  todos los `CREATE TABLE`, y no se detectó porque los otros tests ejecutan
  el schema completo de una sola vez.
- `tests/ml-api.test.mjs` levanta un servidor que imita a Mercado Libre
  **incluyendo sus 403 reales**, así el código se prueba contra el
  comportamiento verificado de la API y no contra su documentación, que está
  desactualizada.

---

## Qué hay en cada archivo

```
app/
  page.tsx                  El tablero
  login/page.tsx            Pantalla de contraseña
  api/
    cron/scan/              El control diario (lo llama el cron de Vercel)
    scan-now/               Control a demanda (botón del tablero)
    watchlist/              Alta y baja de links; verifica contra ML al agregar
    ml/auth, ml/callback    Autorización con Mercado Libre (una sola vez)
    ml/diag                 Diagnóstico de qué endpoints responden
    ingest/                 Recibe un relevamiento externo (por si algún día
                            los datos vienen de otra fuente)
    setup/                  Crea las tablas
    listings, changes,      Datos para el tablero
    history, stats
lib/
  ml-api.ts                 Cliente de ML: tokens, /items, cuotas, links → ID
  scan.ts                   Orquesta el control: lee la lista y consulta ML
  ingest-core.ts            Guarda todo y detecta cambios (el SQL testeado)
  diff.ts                   Las reglas de qué cuenta como cambio
  notify.ts                 El mail de alerta
  sql-split.ts              Parte el schema.sql en sentencias
  db.ts                     Conexión a Postgres
  auth.ts                   Sesión del tablero
db/schema.sql               Las tablas y las migraciones
tests/                      123 tests
vercel.json                 El horario del cron
```

---

## Cosas que conviene saber

**El permiso de Mercado Libre vence a los 6 meses de inactividad.** Mientras
el control corra todos los días se renueva solo. Si estuviera parado más de 6
meses, hay que entrar una vez más a `/api/ml/auth`; el error lo dice
explícitamente y queda registrado en el tablero.

**Los precios son los de la publicación**, sin promociones bancarias. Las
cuotas se registran aparte, porque cambian bastante la comparación real: en el
relevamiento de agosto, el 58% de las publicaciones de Bubba mostraba cuotas.

**Si un día el control no corre, no se pierde nada** — el próximo compara
contra la última foto que tenga. Lo único que se pierde es el detalle de qué
pasó exactamente en el medio.

**Si el vendedor edita la publicación al punto de reemplazar el producto**, la
app lo ve como un cambio de precio de la misma publicación, porque para
Mercado Libre sigue siendo el mismo ID. Vale revisar de tanto en tanto que lo
que seguís siga siendo lo que creés.
