-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.
--
-- Исправление единиц в listing_details. Разбор характеристик считал «число ≤ 8 — это
-- терабайты» и для оперативной памяти: «8 ГБ» записывалось как 8192, «4 ГБ» как 4096,
-- «6 ГБ» как 6144 (замерено 29.09.2026: 46 из 134 объявлений MacBook). Из-за этого в
-- рыночной сводке появлялись группы «8 ТБ/256 ГБ», и они не сходились с теми, где память
-- взята из заголовка. Накопитель «1000 Гб» из Kufar и «1 ТБ» из заголовка тоже были
-- разными ключами (1000 и 1024).
--
-- Код (details.js) уже пишет правильно; это только для старых строк.

BEGIN;

UPDATE listings.listing_details
   SET ram_gb = ram_gb / 1024
 WHERE ram_gb >= 1024;

UPDATE listings.listing_details
   SET ssd_gb = CASE
                  WHEN ssd_gb BETWEEN 900  AND 1100 THEN 1024
                  WHEN ssd_gb BETWEEN 1800 AND 2200 THEN 2048
                  WHEN ssd_gb BETWEEN 3600 AND 4400 THEN 4096
                  ELSE ssd_gb
                END
 WHERE ssd_gb IS NOT NULL;

COMMIT;

-- проверка: ram_gb не должно быть больше 128
SELECT ram_gb, count(*) FROM listings.listing_details GROUP BY 1 ORDER BY 1;
SELECT ssd_gb, count(*) FROM listings.listing_details GROUP BY 1 ORDER BY 1;
