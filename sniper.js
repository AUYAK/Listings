// Снайп-ставки ay.by (pm2: coins-sniper). Заявки создаёт poll.js по ответу на карточку лота числом
// (listings.coin_bids). Этот процесс раз в POLL_MS берёт заявки, торги по которым заканчиваются в ближайшие
// LEAD_MIN минут, открывает лот под аккаунтом AYBY_LOGIN, ждёт по таймеру лота и за SNIPE_SECONDS до конца
// ставит максимум. После окончания читает итог и отчитывается в Telegram.
// Запуск: node sniper.js. Нужна миграция 014 и сессия ay.by (node ayby-login.js), желательно AYBY_NICK в .env.
require('dotenv').config();
const { chromium } = require('playwright');
const cstore = require('./coins/store');
const favorites = require('./coins/favorites');
const bid = require('./coins/bid');
const tg = require('./telegram');

const POLL_MS = parseInt(process.env.SNIPE_POLL_MS || '15000', 10);
const LEAD_MIN = parseInt(process.env.SNIPE_LEAD_MIN || '6', 10);      // за сколько минут брать заявку в работу
const SNIPE = bid.SNIPE_SECONDS;                                        // за сколько секунд до конца подтверждать ставку
const PREP = SNIPE + 25;                                                // за сколько секунд открыть подтверждение
const NICK = (process.env.AYBY_NICK || favorites.savedNick() || '').trim(); // из .env или из файла сессии (ayby-login.js)
const ts = () => new Date().toLocaleString('ru-BY');
const log = (msg) => console.log(`[${ts()}] [Sniper] ${msg}`);

let browser = null;
const inflight = new Map(); // listing_id → promise

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
    await favorites.open(browser);
  }
  return browser;
}

async function releaseBrowser() {
  if (inflight.size || !browser) return;
  await favorites.close();
  await browser.close().catch(() => {});
  browser = null;
}

async function say(chatId, text) {
  if (!tg.isConfigured()) return;
  await tg.telegramRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

const lotLink = (row) => `<a href="${row.url}">${row.title || row.external_id}</a>`;

// ждать до момента at (ms epoch), просыпаясь не реже чем раз в step мс
async function sleepUntil(at, step = 1000) {
  while (Date.now() < at) await bid.pause(Math.min(step, Math.max(0, at - Date.now())));
}

// Итог торгов после окончания: страница может отдавать 404 первые минуты — несколько попыток
async function readOutcome(page, row) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const st = await bid.openLot(page, row.url);
      if (st.hasLot && st.ended) return st;
    } catch (err) {
      log(`[${row.external_id}] итог: ${err.message}`);
    }
    await bid.pause(30000);
  }
  return null;
}

async function report(row, st) {
  let text;
  let status = 'lost';
  if (!st) {
    text = `🏁 ${lotLink(row)}: торги закончились, итог прочитать не удалось (страница недоступна). Проверьте «Мои аукционы» на ay.by.`;
  } else if (st.soldText) {
    const mine = NICK && st.winner && st.winner.toLowerCase() === NICK.toLowerCase();
    if (mine) status = 'won';
    text = `🏁 ${lotLink(row)}: продан за <b>${bid.fmt(st.price)}</b>, победитель ${st.winner || '?'}${mine ? ' — <b>это вы</b> ✅' : NICK ? ' — не вы ❌' : ' (укажите AYBY_NICK в .env, чтобы бот узнавал вас)'}`;
  } else {
    text = `🏁 ${lotLink(row)}: торги закончились без продажи${st.reserveNotMet ? ' (минимальная цена продавца не пройдена)' : ''}`;
  }
  await cstore.updateBid(row.listing_id, { status, note: st ? (st.soldText || st.unsoldText || 'итог без продажи') : 'итог не прочитан', reportedAt: new Date() });
  await say(row.chat_id, text);
  log(`[${row.external_id}] ${status}: ${text.replace(/<[^>]+>/g, '')}`);
}

async function fail(row, note) {
  await cstore.updateBid(row.listing_id, { status: 'failed', note });
  await say(row.chat_id, `❌ ${lotLink(row)}: ставка не поставлена — ${note}`);
  log(`[${row.external_id}] failed: ${note}`);
}

async function snipe(row) {
  const max = Number(row.max_byn);
  log(`[${row.external_id}] в работе: максимум ${bid.fmt(max)}, конец ${row.ends_at ? new Date(row.ends_at).toLocaleString('ru-BY') : '?'}`);
  await cstore.updateBid(row.listing_id, { status: 'running' });
  let page;
  try {
    await getBrowser();
    page = await favorites.newPage();
    let st = await bid.openLot(page, row.url);
    if (!st.hasLot) throw new Error(`страница лота недоступна (HTTP ${st.httpStatus})`);
    if (st.ended) { await report(row, st); return; }
    if (st.minBid != null && st.minBid > max) { await fail(row, `минимальная ставка уже ${bid.fmt(st.minBid)}, ваш максимум ${bid.fmt(max)}`); return; }
    let deadline = Date.now() + st.remaining * 1000;
    await cstore.touchEndsAt(row.listing_id, new Date(deadline), st.price, st.bids).catch(() => {});
    log(`[${row.external_id}] до конца ${st.remaining} с, цена ${bid.fmt(st.price)}, мин. ставка ${st.minBid != null ? bid.fmt(st.minBid) : '?'}`);

    // ждём момента подготовки, обновляя страницу не реже раза в 2 минуты (точный таймер, свежая цена)
    while (deadline - Date.now() > PREP * 1000) {
      await sleepUntil(Math.min(deadline - PREP * 1000, Date.now() + 120000));
      if (deadline - Date.now() > PREP * 1000 + 5000) {
        st = await bid.openLot(page, row.url);
        if (st.ended) { await report(row, st); return; }
        deadline = Date.now() + st.remaining * 1000;
      }
    }
    st = await bid.openLot(page, row.url);
    if (st.ended) { await report(row, st); return; }
    deadline = Date.now() + st.remaining * 1000;
    if (st.minBid != null && st.minBid > max) { await fail(row, `минимальная ставка уже ${bid.fmt(st.minBid)}, ваш максимум ${bid.fmt(max)}`); return; }
    if (!st.hasBidButton) { await fail(row, 'на странице нет кнопки «Сделать ставку»'); return; }

    const r = await bid.placeBid(page, max, { beforeConfirm: () => sleepUntil(deadline - SNIPE * 1000, 200) });
    const left = Math.round((deadline - r.clickedAt.getTime()) / 1000);
    await favorites.saveSession();
    if (!r.ok) { await fail(row, `${r.state.errorText || 'перенаправило на вход'} (за ${left} с до конца)`); return; }
    const note = `ставка ${bid.fmt(max)} за ${left} с до конца; цена после ставки ${bid.fmt(r.state.price)}${r.state.yours ? ', лидируем' : ''}`;
    await cstore.updateBid(row.listing_id, { status: 'placed', note, placedPrice: r.state.price, placedAt: r.clickedAt });
    await say(row.chat_id, `✅ ${lotLink(row)}: ставка до <b>${bid.fmt(max)}</b> поставлена за ${left} с до конца. Цена сейчас ${bid.fmt(r.state.price)}${r.state.yours ? ', вы лидируете' : ''}.`);
    log(`[${row.external_id}] placed: ${note}`);

    await sleepUntil(deadline + 20000, 5000);
    await report(row, await readOutcome(page, row));
  } catch (err) {
    await fail(row, err.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function tick() {
  let rows;
  try { rows = await cstore.bidsDue(LEAD_MIN); } catch (err) { log(`db: ${err.message}`); return; }
  for (const row of rows) {
    if (inflight.has(row.listing_id)) continue;
    const p = snipe(row).catch((err) => log(`[${row.external_id}] ${err.message}`)).finally(async () => { inflight.delete(row.listing_id); await releaseBrowser(); });
    inflight.set(row.listing_id, p);
  }
}

async function main() {
  if (!favorites.enabled()) { console.error('нет сессии ay.by: выполните node ayby-login.js (или задайте AYBY_LOGIN / AYBY_PASSWORD в .env)'); process.exit(1); }
  log(`started: ставка за ${SNIPE} с до конца, заявки берутся за ${LEAD_MIN} мин, опрос каждые ${POLL_MS / 1000} с${NICK ? `, ник ${NICK}` : ', AYBY_NICK не задан'}`);
  await tick();
  setInterval(tick, POLL_MS);
}

if (require.main === module) main();
module.exports = { snipe, tick };
