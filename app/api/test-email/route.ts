import { NextResponse } from "next/server";
import { sendAlertEmail } from "@/lib/notify";
import { isLoggedIn } from "@/lib/auth";
import type { DetectedChange } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/test-email
 *
 * Manda un correo de prueba para confirmar que las alertas funcionan.
 *
 * Existe porque, sin esto, configurar las notificaciones es a ciegas: no
 * hay forma de saber si andan hasta que la competencia cambie un precio,
 * lo que puede tardar días. Y el error más común (Resend sin dominio propio
 * solo deja enviarte a vos misma) devuelve un 403 que conviene ver ahora.
 *
 * Los datos del correo son de ejemplo y van marcados como tales.
 */
export async function POST() {
  if (!(await isLoggedIn())) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Falta RESEND_API_KEY. Cargala en Vercel (Settings → Environment Variables) y volvé a deployar.",
      },
      { status: 400 }
    );
  }
  if (!process.env.ALERT_EMAIL_TO) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Falta ALERT_EMAIL_TO: el mail donde querés recibir los avisos.",
      },
      { status: 400 }
    );
  }

  const ejemplo: DetectedChange[] = [
    {
      ml_id: "MLA00000000",
      brand: "EJEMPLO",
      title: "Producto de ejemplo — este correo es una prueba",
      url: null,
      seller: "VENDEDOR_DE_EJEMPLO",
      change_type: "price_down",
      old_value: "63599",
      new_value: "59900",
      delta_abs: -3699,
      delta_pct: -5.8,
    },
  ];

  const own = new Map([
    ["MLA00000000", { sku: "SKU-EJEMPLO", price: 68000 }],
  ]);

  const res = await sendAlertEmail(
    ejemplo,
    "correo de prueba (datos de ejemplo)",
    own
  );

  if (res.sent) {
    return NextResponse.json({
      ok: true,
      to: process.env.ALERT_EMAIL_TO,
      mensaje:
        "Correo enviado. Si no llega en un minuto, revisá spam y confirmá que " +
        "ALERT_EMAIL_TO sea la misma dirección con la que creaste la cuenta de Resend.",
    });
  }

  // El error de Resend es el dato útil: se devuelve tal cual.
  const esRestriccionDeDominio = /own email address|verify a domain/i.test(
    res.reason ?? ""
  );

  return NextResponse.json(
    {
      ok: false,
      error: res.reason ?? "No se pudo enviar.",
      ayuda: esRestriccionDeDominio
        ? "Resend, sin un dominio propio verificado, solo permite enviarte correos a la " +
          "dirección con la que creaste la cuenta. Poné esa dirección en ALERT_EMAIL_TO, " +
          "o verificá tu dominio en resend.com/domains para poder enviar a cualquier destinatario."
        : undefined,
    },
    { status: 400 }
  );
}
