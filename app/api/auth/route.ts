import { NextResponse } from "next/server";
import { makeSessionToken, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

/** POST /api/auth  { password }  -> setea cookie de sesion */
export async function POST(req: Request) {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    return NextResponse.json({ ok: true, note: "sin password configurada" });
  }

  let password = "";
  try {
    const body = await req.json();
    password = String(body?.password ?? "");
  } catch {
    return NextResponse.json({ error: "JSON invalido" }, { status: 400 });
  }

  if (password !== expected) {
    return NextResponse.json({ error: "Contrasena incorrecta" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, makeSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

/** DELETE /api/auth -> logout */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
