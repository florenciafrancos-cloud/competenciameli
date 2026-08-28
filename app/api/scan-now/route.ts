import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { runScan } from "@/lib/scan";
import { sendAlertEmail } from "@/lib/notify";
import { isLoggedIn } from "@/lib/auth";
import type { Query } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/scan-now
 *
 * Relevamiento a demanda, disparado desde el boton del dashboard.
 * Protegido por la sesion del dashboard (no necesita secreto).
 */
export async function POST() {
  if (!(await isLoggedIn())) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  const query: Query = (text, params) => sql.query(text, params ?? []);

  try {
    const report = await runScan(query, { source: "manual-dashboard" });

    if (report.error) {
      return NextResponse.json({ ok: false, ...report }, { status: 500 });
    }

    const ingest = report.ingest!;
    const mail = ingest.first_run
      ? { sent: false, reason: "primera carga: se omite el email" }
      : await sendAlertEmail(ingest.changes, ingest.run_id);

    const { changes, ...summary } = ingest;
    return NextResponse.json({
      ...summary,
      ok: true,
      warnings: report.warnings,
      brands_scanned: report.brands_scanned,
      email: mail,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
