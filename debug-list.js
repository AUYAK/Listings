// Проверка страницы списка ay.by нашим сканером: node debug-list.js <url> [...]
// Печатает число карточек и первые из них; если карточек нет — сохраняет HTML в ./debug/ для разбора.
// Пример: node debug-list.js "https://coins.ay.by/topic.phtml?f=1&ti1=6"
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ayby = require('./coins/ayby');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const urls = process.argv.slice(2);
if (!urls.length) { console.error('usage: node debug-list.js <url> [...]'); process.exit(1); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ru-BY' });
  const page = await context.newPage();
  for (const url of urls) {
    console.log(`\n== ${url}`);
    try {
      const cards = await ayby.scanListPage(page, url);
      console.log(`карточек: ${cards.length}; title: ${await page.title()}`);
      for (const c of cards.slice(0, 8)) console.log(`  ${c.id} | ${c.title} | ${c.price} р. | ставок ${c.bids ?? '—'} | ${c.saleType || ''} | ${c.endsAt ? new Date(c.endsAt).toISOString().slice(0, 16) : ''}`);
      if (!cards.length) {
        fs.mkdirSync('debug', { recursive: true });
        const file = path.join('debug', `list-${Date.now()}.html`);
        fs.writeFileSync(file, await page.content());
        console.log(`карточек нет — HTML сохранён в ${file}`);
      }
    } catch (err) {
      console.error(`ошибка: ${err.message}`);
    }
  }
  await browser.close();
})();
