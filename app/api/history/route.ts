import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/history?ml_id=MLA1234567890
 * Devuelve la serie de precios de una publicacion, para el grafico.
 */
export async function GET(req: Request) {
  await ensureSchema((t, p) => sql.query(t, p ?? []));
  const { searchParams } = new URL(req.url);
  const mlId = searchParams.get("ml_id");
  if (!mlId) {
    return NextResponse.json({ error: "falta ml_id" }, { status: 400 });
  }

  try {
    const res = await sql`
      SELECT captured_at, price, list_price, discount_pct, seller, has_installments, status
      FROM price_snapshots
      WHERE ml_id = ${mlId}
      ORDER BY captured_at ASC
    `;
    return NextResponse.json({ ml_id: mlId, points: res.rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
