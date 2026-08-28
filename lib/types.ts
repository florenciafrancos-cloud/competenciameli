// Tipos compartidos entre el cliente de Mercado Libre, la API y el dashboard.

/** Estado de la publicacion segun Mercado Libre. */
export type MlStatus = "active" | "paused" | "closed" | "under_review" | string;

/** Una publicacion tal como queda despues de consultar /items. */
export type ScrapedListing = {
  /** ID de Mercado Libre, ej. "MLA1234567890". Es la clave unica. */
  ml_id: string;
  title: string;
  brand: string;
  url?: string | null;
  seller?: string | null;
  seller_id?: number | null;
  official_store?: boolean | null;
  /** Precio tachado / de lista. null si no hay descuento. */
  list_price?: number | null;
  /** Precio vigente (el que paga el comprador). Obligatorio. */
  price: number;
  discount_pct?: number | null;
  has_installments?: boolean | null;
  installments_text?: string | null;
  currency?: string | null;
  /** Estado en ML: active, paused, closed. */
  ml_status?: MlStatus | null;
  available_quantity?: number | null;
  /** Cuantas ofertas compiten por esta ficha de catalogo. */
  offers_count?: number | null;
};

/** Payload que recibe /api/ingest. */
export type IngestPayload = {
  /** Identificador de la corrida. Ej. "2026-08-28" o "2026-08-28 09:00". */
  run_id: string;
  /** De donde vino. Ej. "ml-api-cron". */
  source?: string;
  /**
   * IDs que se consultaron explicitamente en esta corrida.
   *
   * Es el modo principal del sistema: se sigue una lista concreta de
   * publicaciones. Un ID que esta aca y NO aparece en `listings` se
   * interpreta como dado de baja (ML devolvio 404 para el).
   */
  tracked_ids?: string[];
  /**
   * Marcas relevadas por busqueda. Quedo sin uso porque Mercado Libre
   * cerro la busqueda publica de su API (403), pero se mantiene para no
   * romper compatibilidad si alguna vez la reabren o si se carga un
   * relevamiento desde otra fuente.
   *
   * Si se usa: solo se evaluan bajas de las marcas incluidas aca.
   */
  brands_covered?: string[];
  listings: ScrapedListing[];
  notes?: string;
};

export type ChangeType =
  | "price_up"
  | "price_down"
  | "new_listing"
  | "delisted"
  | "relisted"
  | "seller_change"
  | "installments_added"
  | "installments_removed"
  | "installments_changed"
  | "paused"
  | "reactivated"
  | "out_of_stock"
  | "back_in_stock"
  | "new_competitor"
  | "competitor_left";

export type DetectedChange = {
  ml_id: string;
  brand: string | null;
  title: string | null;
  url: string | null;
  seller: string | null;
  change_type: ChangeType;
  old_value: string | null;
  new_value: string | null;
  delta_abs: number | null;
  delta_pct: number | null;
};

/** Fila de listings como sale de la base. */
export type ListingRow = {
  ml_id: string;
  title: string;
  brand: string | null;
  url: string | null;
  seller: string | null;
  seller_id: string | number | null;
  official_store: boolean | null;
  list_price: string | number | null;
  price: string | number | null;
  discount_pct: string | number | null;
  has_installments: boolean | null;
  installments_text: string | null;
  currency: string | null;
  status: string;
  ml_status: string | null;
  available_quantity: number | null;
  offers_count: number | null;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
};

export type ChangeRow = {
  id: number;
  ml_id: string | null;
  brand: string | null;
  title: string | null;
  url: string | null;
  seller: string | null;
  change_type: ChangeType;
  old_value: string | null;
  new_value: string | null;
  delta_abs: string | number | null;
  delta_pct: string | number | null;
  detected_at: string;
  run_id: string | null;
  seen: boolean;
};

export const CHANGE_LABELS: Record<ChangeType, string> = {
  price_down: "Bajó el precio",
  price_up: "Subió el precio",
  new_listing: "Publicación nueva",
  delisted: "Dada de baja",
  relisted: "Volvió a publicarse",
  seller_change: "Cambió el vendedor",
  installments_added: "Empezó a ofrecer cuotas",
  installments_removed: "Dejó de ofrecer cuotas",
  installments_changed: "Cambió las cuotas",
  paused: "Pausada",
  reactivated: "Reactivada",
  out_of_stock: "Sin stock",
  back_in_stock: "Volvió a tener stock",
  new_competitor: "Entraron competidores",
  competitor_left: "Se fueron competidores",
};

/** Orden en que se muestran los cambios: primero lo que más importa. */
export const CHANGE_ORDER: ChangeType[] = [
  "price_down",
  "price_up",
  "delisted",
  "paused",
  "out_of_stock",
  "relisted",
  "reactivated",
  "back_in_stock",
  "installments_added",
  "installments_removed",
  "installments_changed",
  "seller_change",
  "new_competitor",
  "competitor_left",
  "new_listing",
];
