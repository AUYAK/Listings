require('dotenv').config();
const { chromium } = require('playwright');
const store = require('./store');
// Этот процесс ведёт только мониторы Kufar; площадки с другим source (ay.by → coins.js) живут отдельно
const MONITORS = require('./config').MONITORS.filter((m) => !m.source || m.source === 'kufar');
const { parseCoin } = require('./coins/parse');
const cstore = require('./coins/store');
const cmarket = require('./coins/market');
const numista = require('./coins/numista');

// Мониторы с domain='coins' (Kufar): каждое объявление разбирается и сохраняется в coin_lots,
// уведомление — только серебро без копий/подборок и только при выгоде (ниже каталога или нашей оценки
// на BARGAIN_PCT). Возвращает { notify, reason, lines }.
let coinRowsCache = { at: 0, rows: [] };
async function assessCoinListing(listingId, listing) {
  const parsed = parseCoin({ title: listing.title, sectionPath: null, description: listing.params });
  const price = extractPriceFromStr(listing.price, 'р.');
  await cstore.upsertKufarLot(listingId, parsed, price).catch((err) => console.warn(`  [Coins] save failed: ${err.message}`));
  if (!parsed.isSilver) return { notify: false, reason: 'не серебро' };
  if (parsed.flags.includes('копия') || parsed.flags.includes('несколько монет')) return { notify: false, reason: parsed.flags.join(', ') };
  if (Date.now() - coinRowsCache.at > 5 * 60e3) coinRowsCache = { at: Date.now(), rows: await cstore.getCoinRows(null).catch(() => []) };
  // источники в карточке раздельно; ориентир: архив проходов (load-catalog.js) → Numista (если есть ключ) → наша медиана
  const { catalogs, type } = await cstore.getCatalogs(parsed).catch(() => ({ catalogs: [], type: null }));
  if (!catalogs.some((c) => c.source === 'numista')) { const n = await numista.lookup(parsed).catch(() => null); if (n) catalogs.push(n); }
  const est = cmarket.assess({ parsed, price, rows: coinRowsCache.rows, excludeId: listingId, catalogs, coinType: type });
  await cstore.saveEstimate(listingId, est).catch(() => {});
  const coinLine = [parsed.denomination, parsed.year, parsed.mintmaster || parsed.mint, parsed.ruler, 'серебро'].filter(Boolean).join(' · ');
  const lines = [`🔎 ${coinLine}`, parsed.grade ? `🏷 Состояние (из заголовка): ${parsed.grade}` : null, ...cmarket.formatEstimateLines(est)].filter(Boolean);
  if (!est.isBargain) return { notify: false, reason: est.deviationPct == null ? 'нет ориентира' : `${est.deviationPct}% к ${est.referenceSource}`, lines };
  return { notify: true, lines };
}

const INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10);
const { TELEGRAM_BOT_TOKEN } = process.env;
const DEFAULT_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
  .split(',').map((id) => id.trim()).filter(Boolean);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function telegramRequest(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.warn(`[Telegram] ${method} failed: ${data.description}`);
  }
  return data;
}

function formatPrice(byn, usd) {
  return [byn ? `${Number(byn).toLocaleString('ru')} р.` : null, usd ? `${Number(usd).toLocaleString('ru')} $` : null]
    .filter(Boolean).join(' / ') || null;
}

function buildDiff(listing, prev) {
  if (!prev) return '';
  const lines = [];
  if (prev.title !== (listing.title || null)) {
    lines.push(`📝 ${prev.title || '—'} → ${listing.title || '—'}`);
  }
  if (prev.location !== (listing.location || null)) {
    lines.push(`📍 ${prev.location || '—'} → ${listing.location || '—'}`);
  }
  return lines.length ? '\n' + lines.join('\n') : '';
}

function formatHistoryDate(d) {
  return new Date(d).toLocaleString('ru-BY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Chronological list of distinct price points ("date — price"), consecutive
// duplicates collapsed (a snapshot can also be triggered by a title/location change).
function buildPriceHistoryLines(history) {
  const lines = [];
  let lastKey = null;
  for (const row of history) {
    const key = `${row.price_byn ?? ''}|${row.price_usd ?? ''}`;
    if (key === lastKey) continue;
    lastKey = key;
    const priceStr = formatPrice(row.price_byn, row.price_usd) || 'Договорная';
    lines.push(`${formatHistoryDate(row.scraped_at)} — ${priceStr}`);
  }
  return lines;
}

// Who gets notifications for a monitor:
//  - chats that opened bot settings (/settings) — only if they ticked this category;
//  - chats that never opened settings — legacy config (monitor.chatIds or TELEGRAM_CHAT_IDS).
async function resolveRecipients(monitor) {
  const legacy = monitor.optIn ? [] : (monitor.chatIds && monitor.chatIds.length ? monitor.chatIds : DEFAULT_CHAT_IDS);
  try {
    const [subscribers, configured] = await Promise.all([
      store.getSubscribers(monitor.key),
      store.getConfiguredChats(),
    ]);
    const legacyOnly = legacy.filter((id) => !configured.has(String(id)));
    return [...new Set([...subscribers, ...legacyOnly].map(String))];
  } catch (err) {
    console.warn(`[Telegram] Could not load subscriptions (${err.message}), using config recipients`);
    return legacy;
  }
}

async function notify(listing, monitor, isUpdate = false, prev = null, listingId = null, recipientIds = null) {
  const listingUrl = listing.url || monitor.url;
  const label = isUpdate ? '🔄 Обновление' : 'Kufar.by';
  const diff = isUpdate ? buildDiff(listing, prev) : '';

  let priceHistoryBlock = '';
  if (isUpdate && listingId) {
    const history = await store.getPriceHistory(listingId).catch(() => []);
    const historyLines = buildPriceHistoryLines(history);
    const pastLines = historyLines.slice(0, -1); // drop current price, already shown above
    if (pastLines.length > 0) {
      priceHistoryBlock = `\n📈 История цены:\n${pastLines.join('\n')}\n`;
    }
  }

  const targets = recipientIds || await resolveRecipients(monitor);
  if (!TELEGRAM_BOT_TOKEN || !targets || targets.length === 0) {
    console.log('[Telegram] Not configured.');
    return;
  }

  const caption =
    `<b>${monitor.emoji || ''} ${label} — ${monitor.name}</b>\n` +
    `${listing.title || 'Без названия'}\n` +
    (listing.location ? `📍 ${listing.location}\n` : '') +
    (listing.params ? `${listing.params}\n` : '') +
    `💰 ${listing.price}\n` +
    (listing.extraLines && listing.extraLines.length ? `${listing.extraLines.join('\n')}\n` : '') +
    (diff ? `${diff}\n` : '') +
    priceHistoryBlock +
    `<a href="${listingUrl}">Открыть объявление</a>`;

  for (const chatId of targets) {
    const photos = listing.photos || [];
    let sentMsgId = null;

    if (photos.length >= 2) {
      const media = photos.map((url, i) => ({
        type: 'photo',
        media: url,
        ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
      }));
      const res = await telegramRequest('sendMediaGroup', { chat_id: chatId, media });
      if (res.ok) {
        sentMsgId = res.result?.[0]?.message_id;
      } else {
        console.warn(`[Telegram] sendMediaGroup failed for ${chatId}: ${res.description}`);
      }
    }

    // try single photo (first) as fallback or primary
    if (!sentMsgId && photos.length >= 1) {
      const res = await telegramRequest('sendPhoto', {
        chat_id: chatId,
        photo: photos[0],
        caption,
        parse_mode: 'HTML',
      });
      if (res.ok) {
        sentMsgId = res.result?.message_id;
      } else {
        console.warn(`[Telegram] sendPhoto failed for ${chatId}: ${res.description}`);
      }
    }

    if (!sentMsgId) {
      const res = await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: caption,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      });
      if (res.ok) {
        sentMsgId = res.result?.message_id;
      } else {
        console.error(`[Telegram] sendMessage error for ${chatId}: ${res.description}`);
      }
    }

    if (listingId && sentMsgId) {
      await store.saveNotification(listingId, chatId, sentMsgId).catch(() => {});
    }
  }
}

async function fetchKufarListings(monitor, page) {
  await page.goto(monitor.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('a[data-testid="kufar-ad"], a[data-testid="kufar-vip-ad"]', { timeout: 15000 }).catch(() => {});

  return await page.evaluate(() => {
    const cards = [...document.querySelectorAll('a[data-testid="kufar-ad"], a[data-testid="kufar-vip-ad"]')];
    const seen = new Set();
    const results = [];

    for (const card of cards) {
      const href = card.getAttribute('href') || '';
      const match = href.match(/\/item\/(\d+)/);
      if (!match) continue;
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);

      const title = card.querySelector('h3')?.textContent?.trim() || null;

      // Price: strip crossed-out "old price" / discount badge from promo cards
      const priceBlock = card.querySelector('[class*="price_block"]');
      let price = 'Цена не указана';
      if (priceBlock) {
        const clone = priceBlock.cloneNode(true);
        clone.querySelectorAll('[class*="old_price"], [class*="discount"]').forEach((el) => el.remove());
        price = clone.textContent?.trim() || price;
      }

      // Location + date: a <span> with the date, its sibling <p> holds the location
      const spans = [...card.querySelectorAll('span')];
      const dateSpan = spans.find((s) => /Сегодня|Вчера|\d{2}\.\d{2}\.\d{4}/.test(s.textContent || ''));
      const location =
        (dateSpan?.parentElement?.querySelector('p')?.textContent?.trim()) ||
        (dateSpan?.previousElementSibling?.textContent?.trim()) ||
        null;

      const params = card.querySelector('[class*="parameters"]')?.textContent?.trim() || null;

      const photos = [...new Set(
        [...card.querySelectorAll('img[src*="rms.kufar.by"]')].map((el) => el.src)
      )].slice(0, 10);

      const url = href.startsWith('http') ? href.split('?')[0] : `https://www.kufar.by${href.split('?')[0]}`;

      results.push({ id, title, price, url, photos, location, params });
    }

    return results;
  });
}

async function fetchListings(monitor) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ru-BY' });
  const page = await context.newPage();

  try {
    return await fetchKufarListings(monitor, page);
  } finally {
    await browser.close();
  }
}

async function notifyError(monitor, errMessage) {
  console.error(`  [${monitor.name}] Parse error: ${errMessage}`);
}

async function checkMonitor(monitor, isFirstRun) {
  try {
    const listings = await fetchListings(monitor);
    const knownIds = await store.loadKnownIds(monitor.key);

    if (isFirstRun && knownIds.size === 0) {
      for (const l of listings) {
        await store.saveListing(monitor.key, l);
      }
      console.log(`  [${monitor.name}] First run: seeded ${listings.length} listings`);
      return;
    }

    const newListings = listings.filter((l) => !knownIds.has(l.id));
    console.log(`  [${monitor.name}] ${listings.length} total, ${newListings.length} new`);

    for (const listing of listings) {
      const isNew = !knownIds.has(listing.id);
      const { listingId, snapshotWritten, prev, isFirstSnapshot } = await store.saveListing(monitor.key, listing);

      if (isNew) {
        if (monitor.domain === 'coins') {
          const verdict = await assessCoinListing(listingId, listing);
          if (!verdict.notify) {
            console.log(`  [${monitor.name}] stored (${verdict.reason}): [${listing.id}] ${listing.title}`);
            continue;
          }
          listing.extraLines = verdict.lines;
        }
        await notify(listing, monitor, false, null, listingId);
        console.log(`  [${monitor.name}] NEW: [${listing.id}] ${listing.title} — ${listing.price?.replace(/\n/g, ' / ')}`);
      } else if (snapshotWritten && !isFirstSnapshot) {
        if (priceChanged(prev, listing)) {
          await notify(listing, monitor, true, prev, listingId);
          console.log(`  [${monitor.name}] UPDATED: [${listing.id}] ${listing.title}`);
        }
      }
    }
  } catch (err) {
    console.error(`  [${monitor.name}] Error:`, err);
    await notifyError(monitor, err.message || String(err));
  }
}

function priceChanged(prev, listing) {
  if (!prev) return false;
  const newByn = extractPriceFromStr(listing.price, 'р.');
  const newUsd = extractPriceFromStr(listing.price, '$');
  const oldByn = prev.price_byn != null ? parseFloat(prev.price_byn) : null;
  const oldUsd = prev.price_usd != null ? parseFloat(prev.price_usd) : null;
  return String(oldByn ?? '') !== String(newByn ?? '') || String(oldUsd ?? '') !== String(newUsd ?? '');
}

function extractPriceFromStr(priceStr, currency) {
  if (!priceStr) return null;
  const line = priceStr.split('\n').find((l) => l.includes(currency));
  if (!line) return null;
  const match = line.replace(/\s/g, '').match(/([\d,.]+)/);
  if (!match) return null;
  return parseFloat(match[1].replace(',', '.')) || null;
}

async function fetchSingleListing(item, page) {
  await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  return await page.evaluate(() => {
    const title =
      document.querySelector('[class*="brief_wrapper__title"]')?.textContent?.trim() ||
      document.querySelector('h1')?.textContent?.trim() ||
      null;

    const priceBlock = document.querySelector('[class*="brief_wrapper__price"]');
    const price = priceBlock?.textContent?.trim() || 'Цена не указана';

    // The item page has no location block for the listing itself (only a regions menu),
    // so location is not read here; the caller keeps the last known one.
    return { title, price };
  });
}

async function checkFollowedListings() {
  const followed = await store.getFollowedListings();
  if (!followed.length) return;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ru-BY' });
  const page = await context.newPage();

  for (const item of followed) {
    try {
      const current = await fetchSingleListing(item, page);
      if (!current) continue;
      // Keep last known title/location: the item page gives no location and a parse miss must not
      // look like a change (that produced a notification every cycle)
      const merged = {
        ...current, id: item.external_id, url: item.url,
        title: current.title || item.title, location: item.location,
      };

      // Лоты других площадок (ay.by) этим парсером не читаются — их ведёт свой процесс
      const monitor = MONITORS.find((m) => m.key === item.monitor_key);
      if (!monitor) continue;
      const { listingId, snapshotWritten, prev, isFirstSnapshot } = await store.saveListing(item.monitor_key, merged);

      // Followers are told about price changes only, same as the search-results path
      if (snapshotWritten && !isFirstSnapshot && priceChanged(prev, merged)) {
        const followers = await store.getFollowers(listingId);
        if (!followers.length) continue;
        await notify(merged, monitor, true, prev, listingId, followers);
        console.log(`  [Followed] UPDATED: [${item.external_id}] notified ${followers.length} follower(s)`);
      }
    } catch (err) {
      console.error(`  [Followed] Error checking ${item.url}:`, err.message);
    }
  }

  await browser.close();
}

// For monitors with trackSold=true: listings that vanished from search results are opened
// one by one; a 404 (or "не найдено" page) marks them inactive = sold/removed.
// Small batches per cycle so Kufar's rate limit is not hit.
const SOLD_CHECK_BATCH = parseInt(process.env.SOLD_CHECK_BATCH || '12', 10);
const SOLD_CHECK_MIN_AGE_H = 6;    // not seen in results for this long (median detection lag was 36h with 12h/8)
const SOLD_CHECK_RECHECK_H = 24;   // re-verify still-active ones this often

async function checkSoldListings() {
  const monitors = MONITORS.filter((m) => m.trackSold);
  if (!monitors.length) return;

  let browser = null;
  try {
    for (const monitor of monitors) {
      const stale = await store.getStaleActiveListings(monitor.key, SOLD_CHECK_MIN_AGE_H, SOLD_CHECK_RECHECK_H, SOLD_CHECK_BATCH);
      if (!stale.length) continue;

      if (!browser) browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ru-BY' });
      const page = await context.newPage();

      let sold = 0;
      for (const item of stale) {
        let status = null;
        try {
          const resp = await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          const code = resp ? resp.status() : 0;
          if (code === 404) status = 'inactive';
          else if (code === 200) {
            const gone = await page.evaluate(() => /объявление не найдено|снято с публикации/i.test(document.body.innerText));
            status = gone ? 'inactive' : 'active';
          } else {
            console.warn(`  [Sold] [${monitor.name}] HTTP ${code} for ${item.url}, pausing this cycle`);
            break;
          }
        } catch (err) {
          console.warn(`  [Sold] [${monitor.name}] ${item.url}: ${err.message}`);
          break;
        }

        await store.recordStatusCheck(item.id, status);
        if (status === 'inactive') {
          sold++;
          const price = item.price_byn != null ? `${Number(item.price_byn).toLocaleString('ru')} р.` : 'без цены';
          console.log(`  [Sold] [${monitor.name}] gone: [${item.external_id}] ${item.title} — ${price}`);
        }
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
      }
      console.log(`  [Sold] [${monitor.name}] checked ${stale.length}, gone ${sold}`);
      await context.close();
    }
  } catch (err) {
    console.error('  [Sold] Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
}

async function check(isFirstRun) {
  const ts = new Date().toLocaleString('ru-BY');
  console.log(`[${ts}] Checking...`);
  for (const monitor of MONITORS) {
    await checkMonitor(monitor, isFirstRun);
  }
  await checkFollowedListings();
  await checkSoldListings();
}

// Без этой защиты при медленном Kufar (таймауты по 30 с) циклы по таймеру накладывались друг на друга,
// каждый открывал свои браузеры, и Chrome копился до 99% CPU на сервере.
let running = false;
async function tick(isFirstRun) {
  if (running) { console.log('  previous cycle still running, skipping'); return; }
  running = true;
  const started = Date.now();
  try { await check(isFirstRun); }
  catch (err) { console.error('Cycle error:', err); }
  finally {
    running = false;
    const sec = Math.round((Date.now() - started) / 1000);
    if (sec * 1000 > INTERVAL_MS) console.warn(`  cycle took ${sec}s, longer than the ${INTERVAL_MS / 1000}s interval`);
  }
}

async function main() {
  if (!TELEGRAM_BOT_TOKEN || DEFAULT_CHAT_IDS.length === 0) {
    console.warn('Warning: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_IDS not set (only monitors with their own chatIds will notify)');
  }
  console.log(`Kufar monitor started. Monitors: ${MONITORS.map((m) => m.name).join(', ')}. Interval: ${INTERVAL_MS / 1000}s`);

  await tick(true);
  setInterval(() => tick(false), INTERVAL_MS);
}

main();
