/**
 * Cliente de la API oficial de Mercado Libre.
 *
 * Por qué la API oficial y no scraping: Mercado Libre bloquea el scraping
 * automatizado (las paginas de resultados no entregan las publicaciones a
 * un navegador automatizado, y redirige a una pantalla de verificacion).
 * La API oficial es gratuita, permite consultar publicaciones de CUALQUIER
 * vendedor, y no depende de ninguna computadora prendida.
 *
 * Autenticacion: OAuth2 authorization_code (una sola vez, a mano) +
 * refresh_token. El access_token dura 6 horas; el refresh_token dura
 * 6 meses y es de UN SOLO USO — cada refresh devuelve uno nuevo que hay
 * que guardar, por eso se persiste en la base y no en variables de entorno.
 */

import type { Query } from "./ingest-core";
import type { ScrapedListing } from "./types";

const ML_API = "https://api.mercadolibre.com";
const SITE = process.env.ML_SITE_ID || "MLA"; // MLA = Argentina

// ---------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------

export type TokenSet = {
  access_token: string;
  refresh_token: string;
  expires_at: Date;
};

/**
 * Devuelve un access_token valido, refrescandolo si esta por vencer.
 * Guarda el nuevo refresh_token en la base (es de un solo uso).
 */
export async function getAccessToken(q: Query): Promise<string> {
  const res = await q(
    `SELECT access_token, refresh_token, expires_at FROM ml_tokens WHERE id = 1`
  );
  const row = res.rows[0];

  if (!row) {
    throw new Error(
      "No hay tokens de Mercado Libre guardados. Autorizá la app una vez entrando a /api/ml/auth (ver README)."
    );
  }

  // Margen de 10 minutos para no usar un token que vence en el medio.
  const expiresAt = new Date(row.expires_at);
  const margin = 10 * 60 * 1000;
  if (expiresAt.getTime() - margin > Date.now()) {
    return row.access_token as string;
  }

  return refreshAccessToken(q, row.refresh_token as string);
}

/** Intercambia el refresh_token por un access_token nuevo. */
export async function refreshAccessToken(
  q: Query,
  refreshToken: string
): Promise<string> {
  const clientId = requireEnv("ML_CLIENT_ID");
  const clientSecret = requireEnv("ML_CLIENT_SECRET");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const r = await fetch(`${ML_API}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      `No se pudo refrescar el token de Mercado Libre (${r.status}): ${
        data?.message ?? JSON.stringify(data)
      }. Si el refresh_token vencio (6 meses) hay que volver a autorizar la app en /api/ml/auth.`
    );
  }

  await saveTokens(q, {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + (data.expires_in ?? 21600) * 1000),
  });

  return data.access_token as string;
}

/** Guarda (o reemplaza) el juego de tokens. */
export async function saveTokens(q: Query, t: TokenSet): Promise<void> {
  await q(
    `INSERT INTO ml_tokens (id, access_token, refresh_token, expires_at, updated_at)
     VALUES (1, $1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE SET
       access_token  = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at    = EXCLUDED.expires_at,
       updated_at    = NOW()`,
    [t.access_token, t.refresh_token, t.expires_at.toISOString()]
  );
}

/** Cambia el `code` del callback de OAuth por el primer juego de tokens. */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: requireEnv("ML_CLIENT_ID"),
    client_secret: requireEnv("ML_CLIENT_SECRET"),
    code,
    redirect_uri: redirectUri,
  });

  const r = await fetch(`${ML_API}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      `Mercado Libre rechazo el codigo (${r.status}): ${
        data?.message ?? JSON.stringify(data)
      }`
    );
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + (data.expires_in ?? 21600) * 1000),
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

// ---------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------

type MlSearchItem = {
  id: string;
  title: string;
  permalink?: string;
  price?: number;
  original_price?: number | null;
  currency_id?: string;
  available_quantity?: number;
  status?: string;
  seller?: { id?: number; nickname?: string };
  seller_id?: number;
  official_store_id?: number | null;
  attributes?: { id?: string; name?: string; value_name?: string | null }[];
  installments?: {
    quantity?: number;
    amount?: number;
    rate?: number;
    currency_id?: string;
  } | null;
  sale_price?: { amount?: number; regular_amount?: number | null } | null;
};

async function mlFetch(path: string, token: string): Promise<any> {
  const r = await fetch(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`ML API ${r.status} en ${path}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

/** Lee el valor del atributo BRAND de una publicacion. */
function brandOf(item: MlSearchItem): string | null {
  const attr = item.attributes?.find(
    (a) => a.id === "BRAND" || a.name?.toLowerCase() === "marca"
  );
  return attr?.value_name?.trim() || null;
}

/** Convierte un item de la API al formato que espera la ingesta. */
function toScrapedListing(item: MlSearchItem, brand: string): ScrapedListing {
  // ML expone el precio vigente en `price` y el tachado en `original_price`.
  // `sale_price` es la version nueva del mismo dato; usamos la que venga.
  const price = item.sale_price?.amount ?? item.price ?? 0;
  const listPrice =
    item.sale_price?.regular_amount ?? item.original_price ?? null;

  const discountPct =
    listPrice && listPrice > price
      ? Number((((listPrice - price) / listPrice) * 100).toFixed(2))
      : null;

  const inst = item.installments;
  const hasInstallments = !!(inst && (inst.quantity ?? 0) > 1);
  const installmentsText = hasInstallments
    ? `${inst!.quantity} cuotas de ${inst!.amount}${
        inst!.rate === 0 ? " sin interes" : ""
      }`
    : null;

  return {
    ml_id: item.id,
    title: item.title ?? item.id,
    brand,
    url: item.permalink ?? null,
    seller: item.seller?.nickname ?? null,
    official_store: item.official_store_id != null ? true : false,
    list_price: listPrice,
    price,
    discount_pct: discountPct,
    has_installments: hasInstallments,
    installments_text: installmentsText,
    currency: item.currency_id ?? "ARS",
  };
}

export type ScanBrandResult = {
  brand: string;
  listings: ScrapedListing[];
  total_reported: number;
  pages_read: number;
  filtered_out: number;
  warnings: string[];
};

/**
 * Releva todas las publicaciones de una marca.
 *
 * Filtra por el atributo BRAND exacto, que es la leccion del relevamiento
 * manual de agosto: buscar "bubba" por texto trae mochilas, libros
 * infantiles, gorras "Bubba Gump" y cascos de moto. El filtro por marca
 * exacta es lo que evita esos falsos positivos.
 */
export async function scanBrand(
  brand: string,
  token: string,
  opts: { maxPages?: number; pageSize?: number } = {}
): Promise<ScanBrandResult> {
  const pageSize = opts.pageSize ?? 50;
  // ML no permite offset > 1000 en la busqueda publica.
  const maxPages = opts.maxPages ?? 20;

  const byId = new Map<string, ScrapedListing>();
  const warnings: string[] = [];
  let totalReported = 0;
  let pagesRead = 0;
  let filteredOut = 0;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    if (offset >= 1000) {
      warnings.push(
        `Se alcanzo el limite de 1000 posiciones que permite la API. Si la marca tiene mas publicaciones distintas, conviene dividir la busqueda por categoria.`
      );
      break;
    }

    let data: any;
    try {
      data = await mlFetch(
        `/sites/${SITE}/search?q=${encodeURIComponent(
          brand
        )}&limit=${pageSize}&offset=${offset}`,
        token
      );
    } catch (err) {
      warnings.push(
        `Error leyendo la pagina ${page + 1}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      break;
    }

    pagesRead++;
    totalReported = data?.paging?.total ?? totalReported;
    const results: MlSearchItem[] = data?.results ?? [];
    if (results.length === 0) break;

    for (const item of results) {
      const itemBrand = brandOf(item);
      // Solo publicaciones cuya marca declarada coincide exactamente.
      if (!itemBrand || itemBrand.toLowerCase() !== brand.toLowerCase()) {
        filteredOut++;
        continue;
      }
      const price = item.sale_price?.amount ?? item.price;
      if (!price || price <= 0) {
        filteredOut++;
        continue;
      }
      // Dedup: ML repite publicaciones patrocinadas entre paginas.
      if (!byId.has(item.id)) {
        byId.set(item.id, toScrapedListing(item, brand));
      }
    }

    // Si ya leimos todo lo que ML reporta, cortamos.
    if (offset + results.length >= totalReported) break;
  }

  if (byId.size === 0) {
    warnings.push(
      `No se encontro ninguna publicacion con marca exacta "${brand}". Verificá que el nombre coincida con como ML escribe la marca.`
    );
  }

  return {
    brand,
    listings: [...byId.values()],
    total_reported: totalReported,
    pages_read: pagesRead,
    filtered_out: filteredOut,
    warnings,
  };
}

/** Releva un vendedor completo (todas sus publicaciones activas). */
export async function scanSeller(
  nickname: string,
  token: string,
  opts: { maxPages?: number; pageSize?: number } = {}
): Promise<ScanBrandResult> {
  const pageSize = opts.pageSize ?? 50;
  const maxPages = opts.maxPages ?? 20;
  const byId = new Map<string, ScrapedListing>();
  const warnings: string[] = [];
  let totalReported = 0;
  let pagesRead = 0;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    if (offset >= 1000) break;

    let data: any;
    try {
      data = await mlFetch(
        `/sites/${SITE}/search?nickname=${encodeURIComponent(
          nickname
        )}&limit=${pageSize}&offset=${offset}`,
        token
      );
    } catch (err) {
      warnings.push(
        `Error leyendo el vendedor ${nickname}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      break;
    }

    pagesRead++;
    totalReported = data?.paging?.total ?? totalReported;
    const results: MlSearchItem[] = data?.results ?? [];
    if (results.length === 0) break;

    for (const item of results) {
      const price = item.sale_price?.amount ?? item.price;
      if (!price || price <= 0) continue;
      if (!byId.has(item.id)) {
        byId.set(item.id, toScrapedListing(item, brandOf(item) ?? nickname));
      }
    }

    if (offset + results.length >= totalReported) break;
  }

  return {
    brand: nickname,
    listings: [...byId.values()],
    total_reported: totalReported,
    pages_read: pagesRead,
    filtered_out: 0,
    warnings,
  };
}

/** Trae publicaciones puntuales por ID (multiget, hasta 20 por llamada). */
export async function fetchItems(
  ids: string[],
  token: string
): Promise<ScrapedListing[]> {
  const out: ScrapedListing[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    const data = await mlFetch(`/items?ids=${batch.join(",")}`, token);
    for (const entry of data ?? []) {
      if (entry?.code !== 200 || !entry?.body) continue;
      const item = entry.body as MlSearchItem;
      const price = item.sale_price?.amount ?? item.price;
      if (!price || price <= 0) continue;
      out.push(toScrapedListing(item, brandOf(item) ?? ""));
    }
  }
  return out;
}
