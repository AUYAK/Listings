require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Returns Set of known external_ids for a given monitor
async function loadKnownIds(monitorKey) {
  const res = await pool.query(
    'SELECT external_id FROM listings.listings WHERE monitor_key = $1',
    [monitorKey]
  );
  return new Set(res.rows.map((r) => r.external_id));
}

// Upsert listing + write snapshot only when price/title/location changed
async function saveListing(monitorKey, listing) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upsert = await client.query(
      `INSERT INTO listings.listings (external_id, monitor_key, url, title, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (external_id, monitor_key) DO UPDATE SET last_seen = NOW(), title = EXCLUDED.title
       RETURNING id`,
      [String(listing.id), monitorKey, listing.url || null, listing.title || null]
    );
    const listingId = upsert.rows[0].id;

    const priceByn = extractPrice(listing.price, 'р.');
    const priceUsd = extractPrice(listing.price, '$');
    const title = listing.title || null;
    const location = listing.location || null;

    const lastSnap = await client.query(
      `SELECT price_byn, price_usd, title, location FROM listings.listing_snapshots
       WHERE listing_id = $1 ORDER BY scraped_at DESC LIMIT 1`,
      [listingId]
    );
    const last = lastSnap.rows[0];

    const changed = !last ||
      String(last.price_byn ?? '') !== String(priceByn ?? '') ||
      String(last.price_usd ?? '') !== String(priceUsd ?? '') ||
      last.title !== title ||
      last.location !== location;

    if (changed) {
      await client.query(
        `INSERT INTO listings.listing_snapshots
           (listing_id, price_byn, price_usd, title, location, params, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [listingId, priceByn, priceUsd, title, location, listing.params || null, JSON.stringify(listing)]
      );
    }

    await client.query('COMMIT');
    return { listingId, snapshotWritten: changed, prev: last || null, isFirstSnapshot: !last };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Full chronological price history for a listing (every recorded snapshot)
async function getPriceHistory(listingId) {
  const res = await pool.query(
    `SELECT price_byn, price_usd, scraped_at FROM listings.listing_snapshots
     WHERE listing_id = $1 ORDER BY scraped_at ASC`,
    [listingId]
  );
  return res.rows;
}

function extractPrice(priceStr, currency) {
  if (!priceStr) return null;
  const line = priceStr.split('\n').find((l) => l.includes(currency));
  if (!line) return null;
  const match = line.replace(/\s/g, '').match(/([\d,.]+)/);
  if (!match) return null;
  return parseFloat(match[1].replace(',', '.')) || null;
}

async function saveNotification(listingId, chatId, msgId) {
  await pool.query(
    `INSERT INTO listings.listing_notifications (listing_id, telegram_chat_id, telegram_msg_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [listingId, String(chatId), msgId]
  );
}

async function addFollower(chatId, msgId) {
  const res = await pool.query(
    `SELECT listing_id FROM listings.listing_notifications
     WHERE telegram_chat_id = $1 AND telegram_msg_id = $2`,
    [String(chatId), msgId]
  );
  if (!res.rows[0]) return null;
  const listingId = res.rows[0].listing_id;
  await pool.query(
    `INSERT INTO listings.listing_followers (listing_id, telegram_chat_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [listingId, String(chatId)]
  );
  return listingId;
}

// 👍 removed from the bot's message → stop following. Returns listing id or null.
async function removeFollower(chatId, msgId) {
  const res = await pool.query(
    `SELECT listing_id FROM listings.listing_notifications
     WHERE telegram_chat_id = $1 AND telegram_msg_id = $2`,
    [String(chatId), msgId]
  );
  if (!res.rows[0]) return null;
  const listingId = res.rows[0].listing_id;
  await pool.query(
    'DELETE FROM listings.listing_followers WHERE listing_id = $1 AND telegram_chat_id = $2',
    [listingId, String(chatId)]
  );
  return listingId;
}

// Returns all actively-followed listings with their last snapshot data
async function getFollowedListings() {
  const res = await pool.query(
    `SELECT l.id, l.external_id, l.monitor_key, l.url,
            s.price_byn, s.price_usd, s.title, s.location
     FROM listings.listing_followers lf
     JOIN listings.listings l ON l.id = lf.listing_id
     LEFT JOIN LATERAL (
       SELECT price_byn, price_usd, title, location
       FROM listings.listing_snapshots
       WHERE listing_id = l.id ORDER BY scraped_at DESC LIMIT 1
     ) s ON true
     WHERE l.url IS NOT NULL AND l.status = 'active'
     GROUP BY l.id, l.external_id, l.monitor_key, l.url,
              s.price_byn, s.price_usd, s.title, s.location`
  );
  return res.rows;
}

// Returns chat_ids of all followers of a listing
async function getFollowers(listingId) {
  const res = await pool.query(
    'SELECT telegram_chat_id FROM listings.listing_followers WHERE listing_id = $1',
    [listingId]
  );
  return res.rows.map((r) => r.telegram_chat_id);
}

// ---- Bot settings: per-chat category subscriptions ----

// Registers a chat after /start or /settings. Returns true if the chat is new.
async function registerChat(chatId) {
  const res = await pool.query(
    `INSERT INTO listings.bot_chats (telegram_chat_id) VALUES ($1)
     ON CONFLICT (telegram_chat_id) DO UPDATE SET last_seen = NOW()
     RETURNING (xmax = 0) AS is_new`,
    [String(chatId)]
  );
  return res.rows[0].is_new;
}

// Set of chat_ids that have opened bot settings at least once
async function getConfiguredChats() {
  const res = await pool.query('SELECT telegram_chat_id FROM listings.bot_chats');
  return new Set(res.rows.map((r) => r.telegram_chat_id));
}

async function getSubscriptions(chatId) {
  const res = await pool.query(
    'SELECT monitor_key FROM listings.monitor_subscriptions WHERE telegram_chat_id = $1',
    [String(chatId)]
  );
  return new Set(res.rows.map((r) => r.monitor_key));
}

async function setSubscriptions(chatId, monitorKeys) {
  for (const key of monitorKeys) {
    await pool.query(
      `INSERT INTO listings.monitor_subscriptions (telegram_chat_id, monitor_key)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [String(chatId), key]
    );
  }
}

// Flips one checkbox; returns the new state (true = subscribed)
async function toggleSubscription(chatId, monitorKey) {
  const del = await pool.query(
    'DELETE FROM listings.monitor_subscriptions WHERE telegram_chat_id = $1 AND monitor_key = $2',
    [String(chatId), monitorKey]
  );
  if (del.rowCount > 0) return false;
  await pool.query(
    `INSERT INTO listings.monitor_subscriptions (telegram_chat_id, monitor_key)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [String(chatId), monitorKey]
  );
  return true;
}

// chat_ids subscribed to a monitor via bot settings
async function getSubscribers(monitorKey) {
  const res = await pool.query(
    'SELECT telegram_chat_id FROM listings.monitor_subscriptions WHERE monitor_key = $1',
    [monitorKey]
  );
  return res.rows.map((r) => r.telegram_chat_id);
}

// ---- Market stats & sold tracking ----

// All listings of a monitor with their latest price and parsed details (for median calculations)
async function getMarketRows(monitorKey) {
  const withDetails = `SELECT l.id, l.status, l.first_seen, l.last_seen, g.gone_at,
            COALESCE(s.title, l.title) AS title, s.price_byn,
            d.condition, d.chip, d.ram_gb, d.ssd_gb, d.screen_in, d.year
     FROM listings.listings l
     LEFT JOIN LATERAL (
       SELECT title, price_byn FROM listings.listing_snapshots
       WHERE listing_id = l.id ORDER BY scraped_at DESC LIMIT 1
     ) s ON true
     LEFT JOIN LATERAL (
       SELECT min(checked_at) AS gone_at FROM listings.listing_status_logs
       WHERE listing_id = l.id AND status = 'inactive'
     ) g ON true
     LEFT JOIN listings.listing_details d ON d.listing_id = l.id
     WHERE l.monitor_key = $1`;
  try {
    return (await pool.query(withDetails, [monitorKey])).rows;
  } catch (err) {
    if (err.code === '42703') { // undefined_column → migration 010 not applied yet
      return (await pool.query(withDetails.replace(', d.year', ', NULL AS year'), [monitorKey])).rows;
    }
    if (err.code !== '42P01') throw err; // undefined_table → migration 007 not applied yet
    const withoutDetails = withDetails
      .replace('d.condition, d.chip, d.ram_gb, d.ssd_gb, d.screen_in, d.year',
        'NULL AS condition, NULL AS chip, NULL AS ram_gb, NULL AS ssd_gb, NULL AS screen_in, NULL AS year')
      .replace('LEFT JOIN listings.listing_details d ON d.listing_id = l.id', '');
    return (await pool.query(withoutDetails, [monitorKey])).rows;
  }
}

// ---- Listing details (characteristics + description) ----

async function saveListingDetails(listingId, d) {
  const base = [listingId, JSON.stringify(d.specs || {}), d.description || null, d.condition || null, d.cpu || null,
    d.chip || null, d.ramGb ?? null, d.ssdGb ?? null, d.screenIn ?? null, d.batteryCycles ?? null];
  try {
    await pool.query(
      `INSERT INTO listings.listing_details
         (listing_id, specs, description, condition, cpu, chip, ram_gb, ssd_gb, screen_in, battery_cycles,
          year, battery_health_pct, body_condition, flags, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
       ON CONFLICT (listing_id) DO UPDATE SET
         specs = EXCLUDED.specs, description = EXCLUDED.description, condition = EXCLUDED.condition,
         cpu = EXCLUDED.cpu, chip = EXCLUDED.chip, ram_gb = EXCLUDED.ram_gb, ssd_gb = EXCLUDED.ssd_gb,
         screen_in = EXCLUDED.screen_in, battery_cycles = EXCLUDED.battery_cycles,
         year = EXCLUDED.year, battery_health_pct = EXCLUDED.battery_health_pct,
         body_condition = EXCLUDED.body_condition, flags = EXCLUDED.flags, fetched_at = NOW()`,
      [...base, d.year ? parseInt(d.year, 10) : null, d.batteryHealthPct ?? null, d.bodyCondition || null,
        JSON.stringify(d.flags || [])]
    );
  } catch (err) {
    if (err.code !== '42703') throw err; // undefined_column → migration 010 not applied yet: save the old columns
    await pool.query(
      `INSERT INTO listings.listing_details
         (listing_id, specs, description, condition, cpu, chip, ram_gb, ssd_gb, screen_in, battery_cycles, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (listing_id) DO UPDATE SET
         specs = EXCLUDED.specs, description = EXCLUDED.description, condition = EXCLUDED.condition,
         cpu = EXCLUDED.cpu, chip = EXCLUDED.chip, ram_gb = EXCLUDED.ram_gb, ssd_gb = EXCLUDED.ssd_gb,
         screen_in = EXCLUDED.screen_in, battery_cycles = EXCLUDED.battery_cycles, fetched_at = NOW()`,
      base
    );
  }
}

async function getListingDetails(listingId) {
  const res = await pool.query('SELECT * FROM listings.listing_details WHERE listing_id = $1', [listingId]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    specs: r.specs || {}, description: r.description, condition: r.condition, cpu: r.cpu, chip: r.chip,
    ramGb: r.ram_gb, ssdGb: r.ssd_gb, screenIn: r.screen_in != null ? parseFloat(r.screen_in) : null,
    batteryCycles: r.battery_cycles,
    // columns from migration 010; null/undefined → formatDetailsLines recomputes from the description
    year: r.year != null ? String(r.year) : null, batteryHealthPct: r.battery_health_pct ?? null,
    bodyCondition: r.body_condition ?? null, flags: Array.isArray(r.flags) ? r.flags : null,
  };
}

// What the bot showed for a listing at notification time (see migration 009)
async function saveMarketAssessment(listingId, { isUpdate, priceByn, stats, deviationPct }) {
  await pool.query(
    `INSERT INTO listings.market_assessments
       (listing_id, is_update, price_byn, group_label, ref_source, ref_median,
        active_n, active_median, sold_n, sold_median, deviation_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [listingId, !!isUpdate, priceByn ?? null, stats.label, stats.refSource, stats.refMedian ?? null,
     stats.activeN ?? 0, stats.activeMedian ?? null, stats.soldN ?? 0, stats.soldMedian ?? null, deviationPct ?? null]
  );
}

// Active listings of a monitor that have no details row yet, freshest first
async function getListingsWithoutDetails(monitorKey, limit) {
  const res = await pool.query(
    `SELECT l.id, l.external_id, l.url, l.title
     FROM listings.listings l
     LEFT JOIN listings.listing_details d ON d.listing_id = l.id
     WHERE l.monitor_key = $1 AND l.status = 'active' AND l.url IS NOT NULL AND d.listing_id IS NULL
     ORDER BY l.last_seen DESC
     LIMIT $2`,
    [monitorKey, limit]
  );
  return res.rows;
}

// Active listings that dropped out of search results for >= minAgeHours and were not
// status-checked in the last recheckHours. Never-checked first, then oldest check.
async function getStaleActiveListings(monitorKey, minAgeHours, recheckHours, limit) {
  const res = await pool.query(
    `SELECT l.id, l.external_id, l.url, l.title, s.price_byn, c.checked_at
     FROM listings.listings l
     LEFT JOIN LATERAL (
       SELECT price_byn FROM listings.listing_snapshots
       WHERE listing_id = l.id ORDER BY scraped_at DESC LIMIT 1
     ) s ON true
     LEFT JOIN LATERAL (
       SELECT checked_at FROM listings.listing_status_logs
       WHERE listing_id = l.id ORDER BY checked_at DESC LIMIT 1
     ) c ON true
     WHERE l.monitor_key = $1 AND l.status = 'active' AND l.url IS NOT NULL
       AND l.last_seen < NOW() - ($2 || ' hours')::interval
       AND (c.checked_at IS NULL OR c.checked_at < NOW() - ($3 || ' hours')::interval)
     ORDER BY c.checked_at ASC NULLS FIRST, l.last_seen ASC
     LIMIT $4`,
    [monitorKey, String(minAgeHours), String(recheckHours), limit]
  );
  return res.rows;
}

async function recordStatusCheck(listingId, status) {
  await pool.query('UPDATE listings.listings SET status = $1 WHERE id = $2', [status, listingId]);
  await pool.query(
    'INSERT INTO listings.listing_status_logs (listing_id, status) VALUES ($1, $2)',
    [listingId, status]
  );
}

async function closePool() {
  await pool.end();
}

module.exports = {
  loadKnownIds, saveListing, saveNotification, addFollower, removeFollower, getFollowedListings, getFollowers, getPriceHistory,
  registerChat, getConfiguredChats, getSubscriptions, setSubscriptions, toggleSubscription, getSubscribers,
  getMarketRows, getStaleActiveListings, recordStatusCheck,
  saveListingDetails, getListingDetails, getListingsWithoutDetails, saveMarketAssessment,
  closePool,
  pool, // для доменных модулей (coins/store.js), которые ведут свои таблицы в той же базе
};
