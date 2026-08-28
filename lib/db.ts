import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/**
 * Conexión a Postgres (Neon, que es el Postgres nativo de Vercel).
 *
 * Vercel inyecta la variable de conexión al vincular la base al proyecto.
 * Aceptamos varios nombres porque cambia segun como se creo la base:
 *   DATABASE_URL          (integracion Neon en Vercel — el mas comun hoy)
 *   POSTGRES_URL          (Vercel Postgres clasico)
 *   POSTGRES_URL_NON_POOLING
 *
 * La conexion es lazy: no se crea al importar el modulo, asi el `next build`
 * no falla cuando todavia no hay variables de entorno configuradas.
 */

type Row = Record<string, any>;
type Result<T> = { rows: T[]; rowCount: number };

let _client: NeonQueryFunction<false, false> | null = null;

function client(): NeonQueryFunction<false, false> {
  if (_client) return _client;
  const url =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_PRISMA_URL;
  if (!url) {
    throw new Error(
      "Falta la variable de conexion a la base. Configurá DATABASE_URL (o POSTGRES_URL) en Vercel > Settings > Environment Variables."
    );
  }
  _client = neon(url);
  return _client;
}

/**
 * Tagged template para consultas parametrizadas.
 * Devuelve `{ rows }` para que el resto del codigo lea igual que con `pg`.
 *
 *   const res = await sql<MiTipo>`SELECT * FROM listings WHERE ml_id = ${id}`;
 *   res.rows[0]
 */
export async function sql<T extends Row = Row>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<Result<T>> {
  const rows = (await client()(strings, ...values)) as unknown as T[];
  return { rows, rowCount: rows.length };
}

/**
 * Consulta con SQL en string + parametros posicionales ($1, $2, ...).
 * Se usa cuando la cantidad de parametros es dinamica.
 */
sql.query = async function <T extends Row = Row>(
  text: string,
  params: unknown[] = []
): Promise<Result<T>> {
  const rows = (await client().query(text, params as any[])) as unknown as T[];
  return { rows, rowCount: rows.length };
};

/** Placeholders $1..$n para una lista de valores. */
export function placeholders(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, i) => `$${i + 1 + offset}`).join(", ");
}

/** Normaliza numeric de Postgres (que llega como string) a number. */
export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Formatea pesos argentinos. */
export function money(v: string | number | null | undefined): string {
  const n = num(v);
  if (n === null) return "—";
  return n.toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  });
}
