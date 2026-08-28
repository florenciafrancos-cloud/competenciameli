import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getAccessToken } from "@/lib/ml-api";
import { isLoggedIn } from "@/lib/auth";
import type { Query } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * GET /api/ml/diag
 *
 * Diagnostico: prueba, uno por uno, los endpoints de la API de Mercado
 * Libre que este proyecto podria usar, y reporta cual responde y cual
 * devuelve 403.
 *
 * Existe porque en agosto de 2026 nos encontramos con que
 * /sites/MLA/search devuelve 403 incluso con un token valido — Mercado
 * Libre lo cerro para aplicaciones no certificadas. Este endpoint sirve
 * para saber con datos, y no por suposicion, que camino queda abierto.
 *
 * Parametros opcionales:
 *   ?item=MLA1234567890   una publicacion real para probar /items
 *   ?seller=Termo Style   un vendedor real para probar la busqueda por vendedor
 *   ?cat=MLA1601          una categoria para probar /highlights
 *
 * Autorizacion: sesion del dashboard, o Bearer INGEST_SECRET.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const auth = req.headers.get("authorization");
  const secret = process.env.INGEST_SECRET;

  const byToken = !!secret && auth === `Bearer ${secret}`;
  const bySession = !auth && (await isLoggedIn());
  if (!byToken && !bySession) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  const query: Query = (text, params) => sql.query(text, params ?? []);

  let token: string;
  try {
    token = await getAccessToken(query);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  // Primero /users/me, para conocer el user_id y confirmar que el token sirve.
  const me = await probe("/users/me", token);
  const myId = me.ok ? (me.sample as any)?.id : null;
  const myNick = me.ok ? (me.sample as any)?.nickname : null;

  const item = searchParams.get("item")?.trim();
  const seller = searchParams.get("seller")?.trim();
  const cat = searchParams.get("cat")?.trim() || "MLA1601";
  const product = searchParams.get("product")?.trim();

  const targets: { label: string; path: string; why: string }[] = [
    {
      label: "busqueda publica por texto",
      path: `/sites/MLA/search?q=termo&limit=1`,
      why: "Es el que usa el relevamiento por marca. Si da 403, no se puede buscar por marca.",
    },
    {
      label: "busqueda publica por vendedor (nickname)",
      path: `/sites/MLA/search?nickname=${encodeURIComponent(seller || myNick || "test")}&limit=1`,
      why: "Alternativa: seguir competidores puntuales en vez de marcas.",
    },
    {
      label: "busqueda publica por seller_id",
      path: `/sites/MLA/search?seller_id=${myId ?? 1}&limit=1`,
      why: "Misma alternativa, por id en vez de nickname.",
    },
    {
      label: "detalle de publicaciones (multiget)",
      path: `/items?ids=${item || "MLA1"}`,
      why: "Clave: si esto funciona, se puede seguir una lista fija de publicaciones por URL.",
    },
    {
      label: "detalle de una publicacion",
      path: `/items/${item || "MLA1"}`,
      why: "Igual que el anterior, en su forma simple.",
    },
    {
      label: "busqueda en el catalogo de productos",
      path: `/products/search?status=active&site_id=MLA&q=termo`,
      why: "Otra via para encontrar productos y despues sus publicaciones.",
    },
    {
      label: "ficha de catalogo (producto)",
      path: `/products/${product || "MLA1"}`,
      why: "Clave para los links del tipo /p/MLA...: si funciona, se puede seguir la ficha de catalogo y detectar cambios de precio y de vendedor ganador.",
    },
    {
      label: "ofertas de una ficha de catalogo",
      path: `/products/${product || "MLA1"}/items`,
      why: "Alternativa si la ficha no trae buy_box_winner: lista los vendedores que compiten.",
    },
    {
      label: "destacados por categoria",
      path: `/highlights/MLA/category/${cat}`,
      why: "Devuelve las publicaciones mas vendidas de una categoria.",
    },
    {
      label: "mis propias publicaciones",
      path: myId ? `/users/${myId}/items/search?limit=1` : `/users/me/items/search?limit=1`,
      why: "Deberia funcionar siempre. Sirve de referencia.",
    },
    {
      label: "categorias del sitio",
      path: `/sites/MLA/categories`,
      why: "Endpoint publico basico. Referencia.",
    },
  ];

  const results = [];
  for (const t of targets) {
    results.push({ ...t, ...(await probe(t.path, token)) });
  }

  const works = results.filter((r) => r.ok).map((r) => r.label);
  const forbidden = results.filter((r) => r.status === 403).map((r) => r.label);

  return NextResponse.json({
    token_ok: me.ok,
    user: me.ok ? { id: myId, nickname: myNick } : null,
    me_error: me.ok ? undefined : me.body,
    hint: [
      item ? null : "Pasá ?item=MLA... con el ID de una publicación de un vendedor (link articulo.mercadolibre.com.ar).",
      product ? null : "Pasá ?product=MLA... con el ID de una ficha de catálogo (link con /p/MLA...).",
    ]
      .filter(Boolean)
      .join(" ") || undefined,
    resumen: {
      funcionan: works,
      prohibidos_403: forbidden,
    },
    detalle: results,
  });
}

async function probe(path: string, token: string) {
  const url = `https://api.mercadolibre.com${path}`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const text = await r.text();
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* no era JSON */
    }
    return {
      path,
      status: r.status,
      ok: r.ok,
      body: r.ok ? undefined : text.slice(0, 300),
      sample: r.ok ? summarize(parsed) : undefined,
    };
  } catch (err) {
    return {
      path,
      status: 0,
      ok: false,
      body: err instanceof Error ? err.message : String(err),
      sample: undefined,
    };
  }
}

/** Recorta la respuesta para que el diagnostico sea legible. */
function summarize(data: unknown): unknown {
  if (Array.isArray(data)) {
    return { tipo: "array", largo: data.length, primero: shallow(data[0]) };
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.results)) {
      return {
        total: (o.paging as any)?.total,
        devueltos: o.results.length,
        primero: shallow(o.results[0]),
      };
    }
    return shallow(o);
  }
  return data;
}

function shallow(o: unknown): unknown {
  if (!o || typeof o !== "object") return o;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (Object.keys(out).length >= 12) break;
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
      out[k] = typeof v === "string" ? v.slice(0, 120) : v;
    } else if (Array.isArray(v)) {
      out[k] = `[array de ${v.length}]`;
    } else {
      out[k] = "{objeto}";
    }
  }
  return out;
}
