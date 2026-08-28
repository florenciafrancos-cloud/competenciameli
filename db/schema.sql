-- ================================================================
-- Esquema de base de datos - Monitor de competencia Mercado Libre
-- Se puede correr multiples veces sin problema (IF NOT EXISTS).
-- ================================================================

-- Que marcas / vendedores / publicaciones puntuales monitoreamos.
-- Agregar una marca nueva = insertar una fila aca. Nada mas.
CREATE TABLE IF NOT EXISTS watchlist (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('brand', 'seller', 'url')),
  value       TEXT NOT NULL,
  label       TEXT,
  notes       TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, value)
);

-- Estado ACTUAL de cada publicacion (una fila por publicacion de ML).
CREATE TABLE IF NOT EXISTS listings (
  ml_id             TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  brand             TEXT,
  url               TEXT,
  seller            TEXT,
  official_store    BOOLEAN,
  list_price        NUMERIC(12,2),
  price             NUMERIC(12,2),
  discount_pct      NUMERIC(5,2),
  has_installments  BOOLEAN,
  installments_text TEXT,
  currency          TEXT DEFAULT 'ARS',
  status            TEXT NOT NULL DEFAULT 'active',  -- active | delisted
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS listings_brand_idx  ON listings (brand);
CREATE INDEX IF NOT EXISTS listings_status_idx ON listings (status);
CREATE INDEX IF NOT EXISTS listings_seller_idx ON listings (seller);

-- Historial: una fila por corrida y por publicacion.
-- Esto es lo que permite graficar la evolucion de precio.
CREATE TABLE IF NOT EXISTS price_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  ml_id             TEXT NOT NULL REFERENCES listings(ml_id) ON DELETE CASCADE,
  run_id            TEXT,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  list_price        NUMERIC(12,2),
  price             NUMERIC(12,2),
  discount_pct      NUMERIC(5,2),
  seller            TEXT,
  has_installments  BOOLEAN,
  status            TEXT
);

CREATE INDEX IF NOT EXISTS snapshots_ml_id_idx ON price_snapshots (ml_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS snapshots_run_idx   ON price_snapshots (run_id);

-- Feed de cambios detectados. Esto es lo que dispara las alertas.
CREATE TABLE IF NOT EXISTS changes (
  id           BIGSERIAL PRIMARY KEY,
  ml_id        TEXT,
  brand        TEXT,
  title        TEXT,
  url          TEXT,
  seller       TEXT,
  change_type  TEXT NOT NULL,
  -- price_up | price_down | new_listing | delisted | relisted
  -- seller_change | installments_added | installments_removed
  old_value    TEXT,
  new_value    TEXT,
  delta_abs    NUMERIC(12,2),
  delta_pct    NUMERIC(7,2),
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id       TEXT,
  seen         BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS changes_detected_idx ON changes (detected_at DESC);
CREATE INDEX IF NOT EXISTS changes_type_idx     ON changes (change_type);
CREATE INDEX IF NOT EXISTS changes_brand_idx    ON changes (brand);

-- Bitacora de cada corrida del scraper (para saber si algun dia fallo).
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  source          TEXT,
  brands_covered  TEXT[],
  listings_seen   INT DEFAULT 0,
  changes_found   INT DEFAULT 0,
  status          TEXT DEFAULT 'ok',
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS runs_started_idx ON runs (started_at DESC);

-- No se precarga nada: el usuario agrega las publicaciones que quiere
-- seguir pegando sus links en el dashboard.

-- Tokens de la API de Mercado Libre. Una sola fila (id = 1).
-- El refresh_token es de UN SOLO USO: cada refresco devuelve uno nuevo,
-- por eso se guarda en la base y no en variables de entorno.
CREATE TABLE IF NOT EXISTS ml_tokens (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ================================================================
-- Migraciones incrementales
-- Se agregan aca en vez de tocar los CREATE TABLE de arriba, para
-- que una base ya creada tambien reciba las columnas nuevas.
-- ================================================================

-- Estado de la publicacion segun Mercado Libre (active | paused | closed)
-- y stock disponible. Vienen del endpoint /items, que es el que la API
-- si permite consultar.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS ml_status TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS available_quantity INT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_id BIGINT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS added_note TEXT;

ALTER TABLE price_snapshots ADD COLUMN IF NOT EXISTS ml_status TEXT;
ALTER TABLE price_snapshots ADD COLUMN IF NOT EXISTS available_quantity INT;

-- Para las entradas de tipo 'url' guardamos el ID ya extraido, asi no
-- hay que volver a parsear la URL en cada corrida.
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS ml_id TEXT;

CREATE INDEX IF NOT EXISTS watchlist_ml_id_idx ON watchlist (ml_id);

-- Mercado Libre cerro la busqueda publica de su API (403 para aplicaciones
-- no certificadas, verificado el 28/08/2026), asi que las entradas de tipo
-- marca o vendedor no se pueden relevar. Se desactivan para que no queden
-- generando advertencias en cada corrida. El seguimiento es por link.
UPDATE watchlist SET active = FALSE WHERE kind IN ('brand', 'seller');

-- Mercado Libre tiene dos clases de link: la publicacion de un vendedor
-- ('item') y la ficha de catalogo donde compiten varios ('product').
-- Se guardan distinto porque se consultan con endpoints distintos.
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS id_kind TEXT NOT NULL DEFAULT 'item';
ALTER TABLE listings  ADD COLUMN IF NOT EXISTS id_kind TEXT NOT NULL DEFAULT 'item';
