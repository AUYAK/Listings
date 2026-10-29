// Сборщик аукционных лотов ay.by для мониторов с source='ayby' (монеты).
// Цикл: разделы → новые карточки → страницы новых лотов (состояние, тип продажи, срок) → уведомления
// подписчикам → дочитывание старых лотов порциями → фиксация итогов по истёкшим лотам.
// Запуск: node coins.js (pm2: coins-monitor). Нужна миграция 011.
require('dotenv').config();
const { chromium } = require('playwright');
const store = require('./store');
const cstore = require('./coins/store');
const ayby = require('./coins/ayby');
const { parseCoin } = require('./coins/parse');
const cmarket = require('./coins/market');
const numista = require('./coins/numista');
const photos = require('./coins/photos');
const tg = require('./telegram');
const { MONITORS } = require('./config');

const INTERVAL_MS = parseInt(process.env.COINS_INTERVAL_MS || '600000', 10); // 10 минут
const PAGES = parseInt(process.env.COINS_PAGES || '3', 10);                  // страниц раздела за цикл
const SEED_PAGES = parseInt(process.env.COINS_SEED_PAGES || '8', 10);        // при первом запуске
const DETAIL_BATCH = 40;      // страниц новых лотов за цикл
const BACKFILL_BATCH = 20;    // страниц старых лотов без подробностей за цикл
const FINALIZE_BATCH = 30;    // истёкших лотов за цикл
const FINALIZE_GRACE_MIN = 10;
const AUCTION_NOTIFY_HOURS = parseFloat(process.env.COINS_AUCTION_NOTIFY_HOURS || '12'); // чистые аукционы — только под конец
const CLOSING_BATCH = 30;
// Страница лота после окончания торгов отдаёт 404 (проверено на 102 лотах), поэтому последнюю ставку и фото
// снимаем за PRECLOSE_MIN минут до конца; итог по 404 = последняя увиденная ставка (final_approx).
const PRECLOSE_MIN = parseInt(process.env.COINS_PRECLOSE_MIN || '40', 10);
const PRECLOSE_STALE_MIN = 15;
const PRECLOSE_BATCH = 40;
const SECTIONS_TTL_MS = 24 * 3600e3;

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

// Когда слать: фиксированная цена — сразу (можно купить); чистый аукцион — за AUCTION_NOTIFY_HOURS до конца,
// когда ставка уже близка к итоговой; никогда — если не подходит (не серебро, копия, подборка, закончился).
// Сама отправка дополнительно требует выгоды: est.isBargain (на BARGAIN_PCT ниже каталога/нашей оценки).
function notifyTiming(monitor, parsed, lot) {
  if (!worthNotifying(monitor, parsed, lot)) return 'never';
  if (lot.saleType === 'auction') {
    const hoursLeft = lot.endsAt ? (new Date(lot.endsAt).getTime() - Date.now()) / 3600e3 : Infinity;
    return hoursLeft <= AUCTION_NOTIFY_HOURS ? 'now' : 'closing';
  }
  return 'now';
}

// Оценка лота: каталог (Numista, если есть ключ) + наша медиана по похожим; сохраняется в базе
let rowsCache = { at: 0, rows: [] };
async function assessLot(listingId, parsed, price) {
  if (Date.now() - rowsCache.at > 5 * 60e3) rowsCache = { at: Date.now(), rows: await cstore.getCoinRows(null) };
  // источники показываются в карточке раздельно; ориентир для «выгодно» — архив проходов (load-catalog.js),
  // иначе Numista (если есть ключ), иначе наша медиана по похожим лотам
  const { catalogs, type } = await cstore.getCatalogs(parsed).catch((err) => { console.warn(`[Catalog] ${err.message}`); return { catalogs: [], type: null }; });
  if (parsed.isSilver && !catalogs.some((c) => c.source === 'numista')) {
    const n = await numista.lookup(parsed).catch((err) => { console.warn(`[Numista] ${err.message}`); return null; });
    if (n) catalogs.push(n);
  }
  const est = cmarket.assess({ parsed, price, rows: rowsCache.rows, excludeId: listingId, catalogs, coinType: type });
  await cstore.saveEstimate(listingId, est).catch((err) => console.warn(`  [Estimate] save failed: ${err.message}`));
  return est;
}

function buildCaption(monitor, lot, parsed, closing = false, est = null) {
  const saleLabel = { auction: 'аукцион', buy_now: 'купить сейчас', auction_buynow: 'аукцион + купить сейчас' }[lot.saleType] || '';
  const priceLine = lot.saleType === 'buy_now'
    ? `💰 ${priceStr(lot.price)}${lot.bargain ? ' · возможен торг' : ''}`
    : `💰 ${lot.bids ? 'ставка' : 'старт'} ${priceStr(lot.price)}${lot.bids ? ` · ${lot.bids} ${lot.bids === 1 ? 'ставка' : lot.bids < 5 ? 'ставки' : 'ставок'}` : ''}`;
  const coin = [parsed.denomination, parsed.year, parsed.mintmaster || parsed.mint, parsed.ruler, parsed.metal === 'silver' ? 'серебро' : parsed.metal === 'gold' ? 'золото' : parsed.metal === 'copper' ? 'медь' : null].filter(Boolean).join(' · ');
  const grade = parsed.conditionCode
    ? `🏷 Состояние по ay.by: ${parsed.conditionCode} (${parsed.grade})${parsed.titleGrade && parsed.titleGrade !== parsed.grade ? `, продавец пишет ${parsed.titleGrade}` : ''}`
    : parsed.titleGrade ? `🏷 Состояние (из заголовка): ${parsed.titleGrade}` : null;
  const lines = [
    `<b>${monitor.emoji || ''} ${closing ? '🔔 Торги заканчиваются' : 'ay.by'} — ${monitor.name}</b>`,
    lot.title || 'Без названия',
    priceLine + (saleLabel ? ` · ${saleLabel}` : ''),
    lot.endsAt ? `⏳ до ${fmtDate(lot.endsAt)} (${timeLeftStr(lot.endsAt)})` : null,
    grade,
    coin ? `🔎 ${coin}` : null,
    parsed.flags.length ? `⚠️ ${parsed.flags.join(', ')}` : null,
    ...cmarket.formatEstimateLines(est),
    lot.sellerCity ? `📍 ${lot.sellerCity}` : null,
    `<a href="${lot.url}">Открыть лот</a>`,
  ].filter(Boolean);
  return lines.join('\n');
}

async function notifyLot(monitor, listingId, lot, parsed, closing = false, est = null) {
  await cstore.markNotified(listingId).catch(() => {}); // даже без получателей второй раз не шлём
  const targets = await tg.resolveRecipients(monitor);
  if (!tg.isConfigured() || !targets.length) return 0;
  const caption = buildCaption(monitor, lot, parsed, closing, est);
  let sent = 0;
  for (const chatId of targets) {
    const msgId = await tg.sendCard(chatId, caption, lot.photos || []);
    if (msgId) { sent++; await store.saveNotification(listingId, chatId, msgId).catch(() => {}); }
  }
  return sent;
}

// Аукционы, до конца которых осталось ≤ AUCTION_NOTIFY_HOURS: обновить ставку и уведомить один раз
async function notifyClosingSoon(page, monitor) {
  const rows = await cstore.lotsClosingSoon(monitor.key, AUCTION_NOTIFY_HOURS, CLOSING_BATCH);
  if (!rows.length) return;
  let sent = 0;
  for (const row of rows) {
    try {
      const r = await fetchAndSave(page, row.id, row.url, row.section, { monitorKey: monitor.key, externalId: row.external_id });
      ok();
      if (r.gone) { await finalizeGone(row, 'before closing'); continue; }
      if (r.lot.ended) continue; // итог запишет finalizeEnded
      if (notifyTiming(monitor, r.parsed, r.lot) === 'now') {
        const est = await assessLot(row.id, r.parsed, r.lot.price);
        if (est.isBargain) {
          const n = await notifyLot(monitor, row.id, r.lot, r.parsed, true, est);
          if (n) sent++;
          console.log(`  [${monitor.name}] CLOSING: [${row.external_id}] ${r.lot.title} — ${priceStr(r.lot.price)} · ${r.lot.bids} ставок · ${est.deviationPct}% → ${n} чат(ов)`);
        } else {
          await cstore.markNotified(row.id); // не выгодно по текущей ставке — больше не рассматриваем
        }
      } else {
        await cstore.markNotified(row.id); // не подходит под фильтр — больше не рассматриваем
      }
    } catch (err) {
      console.warn(`  [Closing] ${row.url}: ${err.message}`);
      failed(err);
    }
    await jitter(900);
  }
  console.log(`  [Closing] ${monitor.name}: проверено ${rows.length}, уведомлений ${sent}`);
}

// Стоит ли уведомлять: серебро (если монитор только про серебро), не копия, не подборка, торги идут
function worthNotifying(monitor, parsed, lot) {
  if (lot.ended) return false;
  if (monitor.silverOnly && !parsed.isSilver) return false;
  if (parsed.flags.includes('копия') || parsed.flags.includes('несколько монет')) return false;
  return true;
}

async function fetchAndSave(page, listingId, url, sectionPath, extras = {}) {
  const lot = await ayby.fetchLot(page, url);
  if (lot.gone) return { gone: true };
  lot.url = url;
  const parsed = parseCoin({ title: lot.title, sectionPath: lot.categoryPath || sectionPath, conditionText: lot.conditionText, description: lot.description, specs: lot.specs });
  await cstore.saveLotDetails(listingId, lot, parsed);
  // цена со страницы точнее карточки → снапшот
  await store.saveListing(extras.monitorKey, { id: extras.externalId, title: lot.title, price: priceStr(lot.price), url, photos: lot.photos, location: lot.sellerCity, params: null });
  return { gone: false, lot, parsed };
}

async function scanMonitor(page, monitor, isFirstRun) {
  const sections = await resolveSections(page, monitor);
  const known = await store.loadKnownIds(monitor.key);
  const seeding = isFirstRun && known.size === 0;
  const pages = seeding ? SEED_PAGES : PAGES;
  const fresh = [];
  let seen = 0;

  for (const section of sections) {
    for (let p = 1; p <= pages; p++) {
      const url = p === 1 ? section : `${section}?page=${p}`;
      let cards;
      try { cards = await ayby.scanListPage(page, url); ok(); } catch (err) { console.warn(`  [Scan] ${url}: ${err.message}`); failed(err); break; }
      if (!cards.length) break;
      for (const card of cards) {
        seen++;
        const { listingId } = await store.saveListing(monitor.key, listingFromCard(card));
        await cstore.upsertCard(listingId, monitor, section, card);
        if (!known.has(card.id)) { known.add(card.id); fresh.push({ listingId, card, section }); }
      }
      await jitter(800);
    }
  }
  console.log(`  [${monitor.name}] просмотрено ${seen} карточек, новых ${fresh.length}${seeding ? ' (засев, без уведомлений)' : ''}`);
  if (seeding) return;

  let notified = 0, silver = 0;
  for (const { listingId, card, section } of fresh.slice(0, DETAIL_BATCH)) {
    try {
      const r = await fetchAndSave(page, listingId, card.url, section, { monitorKey: monitor.key, externalId: card.id });
      ok();
      if (r.gone) { await cstore.recordOutcome(listingId, { outcome: 'removed', statusText: '404 at first fetch' }); continue; }
      if (r.parsed.isSilver) silver++;
      const timing = notifyTiming(monitor, r.parsed, r.lot);
      if (timing === 'now') {
        const est = await assessLot(listingId, r.parsed, r.lot.price);
        if (est.isBargain) {
          const n = await notifyLot(monitor, listingId, r.lot, r.parsed, false, est);
          if (n) notified++;
          console.log(`  [${monitor.name}] BARGAIN: [${card.id}] ${r.lot.title} — ${priceStr(r.lot.price)} · ${r.parsed.grade || '?'} · ${est.deviationPct}% к ${est.referenceSource} → ${n} чат(ов)`);
        } else {
          await cstore.markNotified(listingId).catch(() => {});
          console.log(`  [${monitor.name}] stored: [${card.id}] ${r.lot.title} — ${priceStr(r.lot.price)} · ${r.parsed.grade || '?'} · ${est.deviationPct == null ? 'нет ориентира' : est.deviationPct + '%'}`);
        }
      } else if (timing === 'closing') {
        console.log(`  [${monitor.name}] auction, notify ≤${AUCTION_NOTIFY_HOURS}h before end: [${card.id}] ${r.lot.title} (${timeLeftStr(r.lot.endsAt)})`);
      } else {
        await cstore.markNotified(listingId).catch(() => {}); // не подходит — не рассматривать повторно
      }
    } catch (err) {
      console.warn(`  [${monitor.name}] lot ${card.url}: ${err.message}`);
      failed(err);
    }
    await jitter(900);
  }
  console.log(`  [${monitor.name}] подробности: ${Math.min(fresh.length, DETAIL_BATCH)}, серебро ${silver}, уведомлений ${notified}`);
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
    await jitter(900);
  }
  console.log(`  [Backfill] ${monitor.name}: дочитано ${done}, исчезло ${gone}, осталось ≥ ${rows.length - done - gone}`);
}

// Стоит ли хранить фото лота: серебро, не копия, не подборка, есть ставки (то есть лот будет продан)
function worthPhotos(monitor, parsed, bids) {
  if (!(bids > 0)) return false;
  if (monitor.silverOnly && !(parsed && parsed.isSilver)) return false;
  return !(parsed && parsed.flags && (parsed.flags.includes('копия') || parsed.flags.includes('несколько монет')));
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
    await jitter(900);
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
      });
      if (outcome === 'sold') {
        sold++;
        console.log(`  [Ended] SOLD: [${row.external_id}] ${row.title} — ${priceStr(lot.finalPrice ?? lot.price)} (${lot.bids} ставок)`);
        if (worthPhotos(monitor, row.parsed, lot.bids) && !(row.photo_files && row.photo_files.length)) {
          const files = await photos.saveLotPhotos(row.external_id, lot.photos || [], row.photo_files);
          if (files.length) await cstore.savePhotoFiles(row.id, files);
        }
      } else unsold++;
    } catch (err) {
      console.warn(`  [Ended] ${row.url}: ${err.message}`);
      failed(err);
    }
    await jitter(900);
  }
  console.log(`  [Ended] ${monitor.name}: продано ${sold}, не продано ${unsold} (из них по последней ставке ${approx}), продлено ${extended}`);
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

async function cycle(isFirstRun) {
  console.log(`[${ts()}] Coins: checking...`);
  strikes = 0;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ru-BY' });
    const page = await context.newPage();
    for (const monitor of monitors) {
      try {
        await scanMonitor(page, monitor, isFirstRun);
        await refreshClosing(page, monitor);   // сначала то, что вот-вот закончится
        await finalizeEnded(page, monitor);
        await notifyClosingSoon(page, monitor);
        await backfillDetails(page, monitor);
      } catch (err) {
        console.error(`  [${monitor.name}] Error:`, err.message);
      }
    }
  } finally {
    await browser.close();
  }
  await tidyPhotos();
}

let running = false;
async function tick(isFirstRun) {
  if (running) { console.log('  previous cycle still running, skipping'); return; }
  running = true;
  try { await cycle(isFirstRun); } catch (err) { console.error('Cycle error:', err); } finally { running = false; }
}

async function main() {
  if (!monitors.length) { console.error('No monitors with source="ayby" in config.js'); process.exit(1); }
  console.log(`Coins monitor started. Monitors: ${monitors.map((m) => m.name).join(', ')}. Interval: ${INTERVAL_MS / 1000}s`);
  await tick(true);
  setInterval(() => tick(false), INTERVAL_MS);
}

if (require.main === module) main();
module.exports = { buildCaption, decideOutcome, worthNotifying, worthPhotos, notifyTiming, assessLot, AUCTION_NOTIFY_HOURS, PRECLOSE_MIN };
