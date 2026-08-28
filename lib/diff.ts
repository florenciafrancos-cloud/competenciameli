import type {
  DetectedChange,
  ListingRow,
  ScrapedListing,
} from "./types";
import { num } from "./db";

/**
 * Umbral minimo de cambio de precio para generar una alerta.
 * Evita ruido por redondeos de centavos.
 */
const MIN_PRICE_DELTA_ARS = 1;

/**
 * Compara el snapshot nuevo contra el estado guardado en la base y
 * devuelve la lista de cambios detectados.
 *
 * Reglas clave:
 * - Solo se marcan bajas (delisted) de las marcas incluidas en
 *   `brandsCovered`. Si una marca no se relevo, sus publicaciones
 *   se dejan intactas (no se asume que desaparecieron).
 * - Una publicacion que estaba 'delisted' y reaparece genera 'relisted'.
 */
export function detectChanges(
  scraped: ScrapedListing[],
  existing: ListingRow[],
  brandsCovered: string[]
): DetectedChange[] {
  const changes: DetectedChange[] = [];

  const covered = new Set(
    brandsCovered.map((b) => b.trim().toLowerCase()).filter(Boolean)
  );
  const byId = new Map(existing.map((r) => [r.ml_id, r]));
  const scrapedIds = new Set(scraped.map((s) => s.ml_id));

  for (const s of scraped) {
    const prev = byId.get(s.ml_id);

    // --- Publicacion nueva ---
    if (!prev) {
      changes.push({
        ml_id: s.ml_id,
        brand: s.brand ?? null,
        title: s.title,
        url: s.url ?? null,
        seller: s.seller ?? null,
        change_type: "new_listing",
        old_value: null,
        new_value: String(s.price),
        delta_abs: null,
        delta_pct: null,
      });
      continue;
    }

    const base = {
      ml_id: s.ml_id,
      brand: s.brand ?? prev.brand,
      title: s.title,
      url: s.url ?? prev.url,
      seller: s.seller ?? prev.seller,
    };

    // --- Volvio a publicarse ---
    if (prev.status === "delisted") {
      changes.push({
        ...base,
        change_type: "relisted",
        old_value: "delisted",
        new_value: String(s.price),
        delta_abs: null,
        delta_pct: null,
      });
    }

    // --- Cambio de precio ---
    const prevPrice = num(prev.price);
    const newPrice = num(s.price);
    if (prevPrice !== null && newPrice !== null) {
      const delta = newPrice - prevPrice;
      if (Math.abs(delta) >= MIN_PRICE_DELTA_ARS) {
        changes.push({
          ...base,
          change_type: delta > 0 ? "price_up" : "price_down",
          old_value: String(prevPrice),
          new_value: String(newPrice),
          delta_abs: Number(delta.toFixed(2)),
          delta_pct:
            prevPrice !== 0
              ? Number(((delta / prevPrice) * 100).toFixed(2))
              : null,
        });
      }
    }

    // --- Cambio de vendedor ---
    const prevSeller = (prev.seller ?? "").trim();
    const newSeller = (s.seller ?? "").trim();
    if (newSeller && prevSeller && newSeller !== prevSeller) {
      changes.push({
        ...base,
        change_type: "seller_change",
        old_value: prevSeller,
        new_value: newSeller,
        delta_abs: null,
        delta_pct: null,
      });
    }

    // --- Cuotas ---
    const prevInst = prev.has_installments;
    const newInst = s.has_installments;
    if (
      prevInst !== null &&
      prevInst !== undefined &&
      newInst !== null &&
      newInst !== undefined &&
      prevInst !== newInst
    ) {
      changes.push({
        ...base,
        change_type: newInst ? "installments_added" : "installments_removed",
        old_value: prevInst ? "con cuotas" : "sin cuotas",
        new_value: s.installments_text ?? (newInst ? "con cuotas" : "sin cuotas"),
        delta_abs: null,
        delta_pct: null,
      });
    }
  }

  // --- Bajas: estaba activa, su marca se relevo, y no aparecio ---
  for (const prev of existing) {
    if (prev.status !== "active") continue;
    if (scrapedIds.has(prev.ml_id)) continue;
    const brandKey = (prev.brand ?? "").trim().toLowerCase();
    if (!brandKey || !covered.has(brandKey)) continue;

    changes.push({
      ml_id: prev.ml_id,
      brand: prev.brand,
      title: prev.title,
      url: prev.url,
      seller: prev.seller,
      change_type: "delisted",
      old_value: prev.price !== null ? String(num(prev.price)) : null,
      new_value: null,
      delta_abs: null,
      delta_pct: null,
    });
  }

  return changes;
}
