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
 * Mercado Libre tiene DOS clases de link, y confundirlos es la causa de un
 * error muy poco claro ("no se encontro la publicacion"):
 *
 *   item     -> la publicacion de UN vendedor puntual
 *               https://articulo.mercadolibre.com.ar/MLA-1234567890-termo-_JM
 *
 *   product  -> la ficha de CATALOGO del producto, donde compiten varios
 *               vendedores. El ID no es una publicacion.
 *               https://www.mercadolibre.com.ar/termo-bubba/p/MLA67012657
 *
 * Seguir una ficha de catalogo es mas util para monitorear competencia:
 * avisa cuando cambia el precio y tambien cuando cambia QUE VENDEDOR esta
 * ganando la venta.
 */
export type MlLinkKind = "item" | "product" | "user_product";

export type ParsedMlLink = {
  id: string;
  kind: MlLinkKind;
};

/**
 * Reconoce un link (o un ID pegado directo) y dice de que clase es.
 *
 * Formatos reales que Mercado Libre usa (los tres aparecieron en uso):
 *
 *   1. Publicacion de un vendedor
 *      https://articulo.mercadolibre.com.ar/MLA-1234567890-termo-_JM
 *
 *   2. Ficha de catalogo
 *      https://www.mercadolibre.com.ar/termo/p/MLA67012657
 *
 *   3. "User product" (agrupador nuevo de ML). El ID empieza con MLAU y no
 *      se puede consultar, pero la URL trae el producto de catalogo en
 *      product_trigger_id:
 *      https://www.mercadolibre.com.ar/termo/up/MLAU4195231986?product_trigger_id=MLA74954916
 *
 * El orden de las reglas importa: en el caso 3, buscar "el primer MLA con
 * numeros" agarraba el product_trigger_id y lo trataba como publicacion,
 * lo que daba un 404 confuso. Por eso se resuelve por forma de URL, no por
 * la primera coincidencia.
 *
 * Tambien se respeta `wid=MLA...`, que en una pagina de catalogo identifica
 * la publicacion puntual que se esta mirando.
 */
export function parseMlLink(input: string): ParsedMlLink | null {
  const text = (input ?? "").trim();
  if (!text) return null;

  // ID pegado directo: no hay URL de donde inferir la clase.
  const direct = text.match(/^(ML[A-Z])(U?)-?(\d{4,})$/i);
  if (direct) {
    const prefix = direct[1].toUpperCase();
    if (direct[2]) {
      return { id: `${prefix}U${direct[3]}`, kind: "user_product" };
    }
    return { id: `${prefix}${direct[3]}`, kind: "item" };
  }

  const isCatalogPage = /\/(p|up)\//i.test(text);

  // Nota: NO se usa el parametro `wid` aunque apunte a la publicacion
  // concreta. Mercado Libre prohibe leer publicaciones de otros vendedores
  // (403 access_denied), asi que en una pagina de catalogo el unico camino
  // consultable es la ficha de catalogo.

  // Ficha de catalogo clasica: /p/MLA...
  const p = text.match(/\/p\/(ML[A-Z])-?(\d{4,})/i);
  if (p) {
    return { id: `${p[1].toUpperCase()}${p[2]}`, kind: "product" };
  }

  // Link /up/MLAU...: el producto de catalogo viene en product_trigger_id.
  const trigger = text.match(/[?&]product_trigger_id=(ML[A-Z])-?(\d{4,})/i);
  if (trigger && isCatalogPage) {
    return { id: `${trigger[1].toUpperCase()}${trigger[2]}`, kind: "product" };
  }

  // Publicacion dentro de una URL: MLA-1234567890 (con guion) o /MLA1234567890.
  const item =
    text.match(/(ML[A-Z])-(\d{6,})/i) ||
    text.match(/\/(ML[A-Z])(\d{6,})/i);
  if (item) {
    return { id: `${item[1].toUpperCase()}${item[2]}`, kind: "item" };
  }

  // Un /up/MLAU... sin product_trigger_id: el ID no es consultable directo,
  // pero se puede resolver buscando el producto en el catalogo por el
  // nombre que viene en la propia URL. Se marca como user_product para que
  // quien lo consuma sepa que necesita ese paso extra.
  const up = text.match(/\/up\/(ML[A-Z]U)(\d{4,})/i);
  if (up) {
    return { id: `${up[1].toUpperCase()}${up[2]}`, kind: "user_product" };
  }

  // Ultimo recurso: cualquier MLA con numeros suficientes.
  const loose = text.match(/(ML[A-Z])-?(\d{6,})/i);
  if (loose) {
    return { id: `${loose[1].toUpperCase()}${loose[2]}`, kind: "item" };
  }

  return null;
}

/** Compatibilidad: devuelve solo el ID. */
export function parseMlId(input: string): string | null {
  return parseMlLink(input)?.id ?? null;
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
  token: string,
  kind: MlLinkKind = "item",
  fallbackUrl: string | null = null
): Promise<
  | { ok: true; listing: ScrapedListing; kind: MlLinkKind }
  | { ok: false; error: string }
> {
  if (kind === "product") {
    const r = await fetchCatalogProduct(mlId, token, { fallbackUrl });
    return r.ok
      ? { ok: true, listing: r.listing, kind: "product" }
      : { ok: false, error: r.error };
  }

  const res = await mlFetch(`/items/${mlId}`, token);

  // Mercado Libre prohibe leer publicaciones de otros vendedores. Cuando
  // pasa, casi siempre el mismo producto tiene ficha de catalogo, que si
  // se puede: la probamos antes de darnos por vencidos.
  if (res.status === 403) {
    const asProduct = await fetchCatalogProduct(mlId, token, { fallbackUrl });
    if (asProduct.ok) {
      return { ok: true, listing: asProduct.listing, kind: "product" };
    }
    return {
      ok: false,
      error:
        `Mercado Libre no permite leer la publicación ${mlId}: solo deja consultar ` +
        `publicaciones propias. Pegá en su lugar el link de la ficha del producto ` +
        `(la URL que tiene /p/ o /up/), que sí se puede seguir y además te muestra ` +
        `todas las ofertas que compiten.`,
    };
  }
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

  return { ok: true, listing: toListing(item, nick, inst), kind: "item" };
}

// ---------------------------------------------------------------
// Fichas de catálogo
// ---------------------------------------------------------------

/**
 * VERIFICADO el 28/08/2026 contra la API real, con el token de Florencia:
 *
 *   /items/{id de otro vendedor}   -> 403 access_denied
 *   /items?ids={id de otro}        -> 200 con { code: 403 } adentro
 *   /products/{catalog_id}         -> 200 OK
 *   /products/{catalog_id}/items   -> 200 OK, lista TODAS las ofertas
 *
 * O sea: las publicaciones de terceros estan cerradas, pero las fichas de
 * catalogo no. Y la lista de ofertas trae, por cada vendedor que compite,
 * su item_id, su seller_id y su precio. Eso es mejor que seguir una sola
 * publicacion: da el mejor precio del producto, quien lo tiene, y cuantos
 * estan compitiendo.
 *
 * Detalles de la respuesta real:
 *   - `buy_box_winner` puede venir en null -> el ganador se calcula como la
 *     oferta mas barata de la lista.
 *   - `permalink` viene vacio -> se conserva el link que pego el usuario.
 *   - la lista de ofertas NO trae stock ni precio de lista.
 */

type CatalogOffer = {
  item_id: string;
  seller_id: number | null;
  price: number;
  currency_id?: string;
  available_quantity?: number | null;
  original_price?: number | null;
  listing_type_id?: string;
  condition?: string;
};

export type CatalogResult =
  | {
      ok: true;
      listing: ScrapedListing;
      winnerItemId: string | null;
      offers: CatalogOffer[];
      warnings: string[];
    }
  | { ok: false; error: string; status: number };

/** Normaliza una oferta de /products/{id}/items. */
function toOffer(r: any): CatalogOffer | null {
  const price = Number(r?.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    item_id: String(r.item_id ?? r.id ?? ""),
    seller_id: r.seller_id ?? null,
    price,
    currency_id: r.currency_id,
    available_quantity: r.available_quantity ?? null,
    original_price: r.original_price ?? null,
    listing_type_id: r.listing_type_id,
    condition: r.condition,
  };
}

export async function fetchCatalogProduct(
  productId: string,
  token: string,
  opts: { fallbackUrl?: string | null } = {}
): Promise<CatalogResult> {
  const warnings: string[] = [];

  const prod = await mlFetch(`/products/${productId}`, token);

  if (prod.status === 404) {
    return {
      ok: false,
      status: 404,
      error: `Mercado Libre no encontró el producto de catálogo ${productId}. Revisá el link.`,
    };
  }
  if (!prod.ok) {
    return {
      ok: false,
      status: prod.status,
      error:
        `Mercado Libre respondió ${prod.status} al consultar el producto ${productId}: ` +
        `${prod.text.slice(0, 200)}`,
    };
  }

  const product = prod.data ?? {};

  // Las ofertas que compiten. Es la fuente del precio y del vendedor.
  const itemsRes = await mlFetch(`/products/${productId}/items`, token);

  let offers: CatalogOffer[] = [];
  if (itemsRes.ok && Array.isArray(itemsRes.data?.results)) {
    offers = itemsRes.data.results
      .map(toOffer)
      .filter((o: CatalogOffer | null): o is CatalogOffer => o !== null)
      .sort((a: CatalogOffer, b: CatalogOffer) => a.price - b.price);
  } else if (itemsRes.status === 404) {
    // "No winners found": el producto existe pero nadie lo esta vendiendo.
    return {
      ok: false,
      status: 404,
      error:
        `El producto ${productId} existe en el catálogo pero no tiene ofertas activas ` +
        `(Mercado Libre responde "No winners found"). No hay precio que seguir todavía.`,
    };
  } else {
    warnings.push(
      `No se pudo leer la lista de ofertas de ${productId}: ML respondió ${itemsRes.status}.`
    );
  }

  // El ganador declarado por ML, si viene; si no, la oferta mas barata.
  const declared = product.buy_box_winner;
  const winner: CatalogOffer | null =
    declared && Number(declared.price) > 0
      ? toOffer(declared)
      : offers.length > 0
        ? offers[0]
        : null;

  if (!winner) {
    return {
      ok: false,
      status: 200,
      error:
        `Mercado Libre devolvió la ficha ${productId} pero sin ninguna oferta con precio. ` +
        `Puede que no tenga vendedores activos en este momento.`,
    };
  }

  // Nombre del vendedor y cuotas: son "si se puede". Si Mercado Libre no
  // los habilita, se sigue igual con el resto en vez de fallar.
  const sellers = new SellerResolver(token);
  const nick = await sellers.nickname(winner.seller_id ?? undefined);
  if (sellers.unavailable) {
    warnings.push(
      "Mercado Libre no permite leer el nombre de los vendedores con este token: " +
        "los cambios de vendedor se detectan igual, pero se muestran por número de vendedor."
    );
  }

  const inst = winner.item_id
    ? await fetchInstallments(winner.item_id, token)
    : { has: null, text: null };
  if (inst.has === null && winner.item_id) {
    warnings.push(
      "Las cuotas no se pueden leer en fichas de catálogo (Mercado Libre no habilita " +
        "el detalle de publicaciones de terceros). El resto se sigue normalmente."
    );
  }

  const brandAttr = (product.attributes ?? []).find(
    (a: any) => a.id === "BRAND" || a.name?.toLowerCase() === "marca"
  );

  const listPrice =
    winner.original_price && winner.original_price > winner.price
      ? Number(winner.original_price)
      : null;

  const listing: ScrapedListing = {
    ml_id: productId,
    title: (product.name ?? productId).toString().trim(),
    brand: (brandAttr?.value_name ?? guessBrand(product)).toString().trim(),
    // El permalink de la ficha viene vacio: conservamos el link del usuario.
    url: product.permalink?.trim() || opts.fallbackUrl || null,
    seller: nick,
    seller_id: winner.seller_id ?? null,
    official_store: null,
    list_price: listPrice,
    price: winner.price,
    discount_pct:
      listPrice && listPrice > winner.price
        ? Number((((listPrice - winner.price) / listPrice) * 100).toFixed(2))
        : null,
    has_installments: inst.has,
    installments_text: inst.text,
    currency: winner.currency_id ?? "ARS",
    ml_status: product.status ?? null,
    available_quantity: winner.available_quantity ?? null,
    offers_count: offers.length > 0 ? offers.length : null,
  };

  return { ok: true, listing, winnerItemId: winner.item_id || null, offers, warnings };
}

/**
 * La ficha no siempre trae el atributo Marca. El nombre del producto
 * empieza por la marca en la practica ("Botella Termica Bubba Vaso..."),
 * pero adivinar de ahi es fragil, asi que solo se usa `family_name` si esta.
 */
function guessBrand(product: any): string {
  const fam = (product?.family_name ?? "").toString().trim();
  if (!fam) return "";
  return fam.split(/\s+/)[0] ?? "";
}

/** Consulta varias fichas de catalogo. */
export async function fetchCatalogProducts(
  products: (string | { id: string; url?: string | null })[],
  token: string
): Promise<FetchItemsResult> {
  const listings: ScrapedListing[] = [];
  const notFound: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  // Los avisos de "no se pueden leer las cuotas" y similares son iguales
  // para todas las fichas: se reportan una sola vez.
  const globalWarnings = new Set<string>();

  for (const entry of products) {
    const id = (typeof entry === "string" ? entry : entry.id).toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const url = typeof entry === "string" ? null : entry.url ?? null;

    const r = await fetchCatalogProduct(id, token, { fallbackUrl: url });
    if (r.ok) {
      listings.push(r.listing);
      r.warnings.forEach((w) => globalWarnings.add(w));
    } else if (r.status === 404) {
      notFound.push(id);
    } else {
      warnings.push(`${id}: ${r.error}`);
    }
  }

  return { listings, notFound, warnings: [...warnings, ...globalWarnings] };
}

// ---------------------------------------------------------------
// Links /up/MLAU... — resolver el producto de catálogo
// ---------------------------------------------------------------

/**
 * Los links `/up/MLAU...` (sin product_trigger_id) traen un ID que Mercado
 * Libre no deja consultar. Pero el nombre del producto viene en la propia
 * URL, y `/products/search` SI funciona (verificado: 200 OK).
 *
 * Asi que se resuelve en tres intentos, del mas confiable al menos:
 *   1. `/products/{MLAU...}` — por si acaso responde.
 *   2. `/user-products/{MLAU...}` — puede traer el catalog_product_id.
 *   3. Buscar en el catalogo con las palabras del slug de la URL.
 *
 * El paso 3 es una coincidencia por texto, asi que NO se elige a ciegas: si
 * hay un candidato claramente mejor se usa, y si no se devuelven las
 * opciones para que la persona elija. Adivinar mal significaria seguir el
 * precio del producto equivocado sin que nadie se entere.
 */

export type CatalogCandidate = {
  id: string;
  name: string;
  score: number;
  /** Mejor precio actual. null si no se pudo leer. */
  price?: number | null;
  /** Cuantos vendedores compiten. 0 = producto sin ofertas activas. */
  offers_count?: number | null;
};

export type ResolveResult =
  | { ok: true; productId: string; via: string }
  | { ok: false; candidates: CatalogCandidate[]; error: string };

/**
 * Los links de resultados de busqueda traen `pdp_filters=item_id:MLA...`,
 * que identifica la oferta exacta que la persona estaba mirando.
 *
 * No se puede leer esa publicacion (ML devuelve 403 para las de otros
 * vendedores), pero sirve para algo mejor: desambiguar. El producto de
 * catalogo correcto es el UNICO cuya lista de ofertas la contiene. Asi se
 * evita elegir el color equivocado entre variantes con nombre casi igual.
 */
export function hintedItemId(url: string): string | null {
  // Mercado Libre lo pone de varias formas, incluso dentro del fragmento
  // despues del "#", y a veces escapado:
  //   ?pdp_filters=item_id:MLA3514608986
  //   ?pdp_filters=item_id%3AMLA3514608986
  //   #...%26wid%3DMLA3514608986%26...
  //   ?wid=MLA3514608986
  const patterns = [
    /item_id(?::|%3A)(ML[A-Z]\d{6,})/i,
    /wid(?:=|%3D)(ML[A-Z]\d{6,})/i,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/** Palabras utiles del slug de una URL de Mercado Libre. */
export function slugWords(url: string): string[] {
  const m = url.match(/mercadolibre\.com\.ar\/([^/?#]+)/i);
  const slug = m?.[1] ?? "";
  return slug
    .split("-")
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 1 && !/^\d+$/.test(w));
}

function scoreName(name: string, words: string[]): number {
  const hay = name.toLowerCase();
  if (words.length === 0) return 0;
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits / words.length;
}

export async function resolveUserProduct(
  userProductId: string,
  url: string,
  token: string
): Promise<ResolveResult> {
  // Intento 1: el ID tal cual.
  const direct = await mlFetch(`/products/${userProductId}`, token);
  if (direct.ok && direct.data?.id) {
    return { ok: true, productId: String(direct.data.id), via: "/products" };
  }

  // Intento 2: endpoint de user products.
  const up = await mlFetch(`/user-products/${userProductId}`, token);
  if (up.ok && up.data) {
    const catalogId =
      up.data.catalog_product_id ?? up.data.product_id ?? up.data.id;
    if (catalogId && String(catalogId).startsWith("ML")) {
      const id = String(catalogId);
      if (!id.includes("U")) {
        return { ok: true, productId: id, via: "/user-products" };
      }
    }
  }

  // Intento 3: buscar en el catalogo por el nombre de la URL.
  const words = slugWords(url);
  if (words.length === 0) {
    return {
      ok: false,
      candidates: [],
      error:
        `No pude resolver el producto de este link (${userProductId}) y la URL no ` +
        `tiene un nombre del que buscarlo.`,
    };
  }

  const q = encodeURIComponent(words.join(" "));
  const search = await mlFetch(
    `/products/search?status=active&site_id=MLA&q=${q}`,
    token
  );

  if (!search.ok || !Array.isArray(search.data?.results)) {
    return {
      ok: false,
      candidates: [],
      error:
        `No pude resolver el producto de este link. Mercado Libre no permite ` +
        `consultar el ID ${userProductId} y la búsqueda en el catálogo respondió ` +
        `${search.status}.`,
    };
  }

  const rough: CatalogCandidate[] = search.data.results
    .filter((r: any) => r?.id && r?.name)
    .map((r: any) => ({
      id: String(r.id),
      name: String(r.name),
      score: scoreName(String(r.name), words),
    }))
    .sort((a: CatalogCandidate, b: CatalogCandidate) => b.score - a.score)
    .slice(0, 6);

  const hint = hintedItemId(url);

  // Se consultan las ofertas de cada candidato UNA sola vez, y ese dato
  // sirve para tres cosas:
  //   - descartar los productos sin ofertas activas (elegir uno de esos
  //     mandaba a la persona a un error, a ciegas)
  //   - mostrar precio y cantidad de competidores en cada opcion, para que
  //     pueda elegir con informacion
  //   - si la URL trae el item_id, identificar la variante exacta
  const enriched: CatalogCandidate[] = [];
  for (const c of rough) {
    const offersRes = await mlFetch(`/products/${c.id}/items`, token);
    const list =
      offersRes.ok && Array.isArray(offersRes.data?.results)
        ? offersRes.data.results
            .map(toOffer)
            .filter((o: CatalogOffer | null): o is CatalogOffer => o !== null)
            .sort((a: CatalogOffer, b: CatalogOffer) => a.price - b.price)
        : [];

    // Coincidencia exacta por item_id: elegimos con certeza.
    if (hint && list.some((o: CatalogOffer) => o.item_id.toUpperCase() === hint)) {
      return { ok: true, productId: c.id, via: "item_id de la URL" };
    }

    if (list.length === 0) continue; // sin ofertas: no se ofrece como opcion

    enriched.push({
      ...c,
      price: list[0].price,
      offers_count: list.length,
    });
  }

  if (rough.length === 0) {
    return {
      ok: false,
      candidates: [],
      error: `No encontré el producto en el catálogo de Mercado Libre a partir de este link.`,
    };
  }

  if (enriched.length === 0) {
    return {
      ok: false,
      candidates: [],
      error:
        `Encontré el producto en el catálogo de Mercado Libre, pero ninguna de las ` +
        `variantes tiene ofertas activas: ninguna publicación de ese producto está ` +
        `participando del catálogo, que es lo único que la API deja consultar. ` +
        `Este producto no se puede seguir.`,
    };
  }

  // Si despues de descartar los muertos queda uno solo, no hay nada que
  // preguntar.
  if (enriched.length === 1) {
    return { ok: true, productId: enriched[0].id, via: "único con ofertas activas" };
  }

  const candidates = enriched;
  const best = candidates[0];
  const second = candidates[1];

  if (best && best.score >= 0.7 && (!second || best.score - second.score >= 0.15)) {
    return { ok: true, productId: best.id, via: "/products/search" };
  }

  return {
    ok: false,
    candidates,
    error:
      candidates.length > 0
        ? `Ese link no dice qué variante es. Estas son las que tienen ofertas activas:`
        : `No encontré el producto en el catálogo de Mercado Libre a partir de este link.`,
  };
}

// ---------------------------------------------------------------
// Cobertura: ¿este producto se puede seguir?
// ---------------------------------------------------------------

/**
 * Responde, para un nombre de producto, si la API de Mercado Libre permite
 * seguirlo o no.
 *
 * Existe para contestar una pregunta concreta antes de invertir tiempo:
 * "¿de mi catálogo, cuánto puedo seguir con esta herramienta?". La API solo
 * deja ver productos que participan del catálogo de ML; el resto (por
 * ejemplo publicaciones de tienda oficial con variantes internas) no tiene
 * ningún camino. Medirlo es mejor que suponerlo.
 */
export type CoverageRow = {
  query: string;
  status: "seguible" | "sin_ofertas" | "no_encontrado" | "error";
  product_id?: string | null;
  product_name?: string | null;
  price?: number | null;
  offers_count?: number | null;
  detail?: string;
};

export async function checkCoverage(
  name: string,
  token: string
): Promise<CoverageRow> {
  const query = name.trim();
  if (!query) {
    return { query, status: "error", detail: "nombre vacío" };
  }

  const words = query
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1);

  const search = await mlFetch(
    `/products/search?status=active&site_id=MLA&q=${encodeURIComponent(query)}`,
    token
  );

  if (!search.ok) {
    return {
      query,
      status: "error",
      detail: `la búsqueda en el catálogo respondió ${search.status}`,
    };
  }

  const results: any[] = Array.isArray(search.data?.results)
    ? search.data.results
    : [];
  if (results.length === 0) {
    return { query, status: "no_encontrado" };
  }

  const ranked = results
    .filter((r) => r?.id && r?.name)
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      score: scoreName(String(r.name), words),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  // Se busca el mejor candidato que ADEMAS tenga ofertas activas: un
  // producto de catálogo sin nadie vendiéndolo no se puede seguir.
  let bestName: string | null = ranked[0]?.name ?? null;
  for (const c of ranked) {
    const offersRes = await mlFetch(`/products/${c.id}/items`, token);
    if (!offersRes.ok || !Array.isArray(offersRes.data?.results)) continue;
    const offers = offersRes.data.results
      .map(toOffer)
      .filter((o: CatalogOffer | null): o is CatalogOffer => o !== null)
      .sort((a: CatalogOffer, b: CatalogOffer) => a.price - b.price);
    if (offers.length === 0) continue;

    return {
      query,
      status: "seguible",
      product_id: c.id,
      product_name: c.name,
      price: offers[0].price,
      offers_count: offers.length,
    };
  }

  return {
    query,
    status: "sin_ofertas",
    product_name: bestName,
    detail:
      "existe en el catálogo pero ninguna publicación participa del catálogo, " +
      "así que no hay precio consultable",
  };
}
