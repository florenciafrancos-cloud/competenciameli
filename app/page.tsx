"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import {
  CHANGE_LABELS,
  CHANGE_ORDER,
  type ChangeRow,
  type ChangeType,
  type ListingRow,
} from "@/lib/types";

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function money(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  });
}

function fecha(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TONE: Partial<Record<ChangeType, string>> = {
  price_up: "text-up",
  price_down: "text-down",
  delisted: "text-up",
  paused: "text-up",
  out_of_stock: "text-up",
  new_competitor: "text-up",
  competitor_left: "text-down",
  relisted: "text-down",
  reactivated: "text-down",
  back_in_stock: "text-down",
};

function estadoTexto(l: {
  status?: string | null;
  ml_status?: string | null;
  available_quantity?: number | null;
}): { text: string; tone: string } {
  if (l.status === "delisted") return { text: "dada de baja", tone: "text-up" };
  const ml = (l.ml_status ?? "").toLowerCase();
  if (ml === "paused") return { text: "pausada", tone: "text-up" };
  if (ml === "closed") return { text: "cerrada", tone: "text-up" };
  if (l.available_quantity === 0) return { text: "sin stock", tone: "text-up" };
  if (ml === "active") return { text: "activa", tone: "muted" };
  return { text: ml || "—", tone: "muted" };
}

// ---------------------------------------------------------------
// Historial de precios
// ---------------------------------------------------------------

function Sparkline({ mlId }: { mlId: string }) {
  const [points, setPoints] = useState<
    { captured_at: string; price: string }[] | null
  >(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/history?ml_id=${encodeURIComponent(mlId)}`)
      .then((r) => r.json())
      .then((d) => alive && setPoints(d.points ?? []))
      .catch(() => alive && setPoints([]));
    return () => {
      alive = false;
    };
  }, [mlId]);

  if (points === null) return <span className="muted text-xs">cargando…</span>;
  if (points.length < 2)
    return (
      <span className="muted text-xs">
        Todavía hay una sola medición. El gráfico aparece cuando haya al menos dos.
      </span>
    );

  const values = points.map((p) => Number(p.price));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 440;
  const h = 70;
  const pad = 6;

  const coords = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const last = values[values.length - 1];
  const first = values[0];
  const stroke = last > first ? "#c0392b" : last < first ? "#1e8e5a" : "#6b7684";

  return (
    <div className="flex items-center gap-4 flex-wrap">
      <svg
        width={w}
        height={h}
        className="max-w-full"
        role="img"
        aria-label="Evolución de precio"
      >
        <polyline
          points={coords.join(" ")}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {coords.map((c, i) => {
          const [x, y] = c.split(",");
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={i === coords.length - 1 ? 3.5 : 2}
              fill={stroke}
            />
          );
        })}
      </svg>
      <div className="text-xs tabular leading-relaxed">
        <div className="muted">
          {points.length} mediciones · desde {fecha(points[0].captured_at)}
        </div>
        <div>
          mín {money(min)} · máx {money(max)} · hoy <strong>{money(last)}</strong>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// Página
// ---------------------------------------------------------------

type Tab = "cambios" | "publicaciones" | "watchlist" | "cobertura";

export default function Home() {
  const [tab, setTab] = useState<Tab>("cambios");
  const [stats, setStats] = useState<any>(null);
  const [changes, setChanges] = useState<ChangeRow[]>([]);
  const [listings, setListings] = useState<ListingRow[]>([]);
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [days, setDays] = useState(30);
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [q, setQ] = useState("");
  const [openRow, setOpenRow] = useState<string | null>(null);

  const [newLink, setNewLink] = useState("");
  const [saving, setSaving] = useState(false);
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const [candidates, setCandidates] = useState<
    {
      id: string;
      name: string;
      price?: number | null;
      offers_count?: number | null;
    }[]
  >([]);

  const [settingUp, setSettingUp] = useState(false);
  const [setupMsg, setSetupMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  // Lista de SKU propios, leida del Sheet publicado
  const [skus, setSkus] = useState<
    { sku: string; price: number | null; label?: string | null }[]
  >([]);
  const [skusError, setSkusError] = useState<string | null>(null);
  const [newSku, setNewSku] = useState("");

  // Prueba de cobertura: cuanto del catalogo propio se puede seguir
  const [covText, setCovText] = useState("");
  const [covRunning, setCovRunning] = useState(false);
  const [covResult, setCovResult] = useState<any>(null);

  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const cq = new URLSearchParams({ days: String(days) });
      if (typeFilter) cq.set("type", typeFilter);
      const lq = new URLSearchParams({ status: statusFilter });
      if (q) lq.set("q", q);

      const [s, c, l, w, sk] = await Promise.all([
        fetch("/api/stats").then((r) => r.json()),
        fetch(`/api/changes?${cq}`).then((r) => r.json()),
        fetch(`/api/listings?${lq}`).then((r) => r.json()),
        fetch("/api/watchlist").then((r) => r.json()),
        fetch("/api/skus").then((r) => r.json()).catch(() => ({ skus: [] })),
      ]);
      if (s.error || c.error || l.error || w.error) {
        throw new Error(s.error || c.error || l.error || w.error);
      }
      setStats(s);
      setChanges(c.changes ?? []);
      setListings(l.listings ?? []);
      setWatchlist(w.watchlist ?? []);
      setSkus(sk?.skus ?? []);
      setSkusError(sk?.error ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [days, typeFilter, statusFilter, q]);

  useEffect(() => {
    load();
  }, [load]);

  const activos = watchlist.filter((w) => w.active);
  // Falta correr el schema: puede faltar una TABLA (instalacion nueva) o una
  // COLUMNA (base creada con una version anterior). Los dos casos se arreglan
  // con el mismo boton, asi que los detectamos juntos.
  const needsSetup =
    !!err &&
    /(relation|column|table) .* does not exist/i.test(err);
  const needsAuth = scanMsg && /api\/ml\/auth/.test(scanMsg.text);

  async function setupTables() {
    setSettingUp(true);
    setSetupMsg(null);
    try {
      const res = await fetch("/api/setup", { method: "POST" });
      const d = await res.json();
      setSetupMsg(
        res.ok && d.ok !== false
          ? {
              ok: true,
              text: `Listo: ${d.tables?.length ?? 0} tablas creadas.`,
            }
          : { ok: false, text: d.error ?? "No se pudieron crear las tablas." }
      );
      if (res.ok) load();
    } catch (e) {
      setSetupMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSettingUp(false);
    }
  }

  async function scanNow() {
    setScanning(true);
    setScanMsg(null);
    try {
      const res = await fetch("/api/scan-now", { method: "POST" });
      const d = await res.json();
      if (!res.ok || d.ok === false) {
        setScanMsg({
          ok: false,
          text: [d.error, ...(d.warnings ?? [])].filter(Boolean).join("\n"),
        });
      } else {
        const parts = [
          `${d.read_ok} publicaciones leídas`,
          `${d.changes_found} cambio${d.changes_found === 1 ? "" : "s"}`,
        ];
        if (d.not_found > 0) parts.push(`${d.not_found} sin ofertas o dadas de baja`);
        if (d.first_run) parts.push("primera carga: no se envió mail");
        else if (d.email?.sent) parts.push("mail enviado");
        else if (d.email?.reason) parts.push(`mail: ${d.email.reason}`);
        setScanMsg({
          ok: true,
          text:
            parts.join(" · ") +
            (d.warnings?.length ? `\n\nAvisos:\n${d.warnings.join("\n")}` : ""),
        });
      }
    } catch (e) {
      setScanMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setScanning(false);
      load();
    }
  }

  async function addLink() {
    const value = newLink.trim();
    if (!value) return;
    setSaving(true);
    setAddMsg(null);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value, sku: newSku || null }),
      });
      const d = await res.json();
      if (!res.ok) {
        setCandidates(Array.isArray(d.candidates) ? d.candidates : []);
        setAddMsg({ ok: false, text: d.error ?? "No se pudo agregar." });
      } else {
        setAddMsg({
          ok: true,
          text: `Agregada (${
            d.kind === "product" ? "ficha de catálogo" : "publicación"
          }): ${d.listing.title} — ${money(d.listing.price)}${
            d.listing.seller ? ` · ${d.listing.seller}` : ""
          }`,
        });
        setNewLink("");
        setCandidates([]);
        load();
      }
    } catch (e) {
      setAddMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  /** La persona eligió una de las opciones: un click y listo. */
  async function chooseCandidate(productId: string) {
    setSaving(true);
    setAddMsg(null);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id: productId,
          value: newLink.trim(),
          sku: newSku || null,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setAddMsg({ ok: false, text: d.error ?? "No se pudo agregar." });
      } else {
        setAddMsg({
          ok: true,
          text: `Agregado: ${d.listing.title} — ${money(d.listing.price)}${
            d.listing.offers_count ? ` · ${d.listing.offers_count} ofertas` : ""
          }`,
        });
        setNewLink("");
        setNewSku("");
        setCandidates([]);
        load();
      }
    } catch (e) {
      setAddMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  /** Asocia un SKU a un producto que ya se está siguiendo. */
  async function setSku(mlId: string, sku: string) {
    await fetch("/api/watchlist/sku", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ml_id: mlId, sku }),
    });
    load();
  }

  async function runCoverage() {
    setCovRunning(true);
    setCovResult(null);
    try {
      const res = await fetch("/api/ml/coverage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: covText }),
      });
      const d = await res.json();
      setCovResult(d);
    } catch (e) {
      setCovResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setCovRunning(false);
    }
  }

  async function removeWatch(id: number) {
    await fetch(`/api/watchlist?id=${id}`, { method: "DELETE" });
    load();
  }

  const lastRun = stats?.last_run;

  return (
    <main className="max-w-[1200px] mx-auto px-5 py-8">
      <header className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Monitor de competencia — Mercado Libre
          </h1>
          <p className="muted text-[13px] mt-0.5">
            {lastRun ? (
              <>
                Último control: <strong>{fecha(lastRun.started_at)}</strong> ·{" "}
                {lastRun.listings_seen} publicaciones · {lastRun.changes_found}{" "}
                cambios
                {lastRun.status !== "ok" && (
                  <span className="text-up"> · falló</span>
                )}
              </>
            ) : (
              "Todavía no se hizo ningún control."
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={scanNow}
            disabled={scanning || activos.length === 0}
            className="rounded-md bg-ink text-white px-3 py-1.5 text-[13px] disabled:opacity-40"
          >
            {scanning ? "Controlando…" : "Controlar ahora"}
          </button>
          <button
            onClick={load}
            className="rounded-md border hairline px-3 py-1.5 text-[13px]"
          >
            Actualizar
          </button>
          <button
            onClick={async () => {
              await fetch("/api/auth", { method: "DELETE" });
              location.href = "/login";
            }}
            className="rounded-md border hairline px-3 py-1.5 text-[13px] muted"
          >
            Salir
          </button>
        </div>
      </header>

      {needsSetup && (
        <div className="card p-4 mb-6 text-[13px]">
          <strong>La base necesita actualizarse.</strong>
          <p className="muted mt-1">
            Falta crear una tabla o una columna. Se puede repetir sin riesgo:
            no borra datos ni historial.
          </p>
          <p className="muted mt-1 text-[12px]">Detalle: {err}</p>
          <button
            onClick={setupTables}
            disabled={settingUp}
            className="mt-3 rounded-md bg-ink text-white px-3 py-1.5 disabled:opacity-40"
          >
            {settingUp ? "Creando…" : "Crear las tablas"}
          </button>
          {setupMsg && (
            <p
              className={`mt-2 whitespace-pre-wrap ${
                setupMsg.ok ? "muted" : "text-up"
              }`}
            >
              {setupMsg.text}
            </p>
          )}
        </div>
      )}

      {err && !needsSetup && (
        <div className="card p-4 mb-6 text-[13px] text-up">Error: {err}</div>
      )}

      {scanMsg && (
        <div className="card p-4 mb-6 text-[13px]">
          <div className="flex items-start justify-between gap-3">
            <div className={scanMsg.ok ? "" : "text-up"}>
              <strong>
                {scanMsg.ok ? "Control terminado" : "El control falló"}
              </strong>
              <div className="mt-1 whitespace-pre-wrap muted">{scanMsg.text}</div>
              {needsAuth && (
                <a
                  href="/api/ml/auth"
                  className="inline-block mt-2 underline decoration-dotted"
                >
                  Autorizar Mercado Libre
                </a>
              )}
            </div>
            <button
              onClick={() => setScanMsg(null)}
              className="muted text-[12px] shrink-0"
            >
              cerrar
            </button>
          </div>
        </div>
      )}

      {/* Cuando todavía no hay nada cargado, la pantalla explica qué hacer */}
      {!loading && !err && activos.length === 0 && (
        <div className="card p-5 mb-6">
          <h2 className="text-sm font-semibold">Empecemos</h2>
          <p className="muted text-[13px] mt-1 mb-4 max-w-2xl">
            Pegá el link de una publicación de la competencia en Mercado Libre.
            Todos los días se controla sola y te avisa por mail si cambia el
            precio, las cuotas, el vendedor, o si se pausa o se da de baja.
            Buscá el producto en Mercado Libre, entrá al resultado, y pegá la
            URL de la barra de direcciones tal cual está — con todo lo que
            venga después del signo de pregunta. Sirven las URLs con{" "}
            <code>/p/</code> y con <code>/up/</code>. Te muestra el mejor precio
            del producto, quién lo tiene, cuántos vendedores compiten, y te
            avisa cuando eso cambia.
          </p>
          <div className="flex gap-2 flex-wrap items-center text-[13px]">
            <input
              value={newLink}
              onChange={(e) => setNewLink(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addLink()}
              placeholder="Pegá acá la URL del producto en Mercado Libre"
              className="rounded-md border hairline bg-transparent px-3 py-2 w-full max-w-xl"
            />
            {skus.length > 0 && (
              <SkuSelect value={newSku} skus={skus} onChange={setNewSku} />
            )}
            <button
              onClick={addLink}
              disabled={saving || !newLink.trim()}
              className="rounded-md bg-ink text-white px-4 py-2 disabled:opacity-40"
            >
              {saving ? "Verificando…" : "Agregar"}
            </button>
          </div>
          {skusError && (
            <p className="muted text-[12px] mt-2">
              Lista de SKU no disponible: {skusError}
            </p>
          )}
          {addMsg && (
            <p className={`text-[13px] mt-2 whitespace-pre-wrap ${addMsg.ok ? "muted" : "text-up"}`}>
              {addMsg.text}
            </p>
          )}
          <CandidateList
            candidates={candidates}
            onChoose={chooseCandidate}
            disabled={saving}
          />
          <p className="muted text-[12px] mt-4">
            ¿No sabés si tus productos se pueden seguir?{" "}
            <button
              onClick={() => setTab("cobertura")}
              className="underline decoration-dotted"
            >
              Probá tu catálogo primero
            </button>
            .
          </p>
        </div>
      )}

      {stats && activos.length > 0 && (
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Kpi label="Publicaciones seguidas" value={activos.length} />
          <Kpi
            label="Cambios (7 días)"
            value={stats.changes_last_7d?.reduce(
              (a: number, b: any) => a + Number(b.n),
              0
            ) ?? 0}
          />
          <Kpi label="Bajas o pausas" value={stats.totals?.bajas ?? 0} />
          <Kpi label="Vendedores distintos" value={stats.totals?.vendedores ?? 0} />
        </section>
      )}

      {(activos.length > 0 || tab === "cobertura") && (
        <>
          <nav className="flex gap-1 border-b hairline mb-4">
            {(
              [
                ["cambios", `Cambios${changes.length ? ` (${changes.length})` : ""}`],
                ["publicaciones", `Precios de hoy${listings.length ? ` (${listings.length})` : ""}`],
                ["watchlist", `Qué se monitorea (${activos.length})`],
                ["cobertura", "Probar mi catálogo"],
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`px-3 py-2 text-[13px] border-b-2 -mb-px ${
                  tab === key
                    ? "border-current font-medium"
                    : "border-transparent muted"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="flex gap-2 flex-wrap items-center mb-4 text-[13px]">
            {tab === "cambios" && (
              <>
                <select
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  className="rounded-md border hairline bg-transparent px-2 py-1.5"
                >
                  <option value={1}>Últimas 24 h</option>
                  <option value={7}>Últimos 7 días</option>
                  <option value={30}>Últimos 30 días</option>
                  <option value={90}>Últimos 90 días</option>
                  <option value={365}>Todo</option>
                </select>
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="rounded-md border hairline bg-transparent px-2 py-1.5"
                >
                  <option value="">Todos los cambios</option>
                  {CHANGE_ORDER.map((k) => (
                    <option key={k} value={k}>
                      {CHANGE_LABELS[k]}
                    </option>
                  ))}
                </select>
              </>
            )}
            {tab === "publicaciones" && (
              <>
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar…"
                  className="rounded-md border hairline bg-transparent px-2 py-1.5 w-56"
                />
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="rounded-md border hairline bg-transparent px-2 py-1.5"
                >
                  <option value="all">Todas</option>
                  <option value="active">Solo activas</option>
                  <option value="delisted">Solo dadas de baja</option>
                </select>
              </>
            )}
            {loading && <span className="muted">cargando…</span>}
          </div>
        </>
      )}

      {/* ---- Cambios ---- */}
      {activos.length > 0 && tab === "cambios" && (
        <section className="card scroll-x">
          {changes.length === 0 ? (
            <p className="muted text-[13px] p-4">
              Sin cambios en el período elegido. Eso significa que la competencia
              no tocó nada.
            </p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Cuándo</th>
                  <th>Qué cambió</th>
                  <th>Publicación</th>
                  <th>Vendedor</th>
                  <th style={{ textAlign: "right" }}>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.id}>
                    <td className="muted whitespace-nowrap tabular">
                      {fecha(c.detected_at)}
                    </td>
                    <td
                      className={`whitespace-nowrap ${TONE[c.change_type] ?? ""}`}
                    >
                      {CHANGE_LABELS[c.change_type] ?? c.change_type}
                    </td>
                    <td className="max-w-[380px]">
                      {c.brand && (
                        <div className="muted text-[11px] uppercase tracking-wide">
                          {c.brand}
                        </div>
                      )}
                      {c.url ? (
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline decoration-dotted"
                        >
                          {c.title}
                        </a>
                      ) : (
                        c.title
                      )}
                    </td>
                    <td className="muted">{c.seller ?? "—"}</td>
                    <td className="tabular text-right whitespace-nowrap">
                      {c.change_type === "price_up" ||
                      c.change_type === "price_down" ? (
                        <>
                          {money(c.old_value)} →{" "}
                          <strong>{money(c.new_value)}</strong>
                          {c.delta_pct !== null && (
                            <span className={TONE[c.change_type]}>
                              {" "}
                              ({Number(c.delta_pct) > 0 ? "+" : ""}
                              {Number(c.delta_pct).toFixed(1)}%)
                            </span>
                          )}
                        </>
                      ) : c.change_type === "seller_change" ? (
                        <span className="text-[12px]">
                          {c.old_value} → {c.new_value}
                        </span>
                      ) : c.change_type === "delisted" ? (
                        <span className="muted">
                          estaba a {money(c.old_value)}
                        </span>
                      ) : c.change_type === "new_listing" ||
                        c.change_type === "relisted" ? (
                        money(c.new_value)
                      ) : (
                        <span className="text-[12px] muted">
                          {c.new_value ?? "—"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* ---- Precios de hoy ---- */}
      {activos.length > 0 && tab === "publicaciones" && (
        <section className="card scroll-x">
          {listings.length === 0 ? (
            <p className="muted text-[13px] p-4">
              Sin datos todavía. Apretá “Controlar ahora”.
            </p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Publicación</th>
                  <th>Vendedor</th>
                  <th style={{ textAlign: "right" }}>Lista</th>
                  <th style={{ textAlign: "right" }}>Precio</th>
                  <th style={{ textAlign: "right" }}>Desc.</th>
                  <th style={{ textAlign: "right" }}>Ofertas</th>
                  <th>Tu SKU</th>
                  <th style={{ textAlign: "right" }}>Tu precio</th>
                  <th style={{ textAlign: "right" }}>Diferencia</th>
                  <th>Cuotas</th>
                  <th>Estado</th>
                  <th>Visto</th>
                </tr>
              </thead>
              <tbody>
                {listings.map((l) => {
                  const est = estadoTexto(l);
                  return (
                    <Fragment key={l.ml_id}>
                      <tr
                        onClick={() =>
                          setOpenRow(openRow === l.ml_id ? null : l.ml_id)
                        }
                        className="cursor-pointer"
                      >
                        <td className="max-w-[360px]">
                          {l.brand && (
                            <div className="muted text-[11px] uppercase tracking-wide">
                              {l.brand}
                            </div>
                          )}
                          {l.url ? (
                            <a
                              href={l.url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="underline decoration-dotted"
                            >
                              {l.title}
                            </a>
                          ) : (
                            l.title
                          )}
                          <div className="muted text-[11px]">{l.ml_id}</div>
                        </td>
                        <td className="muted whitespace-nowrap">
                          {l.seller ?? "—"}
                          {l.official_store && (
                            <div className="text-[11px]">tienda oficial</div>
                          )}
                        </td>
                        <td className="tabular text-right muted whitespace-nowrap">
                          {l.list_price ? money(l.list_price) : "—"}
                        </td>
                        <td className="tabular text-right font-medium whitespace-nowrap">
                          {money(l.price)}
                        </td>
                        <td className="tabular text-right muted">
                          {l.discount_pct
                            ? `${Number(l.discount_pct).toFixed(0)}%`
                            : "—"}
                        </td>
                        <td className="tabular text-right muted">
                          {l.offers_count ?? "—"}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {skus.length > 0 ? (
                            <SkuSelect
                              value={(l as any).sku ?? ""}
                              skus={skus}
                              onChange={(v) => setSku(l.ml_id, v)}
                              compact
                            />
                          ) : (
                            <span className="muted text-[12px]">
                              {(l as any).sku ?? "—"}
                            </span>
                          )}
                        </td>
                        <td className="tabular text-right whitespace-nowrap">
                          {(l as any).own_price != null
                            ? money((l as any).own_price)
                            : "—"}
                        </td>
                        <td className="tabular text-right whitespace-nowrap">
                          <Diferencia
                            diffAbs={(l as any).diff_abs}
                            diffPct={(l as any).diff_pct}
                          />
                        </td>
                        <td className="muted text-[12px]">
                          {l.has_installments === null
                            ? "—"
                            : l.has_installments
                            ? l.installments_text || "sí"
                            : "no"}
                        </td>
                        <td className={`text-[12px] whitespace-nowrap ${est.tone}`}>
                          {est.text}
                          {l.available_quantity !== null &&
                            l.available_quantity !== undefined &&
                            l.available_quantity > 0 && (
                              <div className="muted text-[11px]">
                                {l.available_quantity} disp.
                              </div>
                            )}
                        </td>
                        <td className="muted whitespace-nowrap tabular text-[12px]">
                          {fecha(l.last_seen_at)}
                        </td>
                      </tr>
                      {openRow === l.ml_id && (
                        <tr>
                          <td colSpan={12} className="subtle">
                            <div className="p-2">
                              <div className="text-[11px] uppercase tracking-wide muted mb-2">
                                Evolución de precio
                              </div>
                              <Sparkline mlId={l.ml_id} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* ---- Watchlist ---- */}
      {activos.length > 0 && tab === "watchlist" && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold">Qué se monitorea</h2>
          <p className="muted text-[13px] mt-1 mb-4 max-w-2xl">
            Pegá el link de una publicación de Mercado Libre. Se verifica al
            instante contra ML, así sabés en el momento si el link está bien.
          </p>
          <p className="muted text-[12px] mb-4 max-w-2xl">
            Pegá la URL <strong>completa</strong>, tal como sale de la barra de
            direcciones: lo que viene después del <code>?</code> ayuda a
            identificar exactamente qué producto y qué variante estás mirando.
            Sirven las URLs con <code>/p/</code> y con <code>/up/</code>.
          </p>

          <div className="flex gap-2 flex-wrap items-center mb-2 text-[13px]">
            <input
              value={newLink}
              onChange={(e) => setNewLink(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addLink()}
              placeholder="Pegá acá la URL del producto en Mercado Libre"
              className="rounded-md border hairline bg-transparent px-3 py-2 w-full max-w-xl"
            />
            {skus.length > 0 && (
              <SkuSelect value={newSku} skus={skus} onChange={setNewSku} />
            )}
            <button
              onClick={addLink}
              disabled={saving || !newLink.trim()}
              className="rounded-md bg-ink text-white px-4 py-2 disabled:opacity-40"
            >
              {saving ? "Verificando…" : "Agregar"}
            </button>
          </div>
          {skusError && (
            <p className="muted text-[12px] mb-2">
              Lista de SKU no disponible: {skusError}
            </p>
          )}
          {addMsg && (
            <p className={`text-[13px] mb-2 whitespace-pre-wrap ${addMsg.ok ? "muted" : "text-up"}`}>
              {addMsg.text}
            </p>
          )}
          <CandidateList
            candidates={candidates}
            onChoose={chooseCandidate}
            disabled={saving}
          />

          <div className="scroll-x mt-4">
            <table className="data">
              <thead>
                <tr>
                  <th>Publicación</th>
                  <th>Tu SKU</th>
                  <th style={{ textAlign: "right" }}>Último precio</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {watchlist
                  .filter((w) => w.active)
                  .map((w) => {
                    const est = estadoTexto(w);
                    return (
                      <tr key={w.id}>
                        <td className="max-w-[420px]">
                          {w.url || w.value ? (
                            <a
                              href={w.url || w.value}
                              target="_blank"
                              rel="noreferrer"
                              className="underline decoration-dotted"
                            >
                              {w.title || w.label || w.value}
                            </a>
                          ) : (
                            w.title || w.label
                          )}
                        </td>
                        <td>
                          {skus.length > 0 ? (
                            <SkuSelect
                              value={w.sku ?? ""}
                              skus={skus}
                              onChange={(v) => setSku(w.ml_id, v)}
                              compact
                            />
                          ) : (
                            <span className="muted text-[12px]">{w.sku ?? "—"}</span>
                          )}
                          <div className="muted text-[11px] tabular mt-1">
                            {w.ml_id} · {w.id_kind === "product" ? "catálogo" : "publicación"}
                          </div>
                        </td>
                        <td className="tabular text-right whitespace-nowrap">
                          {money(w.price)}
                        </td>
                        <td className={`text-[12px] ${est.tone}`}>{est.text}</td>
                        <td className="text-right">
                          <button
                            onClick={() => removeWatch(w.id)}
                            className="muted text-[12px] underline decoration-dotted"
                          >
                            dejar de seguir
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          {watchlist.some((w) => !w.active) && (
            <details className="mt-5">
              <summary className="muted text-[13px] cursor-pointer">
                Ver {watchlist.filter((w) => !w.active).length} que dejaste de
                seguir
              </summary>
              <ul className="muted text-[12px] mt-2 space-y-1">
                {watchlist
                  .filter((w) => !w.active)
                  .map((w) => (
                    <li key={w.id}>
                      {w.title || w.label || w.value}
                      {w.kind !== "url" && ` (${w.kind}: ya no se puede relevar)`}
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {tab === "cobertura" && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold">Probar mi catálogo</h2>
          <p className="muted text-[13px] mt-1 mb-1 max-w-2xl">
            Pegá los nombres de tus productos, uno por línea, y te digo cuáles
            se pueden seguir con esta herramienta y cuáles no.
          </p>
          <p className="muted text-[12px] mb-3 max-w-2xl">
            La API de Mercado Libre solo permite consultar productos que
            participan de su catálogo. Las publicaciones de tienda oficial con
            variantes internas no se pueden seguir — ni con esta app ni con
            ninguna que use la API. Esto te dice, con datos, de qué lado cae tu
            catálogo antes de que inviertas tiempo.
          </p>

          <textarea
            value={covText}
            onChange={(e) => setCovText(e.target.value)}
            rows={7}
            placeholder={"Bubba Matterhorn 1.1L\nContigo Autoseal 473ml\nBubba Keg 1.9L"}
            className="w-full rounded-md border hairline bg-transparent px-3 py-2 text-[13px] font-mono"
          />
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={runCoverage}
              disabled={covRunning || !covText.trim()}
              className="rounded-md bg-ink text-white px-4 py-2 text-[13px] disabled:opacity-40"
            >
              {covRunning ? "Probando…" : "Probar"}
            </button>
            <span className="muted text-[12px]">
              Hasta 40 por vez. Tarda unos segundos por producto.
            </span>
          </div>

          {covResult?.error && (
            <p className="text-up text-[13px] mt-3">{covResult.error}</p>
          )}

          {covResult?.resumen && (
            <div className="mt-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <Kpi label="Se pueden seguir" value={covResult.resumen.seguibles} />
                <Kpi label="Sin ofertas en catálogo" value={covResult.resumen.sin_ofertas} />
                <Kpi label="No encontrados" value={covResult.resumen.no_encontrados} />
                <Kpi label="Probados" value={covResult.resumen.total} />
              </div>

              <p className="text-[13px] mb-3">
                {covResult.resumen.seguibles === 0 ? (
                  <>
                    Ninguno de estos productos se puede seguir por la API. Para
                    tu caso, esta herramienta no alcanza — conviene una
                    herramienta con acceso certificado por Mercado Libre.
                  </>
                ) : (
                  <>
                    <strong>
                      {covResult.resumen.seguibles} de {covResult.resumen.total}
                    </strong>{" "}
                    se pueden seguir con precio real y alertas de cambio.
                  </>
                )}
              </p>

              <div className="scroll-x">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Tu producto</th>
                      <th>Estado</th>
                      <th>Encontrado en ML como</th>
                      <th style={{ textAlign: "right" }}>Mejor precio</th>
                      <th style={{ textAlign: "right" }}>Vendedores</th>
                    </tr>
                  </thead>
                  <tbody>
                    {covResult.rows.map((r: any, i: number) => (
                      <tr key={i}>
                        <td className="font-medium">{r.query}</td>
                        <td
                          className={
                            r.status === "seguible" ? "text-down" : "text-up"
                          }
                        >
                          {r.status === "seguible"
                            ? "se puede seguir"
                            : r.status === "sin_ofertas"
                            ? "sin ofertas en catálogo"
                            : r.status === "no_encontrado"
                            ? "no encontrado"
                            : "error"}
                          {r.detail && (
                            <div className="muted text-[11px]">{r.detail}</div>
                          )}
                        </td>
                        <td className="muted max-w-[320px]">
                          {r.product_name ?? "—"}
                          {r.product_id && (
                            <div className="text-[11px] tabular">{r.product_id}</div>
                          )}
                        </td>
                        <td className="tabular text-right whitespace-nowrap">
                          {r.price != null ? money(r.price) : "—"}
                        </td>
                        <td className="tabular text-right">
                          {r.offers_count ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {covResult.omitidos > 0 && (
                <p className="muted text-[12px] mt-3">
                  Se probaron los primeros 40. Quedaron {covResult.omitidos} sin
                  probar: pegalos en otra tanda.
                </p>
              )}
            </div>
          )}
        </section>
      )}

      <footer className="muted text-[12px] mt-8 max-w-2xl">
        <p>
          El control corre solo una vez por día a las 9:00, consultando la API
          oficial de Mercado Libre publicación por publicación. Para adelantarlo,
          usá <strong>Controlar ahora</strong>.
        </p>
        {!needsSetup && (
          <p className="mt-3">
            <button
              onClick={setupTables}
              disabled={settingUp}
              className="underline decoration-dotted disabled:opacity-40"
            >
              {settingUp ? "Actualizando la base…" : "Actualizar la base"}
            </button>
            {setupMsg && (
              <span className={setupMsg.ok ? "" : "text-up"}> — {setupMsg.text}</span>
            )}
          </p>
        )}
      </footer>
    </main>
  );
}

function SkuSelect({
  value,
  skus,
  onChange,
  compact,
}: {
  value: string;
  skus: { sku: string; price: number | null; label?: string | null }[];
  onChange: (sku: string) => void;
  compact?: boolean;
}) {
  const chosen = skus.find((s) => s.sku === value);
  return (
    <span className="inline-flex items-center gap-2">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`rounded-md border hairline bg-transparent ${
          compact ? "px-1.5 py-1 text-[12px]" : "px-2 py-2 text-[13px]"
        }`}
      >
        <option value="">— sin SKU —</option>
        {skus.map((s) => (
          <option key={s.sku} value={s.sku}>
            {s.sku}
            {s.label ? ` · ${s.label}` : ""}
            {s.price != null ? ` · ${money(s.price)}` : " · sin precio"}
          </option>
        ))}
      </select>
      {chosen && (
        <span className="muted text-[12px] tabular whitespace-nowrap">
          {chosen.price != null ? money(chosen.price) : "sin precio"}
        </span>
      )}
    </span>
  );
}

/** Cuánto más caro (o barato) estás vos respecto del mejor de ML. */
function Diferencia({
  diffAbs,
  diffPct,
}: {
  diffAbs: number | null | undefined;
  diffPct: number | null | undefined;
}) {
  if (diffAbs == null || diffPct == null) return <span className="muted">—</span>;
  if (Math.abs(diffPct) < 0.05) return <span className="muted">igual</span>;
  const arriba = diffAbs > 0;
  return (
    <span className={arriba ? "text-up" : "text-down"}>
      {arriba ? "+" : ""}
      {diffPct.toFixed(1)}%
      <span className="muted block text-[11px]">
        {arriba ? "estás arriba" : "estás abajo"}
      </span>
    </span>
  );
}

function CandidateList({
  candidates,
  onChoose,
  disabled,
}: {
  candidates: {
    id: string;
    name: string;
    price?: number | null;
    offers_count?: number | null;
  }[];
  onChoose: (id: string) => void;
  disabled: boolean;
}) {
  if (candidates.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="muted text-[12px] mb-2">
        Tocá el producto correcto:
      </div>
      <ul className="space-y-1.5">
        {candidates.map((c) => (
          <li key={c.id}>
            <button
              onClick={() => onChoose(c.id)}
              disabled={disabled}
              className="w-full text-left rounded-md border hairline px-3 py-2 text-[13px] hover:bg-black/[.03] disabled:opacity-40"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span>{c.name}</span>
                {c.price != null && (
                  <strong className="tabular whitespace-nowrap">
                    {money(c.price)}
                  </strong>
                )}
              </div>
              <span className="muted text-[11px] block tabular">
                {c.offers_count != null
                  ? `${c.offers_count} ${c.offers_count === 1 ? "vendedor" : "vendedores"} · `
                  : ""}
                {c.id}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card p-3.5">
      <div className="muted text-[11px] uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold tabular mt-1">{value}</div>
    </div>
  );
}
