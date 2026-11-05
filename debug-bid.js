// Отладка снайп-ставки ay.by на сервере:
//   node debug-bid.js <url лота>                  — вход, состояние лота, разметка формы ставки (ничего не нажимает)
//   node debug-bid.js <url лота> --amount 12.5    — заполняет сумму, нажимает «Сделать ставку», показывает
//                                                   текст подтверждения и НЕ подтверждает
//   node debug-bid.js <url лота> --amount 12.5 --confirm — реально ставит (сумма — ваш максимум!)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const fav = require('./coins/favorites');
const bid = require('./coins/bid');

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:/.test(a));
const ai = args.indexOf('--amount');
const amount = ai >= 0 ? parseFloat(String(args[ai + 1]).replace(',', '.')) : null;
const confirm = args.includes('--confirm');
if (!url) { console.error('usage: node debug-bid.js <url лота> [--amount N] [--confirm]'); process.exit(1); }
if (!fav.enabled()) { console.error('нет сессии ay.by: выполните node ayby-login.js'); process.exit(1); }

function dump(name, html) {
  fs.mkdirSync('debug', { recursive: true });
  const file = path.join('debug', `${name}-${Date.now()}.html`);
  fs.writeFileSync(file, html);
  console.log(`  HTML сохранён в ${file}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  await fav.open(browser);
  let page;
  try {
    page = await fav.newPage();
    console.log('вход: ок');
    const st = await bid.openLot(page, url);
    console.log(`\n== лот: title «${await page.title()}», HTTP ${st.httpStatus}`);
    console.log(`  до конца ${st.remaining} с, цена ${st.price}, мин. ставка ${st.minBid}, ставок ${st.bids}, закончен ${st.ended}, кнопка ставки ${st.hasBidButton}, резерв не пройден ${st.reserveNotMet}, наша ставка ${st.yours}`);
    console.log(`  поля формы: ${JSON.stringify(st.inputs)}`);
    console.log(`  текст блока управления: ${st.controlText.slice(0, 300)}`);
    const html = await page.$eval('.b-lot-control', (el) => el.outerHTML.replace(/\s+/g, ' ')).catch(() => null);
    if (html) {
      console.log(`\n== разметка .b-lot-control (${html.length} симв.), input/button/form:`);
      for (const m of html.match(/<(?:input|button|form|a)\b[^>]*>/g) || []) console.log(`   ${m.slice(0, 300)}`);
    } else dump('lot', await page.content());
    if (amount == null) return;

    console.log(`\n== ставка ${amount} (${confirm ? 'С ПОДТВЕРЖДЕНИЕМ' : 'без подтверждения'})`);
    const reqs = [];
    page.on('request', (r) => { if (r.method() === 'POST') reqs.push(`POST ${r.url()} body=${(r.postData() || '').slice(0, 300)}`); });
    const r = await bid.placeBid(page, amount, { confirm });
    console.log(`  сумма в поле: ${r.value}`);
    console.log(`  текст подтверждения: ${r.consent || '(не найден)'}`);
    const dialog = await page.evaluate(() => {
      const els = document.querySelectorAll('*');
      for (let i = 0; i < els.length; i++) if (/Да, сделать ставку/.test(els[i].textContent || '') && els[i].children.length < 30 && els[i].textContent.length < 1500) return els[i].outerHTML.replace(/\s+/g, ' ').slice(0, 2000);
      return null;
    });
    console.log(`  разметка подтверждения: ${dialog || '(не найдена)'}`);
    if (confirm) {
      console.log(`  результат: ok=${r.ok}, цена ${r.state.price}, ставок ${r.state.bids}, наша ${r.state.yours}, ошибка ${r.state.errorText || 'нет'}, url ${page.url()}`);
      for (const q of reqs) console.log(`   → ${q}`);
      if (!r.ok) dump('bid', await page.content());
      await fav.saveSession();
    }
  } catch (err) {
    console.error(`ошибка: ${err.message}`);
    if (page) dump('error', await page.content().catch(() => ''));
  } finally {
    if (page) await page.close().catch(() => {});
    await fav.close();
    await browser.close();
  }
})();
