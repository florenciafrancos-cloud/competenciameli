import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import type { ListingRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/listings
 *   ?brand=Bubba        filtrar por marca
 *   ?seller=Termo Style filtrar por vendedor
 *   ?status=active      active | delisted | all   (default: active)
 *   ?q=matterhorn       buscar en el titulo
 *   ?limit=200
 */
export async function GET(req: Request) {
  await ensureSchema((t, p) => sql.query(t, p ?? []));
  const { searchParams } = new URL(req.url);
  const brand = searchParams.get("brand");
  const seller = searchParams.get("seller");
  const status = searchParams.get("status") ?? "all";
  const q = searchParams.get("q");
  const limit = Math.min(Number(searchParams.get("limit") ?? 500) || 500, 2000);

  try {
    const res = await sql<ListingRow & { snapshots: number }>`
      SELECT l.*,
             (SELECT COUNT(*) FROM price_snapshots s WHERE s.ml_id = l.ml_id) AS snapshots
      FROM listings l
      WHERE (${status} = 'all' OR l.status = ${status})
        AND (${brand}::text IS NULL OR LOWER(l.brand) = LOWER(${brand}))
        AND (${seller}::text IS NULL OR LOWER(l.seller) = LOWER(${seller}))
        AND (${q}::text IS NULL OR l.title ILIKE '%' || ${q} || '%')
      ORDER BY l.brand NULLS LAST, l.price ASC
      LIMIT ${limit}
    `;
    return NextResponse.json({ count: res.rows.length, listings: res.rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
