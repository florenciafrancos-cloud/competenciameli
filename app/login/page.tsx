"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const params = useSearchParams();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (res.ok) {
      router.push(params.get("from") || "/");
      router.refresh();
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body?.error ?? "No se pudo entrar");
    }
  }

  return (
    <form onSubmit={submit} className="card w-full max-w-sm p-6">
      <h1 className="text-base font-semibold">Monitor de competencia</h1>
      <p className="muted text-[13px] mt-1 mb-5">
        Ingresá la contraseña para ver el tablero.
      </p>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Contraseña"
        autoFocus
        className="w-full rounded-md border hairline bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
      />
      {error && <p className="text-[13px] mt-2 text-up">{error}</p>}
      <button
        type="submit"
        disabled={loading || !password}
        className="mt-4 w-full rounded-md bg-ink text-white text-sm py-2 disabled:opacity-40"
      >
        {loading ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen grid place-items-center px-6">
      <Suspense fallback={<div className="muted text-[13px]">Cargando…</div>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
