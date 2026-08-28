/**
 * Test end-to-end de la ingesta contra un Postgres real.
 *
 * Usa el MISMO SQL que corre en produccion (lib/ingest-core.ts), solo
 * cambia el driver: aca `pg` contra un Postgres local, en produccion
 * el driver de Neon.
 *
 * Correr:  npx tsx tests/ingest.test.mjs
 *          (o con PGURL apuntando a otra base)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import pg from "pg";

import { runIngest, normalizeListings, validatePayload, IngestError } from "../lib/ingest-core";
import { detectChanges } from "../lib/diff";

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

const client = new pg.Client({ connectionString: PGURL });
await client.connect();

const q = (text, params = []) => client.query(text, params);

// ---------------------------------------------------------------
// Setup: schema limpio
// ---------------------------------------------------------------
console.log("\n== Setup ==");
await q(`DROP TABLE IF EXISTS price_snapshots, changes, listings, runs, watchlist CASCADE`);
const schema = readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8");
await q(schema);
console.log("  ok  schema.sql se ejecuta sin errores");
passed++;

const wl = await q(`SELECT value FROM watchlist ORDER BY value`);
assert.deepEqual(wl.rows.map((r) => r.value), ["Bubba", "Contigo"]);
console.log("  ok  watchlist inicial cargada (Bubba, Contigo)");
passed++;

// ---------------------------------------------------------------
// Logica pura: normalizacion
// ---------------------------------------------------------------
console.log("\n== Normalizacion del payload ==");

await test("deduplica ml_id repetidos (anuncios patrocinados de ML)", () => {
  const { listings } = normalizeListings([
    { ml_id: "MLA111", title: "A", brand: "Bubba", price: 100 },
    { ml_id: "MLA111", title: "A otra vez", brand: "Bubba", price: 100 },
    { ml_id: "MLA222", title: "B", brand: "Bubba", price: 200 },
  ]);
  assert.equal(listings.length, 2);
});

await test("descarta ml_id con formato invalido", () => {
  const { listings, skipped } = normalizeListings([
    { ml_id: "12345", title: "sin prefijo", price: 100 },
    { ml_id: "", title: "vacio", price: 100 },
    { ml_id: "MLA999", title: "valida", brand: "Bubba", price: 100 },
  ]);
  assert.equal(listings.length, 1);
  assert.equal(skipped.length, 2);
});

await test("descarta precios invalidos o cero", () => {
  const { listings, skipped } = normalizeListings([
    { ml_id: "MLA1", title: "cero", price: 0 },
    { ml_id: "MLA2", title: "texto", price: "consultar" },
    { ml_id: "MLA3", title: "ok", brand: "Bubba", price: 5000 },
  ]);
  assert.equal(listings.length, 1);
  assert.equal(skipped.length, 2);
});

await test("normaliza ml_id a mayusculas", () => {
  const { listings } = normalizeListings([
    { ml_id: "mla123456", title: "x", brand: "Bubba", price: 100 },
  ]);
  assert.equal(listings[0].ml_id, "MLA123456");
});

// ---------------------------------------------------------------
// Validacion
// ---------------------------------------------------------------
console.log("\n== Validacion ==");

await test("rechaza payload sin run_id", () => {
  assert.throws(
    () => validatePayload({ listings: [], brands_covered: ["Bubba"] }),
    IngestError
  );
});

await test("rechaza brands_covered vacio (evita marcar bajas falsas)", () => {
  assert.throws(
    () => validatePayload({ run_id: "r1", listings: [], brands_covered: [] }),
    IngestError
  );
});

// ---------------------------------------------------------------
// Logica de deteccion de cambios
// ---------------------------------------------------------------
console.log("\n== Deteccion de cambios (unitario) ==");

await test("NO marca bajas de marcas que no se relevaron", () => {
  const existing = [
    { ml_id: "MLA1", title: "Bubba x", brand: "Bubba", price: "100", status: "active", seller: "S", has_installments: false, url: null },
    { ml_id: "MLA2", title: "Contigo y", brand: "Contigo", price: "200", status: "active", seller: "S", has_installments: false, url: null },
  ];
  // Solo se relevo Bubba, y MLA1 no aparecio -> baja de MLA1 unicamente.
  const changes = detectChanges([], existing, ["Bubba"]);
  const delisted = changes.filter((c) => c.change_type === "delisted");
  assert.equal(delisted.length, 1);
  assert.equal(delisted[0].ml_id, "MLA1");
});

await test("ignora variaciones de centavos", () => {
  const existing = [
    { ml_id: "MLA1", title: "x", brand: "Bubba", price: "1000.00", status: "active", seller: "S", has_installments: false, url: null },
  ];
  const changes = detectChanges(
    [{ ml_id: "MLA1", title: "x", brand: "Bubba", price: 1000.4, seller: "S", has_installments: false }],
    existing,
    ["Bubba"]
  );
  assert.equal(changes.filter((c) => c.change_type.startsWith("price_")).length, 0);
});

await test("calcula el porcentaje de cambio de precio", () => {
  const existing = [
    { ml_id: "MLA1", title: "x", brand: "Bubba", price: "1000", status: "active", seller: "S", has_installments: false, url: null },
  ];
  const changes = detectChanges(
    [{ ml_id: "MLA1", title: "x", brand: "Bubba", price: 1200, seller: "S", has_installments: false }],
    existing,
    ["Bubba"]
  );
  const c = changes.find((x) => x.change_type === "price_up");
  assert.equal(c.delta_abs, 200);
  assert.equal(c.delta_pct, 20);
});

await test("detecta baja de precio", () => {
  const existing = [
    { ml_id: "MLA1", title: "x", brand: "Bubba", price: "1000", status: "active", seller: "S", has_installments: false, url: null },
  ];
  const changes = detectChanges(
    [{ ml_id: "MLA1", title: "x", brand: "Bubba", price: 750, seller: "S", has_installments: false }],
    existing,
    ["Bubba"]
  );
  const c = changes.find((x) => x.change_type === "price_down");
  assert.equal(c.delta_abs, -250);
  assert.equal(c.delta_pct, -25);
});

await test("no inventa cambio de vendedor cuando el scraper no lo trae", () => {
  const existing = [
    { ml_id: "MLA1", title: "x", brand: "Bubba", price: "1000", status: "active", seller: "Termo Style", has_installments: false, url: null },
  ];
  const changes = detectChanges(
    [{ ml_id: "MLA1", title: "x", brand: "Bubba", price: 1000, seller: null, has_installments: false }],
    existing,
    ["Bubba"]
  );
  assert.equal(changes.filter((c) => c.change_type === "seller_change").length, 0);
});

// ---------------------------------------------------------------
// End-to-end contra Postgres
// ---------------------------------------------------------------
console.log("\n== End-to-end contra Postgres ==");

const L = (over = {}) => ({
  ml_id: "MLA100",
  title: "Termo Bubba Matterhorn 1.1L",
  brand: "Bubba",
  url: "https://articulo.mercadolibre.com.ar/MLA-100",
  seller: "Termo Style",
  official_store: true,
  list_price: 50000,
  price: 40000,
  discount_pct: 20,
  has_installments: true,
  installments_text: "6 cuotas sin interes",
  ...over,
});

let r1;
await test("primera corrida: todo es nuevo y first_run=true", async () => {
  r1 = await runIngest(
    {
      run_id: "run-1",
      source: "test",
      brands_covered: ["Bubba", "Contigo"],
      listings: [
        L(),
        L({ ml_id: "MLA200", title: "Vaso Contigo Autoseal 470ml", brand: "Contigo", price: 25000, list_price: null, discount_pct: null, has_installments: false, installments_text: null }),
      ],
    },
    q
  );
  assert.equal(r1.first_run, true);
  assert.equal(r1.listings_valid, 2);
  assert.equal(r1.changes_by_type.new_listing, 2);
});

await test("guarda las publicaciones en la tabla listings", async () => {
  const res = await q(`SELECT ml_id, price, seller, status FROM listings ORDER BY ml_id`);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[0].ml_id, "MLA100");
  assert.equal(Number(res.rows[0].price), 40000);
  assert.equal(res.rows[0].status, "active");
});

await test("guarda el snapshot de precio (historial)", async () => {
  const res = await q(`SELECT COUNT(*)::int AS n FROM price_snapshots WHERE run_id = 'run-1'`);
  assert.equal(res.rows[0].n, 2);
});

await test("registra la corrida con brands_covered como array", async () => {
  const res = await q(`SELECT brands_covered, listings_seen, changes_found, status FROM runs WHERE id = 'run-1'`);
  assert.deepEqual(res.rows[0].brands_covered, ["Bubba", "Contigo"]);
  assert.equal(res.rows[0].listings_seen, 2);
  assert.equal(res.rows[0].changes_found, 2);
  assert.equal(res.rows[0].status, "ok");
});

await test("segunda corrida: detecta suba de precio y cambio de vendedor", async () => {
  const r2 = await runIngest(
    {
      run_id: "run-2",
      source: "test",
      brands_covered: ["Bubba", "Contigo"],
      listings: [
        L({ price: 46000, seller: "CHARCO" }),
        L({ ml_id: "MLA200", title: "Vaso Contigo Autoseal 470ml", brand: "Contigo", price: 25000, list_price: null, discount_pct: null, has_installments: false, installments_text: null }),
      ],
    },
    q
  );
  assert.equal(r2.first_run, false);
  assert.equal(r2.changes_by_type.price_up, 1);
  assert.equal(r2.changes_by_type.seller_change, 1);
  assert.equal(r2.changes_by_type.new_listing, undefined);
});

await test("el precio y el vendedor quedaron actualizados", async () => {
  const res = await q(`SELECT price, seller FROM listings WHERE ml_id = 'MLA100'`);
  assert.equal(Number(res.rows[0].price), 46000);
  assert.equal(res.rows[0].seller, "CHARCO");
});

await test("el historial acumula: 2 mediciones para MLA100", async () => {
  const res = await q(`SELECT COUNT(*)::int AS n FROM price_snapshots WHERE ml_id = 'MLA100'`);
  assert.equal(res.rows[0].n, 2);
});

await test("tercera corrida: MLA100 desaparece -> se marca de baja", async () => {
  const r3 = await runIngest(
    {
      run_id: "run-3",
      brands_covered: ["Bubba", "Contigo"],
      listings: [
        L({ ml_id: "MLA200", title: "Vaso Contigo Autoseal 470ml", brand: "Contigo", price: 25000, list_price: null, discount_pct: null, has_installments: false, installments_text: null }),
      ],
    },
    q
  );
  assert.equal(r3.changes_by_type.delisted, 1);
  const res = await q(`SELECT status FROM listings WHERE ml_id = 'MLA100'`);
  assert.equal(res.rows[0].status, "delisted");
});

await test("si solo se releva Contigo, la baja de Bubba NO se repite", async () => {
  const r4 = await runIngest(
    {
      run_id: "run-4",
      brands_covered: ["Contigo"],
      listings: [
        L({ ml_id: "MLA200", title: "Vaso Contigo Autoseal 470ml", brand: "Contigo", price: 25000, list_price: null, discount_pct: null, has_installments: false, installments_text: null }),
      ],
    },
    q
  );
  assert.equal(r4.changes_by_type.delisted, undefined);
});

await test("cuarta corrida: MLA100 reaparece -> relisted", async () => {
  const r5 = await runIngest(
    {
      run_id: "run-5",
      brands_covered: ["Bubba", "Contigo"],
      listings: [
        L({ price: 42000, seller: "CHARCO" }),
        L({ ml_id: "MLA200", title: "Vaso Contigo Autoseal 470ml", brand: "Contigo", price: 25000, list_price: null, discount_pct: null, has_installments: false, installments_text: null }),
      ],
    },
    q
  );
  assert.equal(r5.changes_by_type.relisted, 1);
  assert.equal(r5.changes_by_type.price_down, 1);
  const res = await q(`SELECT status FROM listings WHERE ml_id = 'MLA100'`);
  assert.equal(res.rows[0].status, "active");
});

await test("detecta que dejo de ofrecer cuotas", async () => {
  const r6 = await runIngest(
    {
      run_id: "run-6",
      brands_covered: ["Bubba"],
      listings: [L({ price: 42000, seller: "CHARCO", has_installments: false, installments_text: null })],
    },
    q
  );
  assert.equal(r6.changes_by_type.installments_removed, 1);
});

await test("reenviar la MISMA corrida no genera cambios nuevos", async () => {
  const before = await q(`SELECT COUNT(*)::int AS n FROM changes`);
  const r7 = await runIngest(
    {
      run_id: "run-7",
      brands_covered: ["Bubba"],
      listings: [L({ price: 42000, seller: "CHARCO", has_installments: false, installments_text: null })],
    },
    q
  );
  assert.equal(r7.changes_found, 0);
  const after = await q(`SELECT COUNT(*)::int AS n FROM changes`);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

await test("la corrida es idempotente por run_id (ON CONFLICT)", async () => {
  await runIngest(
    { run_id: "run-7", brands_covered: ["Bubba"], listings: [L({ price: 42000, seller: "CHARCO", has_installments: false })] },
    q
  );
  const res = await q(`SELECT COUNT(*)::int AS n FROM runs WHERE id = 'run-7'`);
  assert.equal(res.rows[0].n, 1);
});

// ---------------------------------------------------------------
// SQL de las rutas del dashboard
// ---------------------------------------------------------------
console.log("\n== SQL del dashboard ==");

await test("/api/listings: query con todos los filtros combinados", async () => {
  const res = await q(
    `SELECT l.*,
            (SELECT COUNT(*) FROM price_snapshots s WHERE s.ml_id = l.ml_id) AS snapshots
     FROM listings l
     WHERE ($1 = 'all' OR l.status = $1)
       AND ($2::text IS NULL OR LOWER(l.brand) = LOWER($2))
       AND ($3::text IS NULL OR LOWER(l.seller) = LOWER($3))
       AND ($4::text IS NULL OR l.title ILIKE '%' || $4 || '%')
     ORDER BY l.brand NULLS LAST, l.price ASC
     LIMIT $5`,
    ["active", "Bubba", null, "matterhorn", 500]
  );
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].ml_id, "MLA100");
});

await test("/api/listings: sin filtros devuelve las activas", async () => {
  const res = await q(
    `SELECT * FROM listings l
     WHERE ($1 = 'all' OR l.status = $1)
       AND ($2::text IS NULL OR LOWER(l.brand) = LOWER($2))
       AND ($3::text IS NULL OR LOWER(l.seller) = LOWER($3))
       AND ($4::text IS NULL OR l.title ILIKE '%' || $4 || '%')
     LIMIT $5`,
    ["active", null, null, null, 500]
  );
  assert.equal(res.rows.length, 2);
});

await test("/api/changes: query con ventana de dias", async () => {
  const res = await q(
    `SELECT * FROM changes
     WHERE detected_at >= NOW() - ($1 || ' days')::interval
       AND ($2::text IS NULL OR change_type = $2)
       AND ($3::text IS NULL OR LOWER(brand) = LOWER($3))
     ORDER BY detected_at DESC, id DESC
     LIMIT $4`,
    [30, "price_up", null, 300]
  );
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].ml_id, "MLA100");
});

await test("/api/history: serie de precios ordenada", async () => {
  const res = await q(
    `SELECT captured_at, price, list_price, discount_pct, seller, has_installments, status
     FROM price_snapshots WHERE ml_id = $1 ORDER BY captured_at ASC`,
    ["MLA100"]
  );
  assert.ok(res.rows.length >= 4);
  const prices = res.rows.map((r) => Number(r.price));
  assert.equal(prices[0], 40000);
});

await test("/api/stats: totales, por marca, ultima corrida, cambios 7d", async () => {
  const totals = await q(
    `SELECT COUNT(*) FILTER (WHERE status = 'active')   AS activas,
            COUNT(*) FILTER (WHERE status = 'delisted') AS bajas,
            COUNT(DISTINCT brand)                        AS marcas,
            COUNT(DISTINCT seller)                       AS vendedores
     FROM listings`
  );
  assert.equal(Number(totals.rows[0].activas), 2);
  assert.equal(Number(totals.rows[0].marcas), 2);

  const byBrand = await q(
    `SELECT brand, COUNT(*) AS publicaciones, MIN(price) AS precio_min,
            ROUND(AVG(price)) AS precio_prom, MAX(price) AS precio_max
     FROM listings WHERE status = 'active' AND brand IS NOT NULL
     GROUP BY brand ORDER BY publicaciones DESC`
  );
  assert.equal(byBrand.rows.length, 2);

  const lastRun = await q(
    `SELECT id, started_at, finished_at, status, listings_seen, changes_found, notes
     FROM runs ORDER BY started_at DESC LIMIT 1`
  );
  assert.ok(lastRun.rows[0].id);

  const recent = await q(
    `SELECT change_type, COUNT(*) AS n FROM changes
     WHERE detected_at >= NOW() - INTERVAL '7 days'
     GROUP BY change_type ORDER BY n DESC`
  );
  assert.ok(recent.rows.length > 0);
});

await test("/api/watchlist: alta y baja logica", async () => {
  await q(
    `INSERT INTO watchlist (kind, value, label, notes) VALUES ($1,$2,$3,$4)
     ON CONFLICT (kind, value) DO UPDATE SET active = TRUE, label = EXCLUDED.label, notes = EXCLUDED.notes`,
    ["brand", "Stanley", "Stanley", null]
  );
  let res = await q(`SELECT id, active FROM watchlist WHERE value = 'Stanley'`);
  assert.equal(res.rows[0].active, true);

  await q(`UPDATE watchlist SET active = FALSE WHERE id = $1`, [res.rows[0].id]);
  res = await q(`SELECT active FROM watchlist WHERE value = 'Stanley'`);
  assert.equal(res.rows[0].active, false);
});

await test("agregar una marca nueva no borra el historial existente", async () => {
  const res = await q(`SELECT COUNT(*)::int AS n FROM price_snapshots`);
  assert.ok(res.rows[0].n >= 6);
});

await test("schema.sql se puede re-ejecutar sin romper nada (idempotente)", async () => {
  await q(schema);
  const res = await q(`SELECT COUNT(*)::int AS n FROM listings`);
  assert.equal(res.rows[0].n, 2);
});

// ---------------------------------------------------------------
console.log(`\n${passed} pasaron, ${failed} fallaron\n`);
await client.end();
process.exit(failed > 0 ? 1 : 0);
