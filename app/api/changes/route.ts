import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import { getSkuList } from "@/lib/skus";
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
    // Se trae el SKU desde listings: los cambios viejos quedaron guardados
    // antes de que existiera la columna, así que se resuelve por join.
    const res = await sql<ChangeRow & { sku: string | null; current_price: string | null }>`
      SELECT c.*, l.sku, l.price AS current_price
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

    const { rows: skus } = await getSkuList();
    const bySku = new Map(skus.map((s) => [s.sku.toUpperCase(), s]));

    const PRICE_CHANGES = new Set([
      "price_up",
      "price_down",
      "new_listing",
      "relisted",
    ]);

    const changes = res.rows.map((c: any) => {
      const own = c.sku ? bySku.get(String(c.sku).toUpperCase()) : undefined;
      const ownPrice = own?.price ?? null;

      // Para un cambio de precio se compara contra el precio que quedó tras
      // ese cambio; para el resto, contra el precio actual del producto.
      const ref = PRICE_CHANGES.has(c.change_type)
        ? Number(c.new_value)
        : c.current_price !== null
        ? Number(c.current_price)
        : null;

      const valid = ownPrice !== null && ref !== null && Number.isFinite(ref) && ref !== 0;

      return {
        ...c,
        own_price: ownPrice,
        diff_abs: valid ? ownPrice - ref : null,
        diff_pct: valid ? Number((((ownPrice - ref) / ref) * 100).toFixed(1)) : null,
      };
    });

    return NextResponse.json({ count: changes.length, changes });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
