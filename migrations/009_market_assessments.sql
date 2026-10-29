-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.

-- Оценка рынка в момент уведомления: что именно бот показал по объявлению.
-- Нужна, чтобы потом честно мерить качество медианы (связь «ниже рынка» ↔ скорость продажи)
-- по данным на момент показа, а не по сегодняшним.
CREATE TABLE IF NOT EXISTS listings.market_assessments (
  id             SERIAL PRIMARY KEY,
  listing_id     INT NOT NULL REFERENCES listings.listings(id) ON DELETE CASCADE,
  assessed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_update      BOOLEAN NOT NULL DEFAULT false,  -- false = новое объявление, true = смена цены
  price_byn      NUMERIC,                         -- цена объявления на момент оценки
  group_label    TEXT,                            -- «MacBook Air M1 13", б/у»
  ref_source     TEXT,                            -- 'sold' | 'all' — с чем сравнивали
  ref_median     NUMERIC,
  active_n       INT,
  active_median  NUMERIC,
  sold_n         INT,
  sold_median    NUMERIC,
  deviation_pct  INT                              -- (price − ref_median) / ref_median, NULL если цена не настоящая
);

CREATE INDEX IF NOT EXISTS idx_market_assessments_listing ON listings.market_assessments (listing_id, assessed_at DESC);
