import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";

const COOKIE = "mlmon_session";

function sign(value: string): string {
  const secret = process.env.DASHBOARD_PASSWORD ?? "";
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function makeSessionToken(): string {
  const payload = "ok";
  return `${payload}.${sign(payload)}`;
}

export function isValidToken(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return false;
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Lee la cookie de sesion en un Server Component / route handler.
 * En Next 15 `cookies()` es asincrono.
 */
export async function isLoggedIn(): Promise<boolean> {
  if (!process.env.DASHBOARD_PASSWORD) return true; // sin password configurada, abierto
  const store = await cookies();
  return isValidToken(store.get(COOKIE)?.value);
}

export const SESSION_COOKIE = COOKIE;
