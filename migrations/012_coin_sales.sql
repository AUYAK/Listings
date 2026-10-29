-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.

-- Проходы с внешних аукционов (gdenashel.ru: российские аукционные дома, цены в RUB).
-- Источник для каталожной цены по (тип монеты, состояние) — см. load-catalog.js.
CREATE TABLE IF NOT EXISTS listings.coin_sales (
  sale_id      TEXT PRIMARY KEY,              -- id прохода на источнике
  source       TEXT NOT NULL,                 -- 'gdenashel'
  type_key     TEXT NOT NULL,                 -- '100|1895' (номинал в копейках | год)
  variant_key  TEXT,                          -- '100|1895|АГ' — буквы минцмейстера, если известны
  variety      TEXT,                          -- разновидность по источнику («Г: Гладкий», «А: Соосность 180°»)
  title        TEXT,
  sold_on      DATE,
  house        TEXT,                          -- аукционный дом, номер аукциона, лот
  grade_raw    TEXT,                          -- как на источнике: VF, MS64, AU58…
  grade        TEXT,                          -- наша шкала: G, VG, F, VF, XF, AU, UNC, PF
  slab         TEXT,                          -- NGC / PCGS / ННР / RNGA
  price        NUMERIC,                       -- NULL = итог не опубликован
  currency     TEXT NOT NULL DEFAULT 'RUB',
  photos       JSONB,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coin_sales_type ON listings.coin_sales (type_key, grade, sold_on);
CREATE INDEX IF NOT EXISTS idx_coin_sales_variant ON listings.coin_sales (variant_key, grade, sold_on);

-- Справочник типов монет с источника: тираж и редкость по каталогу Конроса (нет отметки = обычная монета).
-- Ключ — как в coin_catalog: '100|1895|АГ' (вариант) или '100|1895' (тип).
CREATE TABLE IF NOT EXISTS listings.coin_types (
  key          TEXT PRIMARY KEY,
  source       TEXT NOT NULL,                 -- 'gdenashel'
  title        TEXT,
  coin_url     TEXT,
  mintage      BIGINT,
  konros       TEXT,                          -- 'R', 'R1', 'R1+', 'R2', 'R3', 'R4' или NULL
  bitkin       TEXT,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Каталог: теперь несколько источников на один тип (gdenashel, numista) → ключ (type_key, source)
ALTER TABLE listings.coin_catalog DROP CONSTRAINT IF EXISTS coin_catalog_pkey;
ALTER TABLE listings.coin_catalog ADD PRIMARY KEY (type_key, source);
ALTER TABLE listings.coin_catalog ADD COLUMN IF NOT EXISTS samples JSONB;   -- {"VF": 42, "XF": 17} — число проходов за окно
ALTER TABLE listings.coin_catalog ADD COLUMN IF NOT EXISTS window_years INT; -- окно проходов, лет
ALTER TABLE listings.coin_catalog ADD COLUMN IF NOT EXISTS rate NUMERIC;     -- курс к BYN на момент пересчёта

-- Лоты, которые раньше были записаны как «исчезли» по коду 404: код приходил от защиты ay.by, страницы живы.
-- Возвращаем их в очередь finalizeEnded, чтобы перечитать итог («Лот продан за …»).
UPDATE listings.coin_lots SET outcome = NULL, ended_at = NULL, end_status_text = NULL
WHERE outcome = 'removed' AND end_status_text IN ('404', '404 at backfill', '404 at first fetch', '404 before closing');
UPDATE listings.listings l SET status = 'active'
FROM listings.coin_lots a WHERE a.listing_id = l.id AND a.outcome IS NULL AND l.status = 'inactive' AND l.monitor_key = 'coins-silver';

-- Лоты: фото на диске, приблизительный итог (страница лота пропала сразу после торгов)
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS photo_files JSONB;      -- ["2026-10/5041461714_1.jpg", ...]
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS final_approx BOOLEAN;   -- true: итог = последняя увиденная ставка
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS price_seen_at TIMESTAMPTZ; -- когда последний раз читали цену со страницы лота
