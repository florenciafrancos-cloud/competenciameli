/**
 * Tests del cliente de la API de Mercado Libre y del orquestador de scan.
 *
 * La API real no se puede llamar sin las credenciales de Florencia, asi que
 * se levanta un servidor local que imita las respuestas de ML (incluyendo
 * las trampas reales: publicaciones de otra marca con el mismo nombre,
 * anuncios patrocinados repetidos, paginacion).
 *
 * Correr:  npx tsx tests/ml-api.test.mjs
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import pg from "pg";

import { scanBrand, saveTokens, getAccessToken } from "../lib/ml-api";
import { runScan, mlIdFromUrl } from "../lib/scan";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PGURL = process.env.PGURL ?? "postgresql://postgres@localhost:5433/postgres";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    if (process.env.VERBOSE) console.log(err.stack);
  }
}

// ---------------------------------------------------------------
// Servidor que imita la API de Mercado Libre
// ---------------------------------------------------------------

const item = (id, brand, price, over = {}) => ({
  id,
  title: `Producto ${id} ${brand}`,
  permalink: `https://articulo.mercadolibre.com.ar/${id}`,
  price,
  original_price: null,
  currency_id: "ARS",
  seller: { id: 1, nickname: "Termo Style" },
  official_store_id: null,
  attributes: [{ id: "BRAND", name: "Marca", value_name: brand }],
  installments: null,
  ...over,
});

// 60 publicaciones reales de Bubba + basura que hay que filtrar.
const BUBBA_ITEMS = Array.from({ length: 60 }, (_, i) =>
  item(`MLA10000${String(i).padStart(3, "0")}`, "Bubba", 30000 + i * 100)
);
const NOISE = [
  // Mismo nombre, otro rubro: mochilas, libros, gorras, cascos.
  item("MLA9990001", "Bubba Essentials", 15000),
  item("MLA9990002", "Bubba Gump", 8000),
  item("MLA9990003", "GP23", 120000),
  // Sin atributo de marca
  { ...item("MLA9990004", "Bubba", 20000), attributes: [] },
  // Precio invalido
  item("MLA9990005", "Bubba", 0),
];

let requestLog = [];
let failNextBrand = null;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  requestLog.push(url.pathname + url.search);

  // /oauth/token NO usa Bearer: se autentica con client_id/client_secret
  // en el body, igual que la API real.
  if (url.pathname === "/oauth/token") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        access_token: "NUEVO_ACCESS",
        refresh_token: "NUEVO_REFRESH",
        expires_in: 21600,
      })
    );
  }

  // El resto de los endpoints si exigen Bearer, como la API real.
  if (!req.headers.authorization?.startsWith("Bearer ")) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ message: "invalid token" }));
  }

  if (url.pathname.endsWith("/search")) {
    const q = url.searchParams.get("q");
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    if (failNextBrand && q === failNextBrand) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "internal error" }));
    }

    let pool = [];
    if (q === "Bubba") {
      // Intercalamos ruido y repetimos las 3 primeras en cada pagina,
      // imitando los anuncios patrocinados de ML.
      pool = [...BUBBA_ITEMS, ...NOISE];
    } else if (q === "Contigo") {
      pool = Array.from({ length: 12 }, (_, i) =>
        item(`MLA20000${String(i).padStart(3, "0")}`, "Contigo", 20000 + i * 50)
      );
    }

    const page = pool.slice(offset, offset + limit);
    const sponsored = pool.slice(0, 3); // repetidos en toda pagina
    const results = offset > 0 ? [...sponsored, ...page] : page;

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({ paging: { total: pool.length, offset, limit }, results })
    );
  }

  if (url.pathname === "/items") {
    const ids = (url.searchParams.get("ids") ?? "").split(",");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify(
        ids.map((id) => ({ code: 200, body: item(id, "Bubba", 45000) }))
      )
    );
  }

  res.writeHead(404).end("{}");
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

// Redirigimos el cliente al servidor de prueba.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = String(input);
  if (u.startsWith("https://api.mercadolibre.com")) {
    return realFetch(u.replace("https://api.mercadolibre.com", BASE), init);
  }
  return realFetch(input, init);
};

process.env.ML_CLIENT_ID = "test-client";
process.env.ML_CLIENT_SECRET = "test-secret";

// ---------------------------------------------------------------
// Base
// ---------------------------------------------------------------
const client = new pg.Client({ connectionString: PGURL });
await client.connect();
const q = (text, params = []) => client.query(text, params);

await q(`DROP TABLE IF EXISTS price_snapshots, changes, listings, runs, watchlist, ml_tokens CASCADE`);
await q(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));

// ---------------------------------------------------------------
console.log("\n== Tokens ==");

await test("error claro cuando todavia no se autorizo la app", async () => {
  await assert.rejects(() => getAccessToken(q), /Autorizá la app/);
});

await test("usa el access_token guardado si todavia es valido", async () => {
  await saveTokens(q, {
    access_token: "TOKEN_VIGENTE",
    refresh_token: "REFRESH_1",
    expires_at: new Date(Date.now() + 5 * 3600 * 1000),
  });
  const t = await getAccessToken(q);
  assert.equal(t, "TOKEN_VIGENTE");
});

await test("refresca automaticamente si el token esta por vencer", async () => {
  await saveTokens(q, {
    access_token: "TOKEN_VIEJO",
    refresh_token: "REFRESH_1",
    expires_at: new Date(Date.now() + 2 * 60 * 1000), // vence en 2 min
  });
  const t = await getAccessToken(q);
  assert.equal(t, "NUEVO_ACCESS");
});

await test("guarda el refresh_token nuevo (es de un solo uso)", async () => {
  const res = await q(`SELECT refresh_token FROM ml_tokens WHERE id = 1`);
  assert.equal(res.rows[0].refresh_token, "NUEVO_REFRESH");
});

await test("solo puede existir una fila de tokens", async () => {
  await assert.rejects(() =>
    q(`INSERT INTO ml_tokens (id, access_token, refresh_token, expires_at)
       VALUES (2, 'x', 'y', NOW())`)
  );
});

// ---------------------------------------------------------------
console.log("\n== Relevamiento de marca ==");

await test("filtra publicaciones de otro rubro con el mismo nombre", async () => {
  const res = await scanBrand("Bubba", "TOKEN");
  const ids = res.listings.map((l) => l.ml_id);
  assert.ok(!ids.some((id) => id.startsWith("MLA999")), "entro basura");
  assert.equal(res.listings.length, 60);
});

await test("deduplica los anuncios patrocinados repetidos entre paginas", async () => {
  const res = await scanBrand("Bubba", "TOKEN", { pageSize: 10 });
  const ids = res.listings.map((l) => l.ml_id);
  assert.equal(new Set(ids).size, ids.length, "hay ml_id duplicados");
});

await test("reporta cuantas publicaciones descarto", async () => {
  const res = await scanBrand("Bubba", "TOKEN");
  assert.ok(res.filtered_out > 0);
});

await test("avisa cuando la marca no existe en vez de fallar en silencio", async () => {
  const res = await scanBrand("MarcaInexistente", "TOKEN");
  assert.equal(res.listings.length, 0);
  assert.ok(res.warnings.some((w) => /No se encontro/.test(w)));
});

await test("calcula el descuento a partir del precio de lista", async () => {
  BUBBA_ITEMS[0].original_price = 50000;
  BUBBA_ITEMS[0].price = 40000;
  const res = await scanBrand("Bubba", "TOKEN");
  const l = res.listings.find((x) => x.ml_id === BUBBA_ITEMS[0].id);
  assert.equal(l.list_price, 50000);
  assert.equal(l.price, 40000);
  assert.equal(l.discount_pct, 20);
  BUBBA_ITEMS[0].original_price = null;
  BUBBA_ITEMS[0].price = 30000;
});

await test("detecta las cuotas cuando ML las informa", async () => {
  BUBBA_ITEMS[1].installments = { quantity: 6, amount: 5000, rate: 0 };
  const res = await scanBrand("Bubba", "TOKEN");
  const l = res.listings.find((x) => x.ml_id === BUBBA_ITEMS[1].id);
  assert.equal(l.has_installments, true);
  assert.match(l.installments_text, /6 cuotas/);
  BUBBA_ITEMS[1].installments = null;
});

await test("respeta el tope de 1000 posiciones de la API", async () => {
  const res = await scanBrand("Bubba", "TOKEN", { pageSize: 50, maxPages: 40 });
  const offsets = requestLog
    .filter((u) => u.includes("q=Bubba"))
    .map((u) => Number(new URL(u, "http://x").searchParams.get("offset")));
  assert.ok(Math.max(...offsets) < 1000);
});

// ---------------------------------------------------------------
console.log("\n== Orquestador (runScan) ==");

await test("extrae el ID de publicacion de una URL de ML", () => {
  assert.equal(
    mlIdFromUrl("https://articulo.mercadolibre.com.ar/MLA-1234567890-termo-bubba"),
    "MLA1234567890"
  );
  assert.equal(
    mlIdFromUrl("https://www.mercadolibre.com.ar/p/MLA987654321"),
    "MLA987654321"
  );
  assert.equal(mlIdFromUrl("https://ejemplo.com/nada"), null);
});

await test("primera corrida: releva el watchlist y carga todo", async () => {
  await saveTokens(q, {
    access_token: "TOKEN_OK",
    refresh_token: "R",
    expires_at: new Date(Date.now() + 5 * 3600 * 1000),
  });
  const report = await runScan(q, { runId: "scan-1" });
  assert.equal(report.error, undefined);
  assert.deepEqual(report.brands_scanned.sort(), ["Bubba", "Contigo"]);
  assert.equal(report.ingest.first_run, true);
  assert.equal(report.ingest.listings_valid, 72); // 60 Bubba + 12 Contigo
});

await test("segunda corrida sin cambios reales no genera alertas", async () => {
  const report = await runScan(q, { runId: "scan-2" });
  assert.equal(report.ingest.changes_found, 0);
});

await test("detecta una baja de precio de la competencia", async () => {
  BUBBA_ITEMS[5].price = 20000; // bajo el precio
  const report = await runScan(q, { runId: "scan-3" });
  assert.equal(report.ingest.changes_by_type.price_down, 1);
});

await test("CRITICO: si falla una marca, NO marca sus publicaciones de baja", async () => {
  failNextBrand = "Bubba";
  const report = await runScan(q, { runId: "scan-4" });
  failNextBrand = null;

  // Bubba fallo -> no debe estar en brands_scanned ni generar bajas
  assert.ok(!report.brands_scanned.includes("Bubba"));
  assert.equal(report.ingest.changes_by_type.delisted, undefined);
  assert.ok(report.warnings.some((w) => /Bubba/.test(w)));

  // Y las publicaciones de Bubba siguen activas
  const res = await q(
    `SELECT COUNT(*)::int AS n FROM listings WHERE brand = 'Bubba' AND status = 'active'`
  );
  assert.equal(res.rows[0].n, 60);
});

await test("si no se obtiene NADA, no toca la base", async () => {
  const before = await q(`SELECT COUNT(*)::int AS n FROM listings WHERE status = 'active'`);
  failNextBrand = "Bubba";
  await q(`UPDATE watchlist SET active = FALSE WHERE value = 'Contigo'`);
  const report = await runScan(q, { runId: "scan-5" });
  failNextBrand = null;
  await q(`UPDATE watchlist SET active = TRUE WHERE value = 'Contigo'`);

  assert.ok(report.error, "deberia reportar error");
  assert.equal(report.ingest, null);
  const after = await q(`SELECT COUNT(*)::int AS n FROM listings WHERE status = 'active'`);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

await test("una baja real SI se detecta", async () => {
  const removed = BUBBA_ITEMS.pop();
  const report = await runScan(q, { runId: "scan-6" });
  assert.equal(report.ingest.changes_by_type.delisted, 1);
  const res = await q(`SELECT status FROM listings WHERE ml_id = $1`, [removed.id]);
  assert.equal(res.rows[0].status, "delisted");
  BUBBA_ITEMS.push(removed);
});

await test("una publicacion nueva de la competencia se detecta", async () => {
  BUBBA_ITEMS.push(item("MLA10000999", "Bubba", 99000));
  const report = await runScan(q, { runId: "scan-7" });
  assert.equal(report.ingest.changes_by_type.new_listing, 1);
  assert.equal(report.ingest.changes_by_type.relisted, 1); // la que volvimos a poner
});

await test("agregar una marca nueva al watchlist la incluye en la proxima corrida", async () => {
  await q(
    `INSERT INTO watchlist (kind, value, label) VALUES ('brand', 'Stanley', 'Stanley')
     ON CONFLICT (kind, value) DO UPDATE SET active = TRUE`
  );
  const report = await runScan(q, { runId: "scan-8" });
  // Stanley no tiene resultados en el mock: debe avisar, no romper.
  assert.ok(report.warnings.some((w) => /Stanley/.test(w)));
  // Y no debe afectar lo que ya venia siguiendo.
  const res = await q(
    `SELECT COUNT(*)::int AS n FROM listings WHERE brand = 'Bubba' AND status = 'active'`
  );
  assert.ok(res.rows[0].n >= 60);
  await q(`UPDATE watchlist SET active = FALSE WHERE value = 'Stanley'`);
});

await test("el historial de precios se acumula corrida a corrida", async () => {
  const res = await q(
    `SELECT COUNT(DISTINCT run_id)::int AS n FROM price_snapshots WHERE ml_id = $1`,
    [BUBBA_ITEMS[0].id]
  );
  assert.ok(res.rows[0].n >= 5, `solo ${res.rows[0].n} corridas`);
});

// ---------------------------------------------------------------
console.log(`\n${passed} pasaron, ${failed} fallaron\n`);
globalThis.fetch = realFetch;
await client.end();
server.close();
process.exit(failed > 0 ? 1 : 0);
