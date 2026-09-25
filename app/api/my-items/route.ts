import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import { getMyItems } from "@/lib/my-items";
import { fetchMe, getAccessToken } from "@/lib/ml-api";
import type { Query } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const query: Query = (text, params) => sql.query(text, params ?? []);

/**
 * GET /api/my-items          mis publicaciones (caché de 10 min)
 * GET /api/my-items?force=1  vuelve a pedirlas a Mercado Libre
 *
 * Alimenta el buscador de "Mi publicación". Devuelve también con qué cuenta
 * de ML está conectada la app: si alguien autorizó con la cuenta equivocada,
 * la lista viene vacía y sin ese dato no hay forma de darse cuenta.
 */
export async function GET(req: Request) {
  await ensureSchema(query);
  const force = new URL(req.url).searchParams.get("force") === "1";

  let account: { id: number; nickname: string | null } | null = null;
  try {
    account = await fetchMe(await getAccessToken(query));
  } catch {
    /* se reporta abajo con el error de la lista */
  }

  const { items, cached, error } = await getMyItems(query, { force });

  return NextResponse.json({
    account,
    count: items.length,
    cached,
    error,
    items: items.map((i) => ({
      ml_id: i.ml_id,
      title: i.title,
      price: i.price,
      ml_status: i.ml_status,
      url: i.url,
    })),
  });
}
