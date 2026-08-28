import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { readFileSync } from "fs";
import { join } from "path";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/setup
 * Crea las tablas la primera vez. Se puede correr varias veces sin
 * riesgo (todo es CREATE TABLE IF NOT EXISTS).
 *
 * Protegido con el mismo INGEST_SECRET.
 *   curl -X POST https://tu-app.vercel.app/api/setup \
 *        -H "Authorization: Bearer TU_INGEST_SECRET"
 */
export async function POST(req: Request) {
  const secret = process.env.INGEST_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "INGEST_SECRET no configurada" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  try {
    const schemaPath = join(process.cwd(), "db", "schema.sql");
    const schema = readFileSync(schemaPath, "utf8");

    // Partimos por ";" al final de linea para ejecutar sentencia por sentencia.
    const statements = schema
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("--"));

    const done: string[] = [];
    for (const stmt of statements) {
      await sql.query(stmt);
      done.push(stmt.split("\n")[0].slice(0, 80));
    }

    return NextResponse.json({ ok: true, statements: done.length, first_lines: done });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
