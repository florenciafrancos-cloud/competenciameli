import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import { getOwnItems, diffAgainst } from "@/lib/own-items";
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
  await ensureSchema((t, p) => sql.query(t, p ?? []));
  const { searchParams } = new URL(req.url);
  const days = Math.min(Number(searchParams.get("days") ?? 30) || 30, 365);
  const type = searchParams.get("type");
  const brand = searchParams.get("brand");
  const limit = Math.min(Number(searchParams.get("limit") ?? 300) || 300, 2000);
  const all = searchParams.get("all") === "1";

  try {
    // Mi publicación asociada se resuelve por join contra la watchlist: los
    // cambios viejos quedaron guardados antes de que existiera la columna.
    const res = await sql<
      ChangeRow & { own_ml_id: string | null; current_price: string | null }
    >`
      SELECT c.*, l.price AS current_price,
             (SELECT w.own_ml_id FROM watchlist w
               WHERE w.ml_id = c.ml_id AND w.own_ml_id IS NOT NULL
               ORDER BY w.active DESC, w.id DESC LIMIT 1) AS own_ml_id
      FROM changes c
      LEFT JOIN listings l ON l.ml_id = c.ml_id
      WHERE (${all} OR EXISTS (
              SELECT 1 FROM watchlist w
              WHERE w.ml_id = c.ml_id AND w.active
            ))
        AND c.detected_at >= NOW() - (${days} || ' days')::interval
        AND (${type}::text IS NULL OR c.change_type = ${type})
        AND (${brand}::text IS NULL OR LOWER(c.brand) = LOWER(${brand}))
      ORDER BY c.detected_at DESC, c.id DESC
      LIMIT ${limit}
    `;

    const own = await getOwnItems((t, p) => sql.query(t, p ?? []));

    const PRICE_CHANGES = new Set([
      "price_up",
      "price_down",
      "new_listing",
      "relisted",
    ]);

    const changes = res.rows.map((c: any) => {
      const mine = c.own_ml_id
        ? own.map.get(String(c.own_ml_id).toUpperCase())
        : undefined;
      const ownPrice = mine?.price ?? null;

      // Para un cambio de precio se compara contra el precio que quedó tras
      // ese cambio; para el resto, contra el precio actual del producto.
      const ref = PRICE_CHANGES.has(c.change_type)
        ? Number(c.new_value)
        : c.current_price !== null
        ? Number(c.current_price)
        : null;

      return {
        ...c,
        own_price: ownPrice,
        own_title: mine?.title ?? null,
        own_link: mine?.url ?? null,
        ...diffAgainst(ownPrice, ref),
      };
    });

    return NextResponse.json({
      count: changes.length,
      changes,
      own_warnings: own.warnings,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
