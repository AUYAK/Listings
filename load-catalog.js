// Загрузка архива проходов gdenashel.ru в listings.coin_sales и пересчёт каталога listings.coin_catalog
// (медиана по типу монеты и состоянию за последние N лет, RUB → BYN по курсу НБРБ). Нужна миграция 012.
//
//   node load-catalog.js                      все разделы (серебро империи + серебро СССР), проходы за 3 года
//   node load-catalog.js --years 5            окно 5 лет
//   node load-catalog.js --only nikolay-ii    только разделы, в URL которых есть подстрока
//   node load-catalog.js --rebuild-only       не ходить на сайт, только пересчитать каталог из coin_sales
//   node load-catalog.js --dry-run            разобрать, в базу не писать
//   node load-catalog.js --max-pages 5        не больше N страниц проходов на монету (по 30 проходов)
//
// Повторный запуск докачивает только новые проходы (страницы отсортированы по дате, старые не перечитываются).
// Запуск по cron раз в неделю с --years 0.3 обновляет свежие проходы; затем каталог пересчитывается.
require('dotenv').config();
const g = require('./coins/gdenashel');
const cstore = require('./coins/store');
const { bynRate } = require('./coins/rates');
const { pool } = require('./store');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] != null ? args[i + 1] : def; };
const YEARS = parseFloat(opt('--years', process.env.COINS_CATALOG_YEARS || '3'));
const ONLY = opt('--only', null);
const MAX_PAGES = parseInt(opt('--max-pages', '40'), 10);
const DELAY_MS = parseInt(opt('--delay', '1500'), 10);
const DRY = args.includes('--dry-run');
const REBUILD_ONLY = args.includes('--rebuild-only');
const SOURCE = 'gdenashel';

// Разделы: серебро по правителям Российской империи и тиражное серебро СССР.
const IMPERIAL_RULERS = ['nikolay-ii', 'aleksandr-iii', 'aleksandr-ii', 'nikolay-i', 'aleksandr-i', 'pavel-i', 'ekaterina-ii', 'petr-iii', 'elizaveta', 'ioann-antonovich', 'anna-ioannovna', 'petr-ii', 'ekaterina-i', 'petr-i'];
const USSR_PAGES = ['10-kopeek', '15-kopeek', '20-kopeek', '50-kopeek', 'odin-poltinnik', '1-rubl'].map((d) => `${g.BASE}/coins/sssr/tirajnye/1921-1958/${d}`);

// СССР: серебро — 10/15/20 коп 1921–1931, полтинники 1921–1927, рубли 1921–1924; только тиражные (не пробные, не местные)
function ussrSilver(row) {
  if (!/\/tirajnye\//.test(row.coinUrl) || !row.year) return false;
  if ([10, 15, 20].includes(row.denomKop)) return row.year <= 1931;
  if (row.denomKop === 50) return row.year <= 1927;
  if (row.denomKop === 100) return row.year <= 1924;
  return false;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const cutoff = new Date(Date.now() - YEARS * 365.25 * 86400e3).toISOString().slice(0, 10);

// --only: подстрока URL страницы номинала («nikolay-ii», «nikolay-ii/serebro/25-kopeek», «sssr», «1921-1958/1-rubl»)
const wanted = (url) => !ONLY || url.includes(ONLY);

async function collectListPages() {
  const pages = [];
  for (const ruler of IMPERIAL_RULERS) {
    const section = `${g.BASE}/coins/imperiya/${ruler}/serebro`;
    if (ONLY && !ONLY.includes(ruler) && !section.includes(ONLY)) continue;
    const html = await g.fetchHtml(section).catch((err) => { console.warn(`[Catalog] ${section}: ${err.message}`); return null; });
    await pause(DELAY_MS);
    if (!html) continue;
    for (const url of g.parseDenominationLinks(html, section)) if (wanted(url)) pages.push({ url, filter: null });
  }
  for (const url of USSR_PAGES) if (wanted(url)) pages.push({ url, filter: ussrSilver });
  return pages;
}

// Страница монеты (тираж, редкость по Конросу) читается один раз на монету и раскладывается по ключам
const coinPages = new Map();
async function loadCoinType(row, typeKey, variantKey) {
  if (!coinPages.has(row.coinUrl)) {
    const info = await g.fetchCoinPage(row.coinUrl).catch((err) => { console.warn(`  [Catalog] ${row.coinUrl}: ${err.message}`); return null; });
    await pause(DELAY_MS);
    coinPages.set(row.coinUrl, info);
    if (info && !DRY) {
      // тип в целом: редкость — у самой обычной разновидности (нет отметки у хотя бы одной → обычная)
      const vars = Object.values(info.variants);
      const konros = vars.length && vars.every((v) => v.konros) ? vars.map((v) => v.konros).sort()[0] : info.konros;
      await cstore.upsertCoinType(typeKey, SOURCE, { title: row.name, coinUrl: row.coinUrl, mintage: info.mintage, konros: vars.length ? konros : info.konros, bitkin: info.bitkin });
    }
  }
  const info = coinPages.get(row.coinUrl);
  if (!info || DRY) return;
  const v = row.childId && info.variants[row.childId];
  if (variantKey && v) await cstore.upsertCoinType(variantKey, SOURCE, { title: v.title || `${row.name} ${row.letters}`, coinUrl: `${row.coinUrl}#coin-${row.childId}`, mintage: v.mintage ?? info.mintage, konros: v.konros, bitkin: v.bitkin });
}

async function loadRow(row) {
  if (row.denomKop == null || !row.year) return { fetched: 0, pages: 0 };
  const typeKey = `${row.denomKop}|${row.year}`;
  const variantKey = row.letters ? `${typeKey}|${row.letters}` : null;
  await loadCoinType(row, typeKey, variantKey);
  let fetched = 0, page = 1, pages = 1;
  while (page <= pages && page <= MAX_PAGES) {
    let res;
    try { res = await g.fetchSalesPage(row.salesUrl, page); }
    catch (err) { console.warn(`  [Catalog] ${row.salesUrl} p${page}: ${err.message}`); break; }
    pages = res.pages || 1;
    const rows = res.sales.map((s) => ({ ...s, source: SOURCE, typeKey, variantKey, variety: row.variety }));
    if (!DRY && rows.length) await cstore.upsertSales(rows);
    fetched += rows.length;
    const dates = rows.map((s) => s.soldOn).filter(Boolean).sort();
    if (!rows.length || (dates.length && dates[0] < cutoff)) break; // дошли до проходов старше окна
    page++;
    await pause(DELAY_MS);
  }
  return { fetched, pages: Math.min(page, pages) };
}

async function main() {
  const rate = await bynRate('RUB');
  console.log(`[Catalog] окно ${YEARS} лет (с ${cutoff}), курс RUB→BYN ${rate.toFixed(5)}${DRY ? ', dry-run' : ''}`);
  if (!REBUILD_ONLY) {
    const pages = await collectListPages();
    console.log(`[Catalog] страниц номиналов: ${pages.length}`);
    let coins = 0, sales = 0, errors = 0;
    for (const { url, filter } of pages) {
      let rows;
      try { rows = await g.listDenomination(url); } catch (err) { console.warn(`[Catalog] ${url}: ${err.message}`); continue; }
      await pause(DELAY_MS);
      rows = rows.filter((r) => r.passes > 0 && (!filter || filter(r)));
      console.log(`[Catalog] ${url.replace(g.BASE, '')}: ${rows.length} монет/вариантов`);
      for (const row of rows) {
        const label = `${row.name}${row.letters ? ' ' + row.letters : ''}${row.variety ? ' (' + row.variety + ')' : ''}`;
        let r;
        try { r = await loadRow(row); }
        catch (err) { console.warn(`  ${label}: ОШИБКА ${err.message}`); errors++; await pause(DELAY_MS); continue; } // одна монета не должна валить весь прогон
        coins++; sales += r.fetched;
        console.log(`  ${label}: ${r.fetched} проходов, ${r.pages} стр.`);
        await pause(DELAY_MS);
      }
    }
    console.log(`[Catalog] монет ${coins}, проходов получено ${sales}${errors ? `, ошибок ${errors}` : ''}`);
  }
  if (!DRY) {
    const n = await cstore.rebuildCatalogFromSales(SOURCE, YEARS, rate);
    console.log(`[Catalog] записей каталога (${SOURCE}): ${n}`);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => pool.end());
