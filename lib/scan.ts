import type { Query } from "./ingest-core";
import { runIngest, type IngestResult } from "./ingest-core";
import {
  getAccessToken,
  fetchItems,
  fetchCatalogProducts,
  parseMlId,
  parseMlLink,
} from "./ml-api";

export { parseMlId, parseMlLink };

export type ScanReport = {
  run_id: string;
  tracked: number;
  read_ok: number;
  not_found: number;
  warnings: string[];
  ingest: IngestResult | null;
  error?: string;
};

/**
 * Corrida completa: lee los links que el usuario cargo, consulta cada
 * publicacion en Mercado Libre, y manda el resultado a la ingesta (que
 * detecta los cambios y guarda el historial).
 *
 * Es la funcion que llama el cron diario.
 *
 * Nota sobre marcas y vendedores: el watchlist admite entradas de tipo
 * 'brand' y 'seller' por compatibilidad, pero Mercado Libre cerro la
 * busqueda publica de su API (403), asi que no se pueden relevar. Si hay
 * entradas de ese tipo activas, se avisa en las advertencias en vez de
 * fallar en silencio.
 */
export async function runScan(
  q: Query,
  opts: { runId?: string; source?: string } = {}
): Promise<ScanReport> {
  const runId =
    opts.runId ?? new Date().toISOString().slice(0, 16).replace("T", " ");

  const report: ScanReport = {
    run_id: runId,
    tracked: 0,
    read_ok: 0,
    not_found: 0,
    warnings: [],
    ingest: null,
  };

  // ---- 1. Que seguir ----
  const wl = await q(
    `SELECT kind, value, ml_id, COALESCE(id_kind, 'item') AS id_kind
     FROM watchlist WHERE active = TRUE ORDER BY id`
  );

  const itemIds: string[] = [];
  const productIds: string[] = [];
  const unparsed: string[] = [];
  let legacyCount = 0;

  for (const row of wl.rows) {
    if (row.kind === "url") {
      const parsed = row.ml_id
        ? { id: row.ml_id, kind: row.id_kind as "item" | "product" }
        : parseMlLink(row.value);
      if (!parsed) {
        unparsed.push(row.value);
        continue;
      }
      if (parsed.kind === "product") productIds.push(parsed.id.toUpperCase());
      else itemIds.push(parsed.id.toUpperCase());
    } else {
      legacyCount++;
    }
  }

  const trackedIds = [...itemIds, ...productIds];

  if (legacyCount > 0) {
    report.warnings.push(
      `Hay ${legacyCount} entrada(s) de tipo marca o vendedor en la lista. ` +
        `Mercado Libre cerró la búsqueda pública de su API, así que no se pueden ` +
        `relevar: hay que seguir esas publicaciones por link. Se ignoran en esta corrida.`
    );
  }
  if (unparsed.length > 0) {
    report.warnings.push(
      `No se pudo extraer el ID de ${unparsed.length} link(s): ${unparsed
        .slice(0, 5)
        .join(", ")}`
    );
  }

  const unique = [...new Set(trackedIds)];
  report.tracked = unique.length;

  if (unique.length === 0) {
    report.error =
      "No hay publicaciones cargadas para seguir. Agregá links de Mercado Libre en la pestaña “Qué se monitorea”.";
    return report;
  }

  // ---- 2. Token ----
  const token = await getAccessToken(q);

  // ---- 3. Consultar Mercado Libre ----
  // Las publicaciones van por /items (multiget, lotes de 20); las fichas de
  // catalogo por /products, una por una.
  const listings = [];
  const notFound: string[] = [];

  if (itemIds.length > 0) {
    const r = await fetchItems([...new Set(itemIds)], token);
    listings.push(...r.listings);
    notFound.push(...r.notFound);
    report.warnings.push(...r.warnings);
  }
  if (productIds.length > 0) {
    const r = await fetchCatalogProducts([...new Set(productIds)], token);
    listings.push(...r.listings);
    notFound.push(...r.notFound);
    report.warnings.push(...r.warnings);
  }

  report.read_ok = listings.length;
  report.not_found = notFound.length;

  // Si no se leyo NADA y tampoco hubo 404s, algo falló: no tocamos la base.
  if (listings.length === 0 && notFound.length === 0) {
    report.error =
      "No se pudo leer ninguna publicación de Mercado Libre en esta corrida. No se modificó nada en la base.";
    return report;
  }

  // Solo se consideran "consultados" los IDs de los que efectivamente
  // tuvimos una respuesta (dato o 404). Si una publicacion no respondio,
  // queda afuera y no se marca de baja.
  const answered = [...listings.map((l) => l.ml_id), ...notFound];

  // ---- 4. Ingesta ----
  report.ingest = await runIngest(
    {
      run_id: runId,
      source: opts.source ?? "ml-api-cron",
      tracked_ids: answered,
      listings,
      notes: report.warnings.length ? report.warnings.join(" | ") : undefined,
    },
    q
  );

  return report;
}

/** Compatibilidad: antes se exportaba con este nombre. */
export const mlIdFromUrl = parseMlId;
