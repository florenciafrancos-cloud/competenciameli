import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { runIngest, IngestError, type Query } from "@/lib/ingest-core";
import { sendAlertEmail } from "@/lib/notify";
import type { IngestPayload } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/ingest
 *
 * Recibe el snapshot de una corrida del scraper, lo compara con el
 * estado guardado, registra los cambios y manda el email de alerta.
 *
 * Header obligatorio:  Authorization: Bearer <INGEST_SECRET>
 */
export async function POST(req: Request) {
  // ---- Auth ----
  const secret = process.env.INGEST_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "INGEST_SECRET no esta configurada en el servidor" },
      { status: 500 }
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  // ---- Payload ----
  let body: IngestPayload;
  try {
    body = (await req.json()) as IngestPayload;
  } catch {
    return NextResponse.json({ error: "JSON invalido" }, { status: 400 });
  }

  const query: Query = (text, params) => sql.query(text, params ?? []);

  try {
    const result = await runIngest(body, query);

    const mail = result.first_run
      ? { sent: false, reason: "primera carga: se omite el email de alerta" }
      : await sendAlertEmail(result.changes, result.run_id);

    // No devolvemos `changes` completo para no inflar la respuesta.
    const { changes, ...summary } = result;
    return NextResponse.json({ ...summary, email: mail });
  } catch (err) {
    if (err instanceof IngestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/** GET de cortesia: documenta el formato esperado. */
export async function GET() {
  return NextResponse.json({
    endpoint: "/api/ingest",
    method: "POST",
    auth: "Authorization: Bearer <INGEST_SECRET>",
    payload: {
      run_id: "2026-08-28",
      source: "claude-chrome",
      brands_covered: ["Bubba", "Contigo"],
      listings: [
        {
          ml_id: "MLA1234567890",
          title: "Termo Bubba Radiant 1.1L",
          brand: "Bubba",
          url: "https://articulo.mercadolibre.com.ar/MLA-1234567890",
          seller: "Termo Style",
          official_store: true,
          list_price: 45000,
          price: 36000,
          discount_pct: 20,
          has_installments: true,
          installments_text: "6 cuotas sin interes",
        },
      ],
    },
  });
}
