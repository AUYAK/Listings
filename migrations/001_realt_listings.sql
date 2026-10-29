CREATE SCHEMA IF NOT EXISTS realt;

CREATE TABLE IF NOT EXISTS realt.listings (
  id          SERIAL PRIMARY KEY,
  external_id TEXT NOT NULL,
  source      TEXT NOT NULL,  -- 'realt', 'kufar'
  type        TEXT NOT NULL,  -- 'plot', 'house'
  url         TEXT,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (external_id, source)
);

CREATE TABLE IF NOT EXISTS realt.listing_snapshots (
  id         SERIAL PRIMARY KEY,
  listing_id INT NOT NULL REFERENCES realt.listings(id) ON DELETE CASCADE,
  scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  price_byn  NUMERIC,
  price_usd  NUMERIC,
  address    TEXT,
  area       TEXT,
  direction  TEXT,
  distance   TEXT,
  raw        JSONB
);

CREATE INDEX IF NOT EXISTS idx_listings_external  ON realt.listings (external_id, source);
CREATE INDEX IF NOT EXISTS idx_snapshots_listing  ON realt.listing_snapshots (listing_id, scraped_at DESC);
