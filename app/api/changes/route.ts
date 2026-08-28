import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import type { ChangeRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/changes
 *   ?days=7        ventana de tiempo (default 30)
 *   ?type=price_up filtrar por tipo de cambio
 *   ?brand=Bubba
 *   ?limit=200
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = Math.min(Number(searchParams.get("days") ?? 30) || 30, 365);
  const type = searchParams.get("type");
  const brand = searchParams.get("brand");
  const limit = Math.min(Number(searchParams.get("limit") ?? 300) || 300, 2000);

  try {
    const res = await sql<ChangeRow>`
      SELECT * FROM changes
      WHERE detected_at >= NOW() - (${days} || ' days')::interval
        AND (${type}::text IS NULL OR change_type = ${type})
        AND (${brand}::text IS NULL OR LOWER(brand) = LOWER(${brand}))
      ORDER BY detected_at DESC, id DESC
      LIMIT ${limit}
    `;
    return NextResponse.json({ count: res.rows.length, changes: res.rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
