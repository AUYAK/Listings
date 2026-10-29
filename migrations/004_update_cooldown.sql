ALTER TABLE realt.listings
  ADD COLUMN IF NOT EXISTS last_update_notified_at TIMESTAMPTZ;
