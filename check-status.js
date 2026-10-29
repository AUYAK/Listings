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

const { TELEGRAM_BOT_TOKEN } = process.env;
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
  .split(',').map((id) => id.trim()).filter(Boolean);

const DELAY_MS = 2000;
const JITTER_MS = 1500;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'ru-BY,ru;q=0.9',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 404) return 'inactive';
    if (!res.ok) return null; // 429 "Доступ ограничен" и прочее — статус неизвестен, не трогаем
    if (res.redirected && !res.url.includes('/item/')) return 'inactive';

    const html = await res.text();
    if (/объявление не найдено|снято с публикации/i.test(html)) {
      return 'inactive';
    }

    return 'active';
  } catch {
    return null;
  }
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) return;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    }).catch(() => {});
  }
}

async function main() {
  const client = await pool.connect();

  const { rows: listings } = await client.query(
    `SELECT l.id, l.external_id, l.monitor_key, l.url, l.status,
            s.title, s.price_byn, s.price_usd
     FROM listings.listings l
     LEFT JOIN LATERAL (
       SELECT title, price_byn, price_usd FROM listings.listing_snapshots
       WHERE listing_id = l.id ORDER BY scraped_at DESC LIMIT 1
     ) s ON true
     WHERE l.url IS NOT NULL ORDER BY l.id`
  );

  console.log(`Checking ${listings.length} listings...`);

  let checked = 0;
  let wentInactive = 0;
  let wentActive = 0;
  let stillActive = 0;
  let stillInactive = 0;
  const inactiveDetails = [];

  for (const listing of listings) {
    const newStatus = await checkUrl(listing.url);
    if (newStatus === null) {
      console.warn(`  skip (unknown status): ${listing.url}`);
      await sleep(DELAY_MS + Math.random() * JITTER_MS);
      continue;
    }
    const changed = newStatus !== listing.status;

    if (changed) {
      await client.query(
        `UPDATE listings.listings SET status = $1 WHERE id = $2`,
        [newStatus, listing.id]
      );
      if (newStatus === 'inactive') {
        wentInactive++;
        inactiveDetails.push(listing);
      } else {
        wentActive++;
      }
    } else {
      if (newStatus === 'active') stillActive++;
      else stillInactive++;
    }

    await client.query(
      `INSERT INTO listings.listing_status_logs (listing_id, status) VALUES ($1, $2)`,
      [listing.id, newStatus]
    );

    checked++;
    if (checked % 10 === 0) console.log(`  ${checked}/${listings.length}...`);

    await sleep(DELAY_MS + Math.random() * JITTER_MS);
  }

  client.release();

  const inactiveLines = inactiveDetails.map((l) => {
    const price = [l.price_byn ? `${Number(l.price_byn).toLocaleString('ru')} р.` : null, l.price_usd ? `${Number(l.price_usd).toLocaleString('ru')} $` : null]
      .filter(Boolean).join(' / ');
    return `  • ${l.title || l.external_id}${price ? ` — ${price}` : ''}\n    <a href="${l.url}">${l.url}</a>`;
  }).join('\n');

  const summary =
    `📊 <b>Сводка по объявлениям Kufar — ${new Date().toLocaleDateString('ru-BY')}</b>\n\n` +
    `Проверено: ${checked}\n` +
    `✅ Активные: ${stillActive}\n` +
    `🔴 Сняты с публикации: ${wentInactive}\n` +
    (inactiveLines ? `${inactiveLines}\n` : '') +
    (wentActive > 0 ? `🔄 Снова активные: ${wentActive}\n` : '') +
    `⚪ Уже неактивные: ${stillInactive}`;

  console.log('\n' + summary.replace(/<[^>]+>/g, ''));
  await sendTelegram(summary);

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
