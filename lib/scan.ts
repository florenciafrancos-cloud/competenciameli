import type { Query } from "./ingest-core";
import { runIngest, type IngestResult } from "./ingest-core";
import { getAccessToken, scanBrand, scanSeller, fetchItems } from "./ml-api";
import type { ScrapedListing } from "./types";

export type ScanReport = {
  run_id: string;
  brands_scanned: string[];
  sellers_scanned: string[];
  urls_scanned: number;
  warnings: string[];
  ingest: IngestResult | null;
  error?: string;
};

/** Extrae el ID de publicacion (MLA...) de una URL de Mercado Libre. */
export function mlIdFromUrl(url: string): string | null {
  // Formatos: .../MLA-1234567890-titulo... o .../p/MLA1234567890
  const m = url.match(/ML[A-Z]-?(\d{6,})/i);
  if (!m) return null;
  const prefix = url.match(/ML([A-Z])/i);
  return `ML${(prefix?.[1] ?? "A").toUpperCase()}${m[1]}`;
}

/**
 * Corrida completa: lee el watchlist, releva todo en Mercado Libre,
 * y manda el resultado a la ingesta (que detecta los cambios).
 *
 * Es la funcion que llama el cron diario.
 */
export async function runScan(
  q: Query,
  opts: { runId?: string; source?: string } = {}
): Promise<ScanReport> {
  const runId =
    opts.runId ?? new Date().toISOString().slice(0, 16).replace("T", " ");

  const report: ScanReport = {
    run_id: runId,
    brands_scanned: [],
    sellers_scanned: [],
    urls_scanned: 0,
    warnings: [],
    ingest: null,
  };

  // ---- 1. Qué monitorear ----
  const wl = await q(
    `SELECT kind, value FROM watchlist WHERE active = TRUE ORDER BY kind, value`
  );
  if (wl.rows.length === 0) {
    report.error = "El watchlist está vacío: no hay nada que monitorear.";
    return report;
  }

  const brands = wl.rows.filter((r) => r.kind === "brand").map((r) => r.value);
  const sellers = wl.rows.filter((r) => r.kind === "seller").map((r) => r.value);
  const urls = wl.rows.filter((r) => r.kind === "url").map((r) => r.value);

  // ---- 2. Token ----
  const token = await getAccessToken(q);

  // ---- 3. Relevar ----
  const all: ScrapedListing[] = [];
  // Solo las marcas que se relevaron SIN error entran en brands_covered.
  // Si una marca falla y la incluyeramos, la ingesta marcaria como dadas
  // de baja todas sus publicaciones. Ese es el bug mas caro posible aca.
  const covered: string[] = [];

  for (const brand of brands) {
    try {
      const res = await scanBrand(brand, token);
      report.warnings.push(...res.warnings.map((w) => `[${brand}] ${w}`));
      if (res.listings.length > 0) {
        all.push(...res.listings);
        covered.push(brand);
        report.brands_scanned.push(brand);
      } else {
        report.warnings.push(
          `[${brand}] No se obtuvo ninguna publicación; se excluye de la detección de bajas para no marcar bajas falsas.`
        );
      }
    } catch (err) {
      report.warnings.push(
        `[${brand}] Falló el relevamiento: ${
          err instanceof Error ? err.message : String(err)
        }. Se excluye de la detección de bajas.`
      );
    }
  }

  for (const seller of sellers) {
    try {
      const res = await scanSeller(seller, token);
      report.warnings.push(...res.warnings.map((w) => `[${seller}] ${w}`));
      if (res.listings.length > 0) {
        all.push(...res.listings);
        report.sellers_scanned.push(seller);
      }
    } catch (err) {
      report.warnings.push(
        `[vendedor ${seller}] Falló: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  if (urls.length > 0) {
    const ids = urls.map(mlIdFromUrl).filter((x): x is string => !!x);
    const bad = urls.length - ids.length;
    if (bad > 0) {
      report.warnings.push(
        `${bad} URL(s) del watchlist no tienen un ID de publicación reconocible.`
      );
    }
    if (ids.length > 0) {
      try {
        const items = await fetchItems(ids, token);
        all.push(...items);
        report.urls_scanned = items.length;
      } catch (err) {
        report.warnings.push(
          `Falló la lectura de publicaciones puntuales: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  if (all.length === 0) {
    report.error =
      "No se obtuvo ninguna publicación de Mercado Libre en esta corrida. No se modificó nada en la base.";
    return report;
  }

  // ---- 4. Ingesta ----
  report.ingest = await runIngest(
    {
      run_id: runId,
      source: opts.source ?? "ml-api-cron",
      brands_covered: covered.length > 0 ? covered : report.sellers_scanned,
      listings: all,
      notes: report.warnings.length ? report.warnings.join(" | ") : undefined,
    },
    q
  );

  return report;
}
