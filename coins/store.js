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
       detail_fetched_at = NOW(), checked_at = NOW()
     WHERE listing_id = $1`,
    [listingId, lot.categoryPath, lot.saleType, parsed.conditionCode, parsed.grade, lot.price, lot.bids, !!lot.bargain,
      lot.endsAt, lot.seller, lot.sellerCity, lot.views, JSON.stringify(lot.specs || {}), lot.description,
      JSON.stringify(parsed), JSON.stringify(lot.photos || [])]
  );
}

async function recordOutcome(listingId, { outcome, finalPrice, finalBids, statusText, approx = false, endedAt = null }) {
  await pool.query(
    `UPDATE listings.coin_lots SET outcome = $2, final_price = $3, final_bids = $4, end_status_text = $5, final_approx = $6,
       ended_at = COALESCE($7, NOW()), checked_at = NOW()
     WHERE listing_id = $1`,
    [listingId, outcome, finalPrice ?? null, finalBids ?? null, statusText ?? null, approx, endedAt ?? null]
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

async function markNotified(listingId) {
  await pool.query('UPDATE listings.coin_lots SET notified_at = NOW() WHERE listing_id = $1', [listingId]);
}

// Аукционы, у которых до конца осталось не больше hours часов, уведомление ещё не уходило
async function lotsClosingSoon(monitorKey, hours, limit) {
  const res = await pool.query(
    `SELECT l.id, l.external_id, l.url, l.title, a.section, a.ends_at, a.sale_type
     FROM listings.coin_lots a JOIN listings.listings l ON l.id = a.listing_id
     WHERE l.monitor_key = $1 AND a.outcome IS NULL AND a.notified_at IS NULL
       AND a.sale_type = 'auction' AND a.detail_fetched_at IS NOT NULL
       AND a.ends_at IS NOT NULL AND a.ends_at > NOW() AND a.ends_at <= NOW() + ($2 || ' hours')::interval
     ORDER BY a.ends_at ASC
     LIMIT $3`,
    [monitorKey, String(hours), limit]
  );
  return res.rows;
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
            a.ends_at, a.ended_at, a.outcome, a.final_price, a.final_bids, a.parsed, a.category_path
     FROM listings.listings l JOIN listings.coin_lots a ON a.listing_id = l.id
     WHERE ($1::text IS NULL OR l.monitor_key = $1)`,
    [monitorKey]
  );
  return res.rows;
}

// ---- каталог (listings.coin_catalog, listings.coin_sales) ----

const CATALOG_FACTOR = parseFloat(process.env.COINS_CATALOG_FACTOR || '1'); // поправка к ценам внешних аукционов для нашего рынка

function catalogKeys(parsed) {
  if (parsed.denomKop == null || !parsed.year) return [];
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
    `SELECT DISTINCT ON (source) type_key, source, title, prices, samples, window_years FROM listings.coin_catalog
     WHERE type_key = ANY($1::text[]) AND prices IS NOT NULL AND prices <> '{}'::jsonb
     ORDER BY source, array_position($1::text[], type_key)`,
    [keys]
  );
  const order = { gdenashel: 0, numista: 1 };
  const catalogs = res.rows
    .sort((a, b) => (order[a.source] ?? 9) - (order[b.source] ?? 9))
    .map((r) => {
      const prices = {};
      const f = r.source === 'numista' ? 1 : factor;
      for (const [g, v] of Object.entries(r.prices || {})) if (v != null) prices[g] = Math.round(v * f * 100) / 100;
      return { source: r.source, title: r.title, prices, samples: r.samples || null, typeKey: r.type_key, windowYears: r.window_years, factor: f };
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

// Пересчёт каталога из проходов: медиана цены по (ключ, состояние) за последние years лет, в BYN по курсу rate.
// Ключи: и точный вариант (с буквами), и тип целиком. Возвращает число записей каталога.
async function rebuildCatalogFromSales(source, years, rate, minSamples = 2) {
  // Проходы, сохранённые до разделения слабов: MS64 и выше — отдельное состояние (см. gdenashel.normalizeGrade)
  await pool.query(
    `UPDATE listings.coin_sales SET grade = 'MS64+'
     WHERE source = $1 AND grade = 'UNC' AND upper(regexp_replace(grade_raw, '\\s', '', 'g')) ~ '^MS(6[4-9]|70)'`,
    [source]
  );
  const agg = await pool.query(
    `WITH recent AS (
       SELECT type_key, variant_key, grade, price, title FROM listings.coin_sales
       WHERE source = $1 AND price > 0 AND grade IS NOT NULL AND sold_on >= CURRENT_DATE - ($2 || ' years')::interval AND sold_on <= CURRENT_DATE
     ), keyed AS (
       SELECT type_key AS key, grade, price, title FROM recent
       UNION ALL
       SELECT variant_key AS key, grade, price, title FROM recent WHERE variant_key IS NOT NULL
     )
     SELECT key, grade, count(*)::int n, percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median, min(title) AS title
     FROM keyed GROUP BY key, grade`,
    [source, String(years)]
  );
  const byKey = new Map();
  for (const r of agg.rows) {
    if (r.n < minSamples) continue;
    const e = byKey.get(r.key) || { prices: {}, samples: {}, title: r.title };
    e.prices[r.grade] = Math.round(parseFloat(r.median) * rate * 100) / 100;
    e.samples[r.grade] = r.n;
    byKey.set(r.key, e);
  }
  for (const [key, e] of byKey) {
    await pool.query(
      `INSERT INTO listings.coin_catalog (type_key, source, title, currency, prices, samples, window_years, rate, fetched_at)
       VALUES ($1, $2, $3, 'BYN', $4, $5, $6, $7, NOW())
       ON CONFLICT (type_key, source) DO UPDATE SET title = EXCLUDED.title, currency = 'BYN', prices = EXCLUDED.prices,
         samples = EXCLUDED.samples, window_years = EXCLUDED.window_years, rate = EXCLUDED.rate, fetched_at = NOW()`,
      [key, source, e.title, JSON.stringify(e.prices), JSON.stringify(e.samples), years, rate]
    );
  }
  return byKey.size;
}

module.exports = {
  upsertCard, saveLotDetails, recordOutcome, touchEndsAt, markNotified, lotsClosingSoon, lotsWithoutDetails, lotsToFinalize,
  lotsClosingWithin, savePhotoFiles, photoKeepIds, clearPhotoFiles,
  getLot, getCoinRows, upsertKufarLot, saveEstimate,
  getCatalog, getCatalogs, catalogKeys, upsertCoinType, upsertSales, rebuildCatalogFromSales, CATALOG_FACTOR,
};
