-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.

-- Характеристики и описание со страницы объявления (для категорий с market=true в config.js).
-- Заполняется при появлении нового объявления и порциями для уже сохранённых (backfill).
CREATE TABLE IF NOT EXISTS listings.listing_details (
  listing_id     INT PRIMARY KEY REFERENCES listings.listings(id) ON DELETE CASCADE,
  specs          JSONB,          -- блок «Характеристики» как есть: {"Процессор": "Intel Core i5", ...}
  description    TEXT,           -- текст описания продавца
  condition      TEXT,           -- 'new' | 'used' | NULL (не удалось определить)
  cpu            TEXT,           -- «Процессор» из характеристик
  chip           TEXT,           -- нормализованно: M1, M2 Pro, M4 Max, Intel ...
  ram_gb         INT,
  ssd_gb         INT,
  screen_in      NUMERIC(4,1),
  battery_cycles INT,            -- из описания: «около 200 циклов»
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_details_cond ON listings.listing_details (condition);
