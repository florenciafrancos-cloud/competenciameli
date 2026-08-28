import { detectChanges } from "./diff";
import type {
  DetectedChange,
  IngestPayload,
  ListingRow,
  ScrapedListing,
} from "./types";

/**
 * Toda la logica de ingesta vive aca, desacoplada del driver de base.
 *
 * `Query` es cualquier funcion que ejecute SQL con parametros posicionales
 * ($1, $2, ...). En produccion se la pasa el driver de Neon; en los tests
 * se le pasa `pg` contra un Postgres local. Asi el SQL que se testea es
 * exactamente el mismo que corre en produccion.
 */
export type Query = (
  text: string,
  params?: unknown[]
) => Promise<{ rows: any[] }>;

export type IngestResult = {
  ok: true;
  run_id: string;
  listings_received: number;
  listings_valid: number;
  listings_skipped: number;
  skipped_detail: string[];
  changes_found: number;
  changes_by_type: Record<string, number>;
  changes: DetectedChange[];
  first_run: boolean;
};

export class IngestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Placeholders $1..$n, con offset opcional. */
function ph(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, i) => `$${i + 1 + offset}`).join(", ");
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Limpia y deduplica el payload crudo.
 * ML repite anuncios patrocinados en cada pagina, asi que deduplicar
 * por ml_id es obligatorio (ver relevamiento de Contigo: ~1.750
 * "resultados" para ~160 publicaciones reales).
 */
export function normalizeListings(raw: unknown[]): {
  listings: ScrapedListing[];
  skipped: string[];
} {
  const seen = new Set<string>();
  const listings: ScrapedListing[] = [];
  const skipped: string[] = [];

  for (const item of raw) {
    const r = item as Partial<ScrapedListing>;
    const mlId = String(r?.ml_id ?? "").trim().toUpperCase();
    const price = Number(r?.price);

    if (!mlId || !/^ML[A-Z]\d+$/.test(mlId)) {
      skipped.push(`ml_id invalido: ${JSON.stringify(r?.ml_id)}`);
      continue;
    }
    if (!Number.isFinite(price) || price <= 0) {
      skipped.push(`${mlId}: precio invalido (${r?.price})`);
      continue;
    }
    if (seen.has(mlId)) continue;
    seen.add(mlId);

    listings.push({
      ml_id: mlId,
      title: String(r.title ?? "").trim().slice(0, 500) || mlId,
      brand: String(r.brand ?? "").trim(),
      url: r.url ? String(r.url).trim() : null,
      seller: r.seller ? String(r.seller).trim() : null,
      official_store: r.official_store ?? null,
      list_price: numOrNull(r.list_price),
      price,
      discount_pct: numOrNull(r.discount_pct),
      has_installments: r.has_installments ?? null,
      installments_text: r.installments_text
        ? String(r.installments_text).trim()
        : null,
      currency: r.currency ?? "ARS",
      seller_id: numOrNull(r.seller_id),
      ml_status: r.ml_status ? String(r.ml_status).trim() : null,
      available_quantity: numOrNull(r.available_quantity),
    });
  }

  return { listings, skipped };
}

/** Valida el payload y lanza IngestError si algo falta. */
export function validatePayload(body: IngestPayload): {
  runId: string;
  brandsCovered: string[];
  trackedIds: string[];
} {
  const runId = String(body?.run_id ?? "").trim();
  if (!runId) throw new IngestError("falta run_id");

  if (!Array.isArray(body?.listings)) {
    throw new IngestError("listings debe ser un array");
  }

  const brandsCovered = (body.brands_covered ?? [])
    .map((b) => String(b).trim())
    .filter(Boolean);

  const trackedIds = (body.tracked_ids ?? [])
    .map((id) => String(id).trim().toUpperCase())
    .filter(Boolean);

  // Hace falta al menos uno de los dos: son los que definen de que
  // publicaciones se puede inferir una baja. Sin ninguno, una corrida
  // vacia no debe borrar nada.
  if (brandsCovered.length === 0 && trackedIds.length === 0) {
    throw new IngestError(
      "hace falta tracked_ids (los IDs consultados) o brands_covered: son los que definen de que publicaciones se puede inferir una baja"
    );
  }

  return { runId, brandsCovered, trackedIds };
}

/**
 * Ejecuta la ingesta completa: guarda la corrida, compara contra el
 * estado anterior, registra cambios y actualiza publicaciones.
 */
export async function runIngest(
  body: IngestPayload,
  q: Query
): Promise<IngestResult> {
  const { runId, brandsCovered, trackedIds } = validatePayload(body);
  const { listings, skipped } = normalizeListings(body.listings);

  try {
    // ---- 1. Abrir la corrida ----
    await q(
      `INSERT INTO runs (id, source, brands_covered, listings_seen, status, notes)
       VALUES ($1, $2, string_to_array($3, '|'), $4, 'running', $5)
       ON CONFLICT (id) DO UPDATE SET
         started_at     = NOW(),
         source         = EXCLUDED.source,
         brands_covered = EXCLUDED.brands_covered,
         listings_seen  = EXCLUDED.listings_seen,
         status         = 'running',
         notes          = EXCLUDED.notes`,
      [
        runId,
        body.source ?? "manual",
        brandsCovered.join("|"),
        listings.length,
        body.notes ?? null,
      ]
    );

    // ---- 2. Estado anterior ----
    // (a) todo lo de las marcas relevadas (para poder detectar bajas)
    // (b) cualquier publicacion del snapshot, aunque este guardada
    //     bajo otra marca
    const lowerBrands = brandsCovered.map((b) => b.toLowerCase());
    // Los IDs que nos interesan: los consultados explicitamente y los que
    // vinieron en el snapshot.
    const relevantIds = [
      ...new Set([...trackedIds, ...listings.map((l) => l.ml_id)]),
    ];

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (lowerBrands.length > 0) {
      clauses.push(`LOWER(COALESCE(brand, '')) IN (${ph(lowerBrands.length)})`);
      params.push(...lowerBrands);
    }
    if (relevantIds.length > 0) {
      clauses.push(`ml_id IN (${ph(relevantIds.length, params.length)})`);
      params.push(...relevantIds);
    }

    const existing: ListingRow[] =
      clauses.length === 0
        ? []
        : ((
            await q(
              `SELECT * FROM listings WHERE ${clauses.join(" OR ")}`,
              params
            )
          ).rows as ListingRow[]);

    // ---- 3. Detectar cambios ----
    const changes = detectChanges(listings, existing, {
      brandsCovered,
      trackedIds,
    });

    // ---- 4. Guardar publicaciones + snapshot de precio ----
    for (const l of listings) {
      await q(
        `INSERT INTO listings (
           ml_id, title, brand, url, seller, official_store,
           list_price, price, discount_pct, has_installments,
           installments_text, currency, seller_id, ml_status,
           available_quantity, status, last_seen_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   'active',NOW(),NOW())
         ON CONFLICT (ml_id) DO UPDATE SET
           title             = EXCLUDED.title,
           brand             = COALESCE(NULLIF(EXCLUDED.brand, ''), listings.brand),
           url               = COALESCE(EXCLUDED.url, listings.url),
           seller            = COALESCE(EXCLUDED.seller, listings.seller),
           official_store    = COALESCE(EXCLUDED.official_store, listings.official_store),
           list_price        = EXCLUDED.list_price,
           price             = EXCLUDED.price,
           discount_pct      = EXCLUDED.discount_pct,
           -- Si esta corrida no pudo averiguar las cuotas (null), se
           -- conserva lo que ya sabiamos en vez de borrarlo.
           has_installments  = COALESCE(EXCLUDED.has_installments, listings.has_installments),
           installments_text = COALESCE(EXCLUDED.installments_text, listings.installments_text),
           currency          = EXCLUDED.currency,
           seller_id         = COALESCE(EXCLUDED.seller_id, listings.seller_id),
           ml_status         = COALESCE(EXCLUDED.ml_status, listings.ml_status),
           available_quantity = COALESCE(EXCLUDED.available_quantity, listings.available_quantity),
           status            = 'active',
           last_seen_at      = NOW(),
           updated_at        = NOW()`,
        [
          l.ml_id,
          l.title,
          l.brand,
          l.url,
          l.seller,
          l.official_store,
          l.list_price,
          l.price,
          l.discount_pct,
          l.has_installments,
          l.installments_text,
          l.currency,
          l.seller_id ?? null,
          l.ml_status ?? null,
          l.available_quantity ?? null,
        ]
      );

      await q(
        `INSERT INTO price_snapshots (
           ml_id, run_id, list_price, price, discount_pct,
           seller, has_installments, status, ml_status, available_quantity
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`,
        [
          l.ml_id,
          runId,
          l.list_price,
          l.price,
          l.discount_pct,
          l.seller,
          l.has_installments,
          l.ml_status ?? null,
          l.available_quantity ?? null,
        ]
      );
    }

    // ---- 5. Marcar bajas ----
    const delistedIds = changes
      .filter((c) => c.change_type === "delisted")
      .map((c) => c.ml_id);

    if (delistedIds.length > 0) {
      await q(
        `UPDATE listings SET status = 'delisted', updated_at = NOW()
         WHERE ml_id IN (${ph(delistedIds.length)})`,
        delistedIds
      );
    }

    // ---- 6. Feed de cambios ----
    for (const c of changes) {
      await q(
        `INSERT INTO changes (
           ml_id, brand, title, url, seller, change_type,
           old_value, new_value, delta_abs, delta_pct, run_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          c.ml_id,
          c.brand,
          c.title,
          c.url,
          c.seller,
          c.change_type,
          c.old_value,
          c.new_value,
          c.delta_abs,
          c.delta_pct,
          runId,
        ]
      );
    }

    // ---- 7. Cerrar la corrida ----
    await q(
      `UPDATE runs SET finished_at = NOW(), changes_found = $2, status = 'ok'
       WHERE id = $1`,
      [runId, changes.length]
    );

    return {
      ok: true,
      run_id: runId,
      listings_received: body.listings.length,
      listings_valid: listings.length,
      listings_skipped: skipped.length,
      skipped_detail: skipped.slice(0, 20),
      changes_found: changes.length,
      changes_by_type: changes.reduce<Record<string, number>>((acc, c) => {
        acc[c.change_type] = (acc[c.change_type] ?? 0) + 1;
        return acc;
      }, {}),
      changes,
      // La primera corrida crea TODO como nuevo; no tiene sentido
      // mandar un mail con 285 "novedades".
      first_run: existing.length === 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await q(
        `UPDATE runs SET finished_at = NOW(), status = 'error', notes = $2 WHERE id = $1`,
        [runId, message]
      );
    } catch {
      /* la corrida puede no existir todavia */
    }
    throw err;
  }
}
