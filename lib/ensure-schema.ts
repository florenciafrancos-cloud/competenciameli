import { readFileSync } from "fs";
import { join } from "path";
import { splitSqlStatements } from "./sql-split";
import type { Query } from "./ingest-core";

/**
 * Corre las migraciones solas, sin que el usuario tenga que apretar nada.
 *
 * POR QUE EXISTE
 * --------------
 * Cada version del proyecto que agrega una columna dejaba la app rota hasta
 * que el usuario apretaba un boton "Crear las tablas". Eso convirtio cada
 * actualizacion en un error en la cara: "column w.id_kind does not exist",
 * "column l.offers_count does not exist", una por version.
 *
 * El schema es idempotente (todo es IF NOT EXISTS / ADD COLUMN IF NOT
 * EXISTS), asi que se puede correr sin riesgo. Lo unico que hay que evitar
 * es correrlo en cada request: para eso esta el marcador de version en la
 * base y el flag en memoria.
 *
 * Subir SCHEMA_VERSION cuando se agrega algo a db/schema.sql.
 */
const SCHEMA_VERSION = 11;

/** Una vez por instancia del servidor, para no consultar la base de gusto. */
let verifiedInThisInstance = false;

export type EnsureResult = {
  ran: boolean;
  from?: number | null;
  to?: number;
  statements?: number;
  error?: string;
};

export async function ensureSchema(q: Query): Promise<EnsureResult> {
  if (verifiedInThisInstance) return { ran: false };

  try {
    // La tabla del marcador es lo unico que se crea "a mano", porque es la
    // que nos dice si hace falta correr el resto.
    await q(`CREATE TABLE IF NOT EXISTS schema_meta (
               id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
               version INT NOT NULL,
               updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
             )`);

    const cur = await q(`SELECT version FROM schema_meta WHERE id = 1`);
    const current: number | null = cur.rows[0]?.version ?? null;

    if (current === SCHEMA_VERSION) {
      verifiedInThisInstance = true;
      return { ran: false, from: current, to: SCHEMA_VERSION };
    }

    // Hay que migrar.
    const schema = readFileSync(join(process.cwd(), "db", "schema.sql"), "utf8");
    const statements = splitSqlStatements(schema);
    for (const stmt of statements) {
      await q(stmt);
    }

    await q(
      `INSERT INTO schema_meta (id, version, updated_at) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, updated_at = NOW()`,
      [SCHEMA_VERSION]
    );

    verifiedInThisInstance = true;
    return {
      ran: true,
      from: current,
      to: SCHEMA_VERSION,
      statements: statements.length,
    };
  } catch (err) {
    // Si la migracion automatica falla, no se marca como verificada: se
    // reintenta en el proximo request, y el boton manual sigue existiendo.
    return {
      ran: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Para los tests: olvida que ya verifico. */
export function resetSchemaCache(): void {
  verifiedInThisInstance = false;
}

export { SCHEMA_VERSION };
