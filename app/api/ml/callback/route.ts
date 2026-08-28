import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { exchangeCodeForTokens, saveTokens } from "@/lib/ml-api";
import type { Query } from "@/lib/ingest-core";

export const runtime = "nodejs";

/**
 * GET /api/ml/callback?code=...
 *
 * Paso 2 de la autorizacion: Mercado Libre vuelve aca con un `code`,
 * lo canjeamos por access_token + refresh_token y los guardamos.
 * A partir de ese momento el sistema se refresca solo.
 */
export async function GET(req: Request) {
  const { searchParams, origin } = new URL(req.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (error) {
    return html(
      `<h2>Mercado Libre devolvió un error</h2><p><code>${escape(error)}</code></p>
       <p>${escape(searchParams.get("error_description") ?? "")}</p>`,
      400
    );
  }
  if (!code) {
    return html(
      `<h2>Falta el parámetro <code>code</code></h2>
       <p>Empezá el proceso desde <a href="/api/ml/auth">/api/ml/auth</a>.</p>`,
      400
    );
  }

  const base = process.env.NEXT_PUBLIC_APP_URL || origin;
  const redirectUri = `${base}/api/ml/callback`;
  const query: Query = (text, params) => sql.query(text, params ?? []);

  try {
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    await saveTokens(query, tokens);

    return html(`
      <h2>Listo — la app quedó autorizada</h2>
      <p>Ya puede consultar Mercado Libre por su cuenta. No hace falta repetir
      este paso: el sistema renueva el permiso solo.</p>
      <p style="color:#6b7684;font-size:13px">El permiso vence si pasan 6 meses
      sin actividad. Si eso llegara a pasar, el mail de alerta te lo va a avisar
      y solo hay que volver a entrar acá.</p>
      <p><a href="/">Ir al tablero</a></p>
    `);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return html(
      `<h2>No se pudo completar la autorización</h2>
       <pre style="white-space:pre-wrap;background:#f7f8fa;padding:12px;border-radius:6px">${escape(
         msg
       )}</pre>
       <p>Revisá que <code>ML_CLIENT_ID</code>, <code>ML_CLIENT_SECRET</code> y la
       Redirect URI configurada en Mercado Libre
       (<code>${escape(redirectUri)}</code>) coincidan.</p>`,
      500
    );
  }
}

function html(body: string, status = 200) {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>Autorización Mercado Libre</title>
     <div style="font-family:system-ui,sans-serif;max-width:620px;margin:60px auto;padding:0 20px;line-height:1.55">${body}</div>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function escape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
