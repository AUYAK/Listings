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

// ---- Sold tracking ----

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
  getStaleActiveListings, recordStatusCheck,
  closePool,
  pool, // для доменных модулей (coins/store.js), которые ведут свои таблицы в той же базе
};
