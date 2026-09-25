import type { Query } from "./ingest-core";
import { fetchMyItemsFromMl, getAccessToken, type OwnListing } from "./ml-api";

/**
 * La lista de MIS publicaciones, para elegir a mano cuál corresponde a cada
 * producto que sigo de la competencia.
 *
 * POR QUE UNA LISTA Y NO PEGAR EL LINK
 * ------------------------------------
 * Pegar el link parecía lo natural, pero obliga a distinguir a ojo entre
 * tres códigos que Mercado Libre muestra en lugares parecidos:
 *
 *   MLA2097403253   la publicación        -> es este
 *   MLAU5205662057  la página de producto -> 404 en /items
 *   MLA3548989      la ficha de catálogo  -> otro endpoint
 *
 * Verificado el 25/09/2026 con la cuenta real: `/users/{id}/items/search`
 * responde 200 y devuelve las 135 publicaciones. Teniendo la lista, elegir
 * es buscar por nombre y hacer un click; el código no lo tiene que ver
 * nadie.
 *
 * Caché de 10 minutos: la lista cambia poco y armarla cuesta 7 llamadas.
 */

const TTL_MS = 10 * 60 * 1000;

let cache: { at: number; items: OwnListing[] } | null = null;

export function resetMyItemsCache(): void {
  cache = null;
}

export type MyItemsResult = {
  items: OwnListing[];
  cached: boolean;
  error: string | null;
};

export async function getMyItems(
  q: Query,
  opts: { force?: boolean } = {}
): Promise<MyItemsResult> {
  if (!opts.force && cache && Date.now() - cache.at < TTL_MS) {
    return { items: cache.items, cached: true, error: null };
  }

  try {
    const token = await getAccessToken(q);
    const items = await fetchMyItemsFromMl(token);
    cache = { at: Date.now(), items };
    return { items, cached: false, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Igual que con el resto: si falla, se conserva lo último bueno. Que la
    // lista no se pueda refrescar no tiene por qué vaciar el buscador.
    if (cache) return { items: cache.items, cached: true, error: msg };
    return { items: [], cached: false, error: msg };
  }
}
