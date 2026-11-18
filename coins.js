// Сборщик аукционных лотов ay.by для мониторов с source='ayby' (монеты).
// Цикл: разделы, сначала новые (или все страницы продавцов) → новые карточки → страницы новых лотов (состояние,
// тип продажи, срок, продавец, минимальная цена) → решение по лоту (выгодно / тихий лот / подождать / закрыть) →
// дочитывание старых лотов порциями → итоги по истёкшим лотам (цена, победитель) → рейтинги победителей.
// Отдельно раз в несколько минут — лента новых лотов всех разделов (scanFeed): дешёвое «купить сейчас» не ждёт цикла.
// В конце цикла — история продаж через отзывы покупателей и продавцов (collectHistory).
// Запуск: node coins.js (pm2: coins-monitor). Нужны миграции 011–017.
require('dotenv').config();
const { chromium } = require('playwright');
const store = require('./store');
const cstore = require('./coins/store');
const ayby = require('./coins/ayby');
const { parseCoin, notifyBlocker } = require('./coins/parse');
const cmarket = require('./coins/market');
const { assessCoin } = require('./coins/assess');
const photos = require('./coins/photos');
const favorites = require('./coins/favorites');
const { SNIPE_SECONDS } = require('./coins/bid');
const tg = require('./telegram');
const { MONITORS } = require('./config');

const INTERVAL_MS = parseInt(process.env.COINS_INTERVAL_MS || '600000', 10); // 10 минут
const PAGES = parseInt(process.env.COINS_PAGES || '3', 10);                  // страниц раздела за цикл
const SEED_PAGES = parseInt(process.env.COINS_SEED_PAGES || '8', 10);        // при первом запуске
const DETAIL_BATCH = 40;      // страниц новых лотов за цикл
const BACKFILL_BATCH = 40;    // страниц старых лотов без подробностей за цикл (сначала те, что кончаются раньше)
// Глубокий проход (мониторы с deep: true): все страницы разделов, только карточки — по DEEP_PAGES страниц за цикл,
// полный круг раз в DEEP_EVERY_MS. Лоты, выставленные до запуска, иначе не попадают в базу никогда.
const DEEP_PAGES = parseInt(process.env.COINS_DEEP_PAGES || '40', 10);
const DEEP_EVERY_MS = 24 * 3600e3;
const LIST_CACHE_MS = 5 * 60e3; // страница списка, уже прочитанная другим монитором в этом цикле, не грузится снова
const ASSESS_BATCH = 300;    // неоценённых лотов за цикл (по базе, без страниц; страница — только у выгодных)
const FINALIZE_BATCH = 30;    // истёкших лотов за цикл
const FINALIZE_GRACE_MIN = 10;
const AUCTION_NOTIFY_HOURS = parseFloat(process.env.COINS_AUCTION_NOTIFY_HOURS || '12'); // чистые аукционы — только под конец
const QUIET_HOURS = cmarket.QUIET_HOURS; // тихие лоты — раньше, за сутки: успеть заказать снайп
const CLOSING_BATCH = 30;
const USER_LOOKUPS = parseInt(process.env.COINS_USER_LOOKUPS || '10', 10); // профилей победителей за цикл
const LOW_RATING = parseInt(process.env.COINS_LOW_RATING || '20', 10);     // продавец с меньшим рейтингом — предупреждение
// Страница лота после торгов обычно жива («Завершён… Лот продан за …»), но защита ay.by иногда отдаёт 403/404,
// поэтому последнюю ставку и фото снимаем за PRECLOSE_MIN минут до конца; если страница всё же пропала,
// итог = последняя увиденная ставка (final_approx).
const PRECLOSE_MIN = parseInt(process.env.COINS_PRECLOSE_MIN || '40', 10);
const PRECLOSE_STALE_MIN = 15;
const PRECLOSE_BATCH = 40;
const SECTIONS_TTL_MS = 24 * 3600e3;
// История продаж через отзывы (collectHistory): пользователей и страниц лотов за цикл; COINS_HISTORY_LOTS=0 — выключить
const HISTORY_USERS = parseInt(process.env.COINS_HISTORY_USERS || '2', 10);
const HISTORY_LOTS = parseInt(process.env.COINS_HISTORY_LOTS || '40', 10);
const HISTORY_PAGES = 60; // страниц отзывов на вкладку: по 10 сделок, ссылки на лоты кончаются раньше (~60 дней)
const SELLER_MAX_PAGES = parseInt(process.env.COINS_SELLER_MAX_PAGES || '15', 10); // по 100 лотов
// Лента новых лотов всех монетных разделов (coins.ay.by/new/, сортировка «Новые»): дешёвое «купить сейчас» опытные
// покупатели забирают за часы, а полный цикл по разделам идёт долго. Раз в FEED_INTERVAL_MS — 1–2 страницы ленты:
// серебро, золото и лоты продавцов из мониторов с feed: true / sellers, сразу со страницей лота и решением.
// Проход идёт и между циклами, и внутри цикла (между лотами). COINS_FEED_INTERVAL_MS=0 — выключить.
const FEED_URL = process.env.COINS_FEED_URL || 'https://coins.ay.by/new/?order=create';
const FEED_INTERVAL_MS = parseInt(process.env.COINS_FEED_INTERVAL_MS || '90000', 10);
const FEED_PAGES = parseInt(process.env.COINS_FEED_PAGES || '2', 10);
const FEED_DETAIL_MAX = 25;  // страниц лотов за проход
const FEED_SEEN_TTL_MS = 3 * 86400e3;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const monitors = MONITORS.filter((m) => m.source === 'ayby');
const sectionCache = new Map(); // monitor.key → { at, urls }

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => pause(base + Math.random() * base);
const ts = () => new Date().toLocaleString('ru-BY');

// Предохранитель: STRIKES подряд таймаутов/403/429 — ay.by не отвечает или ограничивает нас; цикл прерываем,
// иначе он тянется часами (по 30–45 с на каждую страницу) и следующие циклы пропускаются.
const STRIKES = parseInt(process.env.COINS_MAX_STRIKES || '3', 10);
let strikes = 0;
function failed(err) {
  if (!ayby.isBlocked(err)) return false;
  strikes++;
  if (strikes < STRIKES) return false;
  throw new Error(`ay.by не отвечает или ограничивает запросы (${strikes} подряд): ${err.message}`);
}
const ok = () => { strikes = 0; };

async function resolveSections(page, monitor) {
  const cached = sectionCache.get(monitor.key);
  if (cached && Date.now() - cached.at < SECTIONS_TTL_MS) return cached.urls;
  const urls = [];
  for (const entry of monitor.sections) {
    let level = [entry.url];
    for (const re of entry.discover || []) {
      const next = [];
      for (const u of level) {
        const subs = await ayby.discoverSubsections(page, u, re).catch((err) => { console.warn(`  [Sections] ${u}: ${err.message}`); failed(err); return []; });
        next.push(...subs.map((s) => s.href));
        await jitter(600);
      }
      level = next;
    }
    urls.push(...level);
  }
  const unique = [...new Set(urls)];
  sectionCache.set(monitor.key, { at: Date.now(), urls: unique });
  console.log(`  [Sections] ${monitor.name}: ${unique.length} подразделов`);
  return unique;
}

function priceStr(n) {
  return n != null ? `${n} р.` : 'Цена не указана';
}

function listingFromCard(card, city) {
  return { id: card.id, title: card.title, price: priceStr(card.price), url: card.url, photos: card.thumb ? [card.thumb] : [], location: city || null, params: null };
}

function fmtDate(d) {
  return new Date(d).toLocaleString('ru-BY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function timeLeftStr(endsAt) {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return 'завершается';
  const d = Math.floor(ms / 86400e3), h = Math.floor((ms % 86400e3) / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
  return d ? `${d} дн. ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
}

// Конец торгов ночью по Минску (23:00–8:00): ставок под конец меньше всего
function endsAtNight(endsAt) {
  if (!endsAt) return false;
  const h = (new Date(endsAt).getUTCHours() + 3) % 24;
  return h >= 23 || h < 8;
}

// Когда решать: фиксированная цена — сразу (можно купить); чистый аукцион — за AUCTION_NOTIFY_HOURS до конца,
// когда ставка уже близка к итоговой; за QUIET_HOURS — только проверка на тихий лот; никогда — если не подходит
// (не тот металл, копия, подборка, слаб по фиксированной цене, монитор только собирает цены, торги закончились).
// Сама отправка дополнительно требует выгоды (est.isBargain) или тихого лота (cmarket.quietLot).
function notifyTiming(monitor, parsed, lot) {
  if (!worthNotifying(monitor, parsed, lot)) return 'never';
  if (lot.saleType === 'auction') {
    const hoursLeft = lot.endsAt ? (new Date(lot.endsAt).getTime() - Date.now()) / 3600e3 : Infinity;
    if (hoursLeft <= AUCTION_NOTIFY_HOURS) return 'now';
    return hoursLeft <= QUIET_HOURS ? 'quiet' : 'closing';
  }
  return 'now';
}

// Оценка лота (coins/assess.js: архивы, Numista, наша база, металл); сохраняется в базе
async function assessLot(listingId, parsed, price, saleType = null, text = {}) {
  const est = await assessCoin({ parsed, price, excludeId: listingId, fixedPrice: saleType === 'buy_now', title: text.title, description: text.description });
  await cstore.saveEstimate(listingId, est).catch((err) => console.warn(`  [Estimate] save failed: ${err.message}`));
  return est;
}

// «🔁 Перевыставлен: 09.11 — 4 ставки до 50 р., мин. цена не пройдена; 02.11 — без ставок, старт 60 р.»
// rounds — прошлые раунды лота (cstore.relistLot), последние два, свежий первым
const bidsWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'ставка' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'ставки' : 'ставок');
function roundsLine(rounds) {
  if (!rounds || !rounds.length) return null;
  const parts = rounds.slice(-2).reverse().map((r) => {
    const when = r.ended_at ? new Date(r.ended_at).toLocaleDateString('ru-BY', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Minsk' }) : '?';
    const bids = r.final_bids ?? r.bids ?? 0;
    const last = r.final_price ?? r.last_price;
    if (r.outcome === 'sold') return `${when} — продан за ${priceStr(last)} (видимо, не выкупили)`;
    const what = bids ? `${bids} ${bidsWord(bids)}${last != null ? ` до ${priceStr(last)}` : ''}` : `без ставок${r.start_price != null ? `, старт ${priceStr(r.start_price)}` : ''}`;
    return `${when} — ${what}${r.reserve === 'not_met' ? ', мин. цена не пройдена' : ''}`;
  });
  return `🔁 Перевыставлен${rounds.length > 1 ? ` (${rounds.length}-й раз)` : ''}: ${parts.join('; ')}`;
}

function buildCaption(monitor, lot, parsed, closing = false, est = null, fav = null, quiet = null) {
  const saleLabel = { auction: 'аукцион', buy_now: 'купить сейчас', auction_buynow: 'аукцион + купить сейчас' }[lot.saleType] || '';
  const priceLine = lot.saleType === 'buy_now'
    ? `💰 ${priceStr(lot.price)}${lot.bargain ? ' · возможен торг' : ''}`
    : `💰 ${lot.bids ? 'ставка' : 'старт'} ${priceStr(lot.price)}${lot.bids ? ` · ${lot.bids} ${lot.bids === 1 ? 'ставка' : lot.bids < 5 ? 'ставки' : 'ставок'}` : ''}`;
  const coin = [parsed.denomination, parsed.year, parsed.mintmaster || parsed.mint || (parsed.foreign && parsed.foreign.mint), parsed.foreign && parsed.foreign.state, parsed.ruler,
    parsed.metal === 'silver' ? 'серебро' : parsed.metal === 'gold' ? 'золото' : parsed.metal === 'copper' ? 'медь' : null].filter(Boolean).join(' · ');
  const grade = parsed.conditionCode
    ? `🏷 Состояние по ay.by: ${parsed.conditionCode} (${parsed.grade})${parsed.titleGrade && parsed.titleGrade !== parsed.grade ? `, продавец пишет ${parsed.titleGrade}` : ''}`
    : parsed.titleGrade ? `🏷 Состояние (из заголовка): ${parsed.titleGrade}` : null;
  const s = parsed.slab;
  const slabLine = s ? `🏛 Слаб${s.company ? ` ${s.company}` : ''} ${s.grade || 'без грейда в заголовке'}${s.details ? ' (details: чистка или повреждения)' : ''}` : null;
  const quietLine = quiet
    ? `🤫 Тихий лот: ${lot.bids ? `${lot.bids} ставка` : 'ставок нет'}${parsed.noReserve ? ', без МЦ' : ''}${endsAtNight(lot.endsAt) ? ', заканчивается ночью' : ''}. `
      + `Разумный максимум ≈ ${priceStr(quiet.max)} (ориентир ${priceStr(Math.round(quiet.ref))} минус ${cmarket.BARGAIN_PCT}%)`
    : null;
  const lowRating = lot.sellerRating != null && lot.sellerRating < LOW_RATING;
  const sellerLine = lot.seller
    ? `👤 ${lot.seller}${lot.sellerRating != null ? `, рейтинг ${lot.sellerRating}` : ''}${lowRating ? ` — ⚠️ мало отзывов, выше риск подделки${s ? ' (слабы тоже подделывают)' : ''}` : ''}`
    : null;
  const head = quiet ? '🤫 Тихий лот' : closing ? '🔔 Торги заканчиваются' : 'ay.by';
  const lines = [
    `<b>${monitor.emoji || ''} ${head} — ${monitor.name}</b>`,
    lot.title || 'Без названия',
    priceLine + (saleLabel ? ` · ${saleLabel}` : ''),
    lot.endsAt ? `⏳ до ${fmtDate(lot.endsAt)} (${timeLeftStr(lot.endsAt)})` : null,
    roundsLine(lot.rounds),
    grade,
    slabLine,
    coin ? `🔎 ${coin}` : null,
    parsed.flags.length ? `⚠️ ${parsed.flags.join(', ')}` : null,
    ...cmarket.formatEstimateLines(est),
    quietLine,
    sellerLine,
    lot.sellerCity ? `📍 ${lot.sellerCity}` : null,
    fav ? (fav.ok ? '⭐ Добавлено в избранное ay.by' : `⭐ В избранное не добавлено: ${fav.note}`) : null,
    favorites.enabled() && /auction/.test(lot.saleType || '') ? `✍️ Ответьте числом — максимальная ставка, бот поставит её за ${SNIPE_SECONDS} с до конца` : null,
    `<a href="${lot.url}">Открыть лот</a>`,
  ].filter(Boolean);
  return lines.join('\n');
}

// Выгодный лот: сначала в избранное аккаунта ay.by (если настроено), потом карточка подписчикам
async function addToFavorites(listingId, lot) {
  if (!favorites.enabled()) return null;
  const fav = await favorites.add(lot.url, lot.externalId);
  if (fav.ok) await cstore.markFavorited(listingId).catch(() => {});
  console.log(`  [Favorites] [${lot.externalId}] ${fav.ok ? 'в избранном' : 'не добавлен'}: ${fav.note}`);
  return fav;
}

async function notifyLot(monitor, listingId, lot, parsed, closing = false, est = null, quiet = null) {
  await cstore.markNotified(listingId).catch(() => {}); // даже без получателей второй раз не шлём
  // тот же лот ведёт и другой монитор (раздел и страница продавца) — карточка уже ушла оттуда
  if (await cstore.notifiedElsewhere(lot.externalId, monitor.key).catch(() => false)) {
    console.log(`  [${monitor.name}] [${lot.externalId}] уже отправлен другим монитором`);
    return 0;
  }
  const fav = await addToFavorites(listingId, lot);
  const targets = await tg.resolveRecipients(monitor);
  if (!tg.isConfigured() || !targets.length) return 0;
  lot.rounds = await cstore.lotRounds(listingId).catch(() => []);
  const caption = buildCaption(monitor, lot, parsed, closing, est, fav, quiet);
  let sent = 0;
  for (const chatId of targets) {
    const msgId = await tg.sendCard(chatId, caption, lot.photos || []);
    if (msgId) { sent++; await store.saveNotification(listingId, chatId, msgId).catch(() => {}); }
  }
  return sent;
}

// Решение по лоту, страницу которого только что прочитали: уведомить (выгодно или тихий лот), подождать
// (аукцион ещё далеко от конца) или закрыть (не подходит / не выгодно — больше не рассматриваем).
// «Минимальная цена не пройдена» при выгодной ставке — ждём: когда ставки пройдут минимум, лот может остаться выгодным.
async function considerLot(monitor, listingId, lot, parsed, { closing = false } = {}) {
  const timing = notifyTiming(monitor, parsed, lot);
  if (timing === 'never') { await cstore.markNotified(listingId).catch(() => {}); return { action: 'skip' }; }
  if (timing === 'closing') return { action: 'wait' };
  const est = await assessLot(listingId, parsed, lot.price, lot.saleType, { title: lot.title, description: lot.description });
  const quiet = cmarket.quietLot(est, lot);
  const reserveBlocks = lot.reserve === 'not_met';
  if (quiet || (timing === 'now' && est.isBargain && !reserveBlocks)) {
    const sent = await notifyLot(monitor, listingId, lot, parsed, closing, est, quiet);
    return { action: quiet ? 'quiet' : 'bargain', sent, est, quiet };
  }
  if (timing === 'quiet') { await cstore.markQuietChecked(listingId).catch(() => {}); return { action: 'wait', est }; }
  if (est.isBargain && reserveBlocks) return { action: 'wait', est, reserveBlocks }; // перепроверим в следующем цикле
  // аукцион с «купить сейчас» решается сразу, но под конец ещё может стать тихим лотом — не закрываем до окна
  // (в окне тихих лотов — один раз, дальше до последних AUCTION_NOTIFY_HOURS ждёт)
  const hoursLeft = lot.endsAt ? (new Date(lot.endsAt).getTime() - Date.now()) / 3600e3 : 0;
  if (lot.saleType === 'auction_buynow' && hoursLeft > AUCTION_NOTIFY_HOURS) {
    if (hoursLeft <= QUIET_HOURS) await cstore.markQuietChecked(listingId).catch(() => {});
    return { action: 'wait', est };
  }
  await cstore.markNotified(listingId).catch(() => {});
  return { action: 'rejected', est, reserveBlocks };
}

function logDecision(monitor, id, lot, parsed, r) {
  const head = `  [${monitor.name}]`;
  const what = `[${id}] ${lot.title} — ${priceStr(lot.price)}`;
  if (r.action === 'bargain') console.log(`${head} BARGAIN: ${what} · ${parsed.slab ? `слаб ${parsed.slab.grade}` : parsed.grade || '?'} · ${r.est.deviationPct}% к ${r.est.referenceSource} → ${r.sent} чат(ов)`);
  else if (r.action === 'quiet') console.log(`${head} QUIET: ${what} · ${lot.bids} ставок · ориентир ${Math.round(r.quiet.ref)} (${r.quiet.refSource}), максимум ${r.quiet.max} → ${r.sent} чат(ов)`);
  else if (r.action === 'rejected') console.log(`${head} stored: ${what} · ${parsed.grade || '?'} · ${r.reserveBlocks ? 'минимальная цена не пройдена' : r.est.deviationPct == null ? 'нет ориентира' : r.est.deviationPct + '%'}`);
  else if (r.action === 'wait' && r.reserveBlocks) console.log(`${head} wait: ${what} · выгодно, но минимальная цена не пройдена — перепроверим`);
  else if (r.action === 'wait' && lot.endsAt) console.log(`${head} auction, notify ≤${AUCTION_NOTIFY_HOURS}h before end${r.est ? ' (не тихий)' : ''}: ${what} (${timeLeftStr(lot.endsAt)})`);
}

// Аукционы, до конца которых осталось ≤ AUCTION_NOTIFY_HOURS (и ≤ QUIET_HOURS — проверка на тихий лот):
// обновить ставку и решить один раз
async function notifyClosingSoon(page, monitor) {
  const rows = await cstore.lotsClosingSoon(monitor.key, AUCTION_NOTIFY_HOURS, QUIET_HOURS, CLOSING_BATCH);
  if (!rows.length) return;
  let sent = 0;
  for (const row of rows) {
    try {
      const r = await fetchAndSave(page, row.id, row.url, row.section, { monitorKey: monitor.key, externalId: row.external_id });
      ok();
      if (r.gone) { await finalizeGone(row, 'before closing'); continue; }
      if (r.lot.ended) continue; // итог запишет finalizeEnded
      const d = await considerLot(monitor, row.id, r.lot, r.parsed, { closing: true });
      if (d.sent) sent++;
      if (d.action === 'bargain' || d.action === 'quiet') logDecision(monitor, row.external_id, r.lot, r.parsed, d);
    } catch (err) {
      console.warn(`  [Closing] ${row.url}: ${err.message}`);
      failed(err);
    }
    await next(page);
  }
  console.log(`  [Closing] ${monitor.name}: проверено ${rows.length}, уведомлений ${sent}`);
}

// Монета подходит монитору: металл из monitor.metals (['silver'] / ['gold']), страна по пути раздела лота
// (monitor.countries — регулярки; нужен для сквозных разделов вроде «Золото», где рядом лежат соверены и лиры)
function matchesMonitor(monitor, parsed, categoryPath = null) {
  if (!parsed) return false;
  if (monitor.metals && !monitor.metals.includes(parsed.metal)) return false;
  if (monitor.countries && !monitor.countries.some((re) => re.test(categoryPath || ''))) return false;
  return true;
}

// Стоит ли уведомлять: монитор не только собирает цены, металл подходит, нет препятствий parse.notifyBlocker
// (копия, подборка без веса, слаб по фиксированной цене), торги идут
function worthNotifying(monitor, parsed, lot) {
  if (lot.ended || monitor.notify === false) return false;
  if (!matchesMonitor(monitor, parsed, lot.categoryPath)) return false;
  return !notifyBlocker(parsed, lot.saleType);
}

// Страница лота → лот и разбор монеты (без записи в базу)
async function fetchParsed(page, url, sectionPath, externalId = null) {
  const lot = await ayby.fetchLot(page, url);
  if (lot.gone) return { gone: true };
  lot.url = url;
  lot.externalId = externalId || (url.match(/-(\d+)\.html/) || [null, null])[1];
  const parsed = parseCoin({ title: lot.title, sectionPath: lot.categoryPath || sectionPath, conditionText: lot.conditionText, description: lot.description, specs: lot.specs });
  return { gone: false, lot, parsed };
}

async function saveFetched(listingId, monitorKey, lot, parsed) {
  await cstore.saveLotDetails(listingId, lot, parsed);
  if (lot.sellerId) await cstore.upsertUser({ id: lot.sellerId, nick: lot.seller, rating: lot.sellerRating }, { checked: false }).catch(() => {});
  // цена со страницы точнее карточки → снапшот
  await store.saveListing(monitorKey, { id: lot.externalId, title: lot.title, price: priceStr(lot.price), url: lot.url, photos: lot.photos, location: lot.sellerCity, params: null });
}

async function fetchAndSave(page, listingId, url, sectionPath, extras = {}) {
  const r = await fetchParsed(page, url, sectionPath, extras.externalId);
  if (!r.gone) await saveFetched(listingId, extras.monitorKey, r.lot, r.parsed);
  return r;
}

// Страница раздела с сортировкой «Новые» (по умолчанию ay.by сортирует «Актуальные», и свежий лот мог не попасть
// в первые страницы). Сквозные разделы — topic.phtml?f=1&ti1=6, у них уже есть «?».
function listUrl(section, pageNo = 1) {
  const sep = section.includes('?') ? '&' : '?';
  return `${section}${sep}order=create${pageNo > 1 ? `&page=${pageNo}` : ''}`;
}

// Карточка списка нужна монитору: заголовок подходит под titleFilter; у мониторов с cardMetals — металл из metals
// (строка карточки «Серебро, 1799» — поле «Металл» лота; нет — разбор заголовка) и не копия
function cardWanted(monitor, card) {
  if (monitor.titleFilter && !monitor.titleFilter.test(card.title || '')) return false;
  if (!monitor.cardMetals) return true;
  const p = parseCoin({ title: card.title, sectionPath: null, specs: card.short ? { 'Металл': card.short } : {} });
  return monitor.metals.includes(p.metal) && !p.flags.includes('копия');
}

// Страница списка с кэшем на LIST_CACHE_MS: серебро и золото читают одни и те же разделы
const listCache = new Map();
async function loadList(page, url) {
  const hit = listCache.get(url);
  if (hit && Date.now() - hit.at < LIST_CACHE_MS) return hit.cards;
  const cards = await ayby.scanListPage(page, url);
  for (const [u, v] of listCache) if (Date.now() - v.at >= LIST_CACHE_MS) listCache.delete(u);
  listCache.set(url, { at: Date.now(), cards });
  return cards;
}

// Откуда монитор берёт карточки: разделы (страницы 1…pages, сначала новые) или страницы продавцов (все страницы
// по 100 лотов, до SELLER_MAX_PAGES; короче 100 — последняя). load(i) — карточки i-й страницы (с нуля).
async function cardSources(page, monitor, pages) {
  if (monitor.sellers) {
    return monitor.sellers.map((s) => ({
      section: `https://ay.by/whoiswho.phtml?id=${s.id}&show=auction_active`,
      maxPages: SELLER_MAX_PAGES, pageSize: ayby.SELLER_PAGE_SIZE,
      load: (i) => ayby.scanSellerPage(page, s.id, i + 1),
    }));
  }
  const sections = await resolveSections(page, monitor);
  return sections.map((section) => ({ section, maxPages: pages, pageSize: null, load: (i) => loadList(page, listUrl(section, i + 1)) }));
}

// owners — external_id → мониторы, которые уже ведут лот (cstore.knownOwners); дополняется найденными за цикл.
// Лот, который ведут два монитора (раздел и страница продавца), каждый оценивает по своим правилам,
// а карточка уходит один раз (notifyLot → notifiedElsewhere)
async function scanMonitor(page, monitor, isFirstRun, owners = new Map()) {
  const isMine = (id) => Boolean(owners.get(id) && owners.get(id).has(monitor.key));
  const knownCount = [...owners.values()].filter((s) => s.has(monitor.key)).length;
  const seeding = isFirstRun && knownCount === 0;
  const pages = seeding ? SEED_PAGES : (monitor.pages || PAGES);
  const fresh = [];
  let seen = 0, skipped = 0;

  for (const src of await cardSources(page, monitor, pages)) {
    for (let i = 0; i < src.maxPages; i++) {
      let cards;
      try { cards = await src.load(i); ok(); } catch (err) { console.warn(`  [Scan] ${src.section}: ${err.message}`); failed(err); break; }
      if (!cards.length) { if (i === 0) console.warn(`  [Scan] ${src.section}: карточек нет — раздел пуст или другая разметка (проверить: node debug-ayby.js "${src.section}")`); break; }
      for (const card of cards) {
        seen++;
        if (!cardWanted(monitor, card)) { skipped++; continue; }
        const relisted = isMine(card.id) && await relistIfEnded(card, monitor.key);
        const { listingId } = await store.saveListing(monitor.key, listingFromCard(card));
        await cstore.upsertCard(listingId, monitor, src.section, card);
        if (relisted) fresh.push({ listingId, card, section: src.section });
        else if (!isMine(card.id)) {
          if (!owners.has(card.id)) owners.set(card.id, new Set());
          owners.get(card.id).add(monitor.key);
          fresh.push({ listingId, card, section: src.section });
        }
      }
      await next(page); // лента не ждёт, пока прочитаются все разделы
      if (src.pageSize && cards.length < src.pageSize) break; // последняя страница продавца
    }
  }
  console.log(`  [${monitor.name}] просмотрено ${seen} карточек${skipped ? ` (не подошли — металл, копия или фильтр заголовка: ${skipped})` : ''}, новых ${fresh.length}${seeding ? ' (засев, без уведомлений)' : ''}`);
  if (seeding) return;

  let notified = 0, matched = 0;
  for (const { listingId, card, section } of fresh.slice(0, DETAIL_BATCH)) {
    try {
      const r = await fetchAndSave(page, listingId, card.url, section, { monitorKey: monitor.key, externalId: card.id });
      ok();
      if (r.gone) { await cstore.recordOutcome(listingId, { outcome: 'removed', statusText: '404 at first fetch' }); continue; }
      if (matchesMonitor(monitor, r.parsed, r.lot.categoryPath)) matched++;
      const d = await considerLot(monitor, listingId, r.lot, r.parsed);
      if (d.sent) notified++;
      logDecision(monitor, card.id, r.lot, r.parsed, d);
    } catch (err) {
      console.warn(`  [${monitor.name}] lot ${card.url}: ${err.message}`);
      failed(err);
    }
    await next(page);
  }
  console.log(`  [${monitor.name}] подробности: ${Math.min(fresh.length, DETAIL_BATCH)}, подходящих ${matched}, уведомлений ${notified}`);
}

// Лоты, которые дочитаны, но ни разу не оценены: засев первого запуска и дочитка (backfillDetails) читают страницу без
// решения, цикл мог прерваться на таймаутах ay.by. Оценка — по данным базы, без загрузки страницы; страница
// перечитывается и решение принимается как обычно (considerLot) только у тех, кто выглядит выгодным или тихим.
// «Купить сейчас» без выгоды закрывается, аукционы дальше ждут проверки под конец торгов (notifyClosingSoon).
async function assessPending(page, monitor) {
  const rows = await cstore.lotsToAssess(monitor.key, ASSESS_BATCH);
  if (!rows.length) return;
  let assessed = 0, skipped = 0, candidates = 0, sent = 0;
  for (const row of rows) {
    const specs = row.specs || {};
    const parsed = parseCoin({ title: row.title, sectionPath: row.category_path, conditionText: specs['Состояние'] || null, description: row.description, specs });
    const lot = { ended: false, saleType: row.sale_type, categoryPath: row.category_path, bids: row.bids || 0, reserve: row.reserve,
      endsAt: row.ends_at, price: row.current_price == null ? null : Number(row.current_price) };
    if (!worthNotifying(monitor, parsed, lot)) { await cstore.markNotified(row.id).catch(() => {}); skipped++; continue; }
    const est = await assessLot(row.id, parsed, lot.price, lot.saleType, { title: row.title, description: row.description });
    assessed++;
    if (!est.isBargain && !cmarket.quietLot(est, lot)) {
      if (lot.saleType === 'buy_now') await cstore.markNotified(row.id).catch(() => {});
      continue;
    }
    candidates++;
    try {
      const r = await fetchAndSave(page, row.id, row.url, row.section, { monitorKey: monitor.key, externalId: row.external_id });
      ok();
      if (r.gone || r.lot.ended) continue;
      const d = await considerLot(monitor, row.id, r.lot, r.parsed);
      if (d.sent) sent++;
      logDecision(monitor, row.external_id, r.lot, r.parsed, d);
    } catch (err) {
      console.warn(`  [Assess] ${row.url}: ${err.message}`);
      failed(err);
    }
    await next(page);
  }
  console.log(`  [Assess] ${monitor.name}: неоценённых ${rows.length} — оценено ${assessed}, не подходят ${skipped}, кандидатов ${candidates}, уведомлений ${sent}`);
}

async function backfillDetails(page, monitor) {
  const rows = await cstore.lotsWithoutDetails(monitor.key, BACKFILL_BATCH);
  if (!rows.length) return;
  let done = 0, gone = 0;
  for (const row of rows) {
    try {
      const r = await fetchAndSave(page, row.id, row.url, row.section, { monitorKey: monitor.key, externalId: row.external_id });
      ok();
      if (r.gone) { await cstore.recordOutcome(row.id, { outcome: 'removed', statusText: '404 at backfill' }); gone++; } else done++;
    } catch (err) {
      console.warn(`  [Backfill] ${row.url}: ${err.message}`);
      failed(err);
    }
    await next(page);
  }
  console.log(`  [Backfill] ${monitor.name}: дочитано ${done}, исчезло ${gone}, осталось ≥ ${rows.length - done - gone}`);
}

// Стоит ли хранить фото лота: монитор хранит фото, подходит монитору, не копия, не подборка (лот на вес — можно),
// есть ставки (лот будет продан). Слабы — тоже: правило о фиксированной цене к фото не относится.
function worthPhotos(monitor, parsed, bids) {
  if (monitor.photos === false || !(bids > 0)) return false;
  if (!matchesMonitor(monitor, parsed)) return false;
  return !notifyBlocker(parsed, 'auction');
}

// За PRECLOSE_MIN минут до конца: перечитать ставку (это и будет итог, если страница потом пропадёт) и сохранить фото
async function refreshClosing(page, monitor) {
  const rows = await cstore.lotsClosingWithin(monitor.key, PRECLOSE_MIN, PRECLOSE_STALE_MIN, PRECLOSE_BATCH);
  if (!rows.length) return;
  let refreshed = 0, withPhotos = 0, gone = 0;
  for (const row of rows) {
    try {
      const lot = await ayby.fetchLot(page, row.url);
      ok();
      if (lot.gone) { await finalizeGone(row, 'закрылся раньше срока'); gone++; continue; }
      await cstore.touchEndsAt(row.id, lot.ended ? null : lot.endsAt, lot.price, lot.bids);
      refreshed++;
      const parsed = typeof row.parsed === 'string' ? JSON.parse(row.parsed) : row.parsed;
      if (worthPhotos(monitor, parsed, lot.bids) && !(row.photo_files && row.photo_files.length)) {
        const files = await photos.saveLotPhotos(row.external_id, lot.photos && lot.photos.length ? lot.photos : row.photos || [], row.photo_files);
        if (files.length) { await cstore.savePhotoFiles(row.id, files); withPhotos++; }
      }
    } catch (err) {
      console.warn(`  [Preclose] ${row.url}: ${err.message}`);
      failed(err);
    }
    await next(page);
  }
  console.log(`  [Preclose] ${monitor.name}: обновлено ${refreshed}, с фото ${withPhotos}, пропало ${gone}`);
}

// Страница лота пропала (404): итог по последней увиденной ставке
async function finalizeGone(row, note) {
  const bids = row.bids || 0;
  const price = parseFloat(row.current_price);
  if (bids > 0 && price > 0) {
    await cstore.recordOutcome(row.id, { outcome: 'sold', finalPrice: price, finalBids: bids, approx: true, statusText: `404 after end (${note}); last bid ${price}` });
    return 'sold';
  }
  await cstore.recordOutcome(row.id, { outcome: 'unsold', finalBids: 0, approx: true, statusText: `404 after end (${note}); no bids seen` });
  return 'unsold';
}

// Итог торгов по странице завершённого лота (если она ещё открывается): по статусу/ставкам.
function decideOutcome(row, lot) {
  if (lot.sold) return 'sold';
  const st = (lot.statusText || '').toLowerCase();
  if (/не продан|без ставок|снят|отменён|отменен/.test(st)) return 'unsold';
  if (/продан|куплен/.test(st)) return 'sold';
  if ((lot.bids || row.bids || 0) > 0) return 'sold';
  return 'unsold';
}

async function finalizeEnded(page, monitor) {
  const rows = await cstore.lotsToFinalize(monitor.key, FINALIZE_GRACE_MIN, FINALIZE_BATCH);
  if (!rows.length) return;
  let sold = 0, unsold = 0, approx = 0, extended = 0;
  for (const row of rows) {
    try {
      const lot = await ayby.fetchLot(page, row.url);
      ok();
      if (lot.gone) {
        const o = await finalizeGone(row, 'page gone');
        approx++;
        if (o === 'sold') { sold++; console.log(`  [Ended] SOLD≈: [${row.external_id}] ${row.title} — ${priceStr(row.current_price)} (${row.bids} ставок, по последней ставке)`); } else unsold++;
        continue;
      }
      if (!lot.ended) { await cstore.touchEndsAt(row.id, lot.endsAt, lot.price, lot.bids); extended++; continue; }
      const outcome = decideOutcome(row, lot);
      await cstore.recordOutcome(row.id, {
        outcome, finalPrice: outcome === 'sold' ? (lot.finalPrice ?? lot.price) : null, finalBids: lot.bids, endedAt: lot.endedAt,
        statusText: `${lot.httpStatus !== 200 ? `HTTP ${lot.httpStatus}; ` : ''}${lot.statusText || lot.endsText || ''}`.slice(0, 300),
        winner: outcome === 'sold' ? lot.winner : null, winnerId: outcome === 'sold' ? lot.winnerId : null,
      });
      if (outcome === 'sold') {
        sold++;
        if (lot.winnerId) await cstore.upsertUser({ id: lot.winnerId, nick: lot.winner }, { checked: false }).catch(() => {});
        console.log(`  [Ended] SOLD: [${row.external_id}] ${row.title} — ${priceStr(lot.finalPrice ?? lot.price)} (${lot.bids} ставок${lot.winner ? `, победитель ${lot.winner}` : ''})`);
        if (worthPhotos(monitor, row.parsed, lot.bids) && !(row.photo_files && row.photo_files.length)) {
          const files = await photos.saveLotPhotos(row.external_id, lot.photos || [], row.photo_files);
          if (files.length) await cstore.savePhotoFiles(row.id, files);
        }
      } else unsold++;
    } catch (err) {
      console.warn(`  [Ended] ${row.url}: ${err.message}`);
      failed(err);
    }
    await next(page);
  }
  console.log(`  [Ended] ${monitor.name}: продано ${sold}, не продано ${unsold} (из них по последней ставке ${approx}), продлено ${extended}`);
}

// Рейтинг победителей торгов — кто забирает лоты (профи с рейтингом 1000+ или новички): профиль раз в 30 дней,
// не больше USER_LOOKUPS за цикл. Отчёт — node coin-funnel.js
async function refreshWinners(page) {
  const ids = await cstore.winnersToRefresh(USER_LOOKUPS).catch((err) => { console.warn(`  [Users] ${err.message}`); return []; });
  let done = 0;
  for (const id of ids) {
    try {
      const u = await ayby.fetchUser(page, id);
      ok();
      await cstore.upsertUser(u || { id }); // нет профиля — тоже отметка, чтобы не спрашивать каждый цикл
      if (u) done++;
    } catch (err) {
      console.warn(`  [Users] ${id}: ${err.message}`);
      failed(err);
    }
    await next(page);
  }
  if (ids.length) console.log(`  [Users] профилей победителей прочитано ${done} из ${ids.length}`);
}

// Папка с фото в пределах лимита: лишнее удаляется (сначала непроданные, потом старые), база синхронизируется
async function tidyPhotos() {
  try {
    const keep = await cstore.photoKeepIds();
    const r = photos.enforceLimit(keep);
    if (r.removed) {
      await cstore.clearPhotoFiles([...r.removedIds]);
      console.log(`  [Photos] лимит ${photos.MAX_MB} МБ: удалено ${r.removed} файлов, занято ${(r.bytes / 1048576).toFixed(0)} МБ`);
    }
  } catch (err) {
    console.warn(`  [Photos] tidy failed: ${err.message}`);
  }
}

// ---- Глубокий проход: все страницы разделов мониторов с deep: true ----
// По DEEP_PAGES страниц за цикл, с того места, где остановились; карточки, подходящие монитору (cardWanted) и ещё
// не известные, сохраняются без страницы лота — их дочитывает backfillDetails (сначала те, что кончаются раньше),
// оценивает assessPending. Круг пройден — следующий через DEEP_EVERY_MS. Курсор в памяти: после перезапуска — заново.
const deep = { urls: null, i: 0, pageNo: 1, doneAt: 0, found: 0, lastFirst: null };
async function deepScan(page) {
  const deepMons = monitors.filter((m) => m.deep);
  if (!deepMons.length || (deep.doneAt && Date.now() - deep.doneAt < DEEP_EVERY_MS)) return;
  if (!deep.urls) {
    deep.urls = [...new Set(deepMons.flatMap((m) => m.sections.map((s) => s.url)))];
    Object.assign(deep, { i: 0, pageNo: 1, found: 0 });
    console.log(`  [Глубокий] начат круг: ${deep.urls.length} разделов`);
  }
  let read = 0;
  while (read < DEEP_PAGES && deep.i < deep.urls.length) {
    const section = deep.urls[deep.i];
    const cards = await loadList(page, listUrl(section, deep.pageNo)).catch((err) => { failed(err); throw err; });
    ok();
    read++;
    // за последней страницей ay.by снова отдаёт последнюю (page=5000 → 221): повтор первой карточки — конец раздела
    if (!cards.length || cards[0].id === deep.lastFirst) { deep.i++; deep.pageNo = 1; deep.lastFirst = null; continue; }
    deep.lastFirst = cards[0].id;
    for (const card of cards) {
      for (const monitor of deepMons) {
        const owned = Boolean(owners.get(card.id) && owners.get(card.id).has(monitor.key));
        if (owned && !(ended.get(card.id) && ended.get(card.id).has(monitor.key))) continue;
        if (!cardWanted(monitor, card)) continue;
        if (owned && !(await relistIfEnded(card, monitor.key))) continue; // перевыставлен — дочитает backfillDetails
        const { listingId } = await store.saveListing(monitor.key, listingFromCard(card));
        await cstore.upsertCard(listingId, monitor, section, card);
        if (!owners.has(card.id)) owners.set(card.id, new Set());
        owners.get(card.id).add(monitor.key);
        deep.found++;
      }
    }
    // последняя страница раздела короче полной (≈100 карточек) — дальше пусто
    if (cards.length < 50) { deep.i++; deep.pageNo = 1; deep.lastFirst = null; } else deep.pageNo++;
    await next(page); // 40 страниц — несколько минут: свежие лоты из ленты всё это время в приоритете
  }
  const where = deep.i < deep.urls.length ? `${deep.urls[deep.i].replace('https://coins.ay.by/', '')} стр. ${deep.pageNo}` : 'конец';
  console.log(`  [Глубокий] прочитано страниц ${read}, найдено новых лотов за круг ${deep.found}; сейчас: ${where}`);
  if (deep.i >= deep.urls.length) {
    console.log(`  [Глубокий] круг пройден: новых лотов ${deep.found}, они дочитываются в «дочитке»`);
    Object.assign(deep, { urls: null, doneAt: Date.now() });
  }
}

// ---- Лента новых лотов ----
// owners — external_id → мониторы, которые уже ведут лот: общая для цикла и ленты (обновляется в начале цикла)
let owners = null;
// Перевыставленные лоты: ay.by перевыставляет непроданный лот с тем же номером. Карточка в списке, а в базе итог
// прошлого раунда — прошлый раунд в rounds (карточка покажет «🔁 Перевыставлен…»), лот ведётся заново.
// ended — external_id → Map(monitor_key → listing_id), обновляется в начале цикла вместе с owners.
let ended = new Map();
let relistWarned = false;
async function relistIfEnded(card, monitorKey) {
  const byMonitor = ended.get(card.id);
  const listingId = byMonitor && byMonitor.get(monitorKey);
  if (!listingId) return false;
  byMonitor.delete(monitorKey);
  const ok = await cstore.relistLot(listingId, card).catch((err) => {
    if (!relistWarned) { relistWarned = true; console.warn(`  [Перевыставлен] ${err.message} (применить migrations/016_coin_rounds.sql)`); }
    return false;
  });
  if (ok) console.log(`  [Перевыставлен] [${card.id}] ${card.title} — снова в продаже, ведём заново`);
  return ok;
}
const feedSeen = new Map(); // id карточки → когда лента её разобрала (подошла или нет), чтобы не открывать снова
let lastFeedAt = 0;
let feedBusy = false;

// Карточка ленты, которую стоит открыть: в заголовке серебро/золото/проба/унция (или разбор заголовка даёт металл),
// либо продавец из монитора sellers (ник в карточке «maybach - 888 99.8%»)
const FEED_HINT = /серебр|золот|(?<!\p{L})(?:ag|au)\s*\d{3}|(?<![\d.,])(?:999|925|900|875|835|800|750|585|583)\s*(?:проб|пр\.|°)|унци|(?<!\p{L})oz(?!\p{L})|билон/iu;
const feedMonitors = () => monitors.filter((m) => m.notify !== false && (m.feed || m.sellers));
const sellerNicks = () => new Set(feedMonitors().flatMap((m) => (m.sellers || []).map((s) => s.nick.toLowerCase())));

function feedCandidate(card, nicks) {
  const nick = ayby.authorNick(card.author);
  if (nick && nicks.has(nick.toLowerCase())) return true;
  if (parseCoin({ title: card.title, sectionPath: null }).flags.includes('не монета')) return false;
  if (FEED_HINT.test(card.title || '') || /серебр|золот/i.test(card.short || '')) return true;
  return parseCoin({ title: card.title, sectionPath: null }).isPrecious;
}

// Каким мониторам нужен лот со страницы: продавец из списка sellers или монитор с feed: true, которому подходит
// монета (металл, страна по пути раздела)
function feedOwners(lot, parsed) {
  return feedMonitors().filter((m) => (m.sellers ? m.sellers.some((s) => s.id === lot.sellerId) : matchesMonitor(m, parsed, lot.categoryPath)));
}

async function scanFeed(page) {
  if (!owners) {
    owners = await cstore.knownOwners(monitors.map((m) => m.key));
    ended = await cstore.endedLots(monitors.map((m) => m.key)).catch(() => new Map());
  }
  const now = Date.now();
  for (const [id, at] of feedSeen) if (now - at > FEED_SEEN_TTL_MS) feedSeen.delete(id);
  const nicks = sellerNicks();
  const todo = [];
  let seen = 0;
  for (let i = 0; i < FEED_PAGES && todo.length < FEED_DETAIL_MAX; i++) {
    let cards;
    try { cards = await ayby.scanListPage(page, i ? `${FEED_URL}&page=${i + 1}` : FEED_URL); ok(); } catch (err) { console.warn(`  [Лента] ${err.message}`); failed(err); return; }
    if (!cards.length) break;
    let unknown = 0;
    for (const card of cards) {
      seen++;
      if (feedSeen.has(card.id) || (owners.has(card.id) && !(ended.get(card.id) && ended.get(card.id).size))) continue;
      unknown++;
      // кандидат помечается, когда его откроют: не влезший в FEED_DETAIL_MAX остаётся на следующий проход
      if (feedCandidate(card, nicks)) todo.push(card); else feedSeen.set(card.id, now);
    }
    if (!unknown) break; // дальше только уже разобранные
    await jitter(600);
  }
  let notified = 0, taken = 0;
  for (const card of todo.slice(0, FEED_DETAIL_MAX)) {
    feedSeen.set(card.id, now);
    try {
      const r = await fetchParsed(page, card.url, null, card.id);
      ok();
      if (r.gone) continue;
      for (const monitor of feedOwners(r.lot, r.parsed)) {
        if (owners.get(card.id) && owners.get(card.id).has(monitor.key) && !(await relistIfEnded(card, monitor.key))) continue;
        const { listingId } = await store.saveListing(monitor.key, listingFromCard(card));
        await cstore.upsertCard(listingId, monitor, FEED_URL, card);
        await saveFetched(listingId, monitor.key, r.lot, r.parsed);
        if (!owners.has(card.id)) owners.set(card.id, new Set());
        owners.get(card.id).add(monitor.key);
        taken++;
        const d = await considerLot(monitor, listingId, r.lot, r.parsed);
        if (d.sent) notified++;
        logDecision(monitor, card.id, r.lot, r.parsed, d);
      }
    } catch (err) {
      console.warn(`  [Лента] lot ${card.url}: ${err.message}`);
      failed(err);
    }
    await jitter(700);
  }
  console.log(`  [Лента] карточек ${seen}, открыто ${Math.min(todo.length, FEED_DETAIL_MAX)}, взято мониторами ${taken}, уведомлений ${notified}`);
}

// Пора ли пройти ленту: вызывается между лотами длинного цикла (тем же браузером) и по таймеру между циклами
async function feedCheckpoint(page) {
  if (!FEED_INTERVAL_MS || feedBusy || Date.now() - lastFeedAt < FEED_INTERVAL_MS || !feedMonitors().length) return;
  feedBusy = true;
  lastFeedAt = Date.now();
  try { await scanFeed(page); } finally { feedBusy = false; }
}

// Пауза между страницами лотов в цикле + лента, если подошло её время
async function next(page) {
  await jitter(900);
  await feedCheckpoint(page);
}

// Между циклами: свой короткий браузер (цикл свой закрывает в конце)
let feedTickRunning = false;
async function feedTick() {
  if (running || feedTickRunning || feedBusy || !FEED_INTERVAL_MS || Date.now() - lastFeedAt < FEED_INTERVAL_MS) return;
  feedTickRunning = true;
  strikes = 0;
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext({ userAgent: USER_AGENT, locale: 'ru-BY' })).newPage();
    await favorites.open(browser).catch((err) => console.warn(`  [Favorites] контекст аккаунта не открыт: ${err.message}`));
    console.log(`[${ts()}] Coins: лента новых лотов`);
    await feedCheckpoint(page);
  } catch (err) {
    console.error('  [Лента] Error:', err.message);
  } finally {
    await favorites.close();
    if (browser) await browser.close();
    feedTickRunning = false;
  }
}

// История продаж: отзывы покупателей и продавцов наших проданных лотов → ссылки на их другие сделки за ~60 дней →
// страницы проданных лотов. В базу попадают продажи серебра и золота, которые шли до запуска мониторов или мимо них
// (металл только в поле «Металл», лот выкуплен до прохода ленты). Уведомлений по ним нет: итог записывается сразу.
function historyCandidate(title) {
  const p = parseCoin({ title, sectionPath: null });
  if (p.flags.includes('не монета') || p.flags.includes('копия')) return false;
  return p.isPrecious || FEED_HINT.test(title || '');
}

async function readFeedback(page, userId) {
  let found = 0, queued = 0;
  try {
    for (const tab of ['buyer_all', 'seller_all']) {
      // страница без ссылок — ещё не конец: у продавца, скрывающего завершённые лоты, ссылок нет, а дальше идут
      // сделки с другими. Конец — три такие страницы подряд (старше 60 дней ссылок нет ни у кого) или неполная страница
      for (let n = 1, empty = 0; n <= HISTORY_PAGES && empty < 3; n++) {
        const r = await ayby.scanFeedback(page, userId, tab, n);
        ok();
        empty = r.deals.length ? 0 : empty + 1;
        found += r.deals.length;
        queued += await cstore.queueHistory(r.deals.filter((d) => !owners.has(d.id) && historyCandidate(d.title)));
        if (r.entries < 10) break;
        await next(page);
      }
    }
  } catch (err) {
    // ay.by ограничивает — пользователь остаётся непрочитанным; другая ошибка — отмечаем, иначе он будет первым
    // в каждом цикле и до остальных очередь не дойдёт (уже найденные сделки стоят в очереди)
    if (ayby.isBlocked(err) || /^HTTP \d/.test(err.message)) throw err;
    console.warn(`  [История] отзывы ${userId}: ${err.message}`);
  }
  await cstore.markHistoryRead(userId);
  return { found, queued };
}

async function saveHistoryLot(page, row) {
  if (owners.has(row.external_id)) return 'known';
  const r = await fetchParsed(page, row.url, null, row.external_id);
  ok();
  if (r.gone) return 'gone';
  const { lot, parsed } = r;
  if (!lot.ended) return 'active'; // перевыставлен и снова идёт — его ведут мониторы
  if (!lot.sold) return 'unsold';
  if (lot.categoryPath ? !/монет/i.test(lot.categoryPath) : !(parsed.denomination && parsed.year)) return 'not_coin';
  const takers = monitors.filter((m) => m.feed && matchesMonitor(m, parsed, lot.categoryPath) && !parsed.flags.includes('копия'));
  if (!takers.length) return 'other_metal';
  const card = { id: row.external_id, title: lot.title, price: lot.price, url: row.url, thumb: (lot.photos || [])[0] || null, bids: lot.bids, endsAt: null };
  for (const monitor of takers) {
    const { listingId } = await store.saveListing(monitor.key, listingFromCard(card));
    await cstore.upsertCard(listingId, monitor, 'history', card);
    await saveFetched(listingId, monitor.key, lot, parsed);
    await cstore.recordOutcome(listingId, {
      outcome: 'sold', finalPrice: lot.finalPrice ?? lot.price, finalBids: lot.bids, endedAt: lot.endedAt || row.deal_date || null,
      statusText: `история (отзывы); ${lot.statusText || ''}`.slice(0, 300), winner: lot.winner, winnerId: lot.winnerId,
    });
    // лот увидели после торгов: дата появления — дата продажи (иначе отчёты по first_seen считают его новым),
    // стартовая цена неизвестна (карточка несла уже итоговую)
    await cstore.markHistoryLot(listingId, lot.endedAt || row.deal_date || null);
    if (worthPhotos(monitor, parsed, Math.max(lot.bids || 0, 1))) {
      const files = await photos.saveLotPhotos(row.external_id, lot.photos || [], null);
      if (files.length) await cstore.savePhotoFiles(listingId, files);
    }
    if (!owners.has(row.external_id)) owners.set(row.external_id, new Set());
    owners.get(row.external_id).add(monitor.key);
  }
  if (lot.winnerId) await cstore.upsertUser({ id: lot.winnerId, nick: lot.winner }, { checked: false }).catch(() => {});
  return 'saved';
}

let historyWarned = false;
async function collectHistory(page) {
  if (!HISTORY_LOTS) return;
  let pending;
  try { pending = await cstore.historyPending(); } catch (err) {
    if (!historyWarned) { historyWarned = true; console.warn(`  [История] ${err.message} (применить migrations/017_coin_history.sql)`); }
    return;
  }
  // отзывы читаем, только когда очередь лотов почти разобрана
  if (pending < HISTORY_LOTS) {
    for (const id of await cstore.historyUsers(HISTORY_USERS)) {
      try {
        const r = await readFeedback(page, id);
        console.log(`  [История] отзывы ${id}: сделок со ссылкой ${r.found}, в очередь ${r.queued}`);
      } catch (err) { console.warn(`  [История] отзывы ${id}: ${err.message}`); failed(err); }
    }
  }
  const counts = {};
  for (const row of await cstore.historyQueue(HISTORY_LOTS)) {
    let result;
    try { result = await saveHistoryLot(page, row); } catch (err) {
      console.warn(`  [История] ${row.url}: ${err.message}`);
      failed(err); // ay.by ограничивает (подряд) — выходим, лот остаётся в очереди
      result = row.result === 'error' ? 'failed' : 'error'; // 'error' — ещё одна попытка через 6 часов (historyQueue)
    }
    await cstore.historyDone(row.external_id, result);
    counts[result] = (counts[result] || 0) + 1;
    await next(page);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total) console.log(`  [История] лотов ${total}: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}; в очереди ещё ${Math.max(0, pending - total)}`);
}

async function cycle(isFirstRun) {
  console.log(`[${ts()}] Coins: checking...`);
  strikes = 0;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ru-BY' });
    const page = await context.newPage();
    await favorites.open(browser).catch((err) => console.warn(`  [Favorites] контекст аккаунта не открыт: ${err.message}`));
    owners = await cstore.knownOwners(monitors.map((m) => m.key));
    ended = await cstore.endedLots(monitors.map((m) => m.key)).catch((err) => { console.warn(`  [Перевыставлен] ${err.message}`); return new Map(); });
    for (const monitor of monitors) {
      // шаги независимы: «ay.by не отвечает (3 подряд)» на скане раздела не должно отменять проверку аукционов под
      // конец, итоги торгов и оценку уже прочитанных лотов (раньше весь монитор пропускался до следующего цикла)
      const steps = [
        ['лента', () => feedCheckpoint(page)],
        ['раздел', () => scanMonitor(page, monitor, isFirstRun, owners)],
        ['ставки под конец', () => refreshClosing(page, monitor)],
        ['итоги', () => finalizeEnded(page, monitor)],
        ['аукционы под конец', () => (monitor.notify !== false ? notifyClosingSoon(page, monitor) : null)],
        ['оценка неоценённых', () => (monitor.notify !== false ? assessPending(page, monitor) : null)],
        ['дочитка', () => backfillDetails(page, monitor)],
      ];
      for (const [name, step] of steps) {
        try { await step(); } catch (err) { console.error(`  [${monitor.name}] ${name}: ${err.message}`); }
      }
    }
    try { await deepScan(page); } catch (err) { console.error('  [Глубокий] Error:', err.message); }
    try { await refreshWinners(page); } catch (err) { console.error('  [Users] Error:', err.message); }
    try { await collectHistory(page); } catch (err) { console.error('  [История] Error:', err.message); }
  } finally {
    await favorites.close();
    await browser.close();
  }
  await tidyPhotos();
}

let running = false;
async function tick(isFirstRun) {
  if (running) { console.log('  previous cycle still running, skipping'); return; }
  running = true;
  try {
    while (feedTickRunning) await pause(1000); // лента между циклами заканчивается за минуту-две
    await cycle(isFirstRun);
  } catch (err) { console.error('Cycle error:', err); } finally { running = false; }
}

async function main() {
  if (!monitors.length) { console.error('No monitors with source="ayby" in config.js'); process.exit(1); }
  console.log(`Coins monitor started. Monitors: ${monitors.map((m) => `${m.name}${m.notify === false ? ' [сбор цен]' : ''}`).join(', ')}. Interval: ${INTERVAL_MS / 1000}s${FEED_INTERVAL_MS ? `, лента новых — раз в ${FEED_INTERVAL_MS / 1000}s` : ''}`);
  await tick(true);
  setInterval(() => tick(false), INTERVAL_MS);
  if (FEED_INTERVAL_MS) setInterval(() => { feedTick().catch(() => {}); }, 30e3);
}

if (require.main === module) main();
module.exports = { buildCaption, roundsLine, cardWanted, decideOutcome, worthNotifying, worthPhotos, notifyTiming, matchesMonitor, assessLot, considerLot, endsAtNight, listUrl, feedCandidate, feedOwners, historyCandidate, AUCTION_NOTIFY_HOURS, PRECLOSE_MIN };
