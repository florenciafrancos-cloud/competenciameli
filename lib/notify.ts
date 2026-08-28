import { CHANGE_LABELS, CHANGE_ORDER, type DetectedChange } from "./types";

/** Tipos de cambio que disparan email. El resto queda solo en el dashboard. */
const ALERT_TYPES = new Set<string>(CHANGE_ORDER);

function fmtMoney(v: string | null): string {
  if (!v) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  });
}

function describe(c: DetectedChange): string {
  switch (c.change_type) {
    case "price_up":
    case "price_down": {
      const arrow = c.change_type === "price_up" ? "▲" : "▼";
      const pct = c.delta_pct !== null ? ` (${c.delta_pct > 0 ? "+" : ""}${c.delta_pct}%)` : "";
      return `${arrow} ${fmtMoney(c.old_value)} → ${fmtMoney(c.new_value)}${pct}`;
    }
    case "new_listing":
      return `Nueva, a ${fmtMoney(c.new_value)}`;
    case "delisted":
      return `Ya no existe (estaba a ${fmtMoney(c.old_value)})`;
    case "relisted":
      return `Volvió, a ${fmtMoney(c.new_value)}`;
    case "reactivated":
      return "Volvió a estar activa";
    case "paused":
      return c.new_value === "closed" ? "Cerrada por el vendedor" : "Pausada";
    case "out_of_stock":
      return "Se quedó sin stock";
    case "back_in_stock":
      return `Volvió a tener stock (${c.new_value})`;
    case "installments_changed":
      return `${c.old_value} → ${c.new_value}`;
    case "seller_change":
      return `${c.old_value} → ${c.new_value}`;
    default:
      return `${c.old_value ?? ""} → ${c.new_value ?? ""}`;
  }
}

/** Tu SKU y tu precio, por publicación seguida. */
export type OwnPriceInfo = Map<string, { sku: string; price: number | null }>;

/** "+6,9% arriba" / "−4,1% abajo", o vacío si no hay con qué comparar. */
function ownComparison(
  c: DetectedChange,
  own: OwnPriceInfo | undefined
): string {
  const info = own?.get(c.ml_id);
  if (!info || info.price == null) return "";

  const PRICE_CHANGES = new Set(["price_up", "price_down", "new_listing", "relisted"]);
  const ref = PRICE_CHANGES.has(c.change_type)
    ? Number(c.new_value)
    : null;
  if (ref === null || !Number.isFinite(ref) || ref === 0) return "";

  const pct = ((info.price - ref) / ref) * 100;
  const arriba = pct > 0;
  const signo = arriba ? "+" : "";
  return (
    `<div style="color:${arriba ? "#c0392b" : "#1e8e5a"};font-size:12px;margin-top:2px">` +
    `${escapeHtml(info.sku)}: ${fmtMoney(String(info.price))} · ` +
    `${signo}${pct.toFixed(1)}% ${arriba ? "estás arriba" : "estás abajo"}</div>`
  );
}

function buildHtml(
  changes: DetectedChange[],
  appUrl: string,
  runId: string,
  own?: OwnPriceInfo
): string {
  const byType = new Map<string, DetectedChange[]>();
  for (const c of changes) {
    if (!byType.has(c.change_type)) byType.set(c.change_type, []);
    byType.get(c.change_type)!.push(c);
  }

  // Los cambios de precio primero, que son los que mas importan.
  const order: string[] = [...CHANGE_ORDER];

  const sections = order
    .filter((t) => byType.has(t))
    .map((t) => {
      const items = byType.get(t)!;
      const rows = items
        .slice(0, 25)
        .map((c) => {
          const title = c.url
            ? `<a href="${c.url}" style="color:#1558d6;text-decoration:none">${escapeHtml(c.title ?? c.ml_id)}</a>`
            : escapeHtml(c.title ?? c.ml_id);
          return `<tr>
            <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px">
              <div style="color:#6b7684;font-size:11px;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(c.brand ?? "")}${c.seller ? " · " + escapeHtml(c.seller) : ""}</div>
              ${title}
              ${ownComparison(c, own)}
            </td>
            <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;white-space:nowrap;text-align:right">${escapeHtml(describe(c))}</td>
          </tr>`;
        })
        .join("");
      const more =
        items.length > 25
          ? `<tr><td colspan="2" style="padding:8px 10px;font-size:12px;color:#6b7684">…y ${items.length - 25} mas. Ver todo en el dashboard.</td></tr>`
          : "";
      return `<h3 style="font:600 14px system-ui;margin:24px 0 6px;color:#0f1720">${CHANGE_LABELS[t as keyof typeof CHANGE_LABELS]} <span style="color:#6b7684;font-weight:400">(${items.length})</span></h3>
        <table style="width:100%;border-collapse:collapse">${rows}${more}</table>`;
    })
    .join("");

  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#0f1720">
    <h2 style="font-size:18px;margin:0 0 4px">Cambios en la competencia — Mercado Libre</h2>
    <p style="color:#6b7684;font-size:13px;margin:0 0 8px">${changes.length} cambio${changes.length === 1 ? "" : "s"} detectado${changes.length === 1 ? "" : "s"} en la corrida <code>${escapeHtml(runId)}</code>.</p>
    ${sections}
    <p style="margin:28px 0 0">
      <a href="${appUrl}" style="display:inline-block;background:#0f1720;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:13px">Abrir el dashboard</a>
    </p>
  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Manda el email de alerta. Si no hay RESEND_API_KEY configurada,
 * no hace nada y devuelve un motivo (el ingest sigue funcionando igual).
 */
export async function sendAlertEmail(
  changes: DetectedChange[],
  runId: string,
  own?: OwnPriceInfo
): Promise<{ sent: boolean; reason?: string }> {
  const relevant = changes.filter((c) => ALERT_TYPES.has(c.change_type));
  if (relevant.length === 0) return { sent: false, reason: "sin cambios relevantes" };

  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM || "onboarding@resend.dev";
  if (!key || !to) return { sent: false, reason: "RESEND_API_KEY o ALERT_EMAIL_TO sin configurar" };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";

  try {
    const { Resend } = await import("resend");
    const resend = new Resend(key);
    await resend.emails.send({
      from,
      to: to.split(",").map((s) => s.trim()),
      subject: `ML competencia: ${relevant.length} cambio${relevant.length === 1 ? "" : "s"} detectado${relevant.length === 1 ? "" : "s"}`,
      html: buildHtml(relevant, appUrl, runId, own),
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
