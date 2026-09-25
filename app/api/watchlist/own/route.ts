import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import { isLoggedIn } from "@/lib/auth";
import { getAccessToken } from "@/lib/ml-api";
import { resolveOwnRef } from "@/lib/own-items";
import type { Query } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const maxDuration = 30;

const query: Query = (text, params) => sql.query(text, params ?? []);

/**
 * POST /api/watchlist/own   { ml_id, own }
 *
 * Asocia (o desasocia, con `own` vacío) MI publicación al producto de la
 * competencia que estoy siguiendo.
 *
 * El precio no se guarda acá: se lee de Mercado Libre en cada consulta.
 * Lo único que se guarda es cuál es mi publicación.
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

  const mlId = String(body?.ml_id ?? "").trim().toUpperCase();
  const own = String(body?.own ?? "").trim();
  if (!mlId) {
    return NextResponse.json({ error: "falta ml_id" }, { status: 400 });
  }

  try {
    // Desasociar.
    if (!own) {
      await query(
        `UPDATE watchlist SET own_ml_id = NULL, own_url = NULL WHERE ml_id = $1`,
        [mlId]
      );
      await query(
        `UPDATE listings SET own_ml_id = NULL, own_url = NULL WHERE ml_id = $1`,
        [mlId]
      );
      return NextResponse.json({ ok: true, ml_id: mlId, own_ml_id: null });
    }

    const token = await getAccessToken(query);
    const resolved = await resolveOwnRef(own, token);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }

    await query(
      `UPDATE watchlist SET own_ml_id = $2, own_url = $3 WHERE ml_id = $1`,
      [mlId, resolved.ml_id, resolved.url]
    );
    await query(
      `UPDATE listings SET own_ml_id = $2, own_url = $3 WHERE ml_id = $1`,
      [mlId, resolved.ml_id, resolved.url]
    );

    return NextResponse.json({
      ok: true,
      ml_id: mlId,
      own_ml_id: resolved.ml_id,
      own_url: resolved.url,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
