import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { ensureSchema } from "@/lib/ensure-schema";
import { runScan } from "@/lib/scan";
import { sendAlertEmail } from "@/lib/notify";
import type { Query } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const maxDuration = 300; // el relevamiento puede tardar

/**
 * GET /api/cron/scan
 *
 * El relevamiento diario. Lo dispara el cron de Vercel (ver vercel.json).
 *
 * Autorizacion: acepta el header que manda Vercel Cron
 * (Authorization: Bearer $CRON_SECRET) o, para correrlo a mano,
 * el INGEST_SECRET.
 */
export async function GET(req: Request) {
  await ensureSchema((t, p) => sql.query(t, p ?? []));
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  const ingestSecret = process.env.INGEST_SECRET;

  const authorized =
    (cronSecret && auth === `Bearer ${cronSecret}`) ||
    (ingestSecret && auth === `Bearer ${ingestSecret}`);

  if (!authorized) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  const query: Query = (text, params) => sql.query(text, params ?? []);

  try {
    const report = await runScan(query, { source: "vercel-cron" });

    if (report.error) {
      // Registramos la corrida fallida para que se vea en el dashboard.
      await query(
        `INSERT INTO runs (id, source, status, notes, finished_at)
         VALUES ($1, 'vercel-cron', 'error', $2, NOW())
         ON CONFLICT (id) DO UPDATE SET status = 'error', notes = EXCLUDED.notes, finished_at = NOW()`,
        [report.run_id, report.error]
      ).catch(() => {});
      return NextResponse.json({ ok: false, ...report }, { status: 500 });
    }

    const ingest = report.ingest!;
    const mail = ingest.first_run
      ? { sent: false, reason: "primera carga: se omite el email de alerta" }
      : await sendAlertEmail(ingest.changes, ingest.run_id);

    const { changes, ...summary } = ingest;
    return NextResponse.json({
      ...summary,
      ok: true,
      run_id: report.run_id,
      tracked: report.tracked,
      read_ok: report.read_ok,
      not_found: report.not_found,
      warnings: report.warnings,
      email: mail,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/** POST hace lo mismo, para poder dispararlo con curl comodamente. */
export const POST = GET;
