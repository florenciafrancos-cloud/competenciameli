import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/ml/auth
 *
 * Paso 1 de la autorizacion (se hace UNA sola vez, a mano).
 * Redirige al login de Mercado Libre para que autorices la aplicacion.
 * Al volver, el callback guarda los tokens en la base.
 */
export async function GET(req: Request) {
  const clientId = process.env.ML_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      {
        error:
          "Falta ML_CLIENT_ID. Creá la aplicacion en https://developers.mercadolibre.com.ar/devcenter y cargá ML_CLIENT_ID y ML_CLIENT_SECRET en Vercel.",
      },
      { status: 500 }
    );
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  const redirectUri = `${origin}/api/ml/callback`;

  // El dominio de autorizacion depende del pais. MLA = Argentina.
  const authHost =
    process.env.ML_AUTH_HOST || "https://auth.mercadolibre.com.ar";

  const url = new URL(`${authHost}/authorization`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);

  return NextResponse.redirect(url.toString());
}
