import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/watchlist
 * Lista qué se está monitoreando. La tarea programada diaria lee esto
 * para saber qué marcas relevar — por eso agregar una marca nueva es
 * solo un POST acá, sin tocar código.
 */
export async function GET() {
  try {
    const res = await sql`
      SELECT id, kind, value, label, notes, active, created_at
      FROM watchlist
      ORDER BY kind, value
    `;
    return NextResponse.json({ watchlist: res.rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/** POST /api/watchlist  { kind, value, label?, notes? } */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const kind = String(body?.kind ?? "brand");
    const value = String(body?.value ?? "").trim();
    if (!value) return NextResponse.json({ error: "falta value" }, { status: 400 });
    if (!["brand", "seller", "url"].includes(kind)) {
      return NextResponse.json({ error: "kind invalido" }, { status: 400 });
    }

    await sql`
      INSERT INTO watchlist (kind, value, label, notes)
      VALUES (${kind}, ${value}, ${body?.label ?? value}, ${body?.notes ?? null})
      ON CONFLICT (kind, value) DO UPDATE
        SET active = TRUE, label = EXCLUDED.label, notes = EXCLUDED.notes
    `;
    return NextResponse.json({ ok: true, kind, value });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/** DELETE /api/watchlist?id=3  -> desactiva (no borra el historial) */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "falta id" }, { status: 400 });
  try {
    await sql`UPDATE watchlist SET active = FALSE WHERE id = ${Number(id)}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
