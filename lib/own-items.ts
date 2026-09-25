import type { Query } from "./ingest-core";
import { fetchOwnItems, getAccessToken, type OwnListing } from "./ml-api";

/**
 * "Mi precio" leido de mis propias publicaciones de Mercado Libre.
 *
 * DECISION: el precio propio NO se guarda en la base.
 * ---------------------------------------------------
 * Se lee de ML en cada consulta, con cache corta. Es la misma decision que
 * se habia tomado con el Sheet, y por el mismo motivo: si se copiara a la
 * base, el tablero mostraria el precio de la ultima corrida (de ayer a la
 * mañana) mientras vos ya cambiaste el precio hoy. Comparar contra un
 * numero viejo es peor que no comparar.
 *
 * El historial es la excepcion: ahi si se guarda el precio propio del
 * momento (price_snapshots.own_price), porque una comparacion de hace tres
 * meses tiene que seguir significando lo que significaba entonces.
 */

const TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  at: number;
  key: string;
  map: Map<string, OwnListing>;
  warnings: string[];
};

let cache: CacheEntry | null = null;

export type OwnItemsResult = {
  /** Clave: ml_id de MI publicacion. */
  map: Map<string, OwnListing>;
  warnings: string[];
  /** true si los datos vienen de la cache y no de ML. */
  cached: boolean;
};

/** Para los tests. */
export function resetOwnItemsCache(): void {
  cache = null;
}

/**
 * Devuelve el dato actual de todas mis publicaciones asociadas.
 *
 * Nunca lanza: si ML falla, devuelve lo ultimo bueno que tenga (o un mapa
 * vacio) y la advertencia. El tablero tiene que abrir igual.
 */
export async function getOwnItems(q: Query): Promise<OwnItemsResult> {
  let ids: string[] = [];
  try {
    const res = await q(
      `SELECT DISTINCT own_ml_id FROM watchlist
        WHERE own_ml_id IS NOT NULL AND own_ml_id <> ''`
    );
    ids = res.rows.map((r: any) => String(r.own_ml_id).toUpperCase()).sort();
  } catch (err) {
    return {
      map: new Map(),
      warnings: [err instanceof Error ? err.message : String(err)],
      cached: false,
    };
  }

  if (ids.length === 0) {
    return { map: new Map(), warnings: [], cached: false };
  }

  const key = ids.join(",");
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) {
    return { map: cache.map, warnings: cache.warnings, cached: true };
  }

  try {
    const token = await getAccessToken(q);
    const { listings, warnings } = await fetchOwnItems(ids, token);
    const map = new Map(listings.map((l) => [l.ml_id.toUpperCase(), l]));
    cache = { at: Date.now(), key, map, warnings };
    return { map, warnings, cached: false };
  } catch (err) {
    // Se conserva lo ultimo bueno aunque la clave haya cambiado: mostrar
    // el precio de nueve productos es mejor que mostrar ninguno porque se
    // agrego un decimo.
    const warning =
      "No se pudo leer tu precio en Mercado Libre: " +
      (err instanceof Error ? err.message : String(err));
    if (cache) {
      return { map: cache.map, warnings: [...cache.warnings, warning], cached: true };
    }
    return { map: new Map(), warnings: [warning], cached: false };
  }
}

/**
 * Calcula la diferencia entre mi precio y el de referencia de la
 * competencia.
 *
 * `ref` es el precio contra el que se compara: el mejor precio actual de la
 * ficha, o —en el historial de cambios— el precio que quedo tras ese
 * cambio puntual.
 *
 * Positivo = estoy mas caro.
 *
 * Un `ref` de 0 o no numerico devuelve null en vez de infinito: un dato
 * faltante no puede convertirse en "estas 100% arriba".
 */
export function diffAgainst(
  ownPrice: number | null,
  ref: number | null
): { diff_abs: number | null; diff_pct: number | null } {
  const valid =
    ownPrice !== null &&
    Number.isFinite(ownPrice) &&
    ref !== null &&
    Number.isFinite(ref) &&
    ref !== 0;

  if (!valid) return { diff_abs: null, diff_pct: null };

  return {
    diff_abs: ownPrice - ref,
    diff_pct: Number((((ownPrice - ref) / ref) * 100).toFixed(1)),
  };
}

/**
 * Convierte lo que la persona eligió o pegó en un ID de publicación propia,
 * validándolo contra Mercado Libre.
 *
 * Acepta tres cosas porque las tres aparecen en la vida real:
 *   - el ID que devuelve el buscador de mis publicaciones (MLA123456789)
 *   - el link de la publicación (articulo.mercadolibre.com.ar/MLA-123...)
 *   - el link /up/MLAU..., que NO es una publicación: ahí se explica la
 *     diferencia en vez de devolver un 404 incomprensible.
 */
export async function resolveOwnRef(
  ref: string,
  token: string
): Promise<
  { ok: true; ml_id: string; url: string | null } | { ok: false; error: string }
> {
  const raw = ref.trim();
  if (!raw) return { ok: false, error: "No llegó ninguna publicación propia." };

  const { parseMlLink, previewOwnItem } = await import("./ml-api");

  let id: string | null = null;

  const direct = raw.toUpperCase().replace(/-/g, "");
  if (/^ML[A-Z]\d{6,}$/.test(direct) && !/^ML[A-Z]U/.test(direct)) {
    id = direct;
  } else {
    const parsed = parseMlLink(raw);
    if (parsed?.kind === "item") {
      id = parsed.id;
    } else if (parsed?.kind === "user_product" || /\/up\/ML[A-Z]U/i.test(raw)) {
      return {
        ok: false,
        error:
          "Ese link es de una página de producto tuya, no de la publicación. " +
          "Elegí tu publicación del buscador de acá al lado, o copiá el link " +
          "que empieza con articulo.mercadolibre.com.ar/MLA-…",
      };
    } else if (parsed?.kind === "product") {
      return {
        ok: false,
        error:
          "Ese es el link de una ficha de catálogo, no de tu publicación. " +
          "Elegí tu publicación del buscador de acá al lado.",
      };
    }
  }

  if (!id) {
    return {
      ok: false,
      error:
        "No pude reconocer una publicación tuya en eso. Elegila del buscador, " +
        "o pegá el link completo de tu publicación.",
    };
  }

  const preview = await previewOwnItem(id, token, raw.startsWith("http") ? raw : null);
  if (!preview.ok) return { ok: false, error: preview.error };

  return { ok: true, ml_id: preview.listing.ml_id, url: preview.listing.url };
}
