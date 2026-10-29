-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.
-- После применения один раз запустить: node reparse-details.js — он пересчитает новые поля
-- по уже сохранённым характеристикам и описаниям (сеть не нужна).

ALTER TABLE listings.listing_details
  ADD COLUMN IF NOT EXISTS year               INT,    -- год выпуска из заголовка/описания/номера модели
  ADD COLUMN IF NOT EXISTS battery_health_pct INT,    -- «ёмкость 83%» из описания
  ADD COLUMN IF NOT EXISTS body_condition     TEXT,   -- 'ideal' | 'marks' | 'damaged' | NULL
  ADD COLUMN IF NOT EXISTS flags              JSONB;  -- ["зарядка","коробка","торг","клавиатура-бабочка",...]
