import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/stats -> numeros de cabecera del dashboard */
export async function GET() {
  try {
    const [totals, byBrand, lastRun, recent] = await Promise.all([
      sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')   AS activas,
          COUNT(*) FILTER (WHERE status = 'delisted') AS bajas,
          COUNT(DISTINCT brand)                        AS marcas,
          COUNT(DISTINCT seller)                       AS vendedores
        FROM listings
      `,
      sql`
        SELECT brand,
               COUNT(*)      AS publicaciones,
               MIN(price)    AS precio_min,
               ROUND(AVG(price)) AS precio_prom,
               MAX(price)    AS precio_max
        FROM listings
        WHERE status = 'active' AND brand IS NOT NULL
        GROUP BY brand
        ORDER BY publicaciones DESC
      `,
      sql`
        SELECT id, started_at, finished_at, status, listings_seen, changes_found, notes
        FROM runs ORDER BY started_at DESC LIMIT 1
      `,
      sql`
        SELECT change_type, COUNT(*) AS n
        FROM changes
        WHERE detected_at >= NOW() - INTERVAL '7 days'
        GROUP BY change_type
        ORDER BY n DESC
      `,
    ]);

    return NextResponse.json({
      totals: totals.rows[0] ?? {},
      by_brand: byBrand.rows,
      last_run: lastRun.rows[0] ?? null,
      changes_last_7d: recent.rows,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
