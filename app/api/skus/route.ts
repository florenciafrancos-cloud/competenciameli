import { NextResponse } from "next/server";
import { getSkuList } from "@/lib/skus";
import { isLoggedIn } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/skus       lista de SKU con su precio propio, desde el Sheet
 * GET /api/skus?force=1   ignora el caché de 5 minutos
 */
export async function GET(req: Request) {
  if (!(await isLoggedIn())) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  const res = await getSkuList({ force });
  return NextResponse.json({
    skus: res.rows,
    count: res.rows.length,
    source: res.source,
    error: res.error,
    fetched_at: res.fetchedAt ?? null,
  });
}
