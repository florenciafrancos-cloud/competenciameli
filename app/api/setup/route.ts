import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { splitSqlStatements } from "@/lib/sql-split";
import { isLoggedIn } from "@/lib/auth";
import { readFileSync } from "fs";
import { join } from "path";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/setup
 *
 * Crea las tablas. Se puede correr varias veces sin riesgo: todo el
 * schema es CREATE TABLE / CREATE INDEX ... IF NOT EXISTS.
 *
 * Autoriza de dos formas:
 *  - Con la sesion del dashboard (el boton "Crear las tablas").
 *  - Con Authorization: Bearer <INGEST_SECRET>, para hacerlo por curl.
 */
export async function POST(req: Request) {
  const secret = process.env.INGEST_SECRET;
  const auth = req.headers.get("authorization");

  const byToken = !!secret && auth === `Bearer ${secret}`;
  const bySession = !auth && (await isLoggedIn());

  if (!byToken && !bySession) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  try {
    const schema = readFileSync(join(process.cwd(), "db", "schema.sql"), "utf8");
    const statements = splitSqlStatements(schema);

    if (statements.length === 0) {
      return NextResponse.json(
        { error: "No se encontro ninguna sentencia en db/schema.sql" },
        { status: 500 }
      );
    }

    const executed: string[] = [];
    for (const stmt of statements) {
      try {
        await sql.query(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
          {
            error: `Falló la sentencia ${executed.length + 1} de ${statements.length}: ${msg}`,
            failed_statement: stmt.slice(0, 300),
            executed_ok: executed,
          },
          { status: 500 }
        );
      }
      executed.push(firstLine(stmt));
    }

    // Verificamos que las tablas que la app necesita quedaron creadas,
    // en vez de confiar en que no hubo excepciones.
    const expected = [
      "watchlist",
      "listings",
      "price_snapshots",
      "changes",
      "runs",
      "ml_tokens",
    ];
    const check = await sql.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [expected]
    );
    const found = check.rows.map((r: any) => r.table_name);
    const missing = expected.filter((t) => !found.includes(t));

    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: `Se ejecutó el schema pero faltan tablas: ${missing.join(", ")}`,
          statements: statements.length,
          executed_ok: executed,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      statements: statements.length,
      tables: found.sort(),
      executed: executed,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/** GET: dice si las tablas ya existen, sin crear nada. */
export async function GET() {
  try {
    const check = await sql.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`
    );
    return NextResponse.json({
      tables: check.rows.map((r: any) => r.table_name),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

function firstLine(stmt: string): string {
  return stmt.split("\n")[0].trim().slice(0, 90);
}
