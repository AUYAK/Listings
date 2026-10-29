// Диагностика страницы лота ay.by: что отдаёт сайт и что из этого вытаскивает coins/ayby.js.
//   node debug-lot.js https://ay.by/lot/...html [ещё ссылки]
// Печатает HTTP-код, заголовок страницы, разобранные поля и сохраняет HTML в ./debug/<id>.html —
// его можно прислать для калибровки разбора завершённых лотов.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ayby = require('./coins/ayby');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function main() {
  const urls = process.argv.slice(2);
  if (!urls.length) { console.error('usage: node debug-lot.js <lot url> [...]'); process.exit(1); }
  fs.mkdirSync(path.join(__dirname, 'debug'), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ru-BY' });
  const page = await context.newPage();
  for (const url of urls) {
    const id = (url.match(/-(\d{6,})\.html/) || [null, Date.now()])[1];
    const file = path.join(__dirname, 'debug', `${id}.html`);
    console.log(`\n=== ${url}`);
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ayby.NAV_TIMEOUT });
      console.log(`HTTP ${resp ? resp.status() : '?'} · title: ${await page.title()}`);
      await page.waitForSelector('.b-lot-title__title, .b-lot-control', { timeout: 10000 }).catch(() => {});
      fs.writeFileSync(file, await page.content());
      console.log(`HTML → ${file}`);
      const text = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 700));
      console.log(`text: ${text}`);
    } catch (err) {
      console.log(`goto error: ${err.message}`);
    }
    try {
      const lot = await ayby.fetchLot(page, url);
      const { specs, description, photos, ...rest } = lot;
      console.log('fetchLot →', JSON.stringify({ ...rest, photos: (photos || []).length, specs }, null, 1));
    } catch (err) {
      console.log(`fetchLot error: ${err.message}`);
    }
  }
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
