-- Maps sent Telegram messages back to listings (for reaction lookup)
CREATE TABLE IF NOT EXISTS realt.listing_notifications (
  id               SERIAL PRIMARY KEY,
  listing_id       INT NOT NULL REFERENCES realt.listings(id) ON DELETE CASCADE,
  telegram_chat_id TEXT NOT NULL,
  telegram_msg_id  BIGINT NOT NULL,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_lookup
  ON realt.listing_notifications (telegram_chat_id, telegram_msg_id);

-- Followers per listing per user
CREATE TABLE IF NOT EXISTS realt.listing_followers (
  listing_id       INT NOT NULL REFERENCES realt.listings(id) ON DELETE CASCADE,
  telegram_chat_id TEXT NOT NULL,
  followed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (listing_id, telegram_chat_id)
);
