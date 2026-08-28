import { NextResponse, type NextRequest } from "next/server";

/**
 * Protege el dashboard con la cookie de sesion.
 *
 * NO protege (cada uno tiene su propia autorizacion):
 *  - /api/ingest    Bearer INGEST_SECRET
 *  - /api/setup     Bearer INGEST_SECRET
 *  - /api/cron/*    Bearer CRON_SECRET, lo llama el cron de Vercel sin cookie
 *  - /api/ml/*      OAuth con Mercado Libre; el callback llega sin cookie
 *  - /api/auth      es el login mismo
 *  - /login
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    pathname.startsWith("/api/ingest") ||
    pathname.startsWith("/api/setup") ||
    pathname.startsWith("/api/cron") ||
    pathname.startsWith("/api/ml") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  // Si no hay password configurada, la app queda abierta.
  if (!process.env.DASHBOARD_PASSWORD) return NextResponse.next();

  const token = req.cookies.get("mlmon_session")?.value;
  if (token && token.includes(".")) {
    // La verificacion criptografica real se hace del lado del server
    // (lib/auth.ts). Aca solo chequeamos presencia, porque el runtime
    // Edge del middleware no tiene modulo crypto de Node.
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
