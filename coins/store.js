// Хранение аукционных лотов (listings.coin_lots) поверх общих listings.listings.
const { pool } = require('../store');

async function upsertCard(listingId, monitor, section, card) {
  await pool.query(
    `INSERT INTO listings.coin_lots (listing_id, source, section, current_price, start_price, bids, ends_at, checked_at)
     VALUES ($1, $2, $3, $4, $4, $5, $6, NOW())
     ON CONFLICT (listing_id) DO UPDATE SET
       current_price = COALESCE(EXCLUDED.current_price, listings.coin_lots.current_price),
       bids = GREATEST(COALESCE(EXCLUDED.bids, 0), COALESCE(listings.coin_lots.bids, 0)),
       ends_at = CASE WHEN listings.coin_lots.detail_fetched_at IS NULL THEN COALESCE(EXCLUDED.ends_at, listings.coin_lots.ends_at) ELSE listings.coin_lots.ends_at END,
       checked_at = NOW()`,
    [listingId, monitor.source || 'ayby', section, card.price ?? null, card.bids ?? 0, card.endsAt ?? null]
  );
}

async function saveLotDetails(listingId, lot, parsed) {
  await pool.query(
    `UPDATE listings.coin_lots SET
       category_path = COALESCE($2, category_path), sale_type = COALESCE($3, sale_type),
       condition_code = $4, grade = $5,
       current_price = COALESCE($6, current_price), start_price = COALESCE(start_price, $6),
       bids = COALESCE($7, bids), bargain = $8, ends_at = COALESCE($9, ends_at),
       seller = COALESCE($10, seller), seller_city = COALESCE($11, seller_city), views = COALESCE($12, views),
       specs = $13, description = $14, parsed = $15, photos = $16,
       seller_id = COALESCE($17, seller_id), seller_rating = COALESCE($18, seller_rating), reserve = $19,
       detail_fetched_at = NOW(), checked_at = NOW()
     WHERE listing_id = $1`,
    [listingId, lot.categoryPath, lot.saleType, parsed.conditionCode, parsed.grade, lot.price, lot.bids, !!lot.bargain,
      lot.endsAt, lot.seller, lot.sellerCity, lot.views, JSON.stringify(lot.specs || {}), lot.description,
      JSON.stringify(parsed), JSON.stringify(lot.photos || []), lot.sellerId ?? null, lot.sellerRating ?? null, lot.reserve ?? null]
  );
}

async function recordOutcome(listingId, { outcome, finalPrice, finalBids, statusText, approx = false, endedAt = null, winner = null, winnerId = null }) {
  await pool.query(
    `UPDATE listings.coin_lots SET outcome = $2, final_price = $3, final_bids = $4, end_status_text = $5, final_approx = $6,
       ended_at = COALESCE($7, NOW()), winner = COALESCE($8, winner), winner_id = COALESCE($9, winner_id), checked_at = NOW()
     WHERE listing_id = $1`,
    [listingId, outcome, finalPrice ?? null, finalBids ?? null, statusText ?? null, approx, endedAt ?? null, winner, winnerId]
  );
  await pool.query(`UPDATE listings.listings SET status = 'inactive' WHERE id = $1`, [listingId]);
  await pool.query(`INSERT INTO listings.listing_status_logs (listing_id, status) VALUES ($1, 'inactive')`, [listingId]);
}

// Лоты, у которых известна только карточка: страницу ещё не открывали
async function lotsWithoutDetails(monitorKey, limit) {
  const res = await pool.query(
    `SELECT l.id, l.external_id, l.url, l.title, a.section
     FROM listings.coin_lots a JOIN listings.listings l ON l.id = a.listing_id
     WHERE l.monitor_key = $1 AND a.detail_fetched_at IS NULL AND a.outcome IS NULL
     ORDER BY a.ends_at ASC NULLS LAST, l.first_seen DESC
     LIMIT $2`,
    [monitorKey, limit]
  );
  return res.rows;
}

// Лоты, срок которых прошёл, итог ещё не записан
async function lotsToFinalize(monitorKey, graceMinutes, limit) {
  const res = await pool.query(
    `SELECT l.id, l.external_id, l.url, l.title, a.current_price, a.bids, a.sale_type, a.parsed, a.photo_files
     FROM listings.coin_lots a JOIN listings.listings l ON l.id = a.listing_id
     WHERE l.monitor_key = $1 AND a.outcome IS NULL AND a.ends_at IS NOT NULL
       AND a.ends_at < NOW() - ($2 || ' minutes')::interval
     ORDER BY a.ends_at ASC
     LIMIT $3`,
    [monitorKey, String(graceMinutes), limit]
  );
  return res.rows;
}

// Лот ещё идёт (срок продлён или карточка дала неточное время): обновляем срок и цену
async function touchEndsAt(listingId, endsAt, price, bids) {
  await pool.query(
    `UPDATE listings.coin_lots SET ends_at = COALESCE($2, ends_at), current_price = COALESCE($3, current_price),
       bids = GREATEST(COALESCE($4, 0), COALESCE(bids, 0)), price_seen_at = NOW(), checked_at = NOW() WHERE listing_id = $1`,
    [listingId, endsAt ?? null, price ?? null, bids ?? null]
  );
}

// Аукционы, которые закончатся в ближайшие minutes минут и цену которых не читали staleMinutes минут:
// страница лота после окончания торгов отдаёт 404, поэтому последнюю ставку снимаем заранее.
async function lotsClosingWithin(monitorKey, minutes, staleMinutes, limit) {
  const res = await pool.query(
    `SELECT l.id, l.external_id, l.url, l.title, a.bids, a.current_price, a.parsed, a.photos, a.photo_files, a.sale_type
     FROM listings.coin_lots a JOIN listings.listings l ON l.id = a.listing_id
     WHERE l.monitor_key = $1 AND a.outcome IS NULL AND a.sale_type IN ('auction', 'auction_buynow')
       AND a.ends_at > NOW() AND a.ends_at <= NOW() + ($2 || ' minutes')::interval
       AND (a.price_seen_at IS NULL OR a.price_seen_at < NOW() - ($3 || ' minutes')::interval)
     ORDER BY a.ends_at ASC
     LIMIT $4`,
    [monitorKey, String(minutes), String(staleMinutes), limit]
  );
  return res.rows;
}

async function savePhotoFiles(listingId, files) {
  await pool.query('UPDATE listings.coin_lots SET photo_files = $2 WHERE listing_id = $1', [listingId, JSON.stringify(files || [])]);
}

// external_id проданных лотов с фото — их снимки при чистке папки удаляются последними
async function photoKeepIds() {
  const res = await pool.query(
    `SELECT l.external_id FROM listings.coin_lots a JOIN listings.listings l ON l.id = a.listing_id
     WHERE a.outcome = 'sold' AND a.photo_files IS NOT NULL AND jsonb_array_length(a.photo_files) > 0`
  );
  return new Set(res.rows.map((r) => r.external_id));
}

async function clearPhotoFiles(externalIds) {
  if (!externalIds.length) return;
  await pool.query(
    `UPDATE listings.coin_lots a SET photo_files = NULL FROM listings.listings l
     WHERE l.id = a.listing_id AND l.external_id = ANY($1::text[])`,
    [externalIds]
  );
}

// Дочитанные, но ни разу не оценённые активные лоты (засев первого запуска, дочитка, прерванный цикл)
async function lotsToAssess(monitorKey, limit) {
  const res = await pool.query(
    `SELECT l.id, l.external_id, l.url, l.title, a.section, a.category_path, a.sale_type, a.current_price, a.bids, a.reserve,
            a.ends_at, a.specs, a.description
     FROM listings.coin_lots a JOIN listings.listings l ON l.id = a.listing_id
     WHERE l.monitor_key = $1 AND a.detail_fetched_at IS NOT NULL AND a.assessed_at IS NULL AND a.notified_at IS NULL
       AND a.outcome IS NULL AND (a.ends_at IS NULL OR a.ends_at > NOW())
     ORDER BY a.ends_at ASC NULLS LAST
     LIMIT $2`,
    [monitorKey, limit]
  );
  return res.rows;
}

async function markNotified(listingId) {
  await pool.query('UPDATE listings.coin_lots SET notified_at = NOW() WHERE listing_id = $1', [listingId]);
}

// Аукционы, у которых до конца осталось не больше hours часов, уведомление ещё не уходило; плюс те, что попали
// в окно тихих лотов (≤ quietHours) и ещё не проверялись на «тихий лот» — их проверяем один раз
async function lotsClosingSoon(monitorKey, hours, quietHours, limit) {
  const res = await pool.query(
    `SELECT l.id, l.external_id, l.url, l.title, a.section, a.ends_at, a.sale_type
     FROM listings.coin_lots a JOIN listings.listings l ON l.id = a.listing_id
     WHERE l.monitor_key = $1 AND a.outcome IS NULL AND a.notified_at IS NULL
       AND a.sale_type IN ('auction', 'auction_buynow') AND a.detail_fetched_at IS NOT NULL
       AND a.ends_at IS NOT NULL AND a.ends_at > NOW()
       AND (a.ends_at <= NOW() + ($2 || ' hours')::interval
            OR (a.quiet_checked_at IS NULL AND a.ends_at <= NOW() + ($3 || ' hours')::interval))
     ORDER BY a.ends_at ASC
     LIMIT $4`,
    [monitorKey, String(hours), String(Math.max(hours, quietHours)), limit]
  );
  return res.rows;
}

async function markQuietChecked(listingId) {
  await pool.query('UPDATE listings.coin_lots SET quiet_checked_at = NOW() WHERE listing_id = $1', [listingId]);
}

// Карточка этого лота ay.by уже ушла от другого монитора (лот ведут и раздел, и страница продавца)
async function notifiedElsewhere(externalId, monitorKey) {
  if (!externalId) return false;
  const res = await pool.query(
    `SELECT 1 FROM listings.listing_notifications n JOIN listings.listings l ON l.id = n.listing_id
     WHERE l.external_id = $1 AND l.monitor_key <> $2 LIMIT 1`,
    [String(externalId), monitorKey]
  );
  return res.rowCount > 0;
}

// Какие мониторы уже ведут лот: external_id → Set(monitor_key). Одним запросом на цикл: свои лоты монитора
// (новые / известные) и засев нового монитора
async function knownOwners(monitorKeys) {
  const owners = new Map();
  if (!monitorKeys.length) return owners;
  const res = await pool.query('SELECT external_id, monitor_key FROM listings.listings WHERE monitor_key = ANY($1::text[])', [monitorKeys]);
  for (const r of res.rows) {
    if (!owners.has(r.external_id)) owners.set(r.external_id, new Set());
    owners.get(r.external_id).add(r.monitor_key);
  }
  return owners;
}

// ---- Перевыставленные лоты (listings.coin_lots.rounds, миграция 016) ----

// Лоты мониторов с записанным итогом: external_id → Map(monitor_key → listing_id). Карточка такого лота в списке ay.by
// значит, что его перевыставили (тот же номер). 30 минут после окончания не трогаем: список мог быть из кэша.
async function endedLots(monitorKeys) {
  const out = new Map();
  if (!monitorKeys.length) return out;
  const res = await pool.query(
    `SELECT l.external_id, l.monitor_key, l.id FROM listings.listings l JOIN listings.coin_lots a ON a.listing_id = l.id
     WHERE l.monitor_key = ANY($1::text[]) AND a.outcome IS NOT NULL AND COALESCE(a.ended_at, a.checked_at) < NOW() - interval '30 minutes'`,
    [monitorKeys]
  );
  for (const r of res.rows) {
    if (!out.has(r.external_id)) out.set(r.external_id, new Map());
    out.get(r.external_id).set(r.monitor_key, r.id);
  }
  return out;
}

// Прошлый раунд — в rounds (ложное «снят» по 404 не сохраняется), лот — с чистого листа: без итога, оценки и
// отметки об уведомлении, цена и срок из карточки, страница лота будет прочитана заново. false — колонки нет (нет миграции).
async function relistLot(listingId, card) {
  const res = await pool.query(
    `UPDATE listings.coin_lots SET
       rounds = COALESCE(rounds, '[]'::jsonb) || CASE WHEN outcome = 'removed' THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object(
         'ended_at', ended_at, 'outcome', outcome, 'final_price', final_price, 'final_bids', final_bids,
         'last_price', current_price, 'bids', bids, 'start_price', start_price, 'reserve', reserve, 'status', end_status_text)) END,
       outcome = NULL, final_price = NULL, final_bids = NULL, end_status_text = NULL, final_approx = FALSE, ended_at = NULL,
       winner = NULL, winner_id = NULL, notified_at = NULL, assessed_at = NULL, quiet_checked_at = NULL, detail_fetched_at = NULL,
       price_seen_at = NULL, est_catalog = NULL, est_catalog_src = NULL, est_market = NULL, est_market_n = NULL,
       est_reference = NULL, deviation_pct = NULL, reserve = NULL,
       current_price = COALESCE($2, current_price), start_price = COALESCE($2, start_price), bids = COALESCE($3, 0),
       ends_at = $4, checked_at = NOW()
     WHERE listing_id = $1 AND outcome IS NOT NULL`,
    [listingId, card.price ?? null, card.bids ?? 0, card.endsAt ?? null]
  );
  if (res.rowCount) await pool.query(`UPDATE listings.listings SET status = 'active' WHERE id = $1`, [listingId]);
  return res.rowCount > 0;
}

async function lotRounds(listingId) {
  const res = await pool.query('SELECT rounds FROM listings.coin_lots WHERE listing_id = $1', [listingId]);
  return (res.rows[0] && res.rows[0].rounds) || [];
}

// ---- Пользователи ay.by (listings.ayby_users, миграция 015) ----

async function upsertUser({ id, nick = null, rating = null, positive = null, negative = null }, { checked = true } = {}) {
  if (!id) return;
  await pool.query(
    `INSERT INTO listings.ayby_users (user_id, nick, rating, positive, negative, checked_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN NOW() ELSE '-infinity'::timestamptz END)
     ON CONFLICT (user_id) DO UPDATE SET nick = COALESCE(EXCLUDED.nick, listings.ayby_users.nick),
       rating = COALESCE(EXCLUDED.rating, listings.ayby_users.rating), positive = COALESCE(EXCLUDED.positive, listings.ayby_users.positive),
       negative = COALESCE(EXCLUDED.negative, listings.ayby_users.negative),
       checked_at = CASE WHEN $6 THEN NOW() ELSE listings.ayby_users.checked_at END`,
    [String(id), nick, rating, positive, negative, checked]
  );
}

// Победители торгов, чей профиль не читали maxAgeDays дней (записанные только со страницы лота — checked_at
// '-infinity' — тоже): сначала дорогие покупки
async function winnersToRefresh(limit, maxAgeDays = 30) {
  const res = await pool.query(
    `SELECT a.winner_id AS id, max(a.final_price) AS top
     FROM listings.coin_lots a LEFT JOIN listings.ayby_users u ON u.user_id = a.winner_id
     WHERE a.winner_id IS NOT NULL AND (u.user_id IS NULL OR u.checked_at < NOW() - ($2 || ' days')::interval)
     GROUP BY a.winner_id ORDER BY top DESC NULLS LAST LIMIT $1`,
    [limit, String(maxAgeDays)]
  );
  return res.rows.map((r) => r.id);
}

// ---- История продаж через отзывы (listings.coin_history_queue, ayby_users.history_at — миграция 017) ----

// Покупатели и продавцы наших проданных лотов, чьи отзывы ещё не читали (или читали давно): сначала самые активные
async function historyUsers(limit, maxAgeDays = 30) {
  const res = await pool.query(
    `SELECT t.id FROM (
       SELECT id, count(*) AS deals FROM (
         SELECT winner_id AS id FROM listings.coin_lots WHERE winner_id IS NOT NULL
         UNION ALL SELECT seller_id FROM listings.coin_lots WHERE seller_id IS NOT NULL AND outcome = 'sold') x
       GROUP BY id) t
     LEFT JOIN listings.ayby_users u ON u.user_id = t.id
     WHERE u.history_at IS NULL OR u.history_at < NOW() - ($2 || ' days')::interval
     ORDER BY t.deals DESC LIMIT $1`,
    [limit, String(maxAgeDays)]
  );
  return res.rows.map((r) => r.id);
}

async function markHistoryRead(userId) {
  await pool.query(
    `INSERT INTO listings.ayby_users (user_id, checked_at, history_at) VALUES ($1, '-infinity'::timestamptz, NOW())
     ON CONFLICT (user_id) DO UPDATE SET history_at = NOW()`,
    [String(userId)]
  );
}

// Сделки из отзывов → очередь на чтение страниц лотов; уже стоящие в очереди и разобранные не дублируются
async function queueHistory(deals) {
  let added = 0;
  for (const d of deals) {
    const res = await pool.query(
      `INSERT INTO listings.coin_history_queue (external_id, url, title, deal_date) VALUES ($1, $2, $3, $4) ON CONFLICT (external_id) DO NOTHING`,
      [String(d.id), d.url, (d.title || '').slice(0, 300), d.date || null]
    );
    added += res.rowCount;
  }
  return added;
}

async function historyPending() {
  const res = await pool.query('SELECT count(*)::int AS n FROM listings.coin_history_queue WHERE done_at IS NULL');
  return res.rows[0].n;
}

// Очередь: непрочитанные и те, что один раз упали с ошибкой (повтор через 6 часов; вторая ошибка — 'failed')
async function historyQueue(limit) {
  const res = await pool.query(
    `SELECT external_id, url, title, deal_date, result FROM listings.coin_history_queue
     WHERE done_at IS NULL OR (result = 'error' AND done_at < NOW() - interval '6 hours')
     ORDER BY added_at, external_id LIMIT $1`,
    [limit]
  );
  return res.rows;
}

// Лот из истории: дата появления = дата продажи, стартовая цена неизвестна
async function markHistoryLot(listingId, soldAt) {
  await pool.query('UPDATE listings.coin_lots SET start_price = NULL WHERE listing_id = $1', [listingId]);
  if (soldAt) await pool.query('UPDATE listings.listings SET first_seen = LEAST(first_seen, $2) WHERE id = $1', [listingId, soldAt]);
}

// ---- Металл лота в базе (fine_g, purity, gross_g, content_source — миграция 018) ----

// Лоты из драгметалла, по которым металл ещё не считали
async function lotsWithoutContent(limit) {
  const res = await pool.query(
    `SELECT a.listing_id AS id, a.parsed FROM listings.coin_lots a
     WHERE a.content_at IS NULL AND a.parsed->>'metal' IN ('silver', 'gold') ORDER BY a.listing_id DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

// Проданные лоты, чей металл не дали ни таблицы, ни текст лота: кандидаты на поиск (наша база → Numista → модель)
async function lotsForContentLookup(limit, minPrice) {
  const res = await pool.query(
    `SELECT a.listing_id AS id, a.parsed, a.description, l.title FROM listings.coin_lots a JOIN listings.listings l ON l.id = a.listing_id
     WHERE a.content_source = 'none' AND a.outcome = 'sold' AND a.final_price >= $2 ORDER BY a.ended_at DESC NULLS LAST LIMIT $1`,
    [limit, minPrice]
  );
  return res.rows;
}

// rec — metal.contentRecord или null; source — что записать, когда rec нет ('none' — не знаем, 'unknown' — искали и не нашли)
async function saveContent(listingId, rec, source = 'none') {
  await pool.query(
    `UPDATE listings.coin_lots SET fine_g = $2, purity = $3, gross_g = $4, content_source = $5, content_basis = $6, content_at = NOW() WHERE listing_id = $1`,
    [listingId, rec ? rec.fineG : null, rec ? rec.purity : null, rec ? rec.grossG : null, rec ? rec.source : source, rec ? (rec.basis || '').slice(0, 300) || null : null]
  );
}

async function historyDone(externalId, result) {
  await pool.query('UPDATE listings.coin_history_queue SET done_at = NOW(), result = $2 WHERE external_id = $1', [String(externalId), result]);
}

async function getLot(listingId) {
  const res = await pool.query('SELECT * FROM listings.coin_lots WHERE listing_id = $1', [listingId]);
  return res.rows[0] || null;
}

// Монета с Kufar: фиксированная цена, итог — исчезновение с сайта (status объявления)
async function upsertKufarLot(listingId, parsed, price) {
  await pool.query(
    `INSERT INTO listings.coin_lots (listing_id, source, sale_type, grade, start_price, current_price, parsed, detail_fetched_at, checked_at)
     VALUES ($1, 'kufar', 'fixed', $2, $3, $3, $4, NOW(), NOW())
     ON CONFLICT (listing_id) DO UPDATE SET current_price = COALESCE(EXCLUDED.current_price, listings.coin_lots.current_price),
       grade = COALESCE(EXCLUDED.grade, listings.coin_lots.grade), parsed = EXCLUDED.parsed, checked_at = NOW()`,
    [listingId, parsed.grade || null, price ?? null, JSON.stringify(parsed)]
  );
}

async function saveEstimate(listingId, est) {
  await pool.query(
    `UPDATE listings.coin_lots SET est_catalog = $2, est_catalog_src = $3, est_market = $4, est_market_n = $5,
       est_reference = $6, deviation_pct = $7, assessed_at = NOW() WHERE listing_id = $1`,
    [listingId, est.catalog ? est.catalog.price : null, est.catalog ? est.catalog.source : null,
      est.market ? est.market.refMedian : null, est.market ? est.market.n : null, est.reference ?? null, est.deviationPct ?? null]
  );
}

// Все монеты со всех площадок с разбором — для оценки и статистики (monitorKey = null → всё)
async function getCoinRows(monitorKey = null) {
  const res = await pool.query(
    `SELECT l.id, l.external_id, l.monitor_key, l.title, l.first_seen, l.last_seen, l.status,
            a.source, a.sale_type, a.grade, a.condition_code, a.current_price, a.start_price, a.bids, a.bargain,
            a.ends_at, a.ended_at, a.outcome, a.final_price, a.final_bids, a.parsed, a.category_path,
            l.url, (to_jsonb(a)->>'fine_g')::numeric AS fine_g -- fine_g — миграция 018; без неё просто NULL
     FROM listings.listings l JOIN listings.coin_lots a ON a.listing_id = l.id
     WHERE ($1::text IS NULL OR l.monitor_key = $1)`,
    [monitorKey]
  );
  return res.rows;
}

// ---- каталог (listings.coin_catalog, listings.coin_sales) ----

const CATALOG_FACTOR = parseFloat(process.env.COINS_CATALOG_FACTOR || '1'); // поправка к ценам внешних аукционов для нашего рынка

function catalogKeys(parsed) {
  if (parsed.denomKop == null || !parsed.year || parsed.year > 1991) return []; // архивы — только Империя и СССР
  const keys = [];
  if (parsed.mintmaster) keys.push(`${parsed.denomKop}|${parsed.year}|${parsed.mintmaster}`);
  keys.push(`${parsed.denomKop}|${parsed.year}`);
  return keys;
}

// Все каталожные записи для монеты, по одной на источник, в порядке приоритета: архив проходов (gdenashel),
// затем Numista; внутри источника — сначала точный вариант (номинал|год|буквы), потом тип (номинал|год).
// Цены уже в BYN; к ценам внешних аукционов применяется factor. Плюс справочник типа (тираж, редкость по Конросу).
async function getCatalogs(parsed, factor = CATALOG_FACTOR) {
  const keys = catalogKeys(parsed);
  if (!keys.length) return { catalogs: [], type: null };
  const res = await pool.query(
    `SELECT DISTINCT ON (source) type_key, source, title, prices, samples, window_years, sold_from, sold_to FROM listings.coin_catalog
     WHERE type_key = ANY($1::text[]) AND prices IS NOT NULL AND prices <> '{}'::jsonb
     ORDER BY source, array_position($1::text[], type_key)`,
    [keys]
  );
  const order = { gdenashel: 0, numista: 1 };
  // pg отдаёт DATE как полночь по местному времени: toISOString() в Минске дала бы предыдущий день
  const day = (d) => (!d ? null : d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));
  const catalogs = res.rows
    .sort((a, b) => (order[a.source] ?? 9) - (order[b.source] ?? 9))
    .map((r) => {
      const prices = {};
      const f = r.source === 'numista' ? 1 : factor;
      for (const [g, v] of Object.entries(r.prices || {})) if (v != null) prices[g] = Math.round(v * f * 100) / 100;
      const period = r.sold_from && r.sold_to ? { from: day(r.sold_from), to: day(r.sold_to) } : null;
      return { source: r.source, title: r.title, prices, samples: r.samples || null, typeKey: r.type_key, windowYears: r.window_years, period, factor: f };
    });
  const t = await pool.query(
    `SELECT key, title, mintage, konros, bitkin FROM listings.coin_types WHERE key = ANY($1::text[]) ORDER BY array_position($1::text[], key) LIMIT 1`,
    [keys]
  ).catch(() => ({ rows: [] })); // таблицы может ещё не быть
  return { catalogs, type: t.rows[0] || null };
}

async function getCatalog(parsed, factor = CATALOG_FACTOR) {
  return (await getCatalogs(parsed, factor)).catalogs[0] || null;
}

async function upsertCoinType(key, source, t) {
  await pool.query(
    `INSERT INTO listings.coin_types (key, source, title, coin_url, mintage, konros, bitkin, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title, coin_url = EXCLUDED.coin_url, mintage = EXCLUDED.mintage,
       konros = EXCLUDED.konros, bitkin = EXCLUDED.bitkin, fetched_at = NOW()`,
    [key, source, t.title ?? null, t.coinUrl ?? null, Number.isFinite(t.mintage) ? t.mintage : null, t.konros ?? null, t.bitkin ?? null]
  );
}

async function upsertSales(rows) {
  for (const s of rows) {
    await pool.query(
      `INSERT INTO listings.coin_sales (sale_id, source, type_key, variant_key, variety, title, sold_on, house, grade_raw, grade, slab, price, currency, photos, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
       ON CONFLICT (sale_id) DO UPDATE SET price = COALESCE(EXCLUDED.price, listings.coin_sales.price),
         grade_raw = COALESCE(EXCLUDED.grade_raw, listings.coin_sales.grade_raw), grade = COALESCE(EXCLUDED.grade, listings.coin_sales.grade),
         sold_on = COALESCE(EXCLUDED.sold_on, listings.coin_sales.sold_on), photos = EXCLUDED.photos, fetched_at = NOW()`,
      [s.saleId, s.source, s.typeKey, s.variantKey ?? null, s.variety ?? null, s.title ?? null, s.soldOn ?? null, s.house ?? null,
        s.gradeRaw ?? null, s.grade ?? null, s.slab ?? null, s.priceRub ?? null, 'RUB', JSON.stringify(s.photos || [])]
    );
  }
}

// Состояния проходов заново по normalize(grade_raw) — после смены правил (корзины слабов) старые строки
// пересчитываются здесь, а не миграцией: правило одно, в коде (gdenashel.normalizeGrade). Возвращает число изменённых.
async function renormalizeSales(source, normalize) {
  const res = await pool.query('SELECT sale_id, grade_raw, grade FROM listings.coin_sales WHERE source = $1', [source]);
  const changed = res.rows.map((r) => ({ id: r.sale_id, grade: normalize(r.grade_raw) })).filter((r, i) => r.grade !== res.rows[i].grade);
  for (let i = 0; i < changed.length; i += 1000) {
    const part = changed.slice(i, i + 1000);
    await pool.query(
      `UPDATE listings.coin_sales s SET grade = u.grade FROM unnest($1::text[], $2::text[]) AS u(id, grade) WHERE s.sale_id = u.id`,
      [part.map((r) => r.id), part.map((r) => r.grade)]
    );
  }
  return changed.length;
}

// Пересчёт каталога из проходов: медиана цены по (ключ, состояние) за последние years лет, в BYN по курсу rate.
// Ключи: и точный вариант (с буквами), и тип целиком. sold_from/sold_to — даты проходов с ценой (карточка пишет
// «2023–2025»). normalize — пересчитать состояния проходов перед агрегацией. Возвращает число записей каталога.
async function rebuildCatalogFromSales(source, years, rate, minSamples = 2, normalize = null) {
  if (normalize) {
    const n = await renormalizeSales(source, normalize);
    if (n) console.log(`[Catalog] состояний проходов пересчитано: ${n}`);
  }
  const agg = await pool.query(
    `WITH recent AS (
       SELECT type_key, variant_key, grade, price, title, sold_on FROM listings.coin_sales
       WHERE source = $1 AND price > 0 AND grade IS NOT NULL AND sold_on >= CURRENT_DATE - ($2 || ' years')::interval AND sold_on <= CURRENT_DATE
     ), keyed AS (
       SELECT type_key AS key, grade, price, title, sold_on FROM recent
       UNION ALL
       SELECT variant_key AS key, grade, price, title, sold_on FROM recent WHERE variant_key IS NOT NULL
     )
     SELECT key, grade, count(*)::int n, percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median, min(title) AS title,
            min(sold_on) AS sold_from, max(sold_on) AS sold_to
     FROM keyed GROUP BY key, grade`,
    [source, String(years)]
  );
  const byKey = new Map();
  for (const r of agg.rows) {
    if (r.n < minSamples) continue;
    const e = byKey.get(r.key) || { prices: {}, samples: {}, title: r.title, from: null, to: null };
    e.prices[r.grade] = Math.round(parseFloat(r.median) * rate * 100) / 100;
    e.samples[r.grade] = r.n;
    if (!e.from || r.sold_from < e.from) e.from = r.sold_from;
    if (!e.to || r.sold_to > e.to) e.to = r.sold_to;
    byKey.set(r.key, e);
  }
  for (const [key, e] of byKey) {
    await pool.query(
      `INSERT INTO listings.coin_catalog (type_key, source, title, currency, prices, samples, window_years, rate, sold_from, sold_to, fetched_at)
       VALUES ($1, $2, $3, 'BYN', $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (type_key, source) DO UPDATE SET title = EXCLUDED.title, currency = 'BYN', prices = EXCLUDED.prices,
         samples = EXCLUDED.samples, window_years = EXCLUDED.window_years, rate = EXCLUDED.rate,
         sold_from = EXCLUDED.sold_from, sold_to = EXCLUDED.sold_to, fetched_at = NOW()`,
      [key, source, e.title, JSON.stringify(e.prices), JSON.stringify(e.samples), years, rate, e.from, e.to]
    );
  }
  return byKey.size;
}

// ---- Снайп-ставки (listings.coin_bids, миграция 014) ----

// Лот по сообщению бота в чате. Карточка — альбом из нескольких фото с подряд идущими message_id,
// а сохранён id первого; ответ на любое фото альбома ведём к ближайшему сохранённому id не позже него.
async function lotByMessage(chatId, msgId) {
  const res = await pool.query(
    `SELECT ${LOT_COLUMNS}
     FROM listings.listing_notifications n
     JOIN listings.listings l ON l.id = n.listing_id
     JOIN listings.coin_lots a ON a.listing_id = l.id
     WHERE n.telegram_chat_id = $1 AND n.telegram_msg_id BETWEEN $2 - 9 AND $2
     ORDER BY n.telegram_msg_id DESC LIMIT 1`,
    [String(chatId), msgId]
  );
  return res.rows[0] || null;
}

// Лот ay.by по номеру (ставка по ссылке). Лот могут вести несколько мониторов — берём тот, на который уже есть
// заявка (чтобы не завести вторую на тот же лот), иначе разобранный, иначе последний проверенный.
const LOT_COLUMNS = `l.id, l.external_id, l.url, l.title, l.monitor_key, a.sale_type, a.ends_at, a.current_price, a.bids, a.outcome, a.source,
       a.parsed, a.photos`;
async function lotByExternalId(externalId) {
  const res = await pool.query(
    `SELECT ${LOT_COLUMNS}
     FROM listings.listings l
     JOIN listings.coin_lots a ON a.listing_id = l.id
     LEFT JOIN listings.coin_bids b ON b.listing_id = l.id
     WHERE l.external_id = $1 AND a.source = 'ayby'
     ORDER BY (b.listing_id IS NULL), (a.detail_fetched_at IS NULL), a.checked_at DESC NULLS LAST
     LIMIT 1`,
    [String(externalId)]
  );
  return res.rows[0] || null;
}

// Лот, которого бот не видел (ставка по ссылке): отдельный ключ монитора — циклы coins.js его не трогают,
// снайпер работает по coin_bids + coin_lots и ключ не смотрит
const MANUAL_KEY = 'coins-manual';
async function saveManualLot({ externalId, url, title, saleType, endsAt, price, bids }) {
  const r = await pool.query(
    `INSERT INTO listings.listings (external_id, monitor_key, url, title, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (external_id, monitor_key) DO UPDATE SET last_seen = NOW(), title = EXCLUDED.title, url = EXCLUDED.url
     RETURNING id`,
    [String(externalId), MANUAL_KEY, url, title]
  );
  await pool.query(
    `INSERT INTO listings.coin_lots (listing_id, source, section, sale_type, current_price, start_price, bids, ends_at, checked_at)
     VALUES ($1, 'ayby', 'manual', $2, $3, $3, $4, $5, NOW())
     ON CONFLICT (listing_id) DO UPDATE SET sale_type = COALESCE(EXCLUDED.sale_type, listings.coin_lots.sale_type),
       current_price = COALESCE(EXCLUDED.current_price, listings.coin_lots.current_price),
       bids = GREATEST(COALESCE(EXCLUDED.bids, 0), COALESCE(listings.coin_lots.bids, 0)),
       ends_at = COALESCE(EXCLUDED.ends_at, listings.coin_lots.ends_at), checked_at = NOW()`,
    [r.rows[0].id, saleType || null, price ?? null, bids ?? 0, endsAt ?? null]
  );
  return lotByExternalId(externalId);
}

// Лот помечен «снят» (404 при первом открытии / дочитке — бывает и от проверки на бота), а страница показывает
// идущие торги: снять пометку, чтобы мониторы снова вели лот (цена под конец, итог)
async function reviveLot(listingId) {
  const res = await pool.query(
    `UPDATE listings.coin_lots SET outcome = NULL, final_price = NULL, final_bids = NULL, end_status_text = NULL, ended_at = NULL, checked_at = NOW()
     WHERE listing_id = $1 AND outcome = 'removed' RETURNING listing_id`,
    [listingId]
  );
  if (res.rowCount) await pool.query(`UPDATE listings.listings SET status = 'active' WHERE id = $1`, [listingId]);
  return res.rowCount > 0;
}

async function setBid(listingId, chatId, maxByn) {
  await pool.query(
    `INSERT INTO listings.coin_bids (listing_id, chat_id, max_byn)
     VALUES ($1, $2, $3)
     ON CONFLICT (listing_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, max_byn = EXCLUDED.max_byn,
       status = 'pending', note = NULL, placed_price = NULL, placed_at = NULL, reported_at = NULL, updated_at = NOW()`,
    [listingId, String(chatId), maxByn]
  );
}

async function cancelBid(listingId) {
  const res = await pool.query(
    `UPDATE listings.coin_bids SET status = 'cancelled', updated_at = NOW()
     WHERE listing_id = $1 AND status IN ('pending', 'running') RETURNING max_byn`,
    [listingId]
  );
  return res.rows[0] || null;
}

async function getBid(listingId) {
  const res = await pool.query('SELECT * FROM listings.coin_bids WHERE listing_id = $1', [listingId]);
  return res.rows[0] || null;
}

async function updateBid(listingId, { status, note, placedPrice, placedAt, reportedAt } = {}) {
  await pool.query(
    `UPDATE listings.coin_bids SET
       status = COALESCE($2, status), note = COALESCE($3, note), placed_price = COALESCE($4, placed_price),
       placed_at = COALESCE($5, placed_at), reported_at = COALESCE($6, reported_at), updated_at = NOW()
     WHERE listing_id = $1`,
    [listingId, status ?? null, note ?? null, placedPrice ?? null, placedAt ?? null, reportedAt ?? null]
  );
}

// Заявки, торги по которым заканчиваются в ближайшие minutes минут (или уже закончились, но итог не отправлен)
async function bidsDue(minutes) {
  const res = await pool.query(
    `SELECT b.*, l.external_id, l.url, l.title, a.ends_at, a.current_price, a.bids, a.outcome
     FROM listings.coin_bids b
     JOIN listings.listings l ON l.id = b.listing_id
     JOIN listings.coin_lots a ON a.listing_id = b.listing_id
     WHERE b.status = 'pending' AND a.ends_at IS NOT NULL AND a.ends_at <= NOW() + ($1 || ' minutes')::interval
     ORDER BY a.ends_at ASC`,
    [String(minutes)]
  );
  return res.rows;
}

// Активные заявки чата (для /bids): ждут, в работе, поставлены — и не поставленные, у которых торги ещё идут
// (их можно перезапустить тем же сообщением со ссылкой и числом)
async function openBids(chatId) {
  const res = await pool.query(
    `SELECT b.*, l.external_id, l.url, l.title, a.ends_at, a.current_price, a.bids
     FROM listings.coin_bids b
     JOIN listings.listings l ON l.id = b.listing_id
     JOIN listings.coin_lots a ON a.listing_id = b.listing_id
     WHERE b.chat_id = $1 AND (b.status IN ('pending', 'running', 'placed') OR (b.status = 'failed' AND a.ends_at > NOW()))
     ORDER BY a.ends_at ASC NULLS LAST`,
    [String(chatId)]
  );
  return res.rows;
}

// Завершённые заявки чата за days дней (для /bids): выиграно, проиграно, не поставлено, отменено
async function recentBids(chatId, days = 7) {
  const res = await pool.query(
    `SELECT b.*, l.external_id, l.url, l.title, a.ends_at, a.final_price, a.winner, a.outcome
     FROM listings.coin_bids b
     JOIN listings.listings l ON l.id = b.listing_id
     JOIN listings.coin_lots a ON a.listing_id = b.listing_id
     WHERE b.chat_id = $1 AND b.status IN ('won', 'lost', 'failed', 'cancelled') AND NOT (b.status = 'failed' AND a.ends_at > NOW())
       AND b.updated_at > NOW() - ($2 || ' days')::interval
     ORDER BY COALESCE(a.ends_at, b.updated_at) DESC`,
    [String(chatId), String(days)]
  );
  return res.rows;
}

module.exports = {
  lotByMessage, lotByExternalId, saveManualLot, reviveLot, endedLots, relistLot, lotRounds, setBid, cancelBid, getBid, updateBid, bidsDue, openBids, recentBids,
  upsertCard, saveLotDetails, recordOutcome, touchEndsAt, lotsToAssess, markNotified, markQuietChecked, lotsClosingSoon, lotsWithoutDetails, lotsToFinalize,
  lotsClosingWithin, savePhotoFiles, photoKeepIds, clearPhotoFiles, knownOwners, notifiedElsewhere, upsertUser, winnersToRefresh,
  getLot, getCoinRows, upsertKufarLot, saveEstimate, historyUsers, markHistoryRead, queueHistory, historyPending, historyQueue, historyDone, markHistoryLot, lotsWithoutContent, lotsForContentLookup, saveContent,
  getCatalog, getCatalogs, catalogKeys, upsertCoinType, upsertSales, rebuildCatalogFromSales, renormalizeSales, CATALOG_FACTOR,
};
