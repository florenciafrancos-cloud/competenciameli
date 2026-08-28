/**
 * Cliente de la API oficial de Mercado Libre.
 *
 * QUE SE PUEDE Y QUE NO (verificado el 28/08/2026 contra la API real)
 * ------------------------------------------------------------------
 * Mercado Libre cerro la busqueda publica para aplicaciones no
 * certificadas. Con un token valido:
 *
 *   /sites/MLA/search?q=...            -> 403 forbidden
 *   /sites/MLA/search?nickname=...     -> 403 forbidden
 *   /sites/MLA/search?seller_id=...    -> 403 forbidden
 *   /highlights/MLA/category/...       -> 403 forbidden
 *
 *   /items?ids=MLA1,MLA2               -> 200 OK
 *   /items/{id}                        -> 200 OK
 *   /products/search                   -> 200 OK
 *   /users/{id}/items/search           -> 200 OK (solo publicaciones propias)
 *
 * Por eso el sistema NO descubre publicaciones: sigue una lista concreta
 * de links que carga el usuario. Eso es exactamente lo que /items permite.
 *
 * Autenticacion: OAuth2 authorization_code (una sola vez, a mano) +
 * refresh_token. El access_token dura 6 horas; el refresh_token dura
 * 6 meses y es de UN SOLO USO — cada refresco devuelve uno nuevo que hay
 * que guardar, por eso se persiste en la base y no en variables de entorno.
 * Requiere el scope `offline_access` en la aplicacion.
 */

import type { Query } from "./ingest-core";
import type { ScrapedListing } from "./types";

const ML_API = "https://api.mercadolibre.com";

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
  if (expiresAt.getTime() - 10 * 60 * 1000 > Date.now()) {
    return row.access_token as string;
  }

  return refreshAccessToken(q, row.refresh_token as string);
}

/** Intercambia el refresh_token por un access_token nuevo. */
export async function refreshAccessToken(
  q: Query,
  refreshToken: string
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: requireEnv("ML_CLIENT_ID"),
    client_secret: requireEnv("ML_CLIENT_SECRET"),
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
  if (!data.access_token || !data.refresh_token) {
    throw new Error(
      "El refresco devolvio una respuesta incompleta de Mercado Libre " +
        `(${JSON.stringify(data)}). Volvé a autorizar la app en /api/ml/auth.`
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
  if (!data.access_token) {
    throw new Error(
      `Mercado Libre no devolvio un access_token. Respuesta: ${JSON.stringify(data)}`
    );
  }

  // ML solo entrega refresh_token si la aplicacion tiene el scope
  // `offline_access`. Sin el, el permiso duraria 6 horas: preferimos
  // fallar aca con un mensaje claro antes que guardar algo que se rompe
  // esta misma tarde.
  if (!data.refresh_token) {
    throw new Error(
      "Mercado Libre no devolvio un refresh_token. Falta habilitar el scope " +
        "`offline_access` en la aplicacion: entrá a " +
        "https://developers.mercadolibre.com.ar/devcenter, editá la aplicacion, " +
        "marcá `offline_access` junto con `read`, guardá, y volvé a autorizar " +
        "desde /api/ml/auth."
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
// Links de Mercado Libre -> ID de publicacion
// ---------------------------------------------------------------

/**
 * Extrae el ID de publicacion de un link de Mercado Libre.
 *
 * Formatos que maneja:
 *   https://articulo.mercadolibre.com.ar/MLA-1234567890-termo-bubba-_JM
 *   https://www.mercadolibre.com.ar/termo-bubba/p/MLA1234567890
 *   https://mercadolibre.com.ar/MLA1234567890
 *   MLA1234567890            (pegar el ID directo tambien vale)
 *   MLA-1234567890
 */
export function parseMlId(input: string): string | null {
  const text = (input ?? "").trim();
  if (!text) return null;

  // Un ID pegado directo.
  const direct = text.match(/^(ML[A-Z])-?(\d{6,})$/i);
  if (direct) return `${direct[1].toUpperCase()}${direct[2]}`;

  // Dentro de una URL. Tomamos la primera aparicion.
  const inUrl = text.match(/(ML[A-Z])-?(\d{6,})/i);
  if (inUrl) return `${inUrl[1].toUpperCase()}${inUrl[2]}`;

  return null;
}

// ---------------------------------------------------------------
// Consulta de publicaciones
// ---------------------------------------------------------------

type MlItem = {
  id: string;
  title?: string;
  permalink?: string;
  price?: number;
  original_price?: number | null;
  base_price?: number | null;
  currency_id?: string;
  available_quantity?: number;
  status?: string;
  sub_status?: string[];
  seller_id?: number;
  official_store_id?: number | null;
  attributes?: { id?: string; name?: string; value_name?: string | null }[];
  sale_price?: { amount?: number; regular_amount?: number | null } | null;
  catalog_product_id?: string | null;
};

async function mlFetch(
  path: string,
  token: string
): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  const r = await fetch(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await r.text();
  let data: any = undefined;
  try {
    data = JSON.parse(text);
  } catch {
    /* no era JSON */
  }
  return { ok: r.ok, status: r.status, data, text };
}

/** Lee el valor del atributo BRAND de una publicacion. */
function brandOf(item: MlItem): string | null {
  const attr = item.attributes?.find(
    (a) => a.id === "BRAND" || a.name?.toLowerCase() === "marca"
  );
  return attr?.value_name?.trim() || null;
}

/**
 * Resuelve el nombre (nickname) de un vendedor, con cache por corrida.
 * Si la API no lo permite, devuelve null y seguimos con el seller_id.
 */
export class SellerResolver {
  private cache = new Map<number, string | null>();
  private failed = false;

  constructor(private token: string) {}

  async nickname(sellerId: number | null | undefined): Promise<string | null> {
    if (!sellerId || this.failed) return null;
    if (this.cache.has(sellerId)) return this.cache.get(sellerId) ?? null;

    const res = await mlFetch(`/users/${sellerId}`, this.token);
    if (!res.ok) {
      // Si el endpoint esta cerrado, no insistimos en cada publicacion.
      if (res.status === 403 || res.status === 401) this.failed = true;
      this.cache.set(sellerId, null);
      return null;
    }
    const nick = (res.data?.nickname ?? "").toString().trim() || null;
    this.cache.set(sellerId, nick);
    return nick;
  }

  get unavailable(): boolean {
    return this.failed;
  }
}

/**
 * Consulta las cuotas de una publicacion.
 *
 * Las cuotas no vienen en /items: eran parte de la respuesta de busqueda,
 * que esta cerrada. Se intenta /items/{id}/prices, que expone las
 * condiciones de financiacion cuando estan disponibles. Si el endpoint no
 * responde, devolvemos `null` (desconocido) y NO `false`, para no generar
 * una alerta falsa de "dejo de ofrecer cuotas".
 */
export async function fetchInstallments(
  mlId: string,
  token: string
): Promise<{ has: boolean | null; text: string | null }> {
  const res = await mlFetch(`/items/${mlId}/prices`, token);
  if (!res.ok || !res.data) return { has: null, text: null };

  const prices: any[] = Array.isArray(res.data?.prices) ? res.data.prices : [];

  for (const p of prices) {
    const inst =
      p?.conditions?.installments ??
      p?.installments ??
      p?.metadata?.installments;
    if (inst && (inst.quantity ?? 0) > 1) {
      const rate = inst.rate ?? inst.interest_rate;
      return {
        has: true,
        text:
          `${inst.quantity} cuotas` +
          (inst.amount ? ` de ${Math.round(inst.amount)}` : "") +
          (rate === 0 ? " sin interés" : ""),
      };
    }
  }

  // La respuesta vino bien pero sin informacion de cuotas: eso sí es
  // informacion — no hay financiacion declarada.
  const hasAnyInstallmentInfo = prices.some(
    (p) =>
      p?.conditions?.installments !== undefined ||
      p?.installments !== undefined ||
      p?.metadata?.installments !== undefined
  );
  return hasAnyInstallmentInfo
    ? { has: false, text: null }
    : { has: null, text: null };
}

/** Convierte un item de la API al formato que espera la ingesta. */
function toListing(
  item: MlItem,
  sellerNick: string | null,
  installments: { has: boolean | null; text: string | null }
): ScrapedListing {
  const price = item.sale_price?.amount ?? item.price ?? 0;
  const listPrice =
    item.sale_price?.regular_amount ??
    item.original_price ??
    (item.base_price && item.base_price > price ? item.base_price : null);

  const discountPct =
    listPrice && listPrice > price
      ? Number((((listPrice - price) / listPrice) * 100).toFixed(2))
      : null;

  return {
    ml_id: item.id,
    title: (item.title ?? item.id).trim(),
    brand: brandOf(item) ?? "",
    url: item.permalink ?? null,
    seller: sellerNick,
    seller_id: item.seller_id ?? null,
    official_store: item.official_store_id != null,
    list_price: listPrice ?? null,
    price,
    discount_pct: discountPct,
    has_installments: installments.has,
    installments_text: installments.text,
    currency: item.currency_id ?? "ARS",
    ml_status: item.status ?? null,
    available_quantity: item.available_quantity ?? null,
  };
}

export type FetchItemsResult = {
  listings: ScrapedListing[];
  /** IDs que Mercado Libre no encontro: publicaciones borradas. */
  notFound: string[];
  warnings: string[];
};

/**
 * Consulta un conjunto de publicaciones por ID.
 *
 * Es el corazon del sistema. Usa el multiget (/items?ids=) en lotes de 20,
 * que es el maximo que acepta la API.
 */
export async function fetchItems(
  ids: string[],
  token: string,
  opts: { withInstallments?: boolean } = {}
): Promise<FetchItemsResult> {
  const withInstallments = opts.withInstallments ?? true;
  const unique = [...new Set(ids.map((i) => i.trim().toUpperCase()))].filter(
    Boolean
  );

  const listings: ScrapedListing[] = [];
  const notFound: string[] = [];
  const warnings: string[] = [];
  const sellers = new SellerResolver(token);

  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    const res = await mlFetch(`/items?ids=${batch.join(",")}`, token);

    if (!res.ok) {
      warnings.push(
        `No se pudo consultar el lote ${batch.join(", ")}: ML respondió ${
          res.status
        } ${res.text.slice(0, 160)}`
      );
      continue;
    }

    const entries: any[] = Array.isArray(res.data) ? res.data : [];
    if (entries.length === 0) {
      warnings.push(
        `El lote ${batch.join(", ")} devolvió una respuesta vacía de Mercado Libre.`
      );
      continue;
    }

    for (const entry of entries) {
      const code = entry?.code;
      const body = entry?.body;

      if (code === 404 || (body && body?.error === "not_found")) {
        const missing = body?.id ?? entry?.id ?? "(id desconocido)";
        notFound.push(String(missing).toUpperCase());
        continue;
      }
      if (code !== 200 || !body?.id) {
        warnings.push(
          `Respuesta inesperada de ML para una publicación (code ${code}).`
        );
        continue;
      }

      const item = body as MlItem;
      const price = item.sale_price?.amount ?? item.price;
      if (!price || price <= 0) {
        warnings.push(
          `${item.id}: Mercado Libre no devolvió un precio válido; se omite.`
        );
        continue;
      }

      const nick = await sellers.nickname(item.seller_id);
      const inst = withInstallments
        ? await fetchInstallments(item.id, token)
        : { has: null, text: null };

      listings.push(toListing(item, nick, inst));
    }
  }

  // Los IDs que no volvieron ni como dato ni como 404: los tratamos como
  // no consultados, no como bajas.
  const returned = new Set([
    ...listings.map((l) => l.ml_id),
    ...notFound,
  ]);
  const missing = unique.filter((id) => !returned.has(id));
  if (missing.length > 0) {
    warnings.push(
      `${missing.length} publicación(es) no devolvieron respuesta y se excluyen de esta corrida (no se marcan de baja): ${missing
        .slice(0, 10)
        .join(", ")}`
    );
  }

  if (sellers.unavailable) {
    warnings.push(
      "Mercado Libre no permite consultar el nombre de los vendedores con este token; se sigue el resto igual, pero no se detectan cambios de vendedor."
    );
  }

  return { listings, notFound, warnings };
}

/**
 * Chequea que un ID exista antes de agregarlo al seguimiento, y devuelve
 * un resumen para mostrar en el dashboard.
 */
export async function previewItem(
  mlId: string,
  token: string
): Promise<
  | { ok: true; listing: ScrapedListing }
  | { ok: false; error: string }
> {
  const res = await mlFetch(`/items/${mlId}`, token);
  if (res.status === 404) {
    return {
      ok: false,
      error: `Mercado Libre no encontró la publicación ${mlId}. Revisá el link.`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `Mercado Libre respondió ${res.status} al consultar ${mlId}: ${res.text.slice(0, 160)}`,
    };
  }

  const item = res.data as MlItem;
  const price = item.sale_price?.amount ?? item.price;
  if (!price || price <= 0) {
    return {
      ok: false,
      error: `La publicación ${mlId} no tiene un precio consultable.`,
    };
  }

  const sellers = new SellerResolver(token);
  const nick = await sellers.nickname(item.seller_id);
  const inst = await fetchInstallments(mlId, token);

  return { ok: true, listing: toListing(item, nick, inst) };
}
