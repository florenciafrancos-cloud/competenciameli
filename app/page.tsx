"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { CHANGE_LABELS, type ChangeRow, type ChangeType, type ListingRow } from "@/lib/types";

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

const CHANGE_TONE: Record<string, string> = {
  price_up: "text-up",
  price_down: "text-down",
  new_listing: "",
  delisted: "muted",
  relisted: "",
  seller_change: "",
  installments_added: "",
  installments_removed: "",
};

// ---------------------------------------------------------------
// Sparkline del historial de precios
// ---------------------------------------------------------------

function Sparkline({ mlId }: { mlId: string }) {
  const [points, setPoints] = useState<{ captured_at: string; price: string }[] | null>(null);

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
    return <span className="muted text-xs">todavía sin historial suficiente</span>;

  const values = points.map((p) => Number(p.price));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 420;
  const h = 70;
  const pad = 6;

  const coords = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const last = values[values.length - 1];
  const first = values[0];
  const trend = last > first ? "up" : last < first ? "down" : "flat";
  const stroke = trend === "up" ? "#c0392b" : trend === "down" ? "#1e8e5a" : "#6b7684";

  return (
    <div className="flex items-center gap-4 flex-wrap">
      <svg width={w} height={h} className="max-w-full" role="img" aria-label="Evolución de precio">
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
          return <circle key={i} cx={x} cy={y} r={i === coords.length - 1 ? 3.5 : 2} fill={stroke} />;
        })}
      </svg>
      <div className="text-xs tabular leading-relaxed">
        <div className="muted">
          {points.length} mediciones · desde {fecha(points[0].captured_at)}
        </div>
        <div>
          mín {money(min)} · máx {money(max)} · actual <strong>{money(last)}</strong>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// Página
// ---------------------------------------------------------------

type Tab = "cambios" | "publicaciones" | "watchlist";

export default function Home() {
  const [tab, setTab] = useState<Tab>("cambios");
  const [stats, setStats] = useState<any>(null);
  const [changes, setChanges] = useState<ChangeRow[]>([]);
  const [listings, setListings] = useState<(ListingRow & { snapshots?: number })[]>([]);
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // filtros
  const [days, setDays] = useState(30);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [brandFilter, setBrandFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [openRow, setOpenRow] = useState<string | null>(null);

  // agregar marca al watchlist
  const [newBrand, setNewBrand] = useState("");
  const [newKind, setNewKind] = useState("brand");
  const [saving, setSaving] = useState(false);

  // creacion de tablas
  const [settingUp, setSettingUp] = useState(false);
  const [setupMsg, setSetupMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  // relevamiento a demanda
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const qs = new URLSearchParams();
      qs.set("days", String(days));
      if (typeFilter) qs.set("type", typeFilter);
      if (brandFilter) qs.set("brand", brandFilter);

      const ls = new URLSearchParams();
      ls.set("status", statusFilter);
      if (brandFilter) ls.set("brand", brandFilter);
      if (q) ls.set("q", q);

      const [s, c, l, w] = await Promise.all([
        fetch("/api/stats").then((r) => r.json()),
        fetch(`/api/changes?${qs}`).then((r) => r.json()),
        fetch(`/api/listings?${ls}`).then((r) => r.json()),
        fetch("/api/watchlist").then((r) => r.json()),
      ]);
      if (s.error || c.error || l.error) {
        throw new Error(s.error || c.error || l.error);
      }
      setStats(s);
      setChanges(c.changes ?? []);
      setListings(l.listings ?? []);
      setWatchlist(w.watchlist ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [days, typeFilter, brandFilter, q, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const brands: string[] = useMemo(
    () => (stats?.by_brand ?? []).map((b: any) => b.brand),
    [stats]
  );

  async function setupTables() {
    setSettingUp(true);
    setSetupMsg(null);
    try {
      const res = await fetch("/api/setup", { method: "POST" });
      const d = await res.json();
      if (!res.ok || d.ok === false) {
        setSetupMsg({
          ok: false,
          text: d.error ?? "No se pudieron crear las tablas.",
        });
      } else {
        setSetupMsg({
          ok: true,
          text: `Listo: ${d.tables?.length ?? 0} tablas creadas. Ahora autorizá Mercado Libre en /api/ml/auth y después apretá "Relevar ahora".`,
        });
        load();
      }
    } catch (e) {
      setSetupMsg({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
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
          text: d.error ?? "No se pudo completar el relevamiento.",
        });
      } else {
        const parts = [
          `${d.listings_valid} publicaciones leídas`,
          `${d.changes_found} cambio${d.changes_found === 1 ? "" : "s"} detectado${d.changes_found === 1 ? "" : "s"}`,
        ];
        if (d.first_run) parts.push("primera carga: no se envió mail");
        else if (d.email?.sent) parts.push("mail enviado");
        else if (d.email?.reason) parts.push(`mail: ${d.email.reason}`);
        setScanMsg({
          ok: true,
          text: parts.join(" · "),
        });
        if (d.warnings?.length) {
          setScanMsg({
            ok: true,
            text: `${parts.join(" · ")}\n\nAvisos:\n${d.warnings.join("\n")}`,
          });
        }
      }
    } catch (e) {
      setScanMsg({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setScanning(false);
      load();
    }
  }

  async function addWatch() {
    if (!newBrand.trim()) return;
    setSaving(true);
    await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: newKind, value: newBrand.trim() }),
    });
    setNewBrand("");
    setSaving(false);
    load();
  }

  async function removeWatch(id: number) {
    await fetch(`/api/watchlist?id=${id}`, { method: "DELETE" });
    load();
  }

  const lastRun = stats?.last_run;
  const needsSetup = err && /relation .* does not exist/i.test(err);

  return (
    <main className="max-w-[1200px] mx-auto px-5 py-8">
      {/* Cabecera */}
      <header className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Monitor de competencia — Mercado Libre
          </h1>
          <p className="muted text-[13px] mt-0.5">
            {lastRun ? (
              <>
                Último relevamiento: <strong>{fecha(lastRun.started_at)}</strong> ·{" "}
                {lastRun.listings_seen} publicaciones · {lastRun.changes_found} cambios
                {lastRun.status !== "ok" && (
                  <span className="text-up"> · estado: {lastRun.status}</span>
                )}
              </>
            ) : (
              "Todavía no hay relevamientos cargados."
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={scanNow}
            disabled={scanning}
            className="rounded-md bg-ink text-white px-3 py-1.5 text-[13px] disabled:opacity-40"
          >
            {scanning ? "Relevando Mercado Libre…" : "Relevar ahora"}
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
          <strong>Falta crear las tablas.</strong>
          <p className="muted mt-1">
            Es el último paso de la instalación. Se puede repetir sin riesgo.
          </p>
          <button
            onClick={setupTables}
            disabled={settingUp}
            className="mt-3 rounded-md bg-ink text-white px-3 py-1.5 disabled:opacity-40"
          >
            {settingUp ? "Creando las tablas…" : "Crear las tablas"}
          </button>
          {setupMsg && (
            <p className={`mt-2 whitespace-pre-wrap ${setupMsg.ok ? "muted" : "text-up"}`}>
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
              <strong>{scanMsg.ok ? "Relevamiento listo" : "Falló el relevamiento"}</strong>
              <div className="mt-1 whitespace-pre-wrap muted">{scanMsg.text}</div>
            </div>
            <button
              onClick={() => setScanMsg(null)}
              className="muted text-[12px] shrink-0"
              aria-label="Cerrar"
            >
              cerrar
            </button>
          </div>
        </div>
      )}

      {/* KPIs */}
      {stats && (
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Kpi label="Publicaciones activas" value={stats.totals?.activas ?? 0} />
          <Kpi label="Dadas de baja" value={stats.totals?.bajas ?? 0} />
          <Kpi label="Marcas seguidas" value={stats.totals?.marcas ?? 0} />
          <Kpi label="Vendedores distintos" value={stats.totals?.vendedores ?? 0} />
        </section>
      )}

      {/* Resumen por marca */}
      {stats?.by_brand?.length > 0 && (
        <section className="card p-4 mb-6">
          <h2 className="text-sm font-semibold mb-3">Rango de precios por marca</h2>
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Marca</th>
                  <th>Publicaciones</th>
                  <th>Mínimo</th>
                  <th>Promedio</th>
                  <th>Máximo</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_brand.map((b: any) => (
                  <tr key={b.brand}>
                    <td className="font-medium">{b.brand}</td>
                    <td className="tabular">{b.publicaciones}</td>
                    <td className="tabular">{money(b.precio_min)}</td>
                    <td className="tabular">{money(b.precio_prom)}</td>
                    <td className="tabular">{money(b.precio_max)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Tabs */}
      <nav className="flex gap-1 border-b hairline mb-4">
        {(
          [
            ["cambios", `Cambios${changes.length ? ` (${changes.length})` : ""}`],
            ["publicaciones", `Publicaciones${listings.length ? ` (${listings.length})` : ""}`],
            ["watchlist", "Qué se monitorea"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-2 text-[13px] border-b-2 -mb-px ${
              tab === key ? "border-current font-medium" : "border-transparent muted"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* Filtros */}
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
            </select>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="rounded-md border hairline bg-transparent px-2 py-1.5"
            >
              <option value="">Todos los cambios</option>
              {Object.entries(CHANGE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
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
              placeholder="Buscar en el título…"
              className="rounded-md border hairline bg-transparent px-2 py-1.5 w-56"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-md border hairline bg-transparent px-2 py-1.5"
            >
              <option value="active">Activas</option>
              <option value="delisted">Dadas de baja</option>
              <option value="all">Todas</option>
            </select>
          </>
        )}
        {tab !== "watchlist" && brands.length > 0 && (
          <select
            value={brandFilter}
            onChange={(e) => setBrandFilter(e.target.value)}
            className="rounded-md border hairline bg-transparent px-2 py-1.5"
          >
            <option value="">Todas las marcas</option>
            {brands.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}
        {loading && <span className="muted">cargando…</span>}
      </div>

      {/* Contenido */}
      {tab === "cambios" && (
        <section className="card scroll-x">
          {changes.length === 0 ? (
            <p className="muted text-[13px] p-4">
              Sin cambios en el período elegido.
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
                    <td className="muted whitespace-nowrap tabular">{fecha(c.detected_at)}</td>
                    <td className={`whitespace-nowrap ${CHANGE_TONE[c.change_type] ?? ""}`}>
                      {CHANGE_LABELS[c.change_type as ChangeType] ?? c.change_type}
                    </td>
                    <td>
                      <div className="muted text-[11px] uppercase tracking-wide">
                        {c.brand}
                      </div>
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
                      {c.change_type === "price_up" || c.change_type === "price_down" ? (
                        <>
                          {money(c.old_value)} → <strong>{money(c.new_value)}</strong>
                          {c.delta_pct !== null && (
                            <span className={CHANGE_TONE[c.change_type]}>
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
                      ) : c.change_type === "new_listing" || c.change_type === "relisted" ? (
                        money(c.new_value)
                      ) : c.change_type === "delisted" ? (
                        <span className="muted">estaba a {money(c.old_value)}</span>
                      ) : (
                        <span className="text-[12px] muted">{c.new_value}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === "publicaciones" && (
        <section className="card scroll-x">
          {listings.length === 0 ? (
            <p className="muted text-[13px] p-4">
              Sin publicaciones cargadas todavía. Corré el primer relevamiento.
            </p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Marca</th>
                  <th>Publicación</th>
                  <th>Vendedor</th>
                  <th style={{ textAlign: "right" }}>Lista</th>
                  <th style={{ textAlign: "right" }}>Precio</th>
                  <th style={{ textAlign: "right" }}>Desc.</th>
                  <th>Cuotas</th>
                  <th>Visto</th>
                </tr>
              </thead>
              <tbody>
                {listings.map((l) => (
                  <Fragment key={l.ml_id}>
                    <tr
                      onClick={() => setOpenRow(openRow === l.ml_id ? null : l.ml_id)}
                      className="cursor-pointer"
                    >
                      <td className="whitespace-nowrap">
                        {l.brand}
                        {l.status === "delisted" && (
                          <div className="text-[11px] text-up">de baja</div>
                        )}
                      </td>
                      <td className="max-w-[380px]">
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
                        {l.discount_pct ? `${Number(l.discount_pct).toFixed(0)}%` : "—"}
                      </td>
                      <td className="muted text-[12px]">
                        {l.has_installments ? l.installments_text || "sí" : "no"}
                      </td>
                      <td className="muted whitespace-nowrap tabular text-[12px]">
                        {fecha(l.last_seen_at)}
                      </td>
                    </tr>
                    {openRow === l.ml_id && (
                      <tr>
                        <td colSpan={8} className="subtle">
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
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === "watchlist" && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold">Qué se monitorea</h2>
          <p className="muted text-[13px] mt-1 mb-4">
            La tarea diaria lee esta lista antes de cada relevamiento. Agregar una marca
            nueva acá alcanza — no hay que tocar código ni se pierde el historial de lo
            que ya se venía siguiendo.
          </p>

          <div className="flex gap-2 flex-wrap items-center mb-5 text-[13px]">
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
              className="rounded-md border hairline bg-transparent px-2 py-1.5"
            >
              <option value="brand">Marca</option>
              <option value="seller">Vendedor / tienda</option>
              <option value="url">URL puntual</option>
            </select>
            <input
              value={newBrand}
              onChange={(e) => setNewBrand(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addWatch()}
              placeholder="Ej: Stanley"
              className="rounded-md border hairline bg-transparent px-2 py-1.5 w-56"
            />
            <button
              onClick={addWatch}
              disabled={saving || !newBrand.trim()}
              className="rounded-md bg-ink text-white px-3 py-1.5 disabled:opacity-40"
            >
              {saving ? "Guardando…" : "Agregar"}
            </button>
          </div>

          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Valor</th>
                  <th>Notas</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {watchlist.map((w) => (
                  <tr key={w.id}>
                    <td className="muted">
                      {w.kind === "brand"
                        ? "Marca"
                        : w.kind === "seller"
                        ? "Vendedor"
                        : "URL"}
                    </td>
                    <td className="font-medium">{w.label ?? w.value}</td>
                    <td className="muted text-[12px]">{w.notes ?? "—"}</td>
                    <td className={w.active ? "" : "muted"}>
                      {w.active ? "activo" : "pausado"}
                    </td>
                    <td className="text-right">
                      {w.active && (
                        <button
                          onClick={() => removeWatch(w.id)}
                          className="muted text-[12px] underline decoration-dotted"
                        >
                          pausar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="muted text-[12px] mt-8">
        Los datos se actualizan solos una vez por día a las 9:00, consultando la API
        oficial de Mercado Libre. Para forzar una actualización, usá{" "}
        <strong>Relevar ahora</strong>.
      </footer>
    </main>
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
