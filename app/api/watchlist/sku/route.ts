import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import { isLoggedIn } from "@/lib/auth";
import type { Query } from "@/lib/ingest-core";

export const runtime = "nodejs";

const query: Query = (text, params) => sql.query(text, params ?? []);

/**
 * POST /api/watchlist/sku   { ml_id, sku }
 *
 * Asocia (o desasocia, con sku vacío) un SKU propio a un producto que ya se
 * está siguiendo. El precio no se guarda: sale del Sheet cada vez.
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
  const sku = String(body?.sku ?? "").trim();
  if (!mlId) {
    return NextResponse.json({ error: "falta ml_id" }, { status: 400 });
  }

  try {
    await query(`UPDATE watchlist SET sku = $2 WHERE ml_id = $1`, [
      mlId,
      sku || null,
    ]);
    await query(`UPDATE listings SET sku = $2 WHERE ml_id = $1`, [
      mlId,
      sku || null,
    ]);
    return NextResponse.json({ ok: true, ml_id: mlId, sku: sku || null });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
