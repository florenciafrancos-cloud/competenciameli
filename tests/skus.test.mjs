/**
 * Tests de la lectura del Sheet de SKU y precios.
 *
 * Es la parte con más riesgo de romperse en silencio: un CSV real de Google
 * trae comas dentro de los nombres, precios en formato argentino, filas
 * vacías y encabezados. Si esto falla, la app muestra "sin precio" y la
 * comparación contra la competencia no sirve para nada.
 *
 * Correr:  npx tsx tests/skus.test.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseCsv, parsePrice, colIndex, getSkuList, resetSkuCache } from "../lib/skus";

/** Misma cuenta que hace la app para mostrar la diferencia. */
function diffPct(own, competencia) {
  if (own == null || competencia == null || competencia === 0) return null;
  return Number((((own - competencia) / competencia) * 100).toFixed(1));
}

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
console.log("\n== Columnas ==");

await test("convierte letra de columna a indice", () => {
  assert.equal(colIndex("A"), 0);
  assert.equal(colIndex("E"), 4);
  assert.equal(colIndex("Z"), 25);
  assert.equal(colIndex("AA"), 26);
  assert.equal(colIndex("a"), 0);
  assert.equal(colIndex("1"), -1);
});

// ---------------------------------------------------------------
console.log("\n== Precios en formato argentino ==");

await test("lee los formatos que salen de un Sheet real", () => {
  assert.equal(parsePrice("68000"), 68000);
  assert.equal(parsePrice("68.000"), 68000);
  assert.equal(parsePrice("$ 68.000"), 68000);
  assert.equal(parsePrice("$68.000,50"), 68000.5);
  assert.equal(parsePrice("68.000,00"), 68000);
  assert.equal(parsePrice("1.234.567"), 1234567);
  assert.equal(parsePrice("68000.50"), 68000.5);
  assert.equal(parsePrice(" 68000 "), 68000);
});

await test("devuelve null cuando no hay precio, sin inventar cero", () => {
  // Un cero inventado diria "estas 100% arriba" y seria mentira.
  assert.equal(parsePrice(""), null);
  assert.equal(parsePrice("-"), null);
  assert.equal(parsePrice("s/d"), null);
  assert.equal(parsePrice("0"), null);
  assert.equal(parsePrice("consultar"), null);
});

// ---------------------------------------------------------------
console.log("\n== CSV ==");

await test("respeta las comas dentro de un nombre entre comillas", () => {
  const rows = parseCsv('P01.001,"Termo Bubba, 1.1L, acero",X,Y,68000\n');
  assert.equal(rows[0].length, 5);
  assert.equal(rows[0][1], "Termo Bubba, 1.1L, acero");
  assert.equal(rows[0][4], "68000");
});

await test("respeta comillas escapadas y saltos de linea internos", () => {
  const rows = parseCsv('A,"dice ""hola""",C\nB,"dos\nlineas",D\n');
  assert.equal(rows[0][1], 'dice "hola"');
  assert.equal(rows[1][1], "dos\nlineas");
  assert.equal(rows.length, 2);
});

await test("aguanta CRLF y BOM, que es lo que manda Google", () => {
  const rows = parseCsv("﻿A,B\r\nC,D\r\n");
  assert.deepEqual(rows[0], ["A", "B"]);
  assert.deepEqual(rows[1], ["C", "D"]);
});

// ---------------------------------------------------------------
console.log("\n== Lectura del Sheet publicado ==");

// Servidor que hace de Google.
let serve = () => ({ status: 200, body: "", type: "text/csv" });
const server = createServer((req, res) => {
  const r = serve();
  res.writeHead(r.status, { "Content-Type": r.type });
  res.end(r.body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/csv`;
process.env.SHEET_CSV_URL = BASE;

await test("lee SKU de la columna A y precio de la E", async () => {
  serve = () => ({
    status: 200,
    type: "text/csv",
    body:
      "SKU,NOMBRE,MARCA,COLOR,PRECIO\n" +
      "P02.015,Bubba Dual Sip 1.53L,Bubba,Rosa,68.000\n" +
      "P03.021,Contigo Autoseal 473ml,Contigo,Negro,$ 42.500\n",
  });
  resetSkuCache();
  const r = await getSkuList({ force: true });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].sku, "P02.015");
  assert.equal(r.rows[0].price, 68000);
  assert.equal(r.rows[1].price, 42500);
  assert.equal(r.rows[0].label, "Bubba Dual Sip 1.53L");
});

await test("saltea el encabezado y las filas sin SKU", async () => {
  serve = () => ({
    status: 200,
    type: "text/csv",
    body: "SKU,NOMBRE,A,B,PRECIO\n,,,,\nP01.001,Termo,x,y,50000\n,,,,\n",
  });
  resetSkuCache();
  const r = await getSkuList({ force: true });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].sku, "P01.001");
});

await test("un SKU sin precio queda en null, no en cero", async () => {
  serve = () => ({
    status: 200,
    type: "text/csv",
    body: "SKU,N,A,B,PRECIO\nP01.001,Termo,x,y,\n",
  });
  resetSkuCache();
  const r = await getSkuList({ force: true });
  assert.equal(r.rows[0].price, null);
});

await test("no repite un SKU que aparece dos veces", async () => {
  serve = () => ({
    status: 200,
    type: "text/csv",
    body: "SKU,N,A,B,PRECIO\nP01.001,Termo,x,y,50000\nP01.001,Termo otra vez,x,y,60000\n",
  });
  resetSkuCache();
  const r = await getSkuList({ force: true });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].price, 50000, "deberia quedarse con la primera");
});

await test("CRITICO: si el Sheet no esta publicado, avisa y no devuelve basura", async () => {
  // Google devuelve una pagina HTML de login. Parsearla daria SKUs
  // inventados a partir del HTML.
  serve = () => ({
    status: 200,
    type: "text/html",
    body: "<!DOCTYPE html><html><body>Iniciar sesión</body></html>",
  });
  resetSkuCache();
  const r = await getSkuList({ force: true });
  assert.equal(r.rows.length, 0);
  assert.match(r.error, /no está publicado/);
});

await test("si el Sheet falla, conserva la ultima lista buena", async () => {
  serve = () => ({
    status: 200,
    type: "text/csv",
    body: "SKU,N,A,B,PRECIO\nP09.999,Termo,x,y,77000\n",
  });
  resetSkuCache();
  await getSkuList({ force: true });

  serve = () => ({ status: 500, type: "text/csv", body: "boom" });
  const r = await getSkuList({ force: true });
  assert.equal(r.rows.length, 1, "perdio la lista por un error temporal");
  assert.equal(r.rows[0].sku, "P09.999");
  assert.ok(r.error);
});

await test("sin SHEET_CSV_URL lo dice claro, no rompe", async () => {
  const prev = process.env.SHEET_CSV_URL;
  delete process.env.SHEET_CSV_URL;
  resetSkuCache();
  const r = await getSkuList({ force: true });
  assert.equal(r.rows.length, 0);
  assert.match(r.error, /SHEET_CSV_URL/);
  process.env.SHEET_CSV_URL = prev;
});

await test("cachea para no pedirle el CSV a Google en cada click", async () => {
  let hits = 0;
  serve = () => {
    hits++;
    return {
      status: 200,
      type: "text/csv",
      body: "SKU,N,A,B,PRECIO\nP01.001,Termo,x,y,50000\n",
    };
  };
  resetSkuCache();
  await getSkuList({ force: true });
  await getSkuList();
  await getSkuList();
  assert.equal(hits, 1, `pidio el CSV ${hits} veces`);
});

// ---------------------------------------------------------------
console.log("\n== Diferencia contra la competencia ==");

await test("estar mas caro da porcentaje positivo", () => {
  assert.equal(diffPct(68000, 63599), 6.9);
});

await test("estar mas barato da porcentaje negativo", () => {
  assert.equal(diffPct(59000, 63599), -7.2);
});

await test("mismo precio da cero", () => {
  assert.equal(diffPct(63599, 63599), 0);
});

await test("sin precio propio no se inventa una diferencia", () => {
  // Es el caso de un SKU sin precio cargado en el Sheet.
  assert.equal(diffPct(null, 63599), null);
});

await test("sin precio de competencia tampoco", () => {
  assert.equal(diffPct(68000, null), null);
  assert.equal(diffPct(68000, 0), null);
});

// ---------------------------------------------------------------
console.log(`\n${passed} pasaron, ${failed} fallaron\n`);
server.close();
process.exit(failed > 0 ? 1 : 0);
