/**
 * Tests del partido de sentencias SQL y de la creacion de tablas.
 *
 * POR QUE EXISTE ESTE ARCHIVO
 * ---------------------------
 * El bug que motivo estos tests: /api/setup partia el schema por ";" y
 * despues descartaba los pedazos que empezaban con "--". Como cada
 * CREATE TABLE del schema viene precedido por un comentario, el pedazo
 * entero se descartaba en silencio y solo se ejecutaban los CREATE INDEX,
 * que despues fallaban con 'relation "listings" does not exist'.
 *
 * Los tests anteriores no lo detectaron porque ejecutaban el schema.sql
 * completo de una sola vez con el cliente `pg` (que soporta multiples
 * sentencias), sin pasar nunca por la logica de partido de la ruta.
 *
 * Estos tests ejecutan el schema **sentencia por sentencia**, igual que
 * el driver HTTP de Neon en produccion.
 *
 * Correr:  npx tsx tests/setup.test.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import pg from "pg";

import { splitSqlStatements } from "../lib/sql-split";

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

const schema = readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8");

// ---------------------------------------------------------------
console.log("\n== splitSqlStatements (unitario) ==");

await test("no descarta una sentencia por venir precedida de un comentario", () => {
  const sql = `
    -- Un comentario explicativo
    -- en dos lineas
    CREATE TABLE foo (id INT);
  `;
  const out = splitSqlStatements(sql);
  assert.equal(out.length, 1);
  assert.match(out[0], /^CREATE TABLE foo/);
});

await test("ignora un ';' que esta dentro de un literal", () => {
  const sql = `INSERT INTO t (a) VALUES ('hola; chau'); SELECT 1;`;
  const out = splitSqlStatements(sql);
  assert.equal(out.length, 2);
  assert.match(out[0], /hola; chau/);
});

await test("ignora un '--' que esta dentro de un literal", () => {
  const sql = `INSERT INTO t (a) VALUES ('guion -- doble'); SELECT 2;`;
  const out = splitSqlStatements(sql);
  assert.equal(out.length, 2);
  assert.match(out[0], /guion -- doble/);
});

await test("respeta las comillas escapadas ('')", () => {
  const sql = `INSERT INTO t (a) VALUES ('O''Brien; test'); SELECT 3;`;
  const out = splitSqlStatements(sql);
  assert.equal(out.length, 2);
  assert.match(out[0], /O''Brien; test/);
});

await test("saca los comentarios al final de una linea con SQL", () => {
  const sql = `CREATE TABLE t (
    status TEXT DEFAULT 'active',  -- active | delisted
    id INT
  );`;
  const out = splitSqlStatements(sql);
  assert.equal(out.length, 1);
  assert.ok(!out[0].includes("delisted"), "quedo el comentario adentro");
  assert.match(out[0], /'active'/);
});

await test("maneja comentarios de bloque", () => {
  const sql = `/* bloque
  con ; adentro */ SELECT 1; SELECT 2;`;
  const out = splitSqlStatements(sql);
  assert.equal(out.length, 2);
});

await test("no devuelve sentencias vacias", () => {
  const out = splitSqlStatements(`SELECT 1;;;\n\n-- solo comentario\n;`);
  assert.equal(out.length, 1);
});

await test("un archivo que es solo comentarios devuelve cero sentencias", () => {
  assert.equal(splitSqlStatements("-- nada\n-- que hacer\n").length, 0);
});

// ---------------------------------------------------------------
console.log("\n== schema.sql real, sentencia por sentencia ==");

const statements = splitSqlStatements(schema);

await test("encuentra todas las sentencias del schema", () => {
  // 6 tablas + indices + el INSERT del watchlist inicial
  assert.ok(statements.length >= 15, `solo encontro ${statements.length}`);
});

await test("REGRESION: no se pierde ningun CREATE TABLE", () => {
  const tablesInFile = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(
    (m) => m[1]
  );
  const tablesInStatements = statements
    .map((s) => s.match(/^CREATE TABLE IF NOT EXISTS (\w+)/)?.[1])
    .filter(Boolean);

  assert.deepEqual(
    tablesInStatements.sort(),
    tablesInFile.sort(),
    "hay CREATE TABLE en el archivo que no sobrevivieron al partido"
  );
  assert.equal(tablesInFile.length, 6);
});

const client = new pg.Client({ connectionString: PGURL });
await client.connect();

await test("ejecuta el schema completo de a una sentencia, sin errores", async () => {
  await client.query(
    `DROP TABLE IF EXISTS price_snapshots, changes, listings, runs, watchlist, ml_tokens CASCADE`
  );
  for (const [i, stmt] of statements.entries()) {
    try {
      await client.query(stmt);
    } catch (err) {
      throw new Error(
        `sentencia ${i + 1}/${statements.length} falló: ${err.message}\n      ${stmt.slice(0, 120)}`
      );
    }
  }
});

await test("quedaron creadas las 6 tablas que la app necesita", async () => {
  const expected = [
    "changes",
    "listings",
    "ml_tokens",
    "price_snapshots",
    "runs",
    "watchlist",
  ];
  const res = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [expected]
  );
  assert.deepEqual(res.rows.map((r) => r.table_name), expected);
});

await test("el watchlist arranca vacio", async () => {
  // Ya no se precarga nada: el usuario agrega los links que quiere seguir.
  const res = await client.query(`SELECT COUNT(*)::int AS n FROM watchlist`);
  assert.equal(res.rows[0].n, 0);
});

await test("v17: las columnas del vendedor seguido existen", async () => {
  // Sin estas, la corrida diaria vuelve a seguir "la mas barata del dia"
  // sin ningun error visible: el peor modo de falla.
  const res = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'watchlist' AND column_name IN ('tracked_item_id','tracked_seller_id','tracked_seller'))
          OR (table_name = 'listings' AND column_name IN ('tracked_item_id','tracked_seller_id')))`
  );
  assert.equal(res.rows.length, 5, `faltan columnas: ${res.rows.length}/5`);
});

await test("v16: las columnas de mi publicacion propia existen", async () => {
  // Si faltan, el tablero abre pero la columna "Mi publicación" queda muda
  // sin ningun error visible: el peor modo de falla posible.
  const res = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name IN ('watchlist','listings') AND column_name IN ('own_ml_id','own_url'))
          OR (table_name = 'ml_tokens' AND column_name IN ('ml_user_id','ml_nickname')))`
  );
  assert.equal(res.rows.length, 6, `faltan columnas: ${res.rows.length}/6`);
});

await test("las columnas que agregan las migraciones existen", async () => {
  const res = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'listings' AND column_name IN ('ml_status','available_quantity','seller_id'))
         OR (table_name = 'price_snapshots' AND column_name IN ('ml_status','available_quantity'))
         OR (table_name = 'watchlist' AND column_name = 'ml_id'))`
  );
  assert.equal(res.rows.length, 6, `faltan columnas: encontradas ${res.rows.length}/6`);
});

await test("las migraciones son idempotentes (ADD COLUMN IF NOT EXISTS)", async () => {
  for (const stmt of statements) await client.query(stmt);
  const res = await client.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_schema='public' AND table_name='listings' AND column_name='ml_status'`
  );
  assert.equal(res.rows[0].n, 1);
});

await test("los indices quedaron creados", async () => {
  const res = await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
  );
  const names = res.rows.map((r) => r.indexname);
  for (const idx of [
    "listings_brand_idx",
    "changes_detected_idx",
    "snapshots_ml_id_idx",
    "runs_started_idx",
  ]) {
    assert.ok(names.includes(idx), `falta el indice ${idx}`);
  }
});

await test("correrlo dos veces no borra los links que el usuario cargo", async () => {
  await client.query(
    `INSERT INTO watchlist (kind, value, label, ml_id, active)
     VALUES ('url', 'https://articulo.mercadolibre.com.ar/MLA-1234567890-x', 'Un termo', 'MLA1234567890', TRUE)`
  );
  for (const stmt of statements) await client.query(stmt);
  const res = await client.query(
    `SELECT active FROM watchlist WHERE ml_id = 'MLA1234567890'`
  );
  assert.equal(res.rows.length, 1, "se borro la entrada del usuario");
  assert.equal(res.rows[0].active, true, "se desactivo una entrada de tipo url");
});

await test("la restriccion de una sola fila de tokens sobrevive", async () => {
  await assert.rejects(() =>
    client.query(
      `INSERT INTO ml_tokens (id, access_token, refresh_token, expires_at)
       VALUES (2, 'a', 'b', NOW())`
    )
  );
});

// ---------------------------------------------------------------
console.log(`\n${passed} pasaron, ${failed} fallaron\n`);
await client.end();
process.exit(failed > 0 ? 1 : 0);
