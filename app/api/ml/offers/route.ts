import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import { getAccessToken } from "@/lib/ml-api";
import type { Query } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const query: Query = (text, params) => sql.query(text, params ?? []);

const ML = "https://api.mercadolibre.com";

/**
 * GET /api/ml/offers?product=MLA58102043
 *
 * Diagnóstico de una ficha de catálogo. Responde UNA pregunta:
 * ¿se puede saber, por API, cuál es la oferta GANADORA de la ficha?
 *
 * POR QUE HACE FALTA
 * ------------------
 * En la página de Mercado Libre hay dos precios distintos:
 *
 *   - el destacado arriba  -> la oferta ganadora del catálogo
 *   - "N productos nuevos desde $X" -> la más barata
 *
 * El tablero muestra la ganadora cuando ML la declara, y si no, la más
 * barata. El campo `buy_box_winner` viene vacío seguido, y ahí es donde
 * aparece la diferencia que se ve en pantalla.
 *
 * Esta pantalla prueba VARIOS caminos posibles para conseguir la ganadora
 * y devuelve la respuesta cruda de cada uno, para decidir con el dato real
 * y no con la documentación de ML (que en este proyecto ya nos hizo
 * construir cuatro versiones sobre una premisa falsa).
 *
 * Es de solo lectura: no guarda ni cambia nada.
 */
export async function GET(req: Request) {
  await ensureSchema(query);

  const productId = (new URL(req.url).searchParams.get("product") ?? "")
    .trim()
    .toUpperCase();

  if (!/^ML[A-Z]\d{4,}$/.test(productId)) {
    return NextResponse.json(
      {
        error:
          "Pasá ?product=MLA... con el ID de la ficha de catálogo (el que " +
          "aparece en el link después de /p/).",
      },
      { status: 400 }
    );
  }

  try {
    const token = await getAccessToken(query);
    const get = async (path: string) => {
      const r = await fetch(`${ML}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await r.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = text.slice(0, 400);
      }
      return { path, status: r.status, ok: r.ok, data };
    };

    // Los caminos posibles para la ganadora. Se prueban todos aunque alguno
    // falle: lo que interesa es saber cuál responde.
    const [prod, items, itemsWinner, search] = await Promise.all([
      get(`/products/${productId}`),
      get(`/products/${productId}/items`),
      // Algunas cuentas tienen este filtro; si no existe, el status lo dice.
      get(`/products/${productId}/items?status=active&limit=50`),
      get(`/products/search?status=active&site_id=MLA&product_identifier=${productId}`),
    ]);

    const resultados: any[] = Array.isArray(items.data?.results)
      ? items.data.results
      : [];

    const ofertas = resultados
      .map((r: any) => ({
        item_id: r.item_id ?? r.id ?? null,
        precio: Number(r.price),
        moneda: r.currency_id ?? null,
        condicion: r.condition ?? "(no informada)",
        vendedor_id: r.seller_id ?? null,
        tipo_publicacion: r.listing_type_id ?? null,
        tier: r.tier ?? null,
        envio: r.shipping?.free_shipping ?? "(no informado)",
      }))
      .sort((a, b) => a.precio - b.precio);

    const bbw = prod.data?.buy_box_winner ?? null;

    return NextResponse.json({
      producto: {
        id: productId,
        nombre: prod.data?.name ?? null,
        estado: prod.data?.status ?? null,
      },

      // ---- LA PREGUNTA ----
      hay_ganador_declarado: Boolean(bbw && Number(bbw.price) > 0),
      ganador_declarado: bbw,

      precio_mas_barato: ofertas[0]?.precio ?? null,
      cantidad_de_ofertas: ofertas.length,
      condiciones: [...new Set(ofertas.map((o) => o.condicion))],
      monedas: [...new Set(ofertas.map((o) => o.moneda))],

      // ---- LOS CAMINOS PROBADOS ----
      // Se incluye el status de cada uno para ver cuál está habilitado.
      caminos: [prod, items, itemsWinner, search].map((r) => ({
        path: r.path,
        status: r.status,
        ok: r.ok,
      })),

      // ---- CRUDO, para inspeccionar qué campos existen de verdad ----
      campos_del_producto: prod.ok ? Object.keys(prod.data ?? {}) : null,
      primera_oferta_cruda: resultados[0] ?? null,
      items_con_filtro_status: {
        status: itemsWinner.status,
        cantidad: Array.isArray(itemsWinner.data?.results)
          ? itemsWinner.data.results.length
          : null,
      },

      ofertas: ofertas.slice(0, 80),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
