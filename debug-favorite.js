// Отладка избранного ay.by на сервере: node debug-favorite.js <url лота> [--no-click]
// Показывает: сессия/вход, разметку кнопки «В избранное», сетевые запросы при нажатии, появился ли лот в избранном.
// Если что-то не так — HTML страниц сохраняется в ./debug/.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const fav = require('./coins/favorites');

const args = process.argv.slice(2);
const noClick = args.includes('--no-click');
const url = args.find((a) => /^https?:/.test(a));
if (!url) { console.error('usage: node debug-favorite.js <url лота> [--no-click]'); process.exit(1); }
const lotId = (url.match(/-(\d+)\.html/) || [null, null])[1];
console.log(`лот ${lotId || '?'}: ${url}`);
console.log(`AYBY_LOGIN: ${process.env.AYBY_LOGIN ? 'задан' : 'НЕ ЗАДАН'}, AYBY_PASSWORD: ${process.env.AYBY_PASSWORD ? 'задан' : 'НЕ ЗАДАН'}, сессия: ${fs.existsSync(fav.SESSION_FILE) ? fav.SESSION_FILE : 'нет файла'}`);

function dump(name, html) {
  fs.mkdirSync('debug', { recursive: true });
  const file = path.join('debug', `${name}-${Date.now()}.html`);
  fs.writeFileSync(file, html);
  console.log(`  HTML сохранён в ${file}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  await fav.open(browser);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  try {
    // 1. вход
    console.log('\n== вход');
    const was = await fav.isLoggedIn(page);
    console.log(`  сессия ${was ? 'жива, вход не нужен' : 'не активна'}`);
    if (!was) {
      await page.goto(fav.LOGIN_URL, { waitUntil: 'domcontentloaded' });
      console.log(`  страница входа: title «${await page.title()}», url ${page.url()}`);
      const forms = await page.$$eval('form', (fs) => fs.map((f) => ({ action: f.action, inputs: Array.from(f.querySelectorAll('input,button')).map((i) => `${i.tagName.toLowerCase()}[type=${i.type} name=${i.name || ''} id=${i.id || ''}]`) })));
      for (const f of forms) console.log(`  form ${f.action}: ${f.inputs.join(', ')}`);
      if (!forms.some((f) => f.inputs.some((i) => /type=password/.test(i)))) dump('login', await page.content());
      await fav.login(page);
      console.log('  вход выполнен');
    }

    // 2. кнопка на странице лота
    console.log('\n== страница лота');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    console.log(`  title «${await page.title()}», url ${page.url()}`);
    const btns = await page.$$eval('*', (els) => {
      const out = [];
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        let own = '';
        for (let j = 0; j < el.childNodes.length; j++) if (el.childNodes[j].nodeType === 3) own += el.childNodes[j].textContent;
        if (/избранн/i.test(own)) out.push(el.outerHTML.replace(/\s+/g, ' ').slice(0, 400));
      }
      return out;
    });
    console.log(`  элементов с текстом «избранн»: ${btns.length}`);
    for (const b of btns) console.log(`   ${b}`);
    const inFav = await fav.hasFavorite(page, lotId);
    console.log(`  в избранном до нажатия: ${inFav}`);
    if (noClick) return;

    // 3. нажатие и сетевые запросы
    console.log('\n== нажимаем «В избранное»');
    const reqs = [];
    page.on('request', (r) => { if (!/\.(png|jpg|jpeg|gif|css|js|woff2?|svg)(\?|$)/i.test(r.url()) && !/google|yandex|facebook|gstatic/.test(r.url())) reqs.push(`${r.method()} ${r.url()}${r.method() === 'POST' ? ` body=${(r.postData() || '').slice(0, 200)}` : ''}`); });
    const r = await fav.clickFavorite(page, url);
    console.log(`  ${JSON.stringify(r)}`);
    for (const q of reqs) console.log(`   → ${q}`);
    const after = await fav.hasFavorite(page, lotId);
    console.log(`  в избранном после нажатия: ${after}`);
    if (!after) dump('favorites', await page.content());
    await context.storageState({ path: fav.SESSION_FILE });
  } catch (err) {
    console.error(`ошибка: ${err.message}`);
    dump('error', await page.content().catch(() => ''));
  } finally {
    await fav.close();
    await browser.close();
  }
})();
