import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import { getAccessToken, checkCoverage, type CoverageRow } from "@/lib/ml-api";
import { isLoggedIn } from "@/lib/auth";
import type { Query } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const maxDuration = 300;

const query: Query = (text, params) => sql.query(text, params ?? []);

/**
 * POST /api/ml/coverage   { names: string[] }  ó  { text: "uno por línea" }
 *
 * Contesta, producto por producto, si se puede seguir con esta herramienta.
 * Sirve para decidir con datos si la app cubre tu catálogo o no.
 */
export async function POST(req: Request) {
  await ensureSchema(query);

  if (!(await isLoggedIn())) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalido" }, { status: 400 });
  }

  const fromText = String(body?.text ?? "")
    .split("\n")
    .map((l: string) => l.trim())
    .filter(Boolean);
  const names: string[] = Array.isArray(body?.names)
    ? body.names.map((n: unknown) => String(n).trim()).filter(Boolean)
    : fromText;

  if (names.length === 0) {
    return NextResponse.json(
      { error: "Pegá los nombres de tus productos, uno por línea." },
      { status: 400 }
    );
  }

  // Tope para no pasarse del tiempo de la función: cada producto son
  // hasta 5 pedidos a la API.
  const MAX = 40;
  const batch = names.slice(0, MAX);

  try {
    const token = await getAccessToken(query);
    const rows: CoverageRow[] = [];
    for (const n of batch) {
      rows.push(await checkCoverage(n, token));
    }

    const resumen = {
      total: rows.length,
      seguibles: rows.filter((r) => r.status === "seguible").length,
      sin_ofertas: rows.filter((r) => r.status === "sin_ofertas").length,
      no_encontrados: rows.filter((r) => r.status === "no_encontrado").length,
      errores: rows.filter((r) => r.status === "error").length,
    };

    return NextResponse.json({
      ok: true,
      resumen,
      omitidos: Math.max(0, names.length - batch.length),
      rows,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
