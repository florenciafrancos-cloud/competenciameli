import type { Query } from "./ingest-core";
import { getOwnItems } from "./own-items";
import type { OwnPriceInfo } from "./notify";

/**
 * Arma el mapa de "mi publicación y mi precio" por producto seguido, para
 * que el mail de alerta diga dónde estás parada vos, no solo qué hizo la
 * competencia.
 *
 * El precio sale de Mercado Libre en el momento del envío, no de la base:
 * así refleja lo que realmente está publicado cuando llega el mail.
 */
export async function buildOwnPriceMap(q: Query): Promise<OwnPriceInfo> {
  const map: OwnPriceInfo = new Map();
  try {
    const res = await q(
      `SELECT ml_id, own_ml_id FROM watchlist
        WHERE own_ml_id IS NOT NULL AND own_ml_id <> '' AND active`
    );
    if (res.rows.length === 0) return map;

    const own = await getOwnItems(q);

    for (const row of res.rows) {
      const mine = own.map.get(String(row.own_ml_id).toUpperCase());
      if (!mine) continue;
      map.set(String(row.ml_id), {
        // El título completo de ML es larguísimo; en el mail entra recortado.
        label: mine.title.length > 60 ? mine.title.slice(0, 57) + "…" : mine.title,
        price: mine.price ?? null,
      });
    }
  } catch {
    // Si algo falla, el mail sale igual sin la comparación.
  }
  return map;
}
