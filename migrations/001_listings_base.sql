-- Применять от lo_admin (владелец схемы listings). Все выражения идемпотентны (IF NOT EXISTS):
-- на сервере, где схема уже есть, миграция ничего не меняет.
-- Базовые таблицы, общие для всех мониторов (store.js): объявления, снимки цены, статус, уведомления
-- Telegram, подписки на объявления (👍). Настройки бота — 006, монеты — 011–014.

CREATE SCHEMA IF NOT EXISTS listings;

-- Объявление / лот любого монитора из config.js (monitor_key). external_id — id на площадке.
CREATE TABLE IF NOT EXISTS listings.listings (
  id          SERIAL PRIMARY KEY,
  external_id TEXT NOT NULL,
  monitor_key TEXT NOT NULL,
  url         TEXT,
  title       TEXT,
  status      TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'inactive' (пропало с площадки)
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (external_id, monitor_key)
);

-- Снимок цены/заголовка: пишется только при изменении
CREATE TABLE IF NOT EXISTS listings.listing_snapshots (
  id         SERIAL PRIMARY KEY,
  listing_id INT NOT NULL REFERENCES listings.listings(id) ON DELETE CASCADE,
  scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  price_byn  NUMERIC,
  price_usd  NUMERIC,
  title      TEXT,
  location   TEXT,
  params     TEXT,
  raw        JSONB
);

-- Проверки «ещё активно?» (Kufar: объявление пропало из выдачи → страница)
CREATE TABLE IF NOT EXISTS listings.listing_status_logs (
  id         SERIAL PRIMARY KEY,
  listing_id INT NOT NULL REFERENCES listings.listings(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Отправленные карточки Telegram → объявление (для 👍 и ответов на карточку)
CREATE TABLE IF NOT EXISTS listings.listing_notifications (
  id               SERIAL PRIMARY KEY,
  listing_id       INT NOT NULL REFERENCES listings.listings(id) ON DELETE CASCADE,
  telegram_chat_id TEXT NOT NULL,
  telegram_msg_id  BIGINT NOT NULL,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Подписка на объявление по 👍 на карточке
CREATE TABLE IF NOT EXISTS listings.listing_followers (
  listing_id       INT NOT NULL REFERENCES listings.listings(id) ON DELETE CASCADE,
  telegram_chat_id TEXT NOT NULL,
  followed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (listing_id, telegram_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_monitor    ON listings.listings (monitor_key, external_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_listing   ON listings.listing_snapshots (listing_id, scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_status_logs_listing ON listings.listing_status_logs (listing_id, checked_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_lookup ON listings.listing_notifications (telegram_chat_id, telegram_msg_id);
