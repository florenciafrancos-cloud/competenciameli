import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import { isLoggedIn } from "@/lib/auth";
import {
  fetchOfferChoices,
  getAccessToken,
  hintedItemId,
  parseMlLink,
  previewItem,
  previewOwnItem,
  resolveUserProduct,
} from "@/lib/ml-api";
import { getOwnItems, resolveOwnRef } from "@/lib/own-items";
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
              w.own_ml_id, w.own_url,
              w.tracked_item_id, w.tracked_seller_id, w.tracked_seller,
              w.created_at,
              l.title, l.price, l.seller, l.ml_status, l.status,
              l.available_quantity, l.url, l.last_seen_at
       FROM watchlist w
       LEFT JOIN listings l ON l.ml_id = w.ml_id
       ORDER BY w.active DESC, w.created_at DESC`
    );

    // El precio propio se lee de ML, no de la base: es el mismo criterio
    // que en el resto del tablero.
    const own = await getOwnItems(query);
    const watchlist = res.rows.map((w: any) => {
      const mine = w.own_ml_id
        ? own.map.get(String(w.own_ml_id).toUpperCase())
        : undefined;
      return {
        ...w,
        own_price: mine?.price ?? null,
        own_title: mine?.title ?? null,
        own_status: mine?.ml_status ?? null,
        own_link: mine?.url ?? w.own_url ?? null,
      };
    });

    return NextResponse.json({ watchlist, own_warnings: own.warnings });
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
  const ownLinkFromBody = String(body?.own_url ?? "").trim() || null;

  /**
   * El vendedor elegido dentro de la ficha. Viene cuando la persona hizo
   * click en una de las ofertas de la lista.
   *
   * Es el dato central de esta version: una ficha de catalogo la comparten
   * decenas de vendedores, y se compite contra uno concreto. Sin esto, la
   * app seguia "la oferta mas barata del dia", que puede ser de un vendedor
   * distinto cada vez.
   */
  const trackedItemId =
    String(body?.tracked_item_id ?? "").trim().toUpperCase() || null;
  const trackedSellerId =
    body?.tracked_seller_id === undefined || body?.tracked_seller_id === null
      ? null
      : Number(body.tracked_seller_id);

  const chosenProductId = String(body?.product_id ?? "").trim().toUpperCase();
  if (chosenProductId) {
    if (!/^ML[A-Z]\d{4,}$/.test(chosenProductId)) {
      return NextResponse.json(
        { error: `Código de producto inválido: ${chosenProductId}` },
        { status: 400 }
      );
    }
    // Si todavia no eligio vendedor, se le ofrecen las ofertas de la ficha.
    if (!trackedItemId) {
      return ofrecerVendedores(chosenProductId, raw || null);
    }
    return addProduct(
      chosenProductId,
      "product",
      raw || null,
      ownLinkFromBody,
      { itemId: trackedItemId, sellerId: trackedSellerId }
    );
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

    // Una ficha de catalogo necesita saber a que vendedor seguir. Si el
    // link traia la pista del vendedor (wid= / pdp_filters=item_id:), se
    // usa; si no, se devuelven las ofertas para elegir con un click.
    if (effectiveKind === "product" && !trackedItemId) {
      const pista = hintedItemId(raw);
      if (pista) {
        return addProduct(effectiveId, "product", raw, ownLinkFromBody, {
          itemId: pista,
          sellerId: null,
        });
      }
      return ofrecerVendedores(effectiveId, raw);
    }

    return addProduct(effectiveId, effectiveKind, raw, ownLinkFromBody, {
      itemId: trackedItemId,
      sellerId: trackedSellerId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * Devuelve las ofertas de una ficha para que la persona elija a quién
 * seguir con un click.
 *
 * No es un error: es un paso del alta. Por eso responde 200 con
 * `needs_pick`, y no un 400 que la pantalla mostraria en rojo.
 */
async function ofrecerVendedores(productId: string, sourceUrl: string | null) {
  try {
    const token = await getAccessToken(query);
    const r = await fetchOfferChoices(productId, token);
    if (!r.ok) {
      return NextResponse.json({ error: r.error }, { status: 400 });
    }
    if (r.offers.length === 0) {
      return NextResponse.json(
        {
          error:
            `La ficha ${productId} no tiene ofertas activas: no hay a quién seguir.`,
        },
        { status: 400 }
      );
    }
    return NextResponse.json({
      needs_pick: true,
      product_id: productId,
      product_name: r.product_name,
      source_url: sourceUrl,
      offers: r.offers,
    });
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
  ownRef: string | null = null,
  tracked: { itemId?: string | null; sellerId?: number | null } = {}
) {
  try {
    const token = await getAccessToken(query);

    // Mi publicación asociada. Se valida ANTES de guardar nada: si el link
    // o el ID están mal, la persona se entera ahora y no mañana viendo una
    // columna vacía sin explicación.
    let ownMlId: string | null = null;
    let ownUrl: string | null = null;
    if (ownRef) {
      const resolved = await resolveOwnRef(ownRef, token);
      if (!resolved.ok) {
        return NextResponse.json({ error: resolved.error }, { status: 400 });
      }
      ownMlId = resolved.ml_id;
      ownUrl = resolved.url;
    }

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

    const preview = await previewItem(id, token, kind, sourceUrl, tracked);
    if (!preview.ok) {
      return NextResponse.json({ error: preview.error }, { status: 400 });
    }

    const l = preview.listing;

    // El vendedor se guarda resuelto: si se eligio por publicacion, su
    // seller_id sale de la propia respuesta de ML.
    const trackedItemId = tracked.itemId ?? null;
    const trackedSellerId =
      tracked.sellerId ?? (l.seller_id != null ? Number(l.seller_id) : null);

    await query(
      `INSERT INTO watchlist (kind, value, label, notes, ml_id, id_kind,
                              own_ml_id, own_url,
                              tracked_item_id, tracked_seller_id, tracked_seller,
                              active)
       VALUES ('url', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       ON CONFLICT (kind, value) DO UPDATE
         SET active            = TRUE,
             label             = EXCLUDED.label,
             notes             = EXCLUDED.notes,
             ml_id             = EXCLUDED.ml_id,
             id_kind           = EXCLUDED.id_kind,
             own_ml_id         = COALESCE(EXCLUDED.own_ml_id, watchlist.own_ml_id),
             own_url           = COALESCE(EXCLUDED.own_url, watchlist.own_url),
             tracked_item_id   = EXCLUDED.tracked_item_id,
             tracked_seller_id = EXCLUDED.tracked_seller_id,
             tracked_seller    = EXCLUDED.tracked_seller`,
      [
        sourceUrl || l.url || id,
        String(l.title).slice(0, 300),
        null,
        id,
        preview.kind,
        ownMlId,
        ownUrl,
        trackedItemId,
        trackedSellerId,
        l.seller ?? null,
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

    if (ownMlId) {
      await query(
        `UPDATE listings SET own_ml_id = $2, own_url = $3 WHERE ml_id = $1`,
        [id, ownMlId, ownUrl]
      );
    }

    return NextResponse.json({
      ok: true,
      ml_id: id,
      kind: preview.kind,
      own_ml_id: ownMlId,
      own_url: ownUrl,
      tracked_item_id: trackedItemId,
      tracked_seller_id: trackedSellerId,
      tracked_seller: l.seller ?? null,
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

/**
 * DELETE /api/watchlist?id=3            deja de seguirlo (conserva historial)
 * DELETE /api/watchlist?id=3&purge=1    lo borra por completo
 *
 * Son dos cosas distintas a propósito:
 *
 *   - Dejar de seguir: el producto desaparece del tablero pero el historial
 *     de precios queda. Si lo volvés a agregar, la serie sigue donde estaba.
 *   - Borrar: se va todo, incluido el historial. No tiene vuelta atrás.
 *     Es para limpiar lo que se cargó por error o de prueba.
 */
export async function DELETE(req: Request) {
  await ensureSchema(query);
  if (!(await isLoggedIn())) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  const purge = params.get("purge") === "1";
  if (!id) return NextResponse.json({ error: "falta id" }, { status: 400 });

  try {
    const found = await query(
      `SELECT ml_id, label FROM watchlist WHERE id = $1`,
      [Number(id)]
    );
    const mlId: string | null = found.rows[0]?.ml_id ?? null;

    if (!purge) {
      await query(`UPDATE watchlist SET active = FALSE WHERE id = $1`, [
        Number(id),
      ]);
      return NextResponse.json({ ok: true, purged: false, ml_id: mlId });
    }

    // Borrado definitivo. El orden importa: primero lo que referencia.
    if (mlId) {
      await query(`DELETE FROM changes WHERE ml_id = $1`, [mlId]);
      await query(`DELETE FROM price_snapshots WHERE ml_id = $1`, [mlId]);
      await query(`DELETE FROM listings WHERE ml_id = $1`, [mlId]);
    }
    await query(`DELETE FROM watchlist WHERE id = $1`, [Number(id)]);

    return NextResponse.json({ ok: true, purged: true, ml_id: mlId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
