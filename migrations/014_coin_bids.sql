-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.
-- Аккаунт ay.by (AYBY_LOGIN в .env): выгодные лоты добавляются в избранное (coins/favorites.js),
-- а по ответу на карточку числом процесс coins-sniper (sniper.js) ставит максимальную ставку
-- за SNIPE_SECONDS до конца торгов.

-- когда лот добавлен в избранное аккаунта
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS favorited_at TIMESTAMPTZ;

-- Снайп-ставки. Одна заявка на лот: аккаунт один, повторный ответ меняет максимум.
CREATE TABLE IF NOT EXISTS listings.coin_bids (
  listing_id   INT PRIMARY KEY REFERENCES listings.coin_lots(listing_id) ON DELETE CASCADE,
  chat_id      TEXT NOT NULL,             -- кто заказал (куда отчитываться)
  max_byn      NUMERIC NOT NULL,          -- максимальная ставка, BYN
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | running | placed | failed | cancelled | won | lost
  note         TEXT,                      -- что произошло (ошибка, цена на момент ставки, победитель)
  placed_price NUMERIC,                   -- цена лота сразу после нашей ставки
  placed_at    TIMESTAMPTZ,
  reported_at  TIMESTAMPTZ,               -- когда итог торгов отправлен в Telegram
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coin_bids_status ON listings.coin_bids (status);
