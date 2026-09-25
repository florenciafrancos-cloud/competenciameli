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
  parseMlLink,
  fetchCatalogProduct,
  fetchCatalogProducts,
  resolveUserProduct,
  slugWords,
  hintedItemId,
  checkCoverage,
  fetchMe,
  fetchOwnItems,
  previewOwnItem,
  fetchMyItemsFromMl,
  fetchOfferChoices,
  hintedOfficialStore,
  precioConEnvio,
} from "../lib/ml-api";
import {
  diffAgainst,
  resolveOwnRef,
  getOwnItems,
  resetOwnItemsCache,
} from "../lib/own-items";
import { getMyItems, resetMyItemsCache } from "../lib/my-items";
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
let catalogMode = "ok"; // ok | no_winner | forbidden

/** La cuenta que autorizo la app, y sus publicaciones. */
const ME_ID = 331382454;
let meForbidden = false;
let myItemsStatus = 200;
const MY_ITEMS = [];

/** Fichas de catalogo "en ML". */
const CATALOG = new Map();
const CATALOG_OFFERS = new Map();
/** Publicaciones de otros vendedores: ML las prohibe (403). */
const FORBIDDEN_ITEMS = new Set();
/** Resultados de /products/search. */
const CATALOG_SEARCH = [];
/** MLAU... -> catalog_product_id, si /user-products lo resolviera. */
const USER_PRODUCTS = new Map();
let userProductsMode = "forbidden";

function putCatalog(id, over = {}) {
  // Forma REAL de /products/{id}, verificada el 28/08/2026:
  // buy_box_winner viene null y permalink vacio.
  CATALOG.set(id, {
    id,
    catalog_product_id: id,
    status: "active",
    domain_id: "MLA-THERMAL_CUPS_AND_TUMBLERS",
    permalink: "",
    name: "Botella Termica Bubba Vaso Dual Sip 1.53 L Acero Inoxidable",
    family_name: "Bubba Flora Aura Vaso",
    type: "catalog_product",
    buy_box_winner: null,
    ...over,
  });
}

/** Forma REAL de /products/{id}/items: sin stock ni precio de lista. */
function putOffers(id, offers) {
  CATALOG_OFFERS.set(
    id,
    offers.map((o) => ({
      item_id: o.item_id,
      site_id: "MLA",
      seller_id: o.seller_id,
      accepts_mercadopago: true,
      price: o.price,
      category_id: "MLA47752",
      currency_id: "ARS",
      warranty: "",
      condition: "new",
      listing_type_id: "gold_special",
      international_delivery_mode: "none",
      tier: "",
      official_store_id: o.official_store_id ?? null,
      // Forma REAL del envio, verificada el 25/09/2026 en MLA58102043.
      shipping: {
        free_shipping: o.free_shipping ?? false,
        mode: "me2",
        cost: o.shipping_cost ?? 0,
      },
    }))
  );
}

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

  // Quien autorizo la app.
  if (url.pathname === "/users/me") {
    if (meForbidden) return json(403, { message: "forbidden" });
    return json(200, { id: ME_ID, nickname: "IMPROMSA" });
  }

  // Mis propias publicaciones. VERIFICADO el 25/09/2026: este endpoint SI
  // responde 200, a diferencia de /sites/MLA/search. Devuelve solo IDs.
  const mineMatch = url.pathname.match(/^\/users\/(\d+)\/items\/search$/);
  if (mineMatch) {
    if (Number(mineMatch[1]) !== ME_ID) return json(403, { message: "forbidden" });
    if (myItemsStatus !== 200) return json(myItemsStatus, { message: "error" });
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const page = MY_ITEMS.slice(offset, offset + limit);
    return json(200, { results: page, paging: { total: MY_ITEMS.length, limit, offset } });
  }

  // Nombre del vendedor
  const userMatch = url.pathname.match(/^\/users\/(\d+)$/);
  if (userMatch) {
    if (sellersForbidden) return json(403, { message: "forbidden" });
    const id = Number(userMatch[1]);
    const nicks = { 555: "TERMO_STYLE", 777: "TERMO_STYLE", 888: "CHARCO", 999: "MUGSHOP" };
    return json(200, { id, nickname: nicks[id] ?? `VENDEDOR_${id}` });
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

  // Multiget. OJO: para publicaciones de OTROS vendedores, ML devuelve 200
  // en el sobre y { code: 403 } adentro. Verificado el 28/08/2026.
  if (url.pathname === "/items" && url.searchParams.has("ids")) {
    if (itemsEndpointStatus !== 200) {
      return json(itemsEndpointStatus, { message: "forbidden" });
    }
    const ids = url.searchParams.get("ids").split(",");
    return json(
      200,
      ids.map((id) => {
        if (FORBIDDEN_ITEMS.has(id)) {
          return {
            code: 403,
            body: {
              id,
              error: "access_denied",
              message: "Access to the requested resource is forbidden",
            },
          };
        }
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

  // Busqueda en el catalogo de productos
  if (url.pathname === "/products/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const results = [...CATALOG_SEARCH].filter((r) =>
      q.split(/\s+/).some((w) => w && r.name.toLowerCase().includes(w))
    );
    return json(200, { paging: { total: results.length }, results });
  }

  // User products (los IDs MLAU de los links /up/)
  const upMatch = url.pathname.match(/^\/user-products\/(ML[A-Z]U\d+)$/);
  if (upMatch) {
    if (userProductsMode === "forbidden") return json(403, { message: "forbidden" });
    const mapped = USER_PRODUCTS.get(upMatch[1]);
    if (!mapped) return json(404, { error: "not_found" });
    return json(200, { id: upMatch[1], catalog_product_id: mapped });
  }

  // Ficha de catalogo
  const prodItemsMatch = url.pathname.match(/^\/products\/(ML[A-Z]\d+)\/items$/);
  if (prodItemsMatch) {
    if (catalogMode === "forbidden") return json(403, { message: "forbidden" });
    const offers = CATALOG_OFFERS.get(prodItemsMatch[1]);
    if (!offers) {
      // Respuesta real de ML cuando la ficha existe pero nadie la vende.
      return json(404, { message: "No winners found", error: "not_found", status: 404 });
    }
    return json(200, { results: offers, paging: { total: offers.length } });
  }

  const prodMatch = url.pathname.match(/^\/products\/(ML[A-Z]\d+)$/);
  if (prodMatch) {
    if (catalogMode === "forbidden") return json(403, { message: "forbidden" });
    const p = CATALOG.get(prodMatch[1]);
    if (!p) return json(404, { error: "not_found", message: "not found" });
    if (catalogMode === "no_winner") {
      const { buy_box_winner, ...rest } = p;
      return json(200, rest);
    }
    return json(200, p);
  }

  // Detalle simple
  const itemMatch = url.pathname.match(/^\/items\/(ML[A-Z]\d+)$/);
  if (itemMatch) {
    if (FORBIDDEN_ITEMS.has(itemMatch[1])) {
      return json(403, {
        message: "Access to the requested resource is forbidden",
        error: "access_denied",
        status: 403,
      });
    }
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

await test("REGRESION: link /up/ toma el producto de catalogo, no el trigger como publicacion", () => {
  // Este link daba un 404 confuso: el parser agarraba el
  // product_trigger_id del final y lo trataba como publicacion.
  const r = parseMlLink(
    "https://www.mercadolibre.com.ar/botella-termica-bubba-keg-acero-inoxidable-154l-antiderrame/up/MLAU4195231986?product_trigger_id=MLA74954916&picker=true&quantity=1"
  );
  assert.deepEqual(r, { id: "MLA74954916", kind: "product" });
});

await test("en una pagina de catalogo se usa la ficha, NO el wid", () => {
  // ML prohibe leer publicaciones de terceros (403), asi que aunque el link
  // traiga wid apuntando a una publicacion concreta, el camino consultable
  // es la ficha de catalogo.
  const r = parseMlLink(
    "https://www.mercadolibre.com.ar/termo/p/MLA67012657?wid=MLA1234567890&quantity=1"
  );
  assert.deepEqual(r, { id: "MLA67012657", kind: "product" });
});

await test("un /up/ sin product_trigger_id queda como user_product", () => {
  // Antes devolvia null y la app decia "pegá otro link". Ahora se marca
  // como user_product para poder resolverlo buscando en el catalogo.
  assert.deepEqual(
    parseMlLink("https://www.mercadolibre.com.ar/termo/up/MLAU4195231986"),
    { id: "MLAU4195231986", kind: "user_product" }
  );
});

await test("un ID MLAU pegado solo tambien queda como user_product", () => {
  assert.deepEqual(parseMlLink("MLAU4195231986"), {
    id: "MLAU4195231986",
    kind: "user_product",
  });
});

await test("no confunde el nombre del producto en la URL con un ID", () => {
  const r = parseMlLink(
    "https://articulo.mercadolibre.com.ar/MLA-1234567890-bubba-keg-154l-_JM"
  );
  assert.deepEqual(r, { id: "MLA1234567890", kind: "item" });
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
console.log("\n== Fichas de catalogo (links /p/MLA...) ==");

await test("distingue un link de catalogo de uno de publicacion", () => {
  const prod = parseMlLink(
    "https://www.mercadolibre.com.ar/bubba-52oz-ss-keg-multifunction-field-trip/p/MLA67012657"
  );
  assert.deepEqual(prod, { id: "MLA67012657", kind: "product" });

  const item = parseMlLink(
    "https://articulo.mercadolibre.com.ar/MLA-1234567890-termo-_JM"
  );
  assert.deepEqual(item, { id: "MLA1234567890", kind: "item" });
});

await test("REGRESION: el ID de catalogo puede tener menos digitos", () => {
  // MLA67012657 son 8 digitos; el regex de publicaciones exige 6+, pero
  // fichas de catalogo mas viejas pueden tener menos. Por eso el patron
  // de /p/ es mas permisivo.
  assert.deepEqual(parseMlLink("https://www.mercadolibre.com.ar/x/p/MLA12345"), {
    id: "MLA12345",
    kind: "product",
  });
});

await test("lee la ficha y calcula el ganador desde las ofertas", async () => {
  // En la respuesta real buy_box_winner viene null: el ganador es la
  // oferta mas barata de /products/{id}/items.
  putCatalog("MLA74954916");
  putOffers("MLA74954916", [
    { item_id: "MLA2040738333", seller_id: 777, price: 63599 },
    { item_id: "MLA2040738444", seller_id: 888, price: 71000 },
    { item_id: "MLA2040738555", seller_id: 999, price: 84250 },
  ]);

  const r = await fetchCatalogProduct("MLA74954916", "T");
  assert.equal(r.ok, true);
  assert.equal(r.listing.ml_id, "MLA74954916");
  assert.equal(r.listing.price, 63599, "no tomo la oferta mas barata");
  assert.equal(r.winnerItemId, "MLA2040738333");
  assert.equal(r.listing.offers_count, 3);
  assert.match(r.listing.title, /Bubba/);
});

await test("usa el link del usuario porque el permalink viene vacio", async () => {
  const url = "https://www.mercadolibre.com.ar/botella/p/MLA74954916";
  const r = await fetchCatalogProduct("MLA74954916", "T", { fallbackUrl: url });
  assert.equal(r.listing.url, url);
});

await test("respeta buy_box_winner cuando ML si lo informa", async () => {
  putCatalog("MLA74954917", {
    buy_box_winner: { item_id: "MLA999", seller_id: 555, price: 55000, currency_id: "ARS" },
  });
  putOffers("MLA74954917", [{ item_id: "MLA888", seller_id: 888, price: 99000 }]);
  const r = await fetchCatalogProduct("MLA74954917", "T");
  assert.equal(r.listing.price, 55000);
  assert.equal(r.winnerItemId, "MLA999");
});

await test("una ficha sin ofertas activas se explica, no se marca de baja", async () => {
  putCatalog("MLA74954918");
  CATALOG_OFFERS.delete("MLA74954918");
  const r = await fetchCatalogProduct("MLA74954918", "T");
  assert.equal(r.ok, false);
  assert.match(r.error, /no tiene ofertas activas/);
});

await test("avisa que las cuotas no se pueden leer en fichas de catalogo", async () => {
  pricesForbidden = true;
  try {
    const r = await fetchCatalogProduct("MLA74954916", "T");
    assert.equal(r.listing.has_installments, null, "inventó un valor de cuotas");
    assert.ok(r.warnings.some((w) => /cuotas/.test(w)));
  } finally {
    pricesForbidden = false;
  }
});

await test("si no se puede leer el vendedor, avisa y sigue", async () => {
  sellersForbidden = true;
  try {
    const r = await fetchCatalogProduct("MLA74954916", "T");
    assert.equal(r.ok, true);
    assert.equal(r.listing.seller, null);
    assert.equal(r.listing.seller_id, 777, "perdio el id, que es lo confiable");
    assert.ok(r.warnings.some((w) => /vendedores/.test(w)));
  } finally {
    sellersForbidden = false;
  }
});

await test("una ficha inexistente se reporta como no encontrada", async () => {
  const r = await fetchCatalogProducts(["MLA99999999"], "T");
  assert.deepEqual(r.notFound, ["MLA99999999"]);
  assert.equal(r.listings.length, 0);
});

await test("CRITICO: si catalogo falla, no se reporta como no encontrada", async () => {
  catalogMode = "forbidden";
  try {
    const r = await fetchCatalogProducts(["MLA74954916"], "T");
    assert.equal(r.notFound.length, 0, "un 403 no significa que no exista");
    assert.equal(r.warnings.length, 1);
  } finally {
    catalogMode = "ok";
  }
});

await test("los avisos repetidos se reportan una sola vez", async () => {
  putCatalog("MLA74954919");
  putOffers("MLA74954919", [{ item_id: "MLA777", seller_id: 777, price: 1000 }]);
  pricesForbidden = true;
  try {
    const r = await fetchCatalogProducts(["MLA74954916", "MLA74954919"], "T");
    const cuotas = r.warnings.filter((w) => /cuotas/.test(w));
    assert.equal(cuotas.length, 1, `se repitio ${cuotas.length} veces`);
  } finally {
    pricesForbidden = false;
  }
});

// ---------------------------------------------------------------
console.log("\n== Links /up/MLAU... (sin product_trigger_id) ==");

await test("reconoce un /up/MLAU como user_product, no como publicacion", () => {
  const r = parseMlLink(
    "https://www.mercadolibre.com.ar/botella-termica-contigo-473ml-acero-inoxidable-dualsip/up/MLAU1234567890"
  );
  assert.deepEqual(r, { id: "MLAU1234567890", kind: "user_product" });
});

await test("saca las palabras utiles del nombre en la URL", () => {
  const w = slugWords(
    "https://www.mercadolibre.com.ar/botella-termica-contigo-473ml-acero-inoxidable-dualsip/up/MLAU1"
  );
  assert.ok(w.includes("contigo"));
  assert.ok(w.includes("dualsip"));
  assert.ok(!w.includes("up"), "no deberia tomar el path");
});

await test("resuelve por /user-products cuando ML lo permite", async () => {
  userProductsMode = "ok";
  USER_PRODUCTS.set("MLAU1234567890", "MLA74954916");
  try {
    const r = await resolveUserProduct(
      "MLAU1234567890",
      "https://www.mercadolibre.com.ar/x/up/MLAU1234567890",
      "T"
    );
    assert.equal(r.ok, true);
    assert.equal(r.productId, "MLA74954916");
    assert.equal(r.via, "/user-products");
  } finally {
    userProductsMode = "forbidden";
    USER_PRODUCTS.clear();
  }
});

await test("si no, busca en el catalogo y acepta un match claro", async () => {
  CATALOG_SEARCH.length = 0;
  CATALOG_SEARCH.push(
    { id: "MLA88888888", name: "Botella Termica Contigo 473ml Acero Inoxidable DualSip" },
    { id: "MLA77777777", name: "Mochila escolar azul" }
  );
  putOffers("MLA88888888", [{ item_id: "MLA1000000003", seller_id: 1, price: 48000 }]);
  putOffers("MLA77777777", [{ item_id: "MLA1000000004", seller_id: 2, price: 9000 }]);
  const r = await resolveUserProduct(
    "MLAU9999999999",
    "https://www.mercadolibre.com.ar/botella-termica-contigo-473ml-acero-inoxidable-dualsip/up/MLAU9999999999",
    "T"
  );
  assert.equal(r.ok, true);
  assert.equal(r.productId, "MLA88888888");
});

await test("CRITICO: si hay dos candidatos parecidos, NO elige solo", async () => {
  // Elegir mal significaria seguir el precio del producto equivocado sin
  // que nadie se entere. Mejor que decida la persona.
  CATALOG_SEARCH.length = 0;
  CATALOG_SEARCH.push(
    { id: "MLA11111111", name: "Botella Termica Contigo 473ml Acero Inoxidable DualSip Negro" },
    { id: "MLA22222222", name: "Botella Termica Contigo 473ml Acero Inoxidable DualSip Blanco" }
  );
  putOffers("MLA11111111", [{ item_id: "MLA1000000001", seller_id: 1, price: 50000 }]);
  putOffers("MLA22222222", [{ item_id: "MLA1000000002", seller_id: 2, price: 52000 }]);
  const r = await resolveUserProduct(
    "MLAU9999999999",
    "https://www.mercadolibre.com.ar/botella-termica-contigo-473ml-acero-inoxidable-dualsip/up/MLAU9999999999",
    "T"
  );
  assert.equal(r.ok, false);
  assert.equal(r.candidates.length, 2);
  assert.match(r.error, /ofertas activas/);
});

await test("devuelve las opciones ordenadas por parecido", async () => {
  CATALOG_SEARCH.length = 0;
  CATALOG_SEARCH.push(
    { id: "MLA33333333", name: "Contigo algo distinto" },
    { id: "MLA44444444", name: "Botella Termica Contigo 473ml Acero Inoxidable DualSip" }
  );
  putOffers("MLA33333333", [{ item_id: "MLA1000000005", seller_id: 1, price: 1000 }]);
  putOffers("MLA44444444", [{ item_id: "MLA1000000006", seller_id: 2, price: 48000 }]);
  const r = await resolveUserProduct(
    "MLAU9999999999",
    "https://www.mercadolibre.com.ar/botella-termica-contigo-473ml-acero-inoxidable-dualsip/up/MLAU9999999999",
    "T"
  );
  // El mejor es claramente mejor -> se acepta
  assert.equal(r.ok, true);
  assert.equal(r.productId, "MLA44444444");
});

await test("extrae el item de referencia en todas sus formas", () => {
  assert.equal(
    hintedItemId(
      "https://www.mercadolibre.com.ar/x/up/MLAU4148053079?pdp_filters=item_id:MLA3514608986#is_advertising=true"
    ),
    "MLA3514608986"
  );
  assert.equal(
    hintedItemId("https://www.mercadolibre.com.ar/x/up/MLAU1?pdp_filters=item_id%3AMLA3514608986"),
    "MLA3514608986"
  );
  // Tambien viene como wid, escapado, dentro del fragmento tras el "#".
  assert.equal(
    hintedItemId(
      "https://www.mercadolibre.com.ar/x/up/MLAU4148053079?gallery_type=horizontal#reco_id%3Df46e%26wid%3DMLA3514608986%26sid%3Drecos"
    ),
    "MLA3514608986"
  );
  assert.equal(
    hintedItemId("https://www.mercadolibre.com.ar/x/p/MLA1?wid=MLA3514608986"),
    "MLA3514608986"
  );
  assert.equal(hintedItemId("https://www.mercadolibre.com.ar/x/up/MLAU1"), null);
});

await test("con el item_id de la URL elige el producto correcto entre variantes", async () => {
  // El caso real: dos colores con nombre casi igual. Sin el item_id habria
  // que preguntarle a la persona; con el, se resuelve solo y sin riesgo.
  CATALOG_SEARCH.length = 0;
  CATALOG_SEARCH.push(
    { id: "MLA55550001", name: "Botella Termica Contigo 473ml Acero Inoxidable Autoseal Negro" },
    { id: "MLA55550002", name: "Botella Termica Contigo 473ml Acero Inoxidable Autoseal Blanco" }
  );
  putOffers("MLA55550001", [{ item_id: "MLA9999999999", seller_id: 1, price: 10000 }]);
  putOffers("MLA55550002", [{ item_id: "MLA3514608986", seller_id: 2, price: 20000 }]);

  const r = await resolveUserProduct(
    "MLAU4148053079",
    "https://www.mercadolibre.com.ar/botella-termica-contigo-473ml-acero-inoxidable-autoseal/up/MLAU4148053079?pdp_filters=item_id:MLA3514608986#is_advertising=true&position=1",
    "T"
  );
  assert.equal(r.ok, true, "no resolvio con el item_id");
  assert.equal(r.productId, "MLA55550002", "eligio la variante equivocada");
  assert.match(r.via, /item_id/);
});

await test("si el item_id no aparece en ninguna, vuelve a preguntar", async () => {
  CATALOG_SEARCH.length = 0;
  CATALOG_SEARCH.push(
    { id: "MLA55550001", name: "Botella Termica Contigo 473ml Acero Inoxidable Autoseal Negro" },
    { id: "MLA55550002", name: "Botella Termica Contigo 473ml Acero Inoxidable Autoseal Blanco" }
  );
  putOffers("MLA55550001", [{ item_id: "MLA1111111111", seller_id: 1, price: 10000 }]);
  putOffers("MLA55550002", [{ item_id: "MLA2222222222", seller_id: 2, price: 20000 }]);
  // ambos tienen ofertas -> no se puede auto-elegir sin el item_id

  const r = await resolveUserProduct(
    "MLAU4148053079",
    "https://www.mercadolibre.com.ar/botella-termica-contigo-473ml-acero-inoxidable-autoseal/up/MLAU4148053079?pdp_filters=item_id:MLA7777777777",
    "T"
  );
  assert.equal(r.ok, false);
  assert.equal(r.candidates.length, 2);
});

await test("no ofrece como opcion los productos sin ofertas activas", async () => {
  // Es lo que hizo perder tiempo en produccion: la lista incluia productos
  // muertos y elegirlos daba error, uno por uno.
  CATALOG_SEARCH.length = 0;
  CATALOG_SEARCH.push(
    { id: "MLA66660001", name: "Botella Termica Contigo 473ml Autoseal Negro" },
    { id: "MLA66660002", name: "Botella Termica Contigo 473ml Autoseal Blanco" },
    { id: "MLA66660003", name: "Botella Termica Contigo 473ml Autoseal Gris" }
  );
  CATALOG_OFFERS.delete("MLA66660001");
  CATALOG_OFFERS.delete("MLA66660002");
  putOffers("MLA66660003", [{ item_id: "MLA1000000007", seller_id: 3, price: 41000 }]);

  const r = await resolveUserProduct(
    "MLAU1",
    "https://www.mercadolibre.com.ar/botella-termica-contigo-473ml-autoseal/up/MLAU1",
    "T"
  );
  // Queda uno solo con ofertas -> no hay nada que preguntar.
  assert.equal(r.ok, true);
  assert.equal(r.productId, "MLA66660003");
  assert.match(r.via, /ofertas activas/);
});

await test("las opciones muestran precio y cantidad de competidores", async () => {
  CATALOG_SEARCH.length = 0;
  CATALOG_SEARCH.push(
    { id: "MLA66670001", name: "Contigo Autoseal 473ml Negro" },
    { id: "MLA66670002", name: "Contigo Autoseal 473ml Blanco" }
  );
  putOffers("MLA66670001", [
    { item_id: "MLA1000000010", seller_id: 1, price: 45000 },
    { item_id: "MLA1000000011", seller_id: 2, price: 47000 },
  ]);
  putOffers("MLA66670002", [{ item_id: "MLA1000000012", seller_id: 3, price: 39000 }]);

  const r = await resolveUserProduct(
    "MLAU1",
    "https://www.mercadolibre.com.ar/contigo-autoseal-473ml/up/MLAU1",
    "T"
  );
  assert.equal(r.ok, false, "deberia preguntar: hay dos validas");
  const negro = r.candidates.find((c) => c.id === "MLA66670001");
  assert.equal(negro.price, 45000, "no muestra el mejor precio");
  assert.equal(negro.offers_count, 2, "no muestra cuantos compiten");
});

await test("si NINGUNA variante tiene ofertas, lo explica claramente", async () => {
  CATALOG_SEARCH.length = 0;
  CATALOG_SEARCH.push(
    { id: "MLA66680001", name: "Contigo Autoseal 473ml Negro" },
    { id: "MLA66680002", name: "Contigo Autoseal 473ml Blanco" }
  );
  CATALOG_OFFERS.delete("MLA66680001");
  CATALOG_OFFERS.delete("MLA66680002");

  const r = await resolveUserProduct(
    "MLAU1",
    "https://www.mercadolibre.com.ar/contigo-autoseal-473ml/up/MLAU1",
    "T"
  );
  assert.equal(r.ok, false);
  assert.equal(r.candidates.length, 0, "no debe ofrecer opciones muertas");
  assert.match(r.error, /ninguna de las variantes tiene ofertas activas/);
});

await test("si el catalogo no devuelve nada, lo dice sin inventar", async () => {
  CATALOG_SEARCH.length = 0;
  const r = await resolveUserProduct(
    "MLAU9999999999",
    "https://www.mercadolibre.com.ar/producto-inexistente-raro/up/MLAU9999999999",
    "T"
  );
  assert.equal(r.ok, false);
  assert.equal(r.candidates.length, 0);
  assert.match(r.error, /No encontré el producto/);
});

// ---------------------------------------------------------------
console.log("\n== Cobertura: se puede seguir o no ==");

await test("marca 'seguible' un producto con ofertas en catalogo", async () => {
  CATALOG_SEARCH.length = 0;
  CATALOG_SEARCH.push({ id: "MLA70000001", name: "Bubba Matterhorn 1.1L Acero" });
  putOffers("MLA70000001", [
    { item_id: "MLA1000000020", seller_id: 1, price: 52000 },
    { item_id: "MLA1000000021", seller_id: 2, price: 58000 },
  ]);

  const r = await checkCoverage("Bubba Matterhorn 1.1L", "T");
  assert.equal(r.status, "seguible");
  assert.equal(r.price, 52000);
  assert.equal(r.offers_count, 2);
  assert.equal(r.product_id, "MLA70000001");
});

await test("marca 'sin_ofertas' el caso de la tienda oficial con variantes", async () => {
  // Este es exactamente el caso del Contigo Autoseal: el producto existe en
  // el catalogo, pero ninguna publicacion participa, asi que no hay precio.
  CATALOG_SEARCH.length = 0;
  CATALOG_SEARCH.push({
    id: "MLA70000002",
    name: "Botella Termica Contigo 473ml Acero Inoxidable Autoseal",
  });
  CATALOG_OFFERS.delete("MLA70000002");

  const r = await checkCoverage("Contigo Autoseal 473ml", "T");
  assert.equal(r.status, "sin_ofertas");
  assert.equal(r.price, undefined);
  assert.match(r.detail, /no hay precio consultable/);
});

await test("marca 'no_encontrado' lo que no existe en el catalogo", async () => {
  CATALOG_SEARCH.length = 0;
  const r = await checkCoverage("Producto Inventado Xyz", "T");
  assert.equal(r.status, "no_encontrado");
});

await test("elige el candidato con ofertas, no simplemente el primero", async () => {
  // Si el mejor por nombre no tiene ofertas, hay que seguir buscando en la
  // lista en vez de declarar que no se puede seguir.
  CATALOG_SEARCH.length = 0;
  CATALOG_SEARCH.push(
    { id: "MLA70000010", name: "Bubba Keg 1.9L Acero Inoxidable" },
    { id: "MLA70000011", name: "Bubba Keg 1.9L Acero" }
  );
  CATALOG_OFFERS.delete("MLA70000010");
  putOffers("MLA70000011", [{ item_id: "MLA1000000030", seller_id: 5, price: 84000 }]);

  const r = await checkCoverage("Bubba Keg 1.9L Acero Inoxidable", "T");
  assert.equal(r.status, "seguible");
  assert.equal(r.product_id, "MLA70000011");
});

await test("un nombre vacio no rompe", async () => {
  const r = await checkCoverage("   ", "T");
  assert.equal(r.status, "error");
});

// ---------------------------------------------------------------
console.log("\n== Alta de una publicacion (previewItem) ==");

await test("previewItem acepta una ficha de catalogo", async () => {
  const r = await previewItem("MLA74954916", "T", "product");
  assert.equal(r.ok, true);
  assert.equal(r.listing.ml_id, "MLA74954916");
  assert.equal(r.kind, "product");
});

await test("si la publicacion esta prohibida, prueba como ficha de catalogo", async () => {
  // Caso real: el usuario pega un link que parece publicacion, ML lo
  // prohibe, pero el mismo ID tiene ficha de catalogo consultable.
  FORBIDDEN_ITEMS.add("MLA74954916");
  try {
    const r = await previewItem("MLA74954916", "T", "item");
    assert.equal(r.ok, true, "no intento el camino de catalogo");
    assert.equal(r.kind, "product");
  } finally {
    FORBIDDEN_ITEMS.delete("MLA74954916");
  }
});

await test("si esta prohibida y no hay ficha, explica que pegar el link /p/", async () => {
  FORBIDDEN_ITEMS.add("MLA1692028243");
  try {
    const r = await previewItem("MLA1692028243", "T", "item");
    assert.equal(r.ok, false);
    assert.match(r.error, /publicaciones propias/);
    assert.match(r.error, /\/p\//);
  } finally {
    FORBIDDEN_ITEMS.delete("MLA1692028243");
  }
});

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

await test("sigue publicaciones y fichas de catalogo en la misma corrida", async () => {
  putCatalog("MLA74954916");
  putOffers("MLA74954916", [
    { item_id: "MLA2040738333", seller_id: 777, price: 63599 },
    { item_id: "MLA2040738444", seller_id: 888, price: 71000 },
  ]);
  await q(
    `INSERT INTO watchlist (kind, value, label, ml_id, id_kind, active)
     VALUES ('url', 'https://www.mercadolibre.com.ar/bubba/p/MLA74954916', 'Dual Sip 1.53L', 'MLA74954916', 'product', TRUE)
     ON CONFLICT (kind, value) DO UPDATE SET active = TRUE, id_kind = 'product'`
  );
  const r = await runScan(q, { runId: "s20" });
  assert.equal(r.error, undefined);
  assert.ok(r.read_ok >= 2, `solo leyo ${r.read_ok}`);

  const res = await q(
    `SELECT price, seller_id, offers_count, url FROM listings WHERE ml_id = 'MLA74954916'`
  );
  assert.equal(Number(res.rows[0].price), 63599);
  assert.equal(Number(res.rows[0].seller_id), 777);
  assert.equal(res.rows[0].offers_count, 2);
  assert.match(res.rows[0].url, /mercadolibre/);
});

await test("detecta cuando ENTRA un competidor nuevo a la ficha", async () => {
  putOffers("MLA74954916", [
    { item_id: "MLA2040738333", seller_id: 777, price: 63599 },
    { item_id: "MLA2040738444", seller_id: 888, price: 71000 },
    { item_id: "MLA2040738555", seller_id: 999, price: 68000 },
  ]);
  const r = await runScan(q, { runId: "s21" });
  const c = r.ingest.changes.find(
    (x) => x.ml_id === "MLA74954916" && x.change_type === "new_competitor"
  );
  assert.ok(c, "no detecto el competidor nuevo");
  assert.equal(c.old_value, "2");
  assert.equal(c.new_value, "3");
});

await test("detecta cuando otro vendedor pasa a tener el mejor precio", async () => {
  // La señal competitiva mas valiosa de una ficha de catalogo.
  putOffers("MLA74954916", [
    { item_id: "MLA2040738333", seller_id: 777, price: 63599 },
    { item_id: "MLA2040738555", seller_id: 999, price: 59900 },
  ]);
  const r = await runScan(q, { runId: "s22" });
  const seller = r.ingest.changes.find(
    (x) => x.ml_id === "MLA74954916" && x.change_type === "seller_change"
  );
  const price = r.ingest.changes.find(
    (x) => x.ml_id === "MLA74954916" && x.change_type === "price_down"
  );
  assert.ok(seller, "no detecto el cambio de vendedor ganador");
  assert.ok(price, "no detecto la baja de precio");
  assert.equal(price.delta_abs, -3699);
});

await test("detecta cuando SE VA un competidor", async () => {
  putOffers("MLA74954916", [
    { item_id: "MLA2040738555", seller_id: 999, price: 59900 },
  ]);
  const r = await runScan(q, { runId: "s23" });
  const c = r.ingest.changes.find(
    (x) => x.ml_id === "MLA74954916" && x.change_type === "competitor_left"
  );
  assert.ok(c, "no detecto que se fue un competidor");
});

await test("el historial de precios se acumula corrida a corrida", async () => {
  const res = await q(
    `SELECT COUNT(DISTINCT run_id)::int AS n FROM price_snapshots WHERE ml_id = 'MLA1000000100'`
  );
  assert.ok(res.rows[0].n >= 8, `solo ${res.rows[0].n} corridas`);
});

// ===============================================================
// Mi publicacion propia (reemplaza al SKU del Sheet)
// ===============================================================
//
// La regla que ordena todo este bloque, verificada contra la API real:
// Mercado Libre deja leer LAS PUBLICACIONES DE LA CUENTA QUE AUTORIZO, y
// nada mas. De ahi salen los tres casos que importan: anda, es de otra
// cuenta, o no existe. Y de ahi sale que valga la pena listar las propias:
// /users/{id}/items/search es de los pocos endpoints de busqueda abiertos.

console.log("\n== Mi cuenta y mis publicaciones ==");

// Mundo de prueba: tres publicaciones mias, una ajena.
putItem("MLA2097403253", { title: "Botella termica Improm 1L", price: 68000, seller_id: ME_ID });
putItem("MLA2097403254", { title: "Botella termica Improm 750ml", price: 52000, seller_id: ME_ID });
putItem("MLA2097403255", { title: "Vaso termico Improm 470ml", price: 39000, seller_id: ME_ID, status: "paused" });
MY_ITEMS.push("MLA2097403253", "MLA2097403254", "MLA2097403255");

putItem("MLA9000000001", { title: "Termo de la competencia", price: 61000, seller_id: 999 });
FORBIDDEN_ITEMS.add("MLA9000000001");

await test("fetchMe identifica la cuenta conectada", async () => {
  const me = await fetchMe(await getAccessToken(q));
  assert.equal(me.id, ME_ID);
  assert.equal(me.nickname, "IMPROMSA");
});

await test("lista MIS publicaciones con titulo y precio", async () => {
  const items = await fetchMyItemsFromMl(await getAccessToken(q));
  assert.equal(items.length, 3);
  const uno = items.find((i) => i.ml_id === "MLA2097403253");
  assert.equal(uno.price, 68000);
  assert.equal(uno.title, "Botella termica Improm 1L");
});

await test("la lista viene ordenada alfabeticamente", async () => {
  const items = await fetchMyItemsFromMl(await getAccessToken(q));
  const titulos = items.map((i) => i.title);
  assert.deepEqual(titulos, [...titulos].sort((a, b) => a.localeCompare(b, "es")));
});

await test("pagina cuando hay mas publicaciones que el limite", async () => {
  // 250 publicaciones obligan a tres vueltas de /items/search (limit 100).
  const extra = [];
  for (let i = 0; i < 247; i++) {
    const id = `MLA30000000${String(i).padStart(3, "0")}`;
    putItem(id, { title: `Producto ${String(i).padStart(3, "0")}`, seller_id: ME_ID });
    extra.push(id);
  }
  MY_ITEMS.push(...extra);
  const items = await fetchMyItemsFromMl(await getAccessToken(q));
  assert.equal(items.length, 250);
  // Y se limpia para no ensuciar los tests siguientes.
  MY_ITEMS.length = 3;
  for (const id of extra) WORLD.delete(id);
});

await test("si /users/me falla, el error dice que hay que reautorizar", async () => {
  meForbidden = true;
  await assert.rejects(
    () => fetchMyItemsFromMl("token"),
    /autorizar/i,
    "el mensaje tiene que decir que hay que volver a autorizar"
  );
  meForbidden = false;
});

console.log("\n== Leer mi precio (previewOwnItem) ==");

await test("acepta una publicacion propia y devuelve su precio", async () => {
  const r = await previewOwnItem("MLA2097403253", await getAccessToken(q));
  assert.equal(r.ok, true);
  assert.equal(r.listing.price, 68000);
  assert.equal(r.listing.ml_status, "active");
});

await test("acepta una publicacion propia PAUSADA (el precio sigue siendo dato)", async () => {
  const r = await previewOwnItem("MLA2097403255", await getAccessToken(q));
  assert.equal(r.ok, true);
  assert.equal(r.listing.ml_status, "paused");
});

await test("CRITICO: una publicacion de otra cuenta explica el problema real", async () => {
  const r = await previewOwnItem("MLA9000000001", await getAccessToken(q));
  assert.equal(r.ok, false);
  // No alcanza con "403": el mensaje tiene que nombrar la causa (la cuenta)
  // y decir a cual esta conectada, que es lo que costo un dia entero.
  assert.match(r.error, /cuenta/i);
  assert.match(r.error, /IMPROMSA/);
  assert.match(r.error, /incógnito|autorizar/i);
});

await test("un ID inexistente dice que revise el link", async () => {
  const r = await previewOwnItem("MLA2097400000", await getAccessToken(q));
  assert.equal(r.ok, false);
  assert.match(r.error, /no encontró/i);
});

console.log("\n== Resolver lo que la persona elige o pega ==");

await test("acepta el ID que devuelve el buscador", async () => {
  const r = await resolveOwnRef("MLA2097403253", await getAccessToken(q));
  assert.equal(r.ok, true);
  assert.equal(r.ml_id, "MLA2097403253");
});

await test("acepta el link de la publicacion, con guion incluido", async () => {
  const r = await resolveOwnRef(
    "https://articulo.mercadolibre.com.ar/MLA-2097403253-botella-termica-_JM",
    await getAccessToken(q)
  );
  assert.equal(r.ok, true);
  assert.equal(r.ml_id, "MLA2097403253");
});

await test("CRITICO: un link /up/MLAU explica que ese no es el codigo", async () => {
  // Es el error real que se comio Florencia: pego MLAU5205662057 y ML
  // devolvio 404 sin ninguna pista de por que.
  const r = await resolveOwnRef(
    "https://www.mercadolibre.com.ar/botella-termica/up/MLAU5205662057",
    await getAccessToken(q)
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /página de producto/i);
  assert.ok(!/404/.test(r.error), "no tiene que hablar de codigos HTTP");
});

await test("un link de ficha de catalogo tambien se distingue", async () => {
  const r = await resolveOwnRef(
    "https://www.mercadolibre.com.ar/termo/p/MLA74954916",
    await getAccessToken(q)
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /ficha de catálogo/i);
});

await test("algo que no es ni link ni ID no rompe", async () => {
  const r = await resolveOwnRef("mi termo azul", await getAccessToken(q));
  assert.equal(r.ok, false);
  assert.match(r.error, /buscador/i);
});

console.log("\n== Precio propio en lote y cache ==");

await test("el multiget trae solo las propias y avisa de las ajenas", async () => {
  const r = await fetchOwnItems(
    ["MLA2097403253", "MLA2097403254", "MLA9000000001"],
    await getAccessToken(q)
  );
  assert.equal(r.listings.length, 2);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /otra cuenta/i);
});

await test("un ID que no existe se omite, no inventa precio", async () => {
  const r = await fetchOwnItems(["MLA2097403253", "MLA2097400000"], await getAccessToken(q));
  assert.equal(r.listings.length, 1);
});

await test("getOwnItems arma el mapa desde la watchlist", async () => {
  resetOwnItemsCache();
  await q(`UPDATE watchlist SET own_ml_id = NULL`);
  await q(
    `UPDATE watchlist SET own_ml_id = 'MLA2097403253' WHERE ml_id = 'MLA1000000100'`
  );
  const r = await getOwnItems(q);
  assert.equal(r.map.get("MLA2097403253").price, 68000);
});

await test("la segunda llamada usa la cache y no vuelve a pegarle a ML", async () => {
  requestLog = [];
  const r = await getOwnItems(q);
  assert.equal(r.cached, true);
  assert.ok(
    !requestLog.some((u) => u.startsWith("/items?ids=")),
    `pego a ML igual: ${requestLog.join(" ")}`
  );
});

await test("sin publicaciones asociadas devuelve vacio sin llamar a ML", async () => {
  resetOwnItemsCache();
  await q(`UPDATE watchlist SET own_ml_id = NULL`);
  requestLog = [];
  const r = await getOwnItems(q);
  assert.equal(r.map.size, 0);
  assert.equal(requestLog.length, 0);
});

await test("si ML falla, getMyItems conserva la ultima lista buena", async () => {
  resetMyItemsCache();
  const primera = await getMyItems(q);
  assert.equal(primera.items.length, 3);

  myItemsStatus = 500;
  const segunda = await getMyItems(q, { force: true });
  myItemsStatus = 200;

  assert.equal(segunda.items.length, 3, "vacio la lista por un error puntual");
  assert.ok(segunda.error, "no reporto el error");
});

console.log("\n== Diferencia de precio ==");

await test("positivo = estas mas caro", () => {
  assert.deepEqual(diffAgainst(68000, 63599), { diff_abs: 4401, diff_pct: 6.9 });
});

await test("negativo = estas mas barato", () => {
  const d = diffAgainst(59900, 63599);
  assert.ok(d.diff_pct < 0);
});

await test("CRITICO: sin precio propio no inventa una diferencia", () => {
  assert.deepEqual(diffAgainst(null, 63599), { diff_abs: null, diff_pct: null });
});

await test("CRITICO: un precio de referencia 0 no da 100% ni infinito", () => {
  assert.deepEqual(diffAgainst(68000, 0), { diff_abs: null, diff_pct: null });
});

await test("un precio de referencia no numerico tampoco", () => {
  assert.deepEqual(diffAgainst(68000, Number.NaN), { diff_abs: null, diff_pct: null });
});

// ===============================================================
// Seguir a UN VENDEDOR dentro de la ficha (v17)
// ===============================================================
//
// El cambio nace de un caso real: la ficha MLA58102043 (Contigo
// Matterhorn 591ml) tiene 67 ofertas. La mas barata era $29.950 de un
// vendedor suelto CON $8.490 de envio; la que Mercado Libre destacaba
// arriba era de $42.649. La app mostraba $29.950 y eso no es contra quien
// se compite.
//
// Verificado ademas el 25/09/2026 con el token real: `buy_box_winner`
// viene NULL, asi que la oferta destacada por ML no se puede obtener. La
// salida es elegir el vendedor a mano y seguirlo a el.

console.log("\n== Seguir a un vendedor puntual ==");

const FICHA = "MLA90000001";
putCatalog(FICHA, { name: "Botella Termica Contigo Matterhorn 591ml" });
putOffers(FICHA, [
  // Barata pero con envio caro: no es la mas barata de verdad.
  { item_id: "MLA800000001", seller_id: 888, price: 29950, free_shipping: false, shipping_cost: 8490 },
  { item_id: "MLA800000002", seller_id: 999, price: 35000, free_shipping: true },
  { item_id: "MLA800000003", seller_id: 555, price: 42649, free_shipping: true, official_store_id: 12 },
]);

await test("sin vendedor elegido sigue tomando la mas barata (compatibilidad)", async () => {
  const r = await fetchCatalogProduct(FICHA, await getAccessToken(q));
  assert.equal(r.ok, true);
  assert.equal(r.listing.price, 29950);
  assert.equal(r.pick, "mas-barata");
});

await test("CRITICO: con vendedor elegido reporta SU precio, no el mas barato", async () => {
  const r = await fetchCatalogProduct(FICHA, await getAccessToken(q), {
    trackedItemId: "MLA800000003",
    trackedSellerId: 555,
  });
  assert.equal(r.ok, true);
  assert.equal(r.listing.price, 42649, "tomo el precio equivocado");
  assert.equal(r.listing.seller_id, 555);
  assert.equal(r.pick, "seguida");
});

await test("si el vendedor republica con otro ID, lo vuelve a encontrar", async () => {
  // Mismo vendedor 999, publicacion nueva: no es una baja.
  putOffers(FICHA, [
    { item_id: "MLA800000001", seller_id: 888, price: 29950, free_shipping: false, shipping_cost: 8490 },
    { item_id: "MLA800000099", seller_id: 999, price: 36500, free_shipping: true },
  ]);
  const r = await fetchCatalogProduct(FICHA, await getAccessToken(q), {
    trackedItemId: "MLA800000002",
    trackedSellerId: 999,
  });
  assert.equal(r.ok, true);
  assert.equal(r.listing.price, 36500);
  assert.equal(r.pick, "seguida-nuevo-id");
  assert.ok(
    r.warnings.some((w) => /cambió de publicación/i.test(w)),
    "no aviso del cambio de publicacion"
  );
});

await test("CRITICO: si el vendedor se fue, NO se cae a otra oferta", async () => {
  // Es el error mas caro posible: cambiar de competidor en silencio haria
  // que la serie de precios mezcle vendedores y que "bajo el precio"
  // signifique en realidad "entro otro mas barato".
  const r = await fetchCatalogProduct(FICHA, await getAccessToken(q), {
    trackedItemId: "MLA800000003",
    trackedSellerId: 555,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.match(r.error, /vendedor que seguís/i);
});

await test("el precio con envio es el que hace comparables dos ofertas", () => {
  assert.equal(
    precioConEnvio({ price: 29950, free_shipping: false, shipping_cost: 8490 }),
    38440
  );
  assert.equal(precioConEnvio({ price: 35000, free_shipping: true }), 35000);
});

console.log("\n== Lista de vendedores para elegir ==");

await test("lista las ofertas con nombre de vendedor y precio con envio", async () => {
  putOffers(FICHA, [
    { item_id: "MLA800000001", seller_id: 888, price: 29950, free_shipping: false, shipping_cost: 8490 },
    { item_id: "MLA800000002", seller_id: 999, price: 35000, free_shipping: true },
    { item_id: "MLA800000003", seller_id: 555, price: 42649, free_shipping: true, official_store_id: 12 },
  ]);
  const r = await fetchOfferChoices(FICHA, await getAccessToken(q));
  assert.equal(r.ok, true);
  assert.equal(r.offers.length, 3);
  // Primera por precio real: $35.000 con envio gratis, no la de $29.950
  // que con envio termina en $38.440.
  assert.equal(r.offers[0].seller, "MUGSHOP");
  assert.equal(r.offers[0].price_total, 35000);
  assert.equal(r.offers[1].seller, "CHARCO");
  assert.equal(r.offers[1].price_total, 38440);
});

await test("CRITICO: ordena por precio REAL, no por el de lista", async () => {
  // $29.950 + $8.490 de envio = $38.440, o sea mas caro que el de $35.000.
  // Ordenar por precio de lista pondria primera una oferta que no es la
  // mas barata, que es justo el malentendido que origino esta version.
  const r = await fetchOfferChoices(FICHA, await getAccessToken(q));
  assert.deepEqual(
    r.offers.map((o) => o.item_id),
    ["MLA800000002", "MLA800000001", "MLA800000003"]
  );
});

await test("marca cual es tienda oficial", async () => {
  const r = await fetchOfferChoices(FICHA, await getAccessToken(q));
  const oficial = r.offers.find((o) => o.item_id === "MLA800000003");
  assert.equal(oficial.official_store, true);
});

await test("si ML no habilita los nombres, devuelve null y no rompe", async () => {
  sellersForbidden = true;
  const r = await fetchOfferChoices(FICHA, await getAccessToken(q));
  sellersForbidden = false;
  assert.equal(r.ok, true);
  assert.equal(r.offers[0].seller, null);
  assert.ok(r.offers[0].seller_id, "sin nombre, al menos tiene que quedar el ID");
});

await test("una ficha sin ofertas explica que no hay a quien seguir", async () => {
  const vacia = "MLA90000002";
  putCatalog(vacia, { name: "Ficha sin vendedores" });
  const r = await fetchOfferChoices(vacia, await getAccessToken(q));
  assert.equal(r.ok, false);
  assert.match(r.error, /no tiene ofertas activas|a quién seguir/i);
});

console.log("\n== La corrida diaria respeta el vendedor elegido ==");

await test("la corrida sigue al vendedor guardado en la lista", async () => {
  putOffers(FICHA, [
    { item_id: "MLA800000001", seller_id: 888, price: 29950, free_shipping: false, shipping_cost: 8490 },
    { item_id: "MLA800000003", seller_id: 555, price: 42649, free_shipping: true },
  ]);
  await q(`DELETE FROM watchlist WHERE value = $1`, ["ficha-vendedor"]);
  await q(
    `INSERT INTO watchlist (kind, value, label, ml_id, id_kind,
                            tracked_item_id, tracked_seller_id, active)
     VALUES ('url', 'ficha-vendedor', 'Contigo Matterhorn', $1, 'product', $2, $3, TRUE)`,
    [FICHA, "MLA800000003", 555]
  );

  const r = await runScan(q, { runId: "v17-1" });
  const fila = await q(`SELECT price FROM listings WHERE ml_id = $1`, [FICHA]);
  assert.equal(
    Number(fila.rows[0].price),
    42649,
    "la corrida tomo la mas barata en vez del vendedor elegido"
  );
});

await test("detecta que ESE vendedor bajo el precio", async () => {
  putOffers(FICHA, [
    { item_id: "MLA800000001", seller_id: 888, price: 29950, free_shipping: false, shipping_cost: 8490 },
    { item_id: "MLA800000003", seller_id: 555, price: 39900, free_shipping: true },
  ]);
  const r = await runScan(q, { runId: "v17-2" });
  const c = r.ingest.changes.find(
    (x) => x.ml_id === FICHA && x.change_type === "price_down"
  );
  assert.ok(c, "no detecto la baja del vendedor seguido");
  assert.equal(Number(c.new_value), 39900);
});

await test("si el vendedor seguido se va, lo reporta y avisa por que", async () => {
  putOffers(FICHA, [
    { item_id: "MLA800000001", seller_id: 888, price: 29950, free_shipping: false, shipping_cost: 8490 },
  ]);
  const r = await runScan(q, { runId: "v17-3" });
  assert.ok(
    r.warnings.some((w) => /vendedor que seguís/i.test(w)),
    `no explico por que: ${r.warnings.join(" | ")}`
  );
  const fila = await q(`SELECT price FROM listings WHERE ml_id = $1`, [FICHA]);
  assert.equal(
    Number(fila.rows[0].price),
    39900,
    "CRITICO: se cambio solo de vendedor en vez de reportar la ausencia"
  );
});

console.log("\n== La lista no puede esconder vendedores ==");

await test("CRITICO: devuelve TODOS los vendedores, sin recortar", async () => {
  // Bug real: habia un tope de 40 para ahorrar consultas de nombres. Las
  // tiendas oficiales suelen estar en el tramo caro, justo el que se
  // cortaba, asi que quien entraba desde una tienda oficial no la
  // encontraba en la lista.
  const muchas = "MLA90000003";
  putCatalog(muchas, { name: "Ficha con muchas ofertas" });
  const ofertas = [];
  for (let i = 0; i < 67; i++) {
    ofertas.push({
      item_id: `MLA81000${String(i).padStart(4, "0")}`,
      seller_id: 1000 + i,
      price: 20000 + i * 500,
      free_shipping: true,
      // La tienda oficial, ultima y mas cara: el caso que fallaba.
      official_store_id: i === 66 ? 193704 : null,
    });
  }
  putOffers(muchas, ofertas);

  const r = await fetchOfferChoices(muchas, await getAccessToken(q));
  assert.equal(r.ok, true);
  assert.equal(r.offers.length, 67, "recorto la lista");
  const oficial = r.offers.find((o) => o.official_store);
  assert.ok(oficial, "la tienda oficial no aparece");
  assert.equal(oficial.official_store_id, 193704);
});

await test("resuelve el nombre de la tienda oficial aunque este al final", async () => {
  const r = await fetchOfferChoices("MLA90000003", await getAccessToken(q));
  const oficial = r.offers.find((o) => o.official_store);
  assert.ok(oficial.seller, "quedo sin nombre justo la que se busca a ojo");
});

await test("lee el numero de tienda oficial del link", () => {
  // URL real de Florencia, con el filtro escapado.
  const url =
    "https://www.mercadolibre.com.ar/vaso-termico-contigo/p/MLA63891136" +
    "?pdp_filters=item_id%3AMLA1697454891&pdp_filters=official_store%3A193704";
  assert.equal(hintedOfficialStore(url), 193704);
  assert.equal(hintedItemId(url), "MLA1697454891");
});

await test("sin tienda oficial en el link devuelve null", () => {
  assert.equal(hintedOfficialStore("https://www.mercadolibre.com.ar/x/p/MLA1"), null);
});

// ---------------------------------------------------------------
console.log(`\n${passed} pasaron, ${failed} fallaron\n`);
globalThis.fetch = realFetch;
await client.end();
server.close();
process.exit(failed > 0 ? 1 : 0);
