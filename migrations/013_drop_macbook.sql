-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.
-- Монитор MacBook и рыночная сводка по ноутбукам удалены из кода (market.js, details.js, stats.js).
-- Убираем их таблицы (миграции 007–010) и сами объявления монитора 'macbook';
-- снимки, уведомления, подписчики и логи статусов удаляются каскадом.

DROP TABLE IF EXISTS listings.market_assessments;
DROP TABLE IF EXISTS listings.listing_details;

DELETE FROM listings.monitor_subscriptions WHERE monitor_key = 'macbook';
DELETE FROM listings.listings WHERE monitor_key = 'macbook';
