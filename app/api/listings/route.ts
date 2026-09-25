import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import { getOwnItems, diffAgainst } from "@/lib/own-items";
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
  // Por defecto se muestran solo los productos que se estan siguiendo.
  // Los que se dejaron de seguir quedan guardados (el historial no se
  // pierde) pero no ensucian la vista.
  const all = searchParams.get("all") === "1";
  const limit = Math.min(Number(searchParams.get("limit") ?? 500) || 500, 2000);

  try {
    const res = await sql<ListingRow & { snapshots: number }>`
      SELECT l.*,
             (SELECT COUNT(*) FROM price_snapshots s WHERE s.ml_id = l.ml_id) AS snapshots,
             (SELECT w.own_ml_id FROM watchlist w
               WHERE w.ml_id = l.ml_id AND w.own_ml_id IS NOT NULL
               ORDER BY w.active DESC, w.id DESC LIMIT 1) AS own_ml_id,
             (SELECT w.own_url FROM watchlist w
               WHERE w.ml_id = l.ml_id AND w.own_ml_id IS NOT NULL
               ORDER BY w.active DESC, w.id DESC LIMIT 1) AS own_url
      FROM listings l
      WHERE (${all} OR EXISTS (
              SELECT 1 FROM watchlist w
              WHERE w.ml_id = l.ml_id AND w.active
            ))
        AND (${status} = 'all' OR l.status = ${status})
        AND (${brand}::text IS NULL OR LOWER(l.brand) = LOWER(${brand}))
        AND (${seller}::text IS NULL OR LOWER(l.seller) = LOWER(${seller}))
        AND (${q}::text IS NULL OR l.title ILIKE '%' || ${q} || '%')
      ORDER BY l.brand NULLS LAST, l.price ASC
      LIMIT ${limit}
    `;
    // Mi precio sale de MI publicación en Mercado Libre, leída en vivo
    // (caché de 5 min). Si cambio el precio en ML, el tablero lo refleja
    // sin esperar a la corrida de mañana.
    const own = await getOwnItems((t, p) => sql.query(t, p ?? []));

    const listings = res.rows.map((l: any) => {
      const mine = l.own_ml_id
        ? own.map.get(String(l.own_ml_id).toUpperCase())
        : undefined;
      const ownPrice = mine?.price ?? null;
      const price = l.price !== null ? Number(l.price) : null;

      return {
        ...l,
        own_price: ownPrice,
        own_title: mine?.title ?? null,
        own_status: mine?.ml_status ?? null,
        own_link: mine?.url ?? l.own_url ?? null,
        // Diferencia entre TU precio y el mejor de la competencia.
        // Positivo = estás más caro.
        ...diffAgainst(ownPrice, price),
      };
    });

    return NextResponse.json({
      count: listings.length,
      listings,
      own_warnings: own.warnings,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
