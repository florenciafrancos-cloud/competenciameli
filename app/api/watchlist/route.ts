import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import {
  getAccessToken,
  parseMlLink,
  previewItem,
  resolveUserProduct,
} from "@/lib/ml-api";
import type { Query } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const query: Query = (text, params) => sql.query(text, params ?? []);

/**
 * GET /api/watchlist
 * Lista las publicaciones que se están siguiendo, con su último dato.
 */
export async function GET() {
  await ensureSchema((t, p) => sql.query(t, p ?? []));
  try {
    const res = await sql.query(
      `SELECT w.id, w.kind, w.value, w.label, w.notes, w.ml_id, w.active,
              COALESCE(w.id_kind, 'item') AS id_kind,
              w.sku,
              w.created_at,
              l.title, l.price, l.seller, l.ml_status, l.status,
              l.available_quantity, l.url, l.last_seen_at
       FROM watchlist w
       LEFT JOIN listings l ON l.ml_id = w.ml_id
       ORDER BY w.active DESC, w.created_at DESC`
    );
    return NextResponse.json({ watchlist: res.rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/watchlist  { value, label?, notes? }
 *
 * `value` es un link de Mercado Libre (o un ID pegado directo).
 * Antes de guardarlo se consulta la publicación en ML: así el usuario se
 * entera al instante si el link está mal, en vez de descubrirlo al día
 * siguiente cuando la corrida no encuentra nada.
 */
export async function POST(req: Request) {
  await ensureSchema((t, p) => sql.query(t, p ?? []));
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalido" }, { status: 400 });
  }

  const raw = String(body?.value ?? "").trim();

  /**
   * `product_id` viene cuando la persona eligio una opcion de la lista de
   * candidatos con un click. En ese caso no hay nada que interpretar: ya
   * sabemos exactamente que ficha de catalogo seguir.
   *
   * Existe porque la primera version mostraba los candidatos como texto y
   * pedia copiar un codigo a mano. Eso es trasladarle el problema al
   * usuario: elegir tiene que ser un click.
   */
  const skuFromBody = String(body?.sku ?? "").trim() || null;
  const chosenProductId = String(body?.product_id ?? "").trim().toUpperCase();
  if (chosenProductId) {
    if (!/^ML[A-Z]\d{4,}$/.test(chosenProductId)) {
      return NextResponse.json(
        { error: `Código de producto inválido: ${chosenProductId}` },
        { status: 400 }
      );
    }
    return addProduct(chosenProductId, "product", raw || null, skuFromBody);
  }

  if (!raw) {
    return NextResponse.json(
      { error: "Pegá el link del producto en Mercado Libre." },
      { status: 400 }
    );
  }

  const parsed = parseMlLink(raw);
  const mlId = parsed?.id ?? null;
  if (!parsed || !mlId) {
    // Caso concreto y frecuente: los links /up/MLAU... sin
    // product_trigger_id no se pueden resolver. Vale explicar exactamente
    // qué hacer en vez de un "link inválido" genérico.
    const esUserProduct = /\/up\/ML[A-Z]U/i.test(raw);
    return NextResponse.json(
      {
        error: esUserProduct
          ? "Ese link es de una página de producto que Mercado Libre no permite consultar por sí sola. " +
            "Solución: en esa misma página, hacé click en el vendedor (o en “Otras opciones de compra”) " +
            "y copiá la URL que empieza con articulo.mercadolibre.com.ar."
          : "No pude reconocer un ID de Mercado Libre en eso. Pegá el link completo de la publicación " +
            "(articulo.mercadolibre.com.ar/MLA-...) o de la ficha de catálogo (.../p/MLA...).",
      },
      { status: 400 }
    );
  }

  try {
    const token = await getAccessToken(query);

    // Los links /up/MLAU... no traen el ID de catálogo: hay que resolverlo.
    let effectiveId = mlId;
    let effectiveKind: "item" | "product" = "item";

    if (parsed.kind === "user_product") {
      const resolved = await resolveUserProduct(mlId, raw, token);
      if (!resolved.ok) {
        return NextResponse.json(
          { error: resolved.error, candidates: resolved.candidates },
          { status: 400 }
        );
      }
      effectiveId = resolved.productId;
      effectiveKind = "product";
    } else {
      effectiveKind = parsed.kind === "product" ? "product" : "item";
    }

    return addProduct(effectiveId, effectiveKind, raw, skuFromBody);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * Verifica contra Mercado Libre, guarda en la lista, y deja la foto inicial
 * de precio para tener contra que comparar mañana.
 */
async function addProduct(
  id: string,
  kind: "item" | "product",
  sourceUrl: string | null,
  sku: string | null = null
) {
  try {
    const token = await getAccessToken(query);

    const dup = await query(
      `SELECT id, active FROM watchlist WHERE ml_id = $1 LIMIT 1`,
      [id]
    );
    if (dup.rows.length > 0 && dup.rows[0].active) {
      return NextResponse.json(
        { error: `Ese producto (${id}) ya está en la lista.` },
        { status: 409 }
      );
    }

    const preview = await previewItem(id, token, kind, sourceUrl);
    if (!preview.ok) {
      return NextResponse.json({ error: preview.error }, { status: 400 });
    }

    const l = preview.listing;

    await query(
      `INSERT INTO watchlist (kind, value, label, notes, ml_id, id_kind, sku, active)
       VALUES ('url', $1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (kind, value) DO UPDATE
         SET active  = TRUE,
             label   = EXCLUDED.label,
             notes   = EXCLUDED.notes,
             ml_id   = EXCLUDED.ml_id,
             id_kind = EXCLUDED.id_kind,
             sku     = COALESCE(EXCLUDED.sku, watchlist.sku)`,
      [
        sourceUrl || l.url || id,
        String(l.title).slice(0, 300),
        null,
        id,
        preview.kind,
        sku,
      ]
    );

    const { runIngest } = await import("@/lib/ingest-core");
    await runIngest(
      {
        run_id: `alta ${id} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
        source: "alta-manual",
        tracked_ids: [id],
        listings: [l],
      },
      query
    );

    if (sku) {
      await query(`UPDATE listings SET sku = $2 WHERE ml_id = $1`, [id, sku]);
    }

    return NextResponse.json({
      ok: true,
      ml_id: id,
      kind: preview.kind,
      sku,
      listing: {
        title: l.title,
        price: l.price,
        seller: l.seller,
        ml_status: l.ml_status,
        available_quantity: l.available_quantity,
        installments_text: l.installments_text,
        offers_count: l.offers_count,
        url: l.url,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/** DELETE /api/watchlist?id=3  -> deja de seguirla (conserva el historial) */
export async function DELETE(req: Request) {
  await ensureSchema((t, p) => sql.query(t, p ?? []));
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "falta id" }, { status: 400 });
  try {
    await sql.query(`UPDATE watchlist SET active = FALSE WHERE id = $1`, [
      Number(id),
    ]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
