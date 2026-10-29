-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.
-- Права для lo_agent выдаются автоматически через default privileges схемы.

-- Настройки бота: какие категории (мониторы из config.js) получает каждый чат.
-- Чат появляется в bot_chats после первого /start или /settings; с этого момента
-- рассылка для него определяется только таблицей monitor_subscriptions.

CREATE TABLE IF NOT EXISTS listings.bot_chats (
  telegram_chat_id TEXT PRIMARY KEY,
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS listings.monitor_subscriptions (
  telegram_chat_id TEXT NOT NULL REFERENCES listings.bot_chats(telegram_chat_id) ON DELETE CASCADE,
  monitor_key      TEXT NOT NULL,
  subscribed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (telegram_chat_id, monitor_key)
);

CREATE INDEX IF NOT EXISTS idx_monitor_subs_key ON listings.monitor_subscriptions (monitor_key);
