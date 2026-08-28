import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { getAccessToken, parseMlId, previewItem } from "@/lib/ml-api";
import type { Query } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const query: Query = (text, params) => sql.query(text, params ?? []);

/**
 * GET /api/watchlist
 * Lista las publicaciones que se están siguiendo, con su último dato.
 */
export async function GET() {
  try {
    const res = await sql.query(
      `SELECT w.id, w.kind, w.value, w.label, w.notes, w.ml_id, w.active,
              w.created_at,
              l.title, l.price, l.seller, l.ml_status, l.status,
              l.available_quantity, l.url, l.last_seen_at
       FROM watchlist w
       LEFT JOIN listings l ON l.ml_id = w.ml_id
       ORDER BY w.active DESC, w.created_at DESC`
    );
    return NextResponse.json({ watchlist: res.rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/watchlist  { value, label?, notes? }
 *
 * `value` es un link de Mercado Libre (o un ID pegado directo).
 * Antes de guardarlo se consulta la publicación en ML: así el usuario se
 * entera al instante si el link está mal, en vez de descubrirlo al día
 * siguiente cuando la corrida no encuentra nada.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalido" }, { status: 400 });
  }

  const raw = String(body?.value ?? "").trim();
  if (!raw) {
    return NextResponse.json(
      { error: "Pegá el link de la publicación de Mercado Libre." },
      { status: 400 }
    );
  }

  const mlId = parseMlId(raw);
  if (!mlId) {
    return NextResponse.json(
      {
        error:
          "No pude reconocer un ID de publicación en eso. Pegá el link completo de Mercado Libre (o el código que empieza con MLA).",
      },
      { status: 400 }
    );
  }

  try {
    // ¿Ya la estábamos siguiendo?
    const dup = await query(
      `SELECT id, active FROM watchlist WHERE ml_id = $1 LIMIT 1`,
      [mlId]
    );
    if (dup.rows.length > 0 && dup.rows[0].active) {
      return NextResponse.json(
        { error: `Esa publicación (${mlId}) ya está en la lista.` },
        { status: 409 }
      );
    }

    // Verificamos contra Mercado Libre antes de guardar.
    const token = await getAccessToken(query);
    const preview = await previewItem(mlId, token);
    if (!preview.ok) {
      return NextResponse.json({ error: preview.error }, { status: 400 });
    }

    const l = preview.listing;

    await query(
      `INSERT INTO watchlist (kind, value, label, notes, ml_id, active)
       VALUES ('url', $1, $2, $3, $4, TRUE)
       ON CONFLICT (kind, value) DO UPDATE
         SET active = TRUE,
             label  = EXCLUDED.label,
             notes  = EXCLUDED.notes,
             ml_id  = EXCLUDED.ml_id`,
      [
        l.url ?? raw,
        String(body?.label ?? l.title).slice(0, 300),
        body?.notes ?? null,
        mlId,
      ]
    );

    // Guardamos la foto inicial para tener contra qué comparar mañana.
    // Sin esto, el primer cambio de precio pasaría desapercibido.
    const { runIngest } = await import("@/lib/ingest-core");
    await runIngest(
      {
        run_id: `alta ${mlId} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
        source: "alta-manual",
        tracked_ids: [mlId],
        listings: [l],
      },
      query
    );

    return NextResponse.json({
      ok: true,
      ml_id: mlId,
      listing: {
        title: l.title,
        price: l.price,
        seller: l.seller,
        ml_status: l.ml_status,
        available_quantity: l.available_quantity,
        installments_text: l.installments_text,
        url: l.url,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/** DELETE /api/watchlist?id=3  -> deja de seguirla (conserva el historial) */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "falta id" }, { status: 400 });
  try {
    await sql.query(`UPDATE watchlist SET active = FALSE WHERE id = $1`, [
      Number(id),
    ]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
