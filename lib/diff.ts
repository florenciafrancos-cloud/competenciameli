import type { DetectedChange, ListingRow, ScrapedListing } from "./types";
import { num } from "./db";

/**
 * Umbral minimo de cambio de precio para generar una alerta.
 * Evita ruido por redondeos de centavos.
 */
const MIN_PRICE_DELTA_ARS = 1;

export type DiffOptions = {
  /**
   * IDs consultados explicitamente en esta corrida. Un ID que esta aca
   * y no aparece en el snapshot = Mercado Libre no lo encontro = baja.
   *
   * Es el modo principal: se sigue una lista concreta de publicaciones.
   */
  trackedIds?: string[];
  /**
   * Marcas relevadas por busqueda. Solo se evaluan bajas de estas marcas.
   * Sin uso hoy (ML cerro la busqueda publica), se mantiene por
   * compatibilidad.
   */
  brandsCovered?: string[];
};

/**
 * Compara el snapshot nuevo contra el estado guardado y devuelve los
 * cambios detectados.
 *
 * Una publicacion se considera dada de baja solo si:
 *  - su ID estaba en `trackedIds` y ML no la devolvio (404), o
 *  - su marca estaba en `brandsCovered` y no aparecio en el relevamiento.
 *
 * Nunca por ausencia sin mas: si una corrida falla a medias, no queremos
 * avisar que la competencia dio de baja publicaciones que siguen ahi.
 */
export function detectChanges(
  scraped: ScrapedListing[],
  existing: ListingRow[],
  options: DiffOptions | string[] = {}
): DetectedChange[] {
  // Compatibilidad: antes el tercer parametro era el array de marcas.
  const opts: DiffOptions = Array.isArray(options)
    ? { brandsCovered: options }
    : options;

  const changes: DetectedChange[] = [];

  const covered = new Set(
    (opts.brandsCovered ?? [])
      .map((b) => b.trim().toLowerCase())
      .filter(Boolean)
  );
  const tracked = new Set(
    (opts.trackedIds ?? []).map((id) => id.trim().toUpperCase()).filter(Boolean)
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
      brand: s.brand || prev.brand,
      title: s.title,
      url: s.url ?? prev.url,
      seller: s.seller ?? prev.seller,
    };

    // --- Volvio a publicarse (estaba marcada de baja por nosotros) ---
    if (prev.status === "delisted") {
      changes.push({
        ...base,
        change_type: "relisted",
        old_value: "dada de baja",
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

    // --- Estado en Mercado Libre: pausada / reactivada ---
    const prevMl = normStatus(prev.ml_status);
    const newMl = normStatus(s.ml_status);
    if (prevMl && newMl && prevMl !== newMl) {
      if (newMl === "paused" || newMl === "closed") {
        changes.push({
          ...base,
          change_type: "paused",
          old_value: prevMl,
          new_value: newMl,
          delta_abs: null,
          delta_pct: null,
        });
      } else if (newMl === "active" && (prevMl === "paused" || prevMl === "closed")) {
        changes.push({
          ...base,
          change_type: "reactivated",
          old_value: prevMl,
          new_value: newMl,
          delta_abs: null,
          delta_pct: null,
        });
      }
    }

    // --- Stock ---
    const prevQty = prev.available_quantity;
    const newQty = s.available_quantity;
    if (
      prevQty !== null &&
      prevQty !== undefined &&
      newQty !== null &&
      newQty !== undefined
    ) {
      if (prevQty > 0 && newQty === 0) {
        changes.push({
          ...base,
          change_type: "out_of_stock",
          old_value: String(prevQty),
          new_value: "0",
          delta_abs: null,
          delta_pct: null,
        });
      } else if (prevQty === 0 && newQty > 0) {
        changes.push({
          ...base,
          change_type: "back_in_stock",
          old_value: "0",
          new_value: String(newQty),
          delta_abs: null,
          delta_pct: null,
        });
      }
    }

    // --- Cambio de vendedor ---
    // Se compara por ID y por nombre. El ID es el dato confiable: el nombre
    // depende de /users/{id}, que Mercado Libre puede no habilitar. En una
    // ficha de catalogo esto es la señal mas valiosa: significa que otro
    // vendedor pasó a ganar la venta.
    const prevSellerId = num(prev.seller_id);
    const newSellerId = num(s.seller_id ?? null);
    const prevSeller = (prev.seller ?? "").trim();
    const newSeller = (s.seller ?? "").trim();

    const idChanged =
      prevSellerId !== null && newSellerId !== null && prevSellerId !== newSellerId;
    const nameChanged = !!newSeller && !!prevSeller && newSeller !== prevSeller;

    if (idChanged || nameChanged) {
      changes.push({
        ...base,
        change_type: "seller_change",
        old_value: prevSeller || (prevSellerId !== null ? `vendedor ${prevSellerId}` : null),
        new_value: newSeller || (newSellerId !== null ? `vendedor ${newSellerId}` : null),
        delta_abs: null,
        delta_pct: null,
      });
    }

    // --- Competencia en la ficha de catalogo ---
    // Que entren o salgan vendedores de un producto es informacion
    // competitiva directa, incluso si el precio no se movio.
    const prevOffers = prev.offers_count;
    const newOffers = s.offers_count;
    if (
      prevOffers !== null &&
      prevOffers !== undefined &&
      newOffers !== null &&
      newOffers !== undefined &&
      prevOffers !== newOffers
    ) {
      changes.push({
        ...base,
        change_type: newOffers > prevOffers ? "new_competitor" : "competitor_left",
        old_value: String(prevOffers),
        new_value: String(newOffers),
        delta_abs: newOffers - prevOffers,
        delta_pct: null,
      });
    }

    // --- Cuotas ---
    const prevInst = prev.has_installments;
    const newInst = s.has_installments;
    const instKnown =
      prevInst !== null &&
      prevInst !== undefined &&
      newInst !== null &&
      newInst !== undefined;

    if (instKnown && prevInst !== newInst) {
      // Empezo o dejo de ofrecer financiacion.
      changes.push({
        ...base,
        change_type: newInst ? "installments_added" : "installments_removed",
        old_value: prevInst ? "con cuotas" : "sin cuotas",
        new_value:
          s.installments_text ?? (newInst ? "con cuotas" : "sin cuotas"),
        delta_abs: null,
        delta_pct: null,
      });
    } else if (instKnown && prevInst && newInst) {
      // Sigue ofreciendo cuotas, pero cambiaron las condiciones
      // (ej. de 6 a 12 cuotas). Es un movimiento competitivo relevante,
      // aunque el "si/no" no cambie.
      const prevText = (prev.installments_text ?? "").trim();
      const newText = (s.installments_text ?? "").trim();
      if (prevText && newText && prevText !== newText) {
        changes.push({
          ...base,
          change_type: "installments_changed",
          old_value: prevText,
          new_value: newText,
          delta_abs: null,
          delta_pct: null,
        });
      }
    }
  }

  // --- Bajas ---
  for (const prev of existing) {
    if (prev.status !== "active") continue;
    if (scrapedIds.has(prev.ml_id)) continue;

    const wasTracked = tracked.has(prev.ml_id);
    const brandKey = (prev.brand ?? "").trim().toLowerCase();
    const brandWasScanned = !!brandKey && covered.has(brandKey);

    if (!wasTracked && !brandWasScanned) continue;

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

function normStatus(s: string | null | undefined): string | null {
  const v = (s ?? "").trim().toLowerCase();
  return v || null;
}
