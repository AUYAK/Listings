// Единственный отладочный скрипт ay.by (запускать на сервере, с ноутбука ay.by отдаёт проверку на бота):
//   node debug-ayby.js <url раздела>              карточки списка нашим сканером (coins/ayby.js scanListPage)
//   node debug-ayby.js <url лота>                 страница лота: HTTP, заголовок, что вытащил fetchLot
//   node debug-ayby.js <url лота> --bid 2250      под аккаунтом (ayby-session.json): состояние лота, форма ставки,
//                                                 заполнить сумму и открыть подтверждение, НЕ подтверждать
//   node debug-ayby.js <url лота> --bid 2250 --confirm   реально поставить (сумма — ваш максимум!)
// Если страница разобралась плохо — HTML сохраняется в ./debug/.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ayby = require('./coins/ayby');
const fav = require('./coins/favorites');
const bid = require('./coins/bid');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const args = process.argv.slice(2);
const url = args.find((a) => /^https?:/.test(a));
const bi = args.indexOf('--bid');
const amount = bi >= 0 ? parseFloat(String(args[bi + 1]).replace(',', '.')) : null;
const confirm = args.includes('--confirm');
if (!url) { console.error('usage: node debug-ayby.js <url> [--bid N [--confirm]]'); process.exit(1); }

function dump(name, html) {
  fs.mkdirSync('debug', { recursive: true });
  const file = path.join('debug', `${name}-${Date.now()}.html`);
  fs.writeFileSync(file, html);
  console.log(`  HTML сохранён в ${file}`);
}

async function listPage(page) {
  const cards = await ayby.scanListPage(page, url);
  console.log(`карточек: ${cards.length}; title: ${await page.title()}`);
  for (const c of cards.slice(0, 8)) console.log(`  ${c.id} | ${c.title} | ${c.price} р. | ставок ${c.bids ?? '—'} | ${c.endsAt ? new Date(c.endsAt).toISOString().slice(0, 16) : ''}`);
  if (!cards.length) dump('list', await page.content());
}

async function lotPage(page) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ayby.NAV_TIMEOUT });
  console.log(`HTTP ${resp ? resp.status() : '?'} · title: ${await page.title()}`);
  await page.waitForSelector('.b-lot-title__title, .b-lot-control', { timeout: 10000 }).catch(() => {});
  console.log(`text: ${await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600))}`);
  try {
    const { specs, description, photos, ...rest } = await ayby.fetchLot(page, url);
    console.log('fetchLot →', JSON.stringify({ ...rest, photos: (photos || []).length, specs }, null, 1));
  } catch (err) {
    console.log(`fetchLot error: ${err.message}`);
    dump('lot', await page.content());
  }
}

async function bidDryRun(browser) {
  if (!fav.enabled()) { console.error('нет сессии ay.by: node ayby-login.js (см. README)'); process.exitCode = 1; return; }
  await fav.open(browser);
  let page;
  try {
    page = await fav.newPage();
    console.log('вход: ок');
    const st = await bid.openLot(page, url);
    console.log(`лот: HTTP ${st.httpStatus}, до конца ${st.remaining} с, цена ${st.price}, мин. ставка ${st.minBid}, ставок ${st.bids}, закончен ${st.ended}, кнопка ставки ${st.hasBidButton}, резерв не пройден ${st.reserveNotMet}, наша ставка ${st.yours}`);
    console.log(`поля формы: ${JSON.stringify(st.inputs)}`);
    if (!st.hasBidButton) { dump('lot', await page.content()); return; }
    console.log(`\n== ставка ${amount} (${confirm ? 'С ПОДТВЕРЖДЕНИЕМ' : 'без подтверждения'})`);
    const r = await bid.placeBid(page, amount, { confirm });
    console.log(`  сумма в поле: ${r.value}\n  текст подтверждения: ${r.consent || '(не найден)'}`);
    if (confirm) {
      console.log(`  результат: ok=${r.ok}, цена ${r.state.price}, ставок ${r.state.bids}, наша ${r.state.yours}, ошибка ${r.state.errorText || 'нет'}`);
      if (!r.ok) dump('bid', await page.content());
      await fav.saveSession();
    }
  } catch (err) {
    console.error(`ошибка: ${err.message}`);
    if (page) dump('error', await page.content().catch(() => ''));
  } finally {
    if (page) await page.close().catch(() => {});
    await fav.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    if (amount != null) return await bidDryRun(browser);
    const page = await browser.newContext({ userAgent: USER_AGENT, locale: 'ru-BY' }).then((c) => c.newPage());
    if (/\/lot\//.test(url)) await lotPage(page); else await listPage(page);
  } catch (err) {
    console.error(`ошибка: ${err.message}`);
  } finally {
    await browser.close();
  }
})();
