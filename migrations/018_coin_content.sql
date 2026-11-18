-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.
-- Металл каждого лота в базе: чистый вес, проба, вес монеты и откуда это известно. Заполняет coins.js (шаг «металл»):
-- сначала по таблицам стандартов и тексту лота, для проданных лотов без веса — наша база, Numista, модель.
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS fine_g NUMERIC;            -- чистого металла, г
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS purity NUMERIC;            -- проба, доля (0.9), если известна
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS gross_g NUMERIC;           -- вес монеты, г, если известен
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS content_source TEXT;       -- table | table_min | lot | base | numista | model | none | unknown
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS content_basis TEXT;        -- пояснение: «14,14 г × проба 500 (билон)»
ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS content_at TIMESTAMPTZ;    -- когда считали
CREATE INDEX IF NOT EXISTS idx_coin_lots_content_todo ON listings.coin_lots (listing_id) WHERE content_at IS NULL;
