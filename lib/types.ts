// Tipos compartidos entre el scraper, la API y el dashboard.

/** Una publicacion tal como la manda el scraper. */
export type ScrapedListing = {
  /** ID de Mercado Libre, ej. "MLA1234567890". Es la clave unica. */
  ml_id: string;
  title: string;
  brand: string;
  url?: string | null;
  seller?: string | null;
  official_store?: boolean | null;
  /** Precio tachado / de lista. null si no hay descuento. */
  list_price?: number | null;
  /** Precio vigente (el que paga el comprador). Obligatorio. */
  price: number;
  discount_pct?: number | null;
  has_installments?: boolean | null;
  installments_text?: string | null;
  currency?: string | null;
};

/** Payload completo que el scraper hace POST a /api/ingest. */
export type IngestPayload = {
  /** Identificador de la corrida. Ej. "2026-08-28" o "2026-08-28T09:00". */
  run_id: string;
  /** De donde vino. Ej. "claude-chrome". */
  source?: string;
  /**
   * Marcas efectivamente relevadas en esta corrida.
   * CRITICO: solo se evaluan bajas (delisted) de las marcas que estan aca.
   * Si una marca no se pudo relevar, NO incluirla, para no marcar
   * todas sus publicaciones como dadas de baja por error.
   */
  brands_covered: string[];
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
  | "installments_removed";

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
  official_store: boolean | null;
  list_price: string | number | null;
  price: string | number | null;
  discount_pct: string | number | null;
  has_installments: boolean | null;
  installments_text: string | null;
  currency: string | null;
  status: string;
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
  price_up: "Subio precio",
  price_down: "Bajo precio",
  new_listing: "Publicacion nueva",
  delisted: "Publicacion dada de baja",
  relisted: "Volvio a publicarse",
  seller_change: "Cambio de vendedor",
  installments_added: "Empezo a ofrecer cuotas",
  installments_removed: "Dejo de ofrecer cuotas",
};
