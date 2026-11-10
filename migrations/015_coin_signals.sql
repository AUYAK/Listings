-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.
-- Сигналы рынка ay.by: продавец и победитель лота с рейтингом, минимальная цена продавца, тихие лоты,
-- годы цен в каталоге. После миграции пересчитать каталог: node load-catalog.js --rebuild-only
-- (числовые грейды архива раскладываются по корзинам слабов MS60-62 … MS66+).

-- продавец (id и рейтинг со страницы лота), победитель торгов, «Минимальная цена не пройдена»
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS seller_id TEXT;
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS seller_rating INT;
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS reserve TEXT;            -- 'not_met' | 'met' | NULL (нет минимальной цены)
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS winner TEXT;
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS winner_id TEXT;
-- аукцион за 12–24 ч до конца один раз проверен на «тихий лот» (дальше ждёт обычного окна уведомлений)
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS quiet_checked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_coin_lots_winner ON listings.coin_lots (winner_id) WHERE winner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coin_lots_seller ON listings.coin_lots (seller_id) WHERE seller_id IS NOT NULL;

-- каталог: за какие даты реально есть цены (архив прячет цены последних ~12 месяцев)
ALTER TABLE listings.coin_catalog ADD COLUMN IF NOT EXISTS sold_from DATE;
ALTER TABLE listings.coin_catalog ADD COLUMN IF NOT EXISTS sold_to DATE;

-- пользователи ay.by: рейтинг продавцов и победителей (профиль перечитывается раз в 30 дней)
CREATE TABLE IF NOT EXISTS listings.ayby_users (
  user_id     TEXT PRIMARY KEY,              -- id из whoiswho.phtml?id=N
  nick        TEXT,
  rating      INT,                           -- число у ника («Литовец 348»)
  positive    INT,                           -- положительных отзывов
  negative    INT,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
