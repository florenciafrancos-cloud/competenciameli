/**
 * Tests del cliente de la API de Mercado Libre y del orquestador.
 *
 * La API real no se puede llamar sin las credenciales de Florencia, asi que
 * se levanta un servidor local que imita lo que ML responde de verdad,
 * incluyendo lo que verificamos el 28/08/2026 contra la API en produccion:
 *
 *   - /sites/MLA/search  -> 403 forbidden (cerrado para apps no certificadas)
 *   - /items?ids=...     -> 200, con un {code, body} por publicacion
 *   - /items/{id}        -> 200, o 404 si no existe
 *
 * Correr:  npx tsx tests/ml-api.test.mjs
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import pg from "pg";

import {
  saveTokens,
  getAccessToken,
  exchangeCodeForTokens,
  fetchItems,
  previewItem,
  parseMlId,
} from "../lib/ml-api";
import { runScan } from "../lib/scan";

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

/** Catalogo de publicaciones "en ML", mutable para simular cambios. */
const WORLD = new Map();

function putItem(id, over = {}) {
  WORLD.set(id, {
    id,
    title: `Termo ${id}`,
    permalink: `https://articulo.mercadolibre.com.ar/${id}-termo`,
    price: 40000,
    original_price: null,
    base_price: null,
    currency_id: "ARS",
    available_quantity: 10,
    status: "active",
    seller_id: 555,
    official_store_id: null,
    attributes: [{ id: "BRAND", name: "Marca", value_name: "Bubba" }],
    sale_price: null,
    ...over,
  });
}

let omitRefreshToken = false;
let sellersForbidden = false;
let pricesForbidden = false;
let installmentsFor = new Map(); // id -> {quantity, amount, rate} | null
let itemsEndpointStatus = 200;
let requestLog = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  requestLog.push(url.pathname + url.search);
  const json = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // /oauth/token no usa Bearer: client_id/secret van en el body.
  if (url.pathname === "/oauth/token") {
    return json(
      200,
      omitRefreshToken
        ? { access_token: "SOLO_ACCESS", expires_in: 21600 }
        : {
            access_token: "NUEVO_ACCESS",
            refresh_token: "NUEVO_REFRESH",
            expires_in: 21600,
          }
    );
  }

  if (!req.headers.authorization?.startsWith("Bearer ")) {
    return json(401, { message: "invalid token" });
  }

  // Las busquedas estan cerradas, como en la realidad.
  if (url.pathname.endsWith("/search") && url.pathname.startsWith("/sites")) {
    return json(403, { message: "forbidden", error: "forbidden", status: 403 });
  }

  // Nombre del vendedor
  const userMatch = url.pathname.match(/^\/users\/(\d+)$/);
  if (userMatch) {
    if (sellersForbidden) return json(403, { message: "forbidden" });
    return json(200, { id: Number(userMatch[1]), nickname: "TERMO_STYLE" });
  }

  // Cuotas
  const pricesMatch = url.pathname.match(/^\/items\/(ML[A-Z]\d+)\/prices$/);
  if (pricesMatch) {
    if (pricesForbidden) return json(403, { message: "forbidden" });
    const inst = installmentsFor.get(pricesMatch[1]);
    if (inst === undefined) {
      // Respuesta sin ninguna info de cuotas -> "desconocido"
      return json(200, { id: pricesMatch[1], prices: [{ type: "standard", amount: 1 }] });
    }
    return json(200, {
      id: pricesMatch[1],
      prices: [{ type: "standard", amount: 1, conditions: { installments: inst } }],
    });
  }

  // Multiget
  if (url.pathname === "/items" && url.searchParams.has("ids")) {
    if (itemsEndpointStatus !== 200) {
      return json(itemsEndpointStatus, { message: "forbidden" });
    }
    const ids = url.searchParams.get("ids").split(",");
    return json(
      200,
      ids.map((id) => {
        const item = WORLD.get(id);
        return item
          ? { code: 200, body: item }
          : {
              code: 404,
              body: { id, error: "not_found", message: `Item ${id} not found` },
            };
      })
    );
  }

  // Detalle simple
  const itemMatch = url.pathname.match(/^\/items\/(ML[A-Z]\d+)$/);
  if (itemMatch) {
    const item = WORLD.get(itemMatch[1]);
    if (!item) return json(404, { error: "not_found", message: "not found" });
    return json(200, item);
  }

  return json(404, {});
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

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
const client = new pg.Client({ connectionString: PGURL });
await client.connect();
const q = (text, params = []) => client.query(text, params);

await q(
  `DROP TABLE IF EXISTS price_snapshots, changes, listings, runs, watchlist, ml_tokens CASCADE`
);
await q(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));

const validToken = () =>
  saveTokens(q, {
    access_token: "TOKEN_OK",
    refresh_token: "R",
    expires_at: new Date(Date.now() + 5 * 3600 * 1000),
  });

// ---------------------------------------------------------------
console.log("\n== Links de Mercado Libre -> ID ==");

await test("reconoce el formato articulo.mercadolibre.com.ar/MLA-...", () => {
  assert.equal(
    parseMlId("https://articulo.mercadolibre.com.ar/MLA-1234567890-termo-bubba-_JM"),
    "MLA1234567890"
  );
});

await test("reconoce el formato de catalogo /p/MLA...", () => {
  assert.equal(
    parseMlId("https://www.mercadolibre.com.ar/termo-bubba/p/MLA987654321"),
    "MLA987654321"
  );
});

await test("acepta el ID pegado directo, con y sin guion", () => {
  assert.equal(parseMlId("MLA1234567890"), "MLA1234567890");
  assert.equal(parseMlId("MLA-1234567890"), "MLA1234567890");
  assert.equal(parseMlId("  mla1234567890  "), "MLA1234567890");
});

await test("devuelve null si no hay ID reconocible", () => {
  assert.equal(parseMlId("https://ejemplo.com/nada"), null);
  assert.equal(parseMlId(""), null);
  assert.equal(parseMlId("hola"), null);
});

// ---------------------------------------------------------------
console.log("\n== Tokens ==");

await test("error claro cuando todavia no se autorizo la app", async () => {
  await assert.rejects(() => getAccessToken(q), /Autorizá la app/);
});

await test("usa el access_token guardado si todavia es valido", async () => {
  await validToken();
  assert.equal(await getAccessToken(q), "TOKEN_OK");
});

await test("refresca automaticamente si esta por vencer", async () => {
  await saveTokens(q, {
    access_token: "VIEJO",
    refresh_token: "R1",
    expires_at: new Date(Date.now() + 2 * 60 * 1000),
  });
  assert.equal(await getAccessToken(q), "NUEVO_ACCESS");
});

await test("guarda el refresh_token nuevo (es de un solo uso)", async () => {
  const res = await q(`SELECT refresh_token FROM ml_tokens WHERE id = 1`);
  assert.equal(res.rows[0].refresh_token, "NUEVO_REFRESH");
});

await test("REGRESION: sin refresh_token avisa sobre offline_access", async () => {
  omitRefreshToken = true;
  try {
    await assert.rejects(
      () => exchangeCodeForTokens("code", "https://app/api/ml/callback"),
      (err) => {
        assert.match(err.message, /offline_access/);
        return true;
      }
    );
  } finally {
    omitRefreshToken = false;
  }
});

// ---------------------------------------------------------------
console.log("\n== Consulta de publicaciones (/items) ==");

await test("lee una publicacion y arma el registro completo", async () => {
  putItem("MLA1000000100", { price: 36000, original_price: 45000, available_quantity: 7 });
  installmentsFor.set("MLA1000000100", { quantity: 6, amount: 6000, rate: 0 });

  const { listings, notFound, warnings } = await fetchItems(["MLA1000000100"], "T");
  assert.equal(notFound.length, 0);
  assert.equal(warnings.length, 0);

  const l = listings[0];
  assert.equal(l.ml_id, "MLA1000000100");
  assert.equal(l.price, 36000);
  assert.equal(l.list_price, 45000);
  assert.equal(l.discount_pct, 20);
  assert.equal(l.brand, "Bubba");
  assert.equal(l.seller, "TERMO_STYLE");
  assert.equal(l.ml_status, "active");
  assert.equal(l.available_quantity, 7);
  assert.equal(l.has_installments, true);
  assert.match(l.installments_text, /6 cuotas/);
});

await test("separa las que no existen de las que si", async () => {
  const { listings, notFound } = await fetchItems(["MLA1000000100", "MLA1000000999"], "T");
  assert.equal(listings.length, 1);
  assert.deepEqual(notFound, ["MLA1000000999"]);
});

await test("deduplica IDs repetidos y normaliza a mayusculas", async () => {
  const { listings } = await fetchItems(["mla100", "MLA1000000100", "MLA1000000100"], "T");
  assert.equal(listings.length, 1);
});

await test("parte en lotes de 20 (limite del multiget de ML)", async () => {
  for (let i = 0; i < 45; i++) putItem(`MLA4${String(i).padStart(9, "0")}`);
  requestLog = [];
  const ids = Array.from({ length: 45 }, (_, i) => `MLA4${String(i).padStart(9, "0")}`);
  const { listings } = await fetchItems(ids, "T", { withInstallments: false });
  assert.equal(listings.length, 45);

  const multigets = requestLog.filter((u) => u.startsWith("/items?ids="));
  assert.equal(multigets.length, 3);
  for (const u of multigets) {
    const count = new URL(u, "http://x").searchParams.get("ids").split(",").length;
    assert.ok(count <= 20, `un lote tenia ${count} ids`);
  }
});

await test("CRITICO: cuotas desconocidas quedan en null, no en false", async () => {
  // Si diera false, generaria una alerta falsa de "dejo de ofrecer cuotas".
  putItem("MLA1000000300");
  installmentsFor.delete("MLA1000000300");
  pricesForbidden = true;
  try {
    const { listings } = await fetchItems(["MLA1000000300"], "T");
    assert.equal(listings[0].has_installments, null);
  } finally {
    pricesForbidden = false;
  }
});

await test("si ML informa que no hay cuotas, se guarda false", async () => {
  putItem("MLA1000000301");
  installmentsFor.set("MLA1000000301", { quantity: 1 });
  const { listings } = await fetchItems(["MLA1000000301"], "T");
  assert.equal(listings[0].has_installments, false);
});

await test("si no se puede leer el vendedor, avisa y sigue", async () => {
  sellersForbidden = true;
  try {
    const { listings, warnings } = await fetchItems(["MLA1000000100"], "T");
    assert.equal(listings[0].seller, null);
    assert.ok(warnings.some((w) => /vendedores/.test(w)));
  } finally {
    sellersForbidden = false;
  }
});

await test("CRITICO: si el multiget falla, no reporta nada como inexistente", async () => {
  itemsEndpointStatus = 403;
  try {
    const { listings, notFound, warnings } = await fetchItems(["MLA1000000100"], "T");
    assert.equal(listings.length, 0);
    assert.equal(notFound.length, 0, "marcó como inexistente algo que no pudo leer");
    assert.ok(warnings.length > 0);
  } finally {
    itemsEndpointStatus = 200;
  }
});

// ---------------------------------------------------------------
console.log("\n== Alta de una publicacion (previewItem) ==");

await test("verifica un link valido y devuelve el dato", async () => {
  const r = await previewItem("MLA1000000100", "T");
  assert.equal(r.ok, true);
  assert.equal(r.listing.ml_id, "MLA1000000100");
});

await test("rechaza un ID que no existe, con mensaje claro", async () => {
  const r = await previewItem("MLA1000000404", "T");
  assert.equal(r.ok, false);
  assert.match(r.error, /no encontró/);
});

// ---------------------------------------------------------------
console.log("\n== Orquestador (runScan) ==");

async function watch(url) {
  const id = parseMlId(url);
  await q(
    `INSERT INTO watchlist (kind, value, label, ml_id, active)
     VALUES ('url', $1, $2, $3, TRUE)
     ON CONFLICT (kind, value) DO UPDATE SET active = TRUE, ml_id = EXCLUDED.ml_id`,
    [url, id, id]
  );
}

await test("sin publicaciones cargadas, avisa y no toca la base", async () => {
  await q(`UPDATE watchlist SET active = FALSE`);
  const r = await runScan(q, { runId: "s0" });
  assert.match(r.error, /No hay publicaciones cargadas/);
  assert.equal(r.ingest, null);
});

await test("primera corrida: carga las publicaciones seguidas", async () => {
  await validToken();
  putItem("MLA1000000100", { price: 36000, original_price: 45000 });
  putItem("MLA1000000101", { price: 22000 });
  await watch("https://articulo.mercadolibre.com.ar/MLA-1000000100-termo");
  await watch("https://articulo.mercadolibre.com.ar/MLA-1000000101-termo");

  const r = await runScan(q, { runId: "s1" });
  assert.equal(r.error, undefined);
  assert.equal(r.tracked, 2);
  assert.equal(r.read_ok, 2);
  assert.equal(r.ingest.first_run, true);
});

await test("segunda corrida sin cambios: no genera alertas", async () => {
  const r = await runScan(q, { runId: "s2" });
  assert.equal(r.ingest.changes_found, 0);
});

await test("detecta que la competencia BAJO el precio", async () => {
  putItem("MLA1000000100", { price: 30000, original_price: 45000 });
  const r = await runScan(q, { runId: "s3" });
  assert.equal(r.ingest.changes_by_type.price_down, 1);
  const c = r.ingest.changes.find((x) => x.change_type === "price_down");
  assert.equal(c.delta_abs, -6000);
});

await test("detecta que SUBIO el precio", async () => {
  putItem("MLA1000000100", { price: 39000, original_price: 45000 });
  const r = await runScan(q, { runId: "s4" });
  assert.equal(r.ingest.changes_by_type.price_up, 1);
});

await test("detecta que se PAUSO la publicacion", async () => {
  putItem("MLA1000000100", { price: 39000, status: "paused" });
  const r = await runScan(q, { runId: "s5" });
  assert.equal(r.ingest.changes_by_type.paused, 1);
});

await test("detecta que se REACTIVO", async () => {
  putItem("MLA1000000100", { price: 39000, status: "active" });
  const r = await runScan(q, { runId: "s6" });
  assert.equal(r.ingest.changes_by_type.reactivated, 1);
});

await test("detecta que se quedo SIN STOCK", async () => {
  putItem("MLA1000000100", { price: 39000, available_quantity: 0 });
  const r = await runScan(q, { runId: "s7" });
  assert.equal(r.ingest.changes_by_type.out_of_stock, 1);
});

await test("detecta que VOLVIO a tener stock", async () => {
  putItem("MLA1000000100", { price: 39000, available_quantity: 5 });
  const r = await runScan(q, { runId: "s8" });
  assert.equal(r.ingest.changes_by_type.back_in_stock, 1);
});

await test("detecta cuando cambian las CONDICIONES de cuotas (6 -> 12)", async () => {
  // Seguia ofreciendo cuotas, pero cambio la cantidad. El "si/no" no
  // cambia, y aun asi es un movimiento competitivo que hay que ver.
  installmentsFor.set("MLA1000000100", { quantity: 12, amount: 3250, rate: 0 });
  const r = await runScan(q, { runId: "s9" });
  assert.equal(r.ingest.changes_by_type.installments_changed, 1);
  const c = r.ingest.changes.find((x) => x.change_type === "installments_changed");
  assert.match(c.old_value, /6 cuotas/);
  assert.match(c.new_value, /12 cuotas/);
});

await test("detecta cuando DEJA de ofrecer cuotas", async () => {
  installmentsFor.set("MLA1000000100", { quantity: 1 });
  const r = await runScan(q, { runId: "s9b" });
  assert.equal(r.ingest.changes_by_type.installments_removed, 1);
});

await test("detecta cuando EMPIEZA a ofrecer cuotas", async () => {
  installmentsFor.set("MLA1000000100", { quantity: 9, amount: 4300, rate: 0 });
  const r = await runScan(q, { runId: "s9c" });
  assert.equal(r.ingest.changes_by_type.installments_added, 1);
});

await test("detecta la BAJA cuando ML ya no encuentra la publicacion", async () => {
  WORLD.delete("MLA1000000101");
  const r = await runScan(q, { runId: "s10" });
  assert.equal(r.not_found, 1);
  assert.equal(r.ingest.changes_by_type.delisted, 1);
  const res = await q(`SELECT status FROM listings WHERE ml_id = 'MLA1000000101'`);
  assert.equal(res.rows[0].status, "delisted");
});

await test("detecta cuando VUELVE a publicarse", async () => {
  putItem("MLA1000000101", { price: 24000 });
  const r = await runScan(q, { runId: "s11" });
  assert.equal(r.ingest.changes_by_type.relisted, 1);
});

await test("CRITICO: si la API falla, NO marca nada de baja", async () => {
  const before = await q(
    `SELECT COUNT(*)::int AS n FROM listings WHERE status = 'active'`
  );
  itemsEndpointStatus = 500;
  const r = await runScan(q, { runId: "s12" });
  itemsEndpointStatus = 200;

  assert.ok(r.error, "deberia reportar error");
  assert.equal(r.ingest, null);
  const after = await q(
    `SELECT COUNT(*)::int AS n FROM listings WHERE status = 'active'`
  );
  assert.equal(after.rows[0].n, before.rows[0].n);
});

await test("dejar de seguir una publicacion la excluye, sin borrar historial", async () => {
  const wl = await q(`SELECT id FROM watchlist WHERE ml_id = 'MLA1000000101'`);
  await q(`UPDATE watchlist SET active = FALSE WHERE id = $1`, [wl.rows[0].id]);

  const r = await runScan(q, { runId: "s13" });
  assert.equal(r.tracked, 1);

  const hist = await q(
    `SELECT COUNT(*)::int AS n FROM price_snapshots WHERE ml_id = 'MLA1000000101'`
  );
  assert.ok(hist.rows[0].n > 0, "se perdio el historial");
});

await test("una entrada de tipo marca avisa que ML cerro la busqueda", async () => {
  await q(
    `INSERT INTO watchlist (kind, value, label, active) VALUES ('brand','Bubba','Bubba',TRUE)
     ON CONFLICT (kind, value) DO UPDATE SET active = TRUE`
  );
  const r = await runScan(q, { runId: "s14" });
  assert.ok(r.warnings.some((w) => /búsqueda pública/.test(w)));
  // Y no debe impedir que el resto funcione.
  assert.equal(r.error, undefined);
  await q(`UPDATE watchlist SET active = FALSE WHERE kind = 'brand'`);
});

await test("el historial de precios se acumula corrida a corrida", async () => {
  const res = await q(
    `SELECT COUNT(DISTINCT run_id)::int AS n FROM price_snapshots WHERE ml_id = 'MLA1000000100'`
  );
  assert.ok(res.rows[0].n >= 8, `solo ${res.rows[0].n} corridas`);
});

// ---------------------------------------------------------------
console.log(`\n${passed} pasaron, ${failed} fallaron\n`);
globalThis.fetch = realFetch;
await client.end();
server.close();
process.exit(failed > 0 ? 1 : 0);
