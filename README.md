# Monitor de competencia — Mercado Libre

Sigue los precios y los cambios de las publicaciones de la competencia en
Mercado Libre. Una vez por día se despierta solo, consulta Mercado Libre,
compara contra lo que vio la última vez y te manda un mail si algo cambió.

Detecta: **cambios de precio**, **publicaciones nuevas**, **publicaciones dadas
de baja**, **cambios de vendedor** y **aparición o desaparición de cuotas**.

---

## Por qué usa la API oficial y no scraping

La primera versión de este proyecto iba a leer las páginas de Mercado Libre
directamente. No funciona: ML bloquea la navegación automatizada — las páginas
de resultados devuelven el cascarón sin las publicaciones, y en algunos casos
redirigen a una pantalla de verificación anti-bots.

La API oficial (gratuita) resuelve esto mejor en todo sentido: no depende de
ninguna computadora prendida, no hay riesgo de bloqueo, corre sola en Vercel, y
es el camino que Mercado Libre habilita para esto. El costo es un trámite de
10 minutos, una sola vez: registrar una aplicación y autorizarla. Está abajo.

---

## Puesta en marcha

Son cinco pasos. El único que lleva algo de tiempo es el 3.

### 1. Subir el código a GitHub y conectarlo a Vercel

Desde esta carpeta:

```bash
git init
git add .
git commit -m "Monitor de competencia Mercado Libre"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

En Vercel: **Add New → Project → Import** ese repo. Framework: Next.js
(lo detecta solo). No hace falta cambiar nada más todavía.

### 2. Crear la base de datos

En el proyecto de Vercel: **Storage → Create Database → Postgres (Neon)**.
Al vincularla al proyecto, Vercel carga la variable de conexión sola.

### 3. Registrar la aplicación en Mercado Libre

1. Entrá a <https://developers.mercadolibre.com.ar/devcenter> con tu cuenta de
   Mercado Libre y creá una aplicación (**Crear nueva aplicación**).
2. En **Redirect URI** poné exactamente:
   `https://TU-PROYECTO.vercel.app/api/ml/callback`
3. En **Scopes** marcá **`read`** y **`offline_access`**.

   > `offline_access` es obligatorio. Es el scope que hace que Mercado Libre
   > entregue un `refresh_token`; sin él el permiso dura 6 horas y el sistema
   > no puede renovarse solo.
4. Guardá y copiá el **App ID** (es el `client_id`) y el **Secret Key**
   (el `client_secret`).

> El `client_secret` es una credencial: va en las variables de entorno de
> Vercel, no en el código ni en el repo.

### 4. Cargar las variables de entorno en Vercel

**Settings → Environment Variables**. Las obligatorias:

| Variable | Qué es |
|---|---|
| `ML_CLIENT_ID` | El App ID del paso 3 |
| `ML_CLIENT_SECRET` | El Secret Key del paso 3 |
| `INGEST_SECRET` | Una clave larga inventada por vos. Sirve para crear las tablas y para correr el relevamiento a mano |
| `CRON_SECRET` | Otra clave larga inventada. Es la que usa el cron de Vercel |
| `DASHBOARD_PASSWORD` | La contraseña para entrar al tablero |
| `NEXT_PUBLIC_APP_URL` | `https://TU-PROYECTO.vercel.app` |

Opcionales, para los mails de alerta (sin esto todo funciona igual, solo que
no manda mails y los cambios se ven únicamente en el tablero):

| Variable | Qué es |
|---|---|
| `RESEND_API_KEY` | API key gratuita de <https://resend.com> |
| `ALERT_EMAIL_TO` | Tu mail. Se pueden poner varios separados por coma |
| `ALERT_EMAIL_FROM` | `onboarding@resend.dev` sirve para arrancar |

Para generar las claves, en una terminal: `openssl rand -hex 32`.

Después de cargarlas, **Deployments → Redeploy** (las variables nuevas no
entran en un deploy ya hecho).

### 5. Crear las tablas y autorizar

Entrá a `https://TU-PROYECTO.vercel.app` y poné tu contraseña. La primera vez
el tablero avisa que faltan las tablas y muestra un botón **Crear las tablas** —
apretalo. Se puede repetir sin riesgo.

> También se puede por línea de comandos, si preferís:
> ```bash
> curl -X POST https://TU-PROYECTO.vercel.app/api/setup \
>   -H "Authorization: Bearer TU_INGEST_SECRET"
> ```
> En PowerShell usá `curl.exe`, no `curl` (que ahí es otro comando).
>
> Y `GET /api/setup` dice qué tablas existen, sin crear nada.

Autorizar la app: abrí en el navegador
`https://TU-PROYECTO.vercel.app/api/ml/auth`, aceptá el permiso, y listo.
Los tokens quedan guardados y el sistema los renueva solo.

Volvé al tablero y apretá **Relevar ahora** para cargar la primera foto.

> La primera corrida no manda mail a propósito: son cientos de publicaciones
> y todas contarían como "nuevas". A partir de la segunda, solo avisa lo que
> cambió de verdad.

---

## Cómo agregar marcas o competidores nuevos

En el tablero, pestaña **Qué se monitorea** → escribís la marca → **Agregar**.
Eso es todo: la corrida del día siguiente ya la incluye, no hay que tocar
código, y el historial de lo que venías siguiendo no se pierde.

Se puede seguir por:

- **Marca** — todas las publicaciones de esa marca, de cualquier vendedor.
- **Vendedor / tienda** — todo lo que publica un competidor puntual.
- **URL** — una publicación específica que querés vigilar de cerca.

Un detalle sobre el filtro de marca: busca por la marca **declarada** en la
publicación, no por el texto del título. Eso es lo que evita que "Bubba" traiga
mochilas, libros infantiles, gorras de Bubba Gump y cascos de moto, que fue
exactamente el problema del relevamiento manual de agosto.

---

## Cuándo corre

Todos los días a las **9:00 de Argentina** (`vercel.json`, en UTC: `0 12 * * *`).

Para cambiar el horario, editá `vercel.json` y volvé a deployar. Tené en cuenta
que el plan gratuito de Vercel permite **un cron por día**; si querés que corra
más seguido hace falta el plan Pro.

Correrlo a mano, sin esperar al cron:

```bash
curl -X POST https://TU-PROYECTO.vercel.app/api/cron/scan \
  -H "Authorization: Bearer TU_INGEST_SECRET"
```

O directamente el botón **Relevar ahora** del tablero.

---

## Trabajar en el código localmente

```bash
npm install
```

Para levantarlo local necesitás las variables en un archivo `.env.local`
(copiá `.env.example` y completalo; la cadena de conexión de la base la saca de
Vercel → Storage → tu base → `.env.local`).

```bash
npm run dev          # http://localhost:3000
npm run build        # verifica que compila antes de subir
```

### Tests

Hay 72 tests. Necesitan un Postgres local:

```bash
npm test
```

Por defecto apunta a `postgresql://postgres@localhost:5433/postgres`; se puede
cambiar con la variable `PGURL`.

Los tests cubren, entre otras cosas, el error más caro que puede tener este
sistema: **si el relevamiento de una marca falla, sus publicaciones NO se
marcan como dadas de baja**. Sin esa protección, un error de red de un día
generaría un mail avisando que la competencia dio de baja 200 publicaciones que
en realidad siguen ahí.

`tests/setup.test.mjs` ejecuta el `schema.sql` **sentencia por sentencia**, que
es como lo corre el driver de Neon en producción. Está separado a propósito: la
primera versión de `/api/setup` tenía un bug que descartaba en silencio todos
los `CREATE TABLE` (los que venían precedidos por un comentario), y no se
detectó porque los otros tests ejecutan el schema completo de una sola vez con
el cliente `pg`, sin pasar por esa lógica.

---

## Qué hay en cada archivo

```
app/
  page.tsx                  El tablero
  login/page.tsx            Pantalla de contraseña
  api/
    cron/scan/              El relevamiento diario (lo llama el cron)
    scan-now/               Relevamiento a demanda (botón del tablero)
    ml/auth, ml/callback    Autorización con Mercado Libre (una sola vez)
    ingest/                 Recibe un relevamiento externo, por si algún día
                            querés cargar datos desde otra fuente
    setup/                  Crea las tablas
    listings, changes,      Datos para el tablero
    history, stats,
    watchlist
lib/
  ml-api.ts                 Cliente de la API de ML: tokens, búsquedas
  scan.ts                   Orquesta la corrida: lee el watchlist y releva
  ingest-core.ts            Guarda todo y detecta cambios (SQL testeado)
  diff.ts                   Las reglas de qué cuenta como cambio
  notify.ts                 El mail de alerta
  db.ts                     Conexión a Postgres
  sql-split.ts              Parte el schema.sql en sentencias
  auth.ts                   Sesión del tablero
db/schema.sql               Las tablas
tests/                      72 tests
vercel.json                 El horario del cron
```

---

## Cosas que conviene saber

**El permiso de Mercado Libre vence a los 6 meses de inactividad.** Mientras el
cron corra todos los días se renueva solo y no hay que hacer nada. Si por algún
motivo estuviera parado más de 6 meses, hay que volver a entrar una vez a
`/api/ml/auth`. Si eso pasa, el relevamiento falla con un mensaje que lo dice
explícitamente y queda registrado en el tablero.

**La API devuelve como máximo 1000 posiciones por búsqueda.** Para marcas con
catálogos enormes, si el tablero avisa que se llegó a ese tope, conviene
dividir el seguimiento por vendedor en lugar de por marca.

**Los precios que ves son los de la publicación, sin cuotas ni promociones
bancarias.** El sistema registra aparte si la publicación ofrece cuotas, porque
en el relevamiento de agosto el 58% de las publicaciones de Bubba las mostraba
y eso cambia bastante la comparación real de precios.

**Si un día el cron no corre, no se pierde nada** — la próxima corrida compara
contra la última foto que tenga. Lo único que se pierde es el detalle de qué
pasó exactamente en el medio.
