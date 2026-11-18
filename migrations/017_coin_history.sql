-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.
-- История продаж ay.by через отзывы покупателей и продавцов (coins.js, шаг «история»): в отзывах ~60 дней есть ссылки
-- на проданные лоты, страница проданного лота остаётся читаемой. Так в базу попадают продажи, которые шли до запуска
-- мониторов или мимо них.

-- когда читали отзывы пользователя (повтор — раз в 30 дней)
ALTER TABLE listings.ayby_users ADD COLUMN IF NOT EXISTS history_at TIMESTAMPTZ;

-- очередь лотов из отзывов: страница лота читается один раз
CREATE TABLE IF NOT EXISTS listings.coin_history_queue (
  external_id TEXT PRIMARY KEY,              -- номер лота ay.by
  url         TEXT NOT NULL,
  title       TEXT,
  deal_date   TIMESTAMPTZ,                   -- дата сделки из отзыва (запасная дата окончания торгов)
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at     TIMESTAMPTZ,
  result      TEXT                           -- saved | known | gone | active | unsold | not_coin | other_metal | error
);
CREATE INDEX IF NOT EXISTS idx_coin_history_queue_pending ON listings.coin_history_queue (added_at) WHERE done_at IS NULL;
