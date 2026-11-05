-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.
-- Выгодные лоты ay.by добавляются в избранное аккаунта (coins/favorites.js); здесь отметка, когда это удалось.

ALTER TABLE listings.coin_lots ADD COLUMN IF NOT EXISTS favorited_at TIMESTAMPTZ;
