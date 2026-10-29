ALTER TABLE realt.listings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

CREATE TABLE IF NOT EXISTS realt.listing_status_logs (
  id         SERIAL PRIMARY KEY,
  listing_id INT NOT NULL REFERENCES realt.listings(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,  -- 'active', 'inactive'
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_status_logs_listing ON realt.listing_status_logs (listing_id, checked_at DESC);
