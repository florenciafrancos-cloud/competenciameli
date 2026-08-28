import type { Query } from "./ingest-core";
import { getSkuList } from "./skus";
import type { OwnPriceInfo } from "./notify";

/**
 * Arma el mapa de "mi SKU y mi precio" por publicación seguida, para que el
 * mail de alerta diga dónde estás parada vos, no solo qué hizo la
 * competencia.
 *
 * El precio sale del Sheet en el momento del envío, no de la base: así
 * refleja tu lista de precios actual.
 */
export async function buildOwnPriceMap(q: Query): Promise<OwnPriceInfo> {
  const map: OwnPriceInfo = new Map();
  try {
    const res = await q(
      `SELECT ml_id, sku FROM listings WHERE sku IS NOT NULL AND sku <> ''`
    );
    if (res.rows.length === 0) return map;

    const { rows: skus } = await getSkuList();
    const bySku = new Map(skus.map((s) => [s.sku.toUpperCase(), s]));

    for (const row of res.rows) {
      const found = bySku.get(String(row.sku).toUpperCase());
      map.set(String(row.ml_id), {
        sku: String(row.sku),
        price: found?.price ?? null,
      });
    }
  } catch {
    // Si algo falla, el mail sale igual sin la comparación.
  }
  return map;
}
