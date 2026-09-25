import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import { getAccessToken, fetchMe } from "@/lib/ml-api";
import type { Query } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const query: Query = (text, params) => sql.query(text, params ?? []);
const ML = "https://api.mercadolibre.com";

/**
 * GET /api/ml/offers?product=MLA58102043        ficha de catálogo
 * GET /api/ml/offers?item=MLA2097403253         MI publicación que compite
 * GET /api/ml/offers?mine=1                     prueba TODAS mis publicaciones
 *
 * LA PREGUNTA QUE RESPONDE
 * ------------------------
 * ¿Se puede saber por API cuál oferta GANA la ficha de catálogo?
 *
 * Verificado el 25/09/2026 sobre MLA58102043 con el token real: el campo
 * `buy_box_winner` de /products/{id} viene NULL. O sea, por el lado de la
 * ficha no se puede.
 *
 * Queda un camino sin probar, y es el que Mercado Libre diseñó justamente
 * para vendedores: `price_to_win`. Se consulta sobre UNA PUBLICACION
 * PROPIA que participe del catálogo, y deberia devolver quien gana, a que
 * precio, y a cuanto habria que estar para ganar. Al ser publicacion
 * propia, el permiso alcanza.
 *
 * `?mine=1` lo prueba sobre todas las publicaciones propias y devuelve solo
 * las que participan de algun catalogo: sirve para medir de una cuanto del
 * negocio queda cubierto, sin ir producto por producto.
 *
 * Es de solo lectura: no guarda ni cambia nada.
 */
export async function GET(req: Request) {
  await ensureSchema(query);
  const sp = new URL(req.url).searchParams;
  const productId = (sp.get("product") ?? "").trim().toUpperCase();
  const itemId = (sp.get("item") ?? "").trim().toUpperCase();
  const mine = sp.get("mine") === "1";

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
        data = text.slice(0, 300);
      }
      return { path, status: r.status, ok: r.ok, data };
    };

    // ---------- Modo 1: probar el catálogo sobre MIS publicaciones ----------
    if (mine) {
      const me = await fetchMe(token);
      if (!me) {
        return NextResponse.json(
          { error: "No se pudo identificar la cuenta conectada." },
          { status: 400 }
        );
      }

      const lista = await get(`/users/${me.id}/items/search?limit=100`);
      const ids: string[] = Array.isArray(lista.data?.results)
        ? lista.data.results
        : [];

      const filas: any[] = [];
      // Se limita a 25 para no pasarse del tiempo máximo de la función.
      for (const id of ids.slice(0, 25)) {
        const ptw = await get(`/items/${id}/price_to_win?version=v2`);
        filas.push({
          mi_publicacion: id,
          status: ptw.status,
          participa_del_catalogo: ptw.ok,
          datos: ptw.ok ? ptw.data : undefined,
        });
      }

      return NextResponse.json({
        cuenta: me,
        publicaciones_totales: ids.length,
        probadas: filas.length,
        con_catalogo: filas.filter((f) => f.participa_del_catalogo).length,
        detalle: filas,
      });
    }

    // ---------- Modo 2: price_to_win sobre una publicación propia ----------
    if (itemId) {
      const [v2, v1, item] = await Promise.all([
        get(`/items/${itemId}/price_to_win?version=v2`),
        get(`/items/${itemId}/price_to_win`),
        get(`/items/${itemId}`),
      ]);

      return NextResponse.json({
        mi_publicacion: {
          id: itemId,
          titulo: item.ok ? item.data?.title : null,
          mi_precio: item.ok ? item.data?.price : null,
          catalogo: item.ok ? item.data?.catalog_product_id ?? null : null,
          compite_en_catalogo: item.ok
            ? item.data?.catalog_listing ?? null
            : null,
        },
        price_to_win_v2: { status: v2.status, ok: v2.ok, datos: v2.data },
        price_to_win_v1: { status: v1.status, ok: v1.ok, datos: v1.data },
      });
    }

    // ---------- Modo 3: la ficha de catálogo ----------
    if (!/^ML[A-Z]\d{4,}$/.test(productId)) {
      return NextResponse.json(
        {
          error:
            "Pasá uno de estos: ?product=MLA... (ficha de catálogo), " +
            "?item=MLA... (una publicación TUYA), o ?mine=1 (probar todas las tuyas).",
        },
        { status: 400 }
      );
    }

    const [prod, items] = await Promise.all([
      get(`/products/${productId}`),
      get(`/products/${productId}/items`),
    ]);

    const resultados: any[] = Array.isArray(items.data?.results)
      ? items.data.results
      : [];

    // El precio "real" para el comprador incluye el envío. Sin esto, una
    // oferta barata con envío caro parece la mejor del mercado y no lo es.
    const ofertas = resultados
      .map((r: any) => {
        const precio = Number(r.price);
        const envioGratis = r.shipping?.free_shipping === true;
        const costoEnvio = Number(r.shipping?.cost ?? 0) || 0;
        return {
          item_id: r.item_id ?? r.id ?? null,
          precio,
          envio_gratis: envioGratis,
          costo_envio: envioGratis ? 0 : costoEnvio,
          precio_con_envio: envioGratis ? precio : precio + costoEnvio,
          vendedor_id: r.seller_id ?? null,
          tienda_oficial: r.official_store_id ?? null,
          condicion: r.condition ?? null,
        };
      })
      .sort((a, b) => a.precio_con_envio - b.precio_con_envio);

    return NextResponse.json({
      producto: {
        id: productId,
        nombre: prod.data?.name ?? null,
      },
      hay_ganador_declarado: Boolean(
        prod.data?.buy_box_winner && Number(prod.data.buy_box_winner.price) > 0
      ),
      ganador_declarado: prod.data?.buy_box_winner ?? null,
      cantidad_de_ofertas: ofertas.length,
      mas_barato_sin_envio: ofertas
        .map((o) => o.precio)
        .sort((a, b) => a - b)[0] ?? null,
      mas_barato_con_envio: ofertas[0]?.precio_con_envio ?? null,
      cuantas_tienen_envio_gratis: ofertas.filter((o) => o.envio_gratis).length,
      ofertas: ofertas.slice(0, 80),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
