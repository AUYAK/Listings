// gdenashel.ru — архив проходов российских аукционов (дата, аукционный дом, состояние, цена в RUB, фото).
// Страницы: список номинала (/coins/imperiya/<правитель>/serebro/<номинал>, /coins/sssr/tirajnye/1921-1958/<номинал>)
// → строки «монета + буквы/разновидность» со ссылкой ?child_id=N#sales → страница проходов (30 на страницу,
// новые сверху, ?page=N). Разбор регулярками по HTML, без браузера: сайт отдаёт страницы обычному fetch.

const { denominationFrom, yearFrom } = require('./parse');

const BASE = 'https://gdenashel.ru';
const USER_AGENT = 'kufar-monitor/1.0 (+coins catalog loader)';

const strip = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&mdash;/g, '—').replace(/\s+/g, ' ').trim();

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, signal: AbortSignal.timeout(30000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// Строки таблицы номинала: { coinUrl, name, year, denomKop, letters, variety, childId, salesUrl, passes }
function parseListHtml(html) {
  const out = [];
  let current = null;
  const trRe = /<tr class="coinTableAdapt-v2__row">([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html))) {
    const block = m[1];
    const name = block.match(/coinTableAdapt-v2__cell--name[^>]*>\s*<a href="([^"]+)">([\s\S]*?)<\/a>/);
    if (name) current = { coinUrl: name[1], name: strip(name[2]) };
    // монета с разновидностями: ?child_id=N#sales; без них — просто #sales
    const sales = block.match(/<a href="([^"]*?(?:\?child_id=(\d+))?#sales)">([\s\S]*?)<\/a>/);
    if (!sales || !current) continue;
    if (/пробн/i.test(current.name) || /\/(probnye|mestnye-vypuski)\//.test(current.coinUrl)) continue; // пробные и местные выпуски — не рынок
    const cells = [...block.matchAll(/<td class="coinTableAdapt-v2__cell"\s*>([\s\S]*?)<\/td>/g)].map((c) => strip(c[1])).filter(Boolean);
    const variety = block.match(/<span>([^<]*)<\/span>\s*([^<]*)</);
    const passes = sales[3].match(/\((\d+)\s/);
    const price = strip(sales[3]).match(/^([\d\s]+)\s*руб/);
    out.push({
      coinUrl: current.coinUrl,
      name: current.name,
      year: yearFrom(current.name),
      denomKop: denominationFrom(current.name),
      letters: cells.find((c) => /^[А-ЯЁІ]{2,3}$/.test(c)) || null,
      variety: variety ? `${variety[1].trim()} ${variety[2].trim()}`.trim() : null,
      childId: sales[2] || null,
      salesUrl: sales[1],
      passes: passes ? parseInt(passes[1], 10) : 0,
      avgRub: price ? parseInt(price[1].replace(/\s/g, ''), 10) : null,
    });
  }
  return out;
}

// Состояние в проходе → наша шкала. «MS64» (слаб) → UNC, «AU58» → AU, «VF25» → VF, «PF63» → PF.
function normalizeGrade(raw) {
  const g = (raw || '').toUpperCase().replace(/\s+/g, '');
  if (!g) return null;
  if (/^(PROOF|PF|PR)/.test(g)) return 'PF';
  if (/^(UNC|MS|BU)/.test(g)) return 'UNC';
  if (/^AU/.test(g)) return 'AU';
  if (/^(XF|EF)/.test(g)) return 'XF';
  if (/^VF/.test(g)) return 'VF';
  if (/^F/.test(g)) return 'F';
  if (/^VG/.test(g)) return 'VG';
  if (/^G/.test(g)) return 'G';
  return null;
}

function parseDate(s) {
  const m = (s || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Страница проходов: { sales: [...], pages, total }
function parseSalesHtml(html) {
  const sales = [];
  const rowRe = /<div class="row coin-sales__row"[^>]*>([\s\S]*?)<div class="col-6 col-md coin-sales__cell coin-sales__cell--price[\s\S]*?<strong>([\s\S]*?)<\/strong>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const block = m[1];
    const id = (block.match(/\/sale\/([0-9a-f-]{36})/) || [])[1];
    if (!id) continue;
    const photos = [...block.matchAll(/data-src="([^"]+)"/g)].map((x) => x[1]);
    const info = block.match(/coin-sales__cell--info[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/);
    const strongs = info ? [...info[1].matchAll(/<strong[^>]*>([\s\S]*?)<\/strong>/g)].map((x) => strip(x[1])) : [];
    const house = info ? strip((info[1].match(/<span>([\s\S]*?)<\/span>/) || [])[1]) : null;
    const gradeCell = block.match(/cell--grade-slab-safety[\s\S]*$/);
    const gradeRaw = gradeCell ? strip((gradeCell[0].match(/<strong[^>]*>([\s\S]*?)<\/strong>/) || [])[1]) : '';
    const slab = gradeCell ? strip((gradeCell[0].match(/slab-cost">([\s\S]*?)<\/span>/) || [])[1]) || null : null;
    const priceText = strip(m[2]);
    const price = priceText.match(/([\d\s]+)\s*RUB/);
    sales.push({
      saleId: id,
      title: strongs[0] || null,
      soldOn: parseDate(strongs[1]),
      house,
      gradeRaw: gradeRaw || null,
      grade: normalizeGrade(gradeRaw),
      slab,
      priceRub: price ? parseInt(price[1].replace(/\s/g, ''), 10) : null,
      photos,
    });
  }
  const pages = Math.max(1, ...[...html.matchAll(/[?&;]page=(\d+)/g)].map((x) => parseInt(x[1], 10))); // «&amp;page=7»
  const total = (html.match(/Перейти к проходам \((\d+)\)/) || [])[1];
  return { sales, pages, total: total ? parseInt(total, 10) : null };
}

// Ссылки на номиналы со страницы «правитель/serebro» или сводной страницы СССР
function parseDenominationLinks(html, sectionUrl) {
  const base = sectionUrl.replace(/\/$/, '');
  const links = new Set();
  const re = new RegExp(`href="(${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[a-z0-9-]+)"`, 'g');
  let m;
  while ((m = re.exec(html))) if (!/\/(jeton|medal|zheton|medali)$/.test(m[1])) links.add(m[1]);
  return [...links];
}

// Страница монеты: тираж и редкость по Конросу для монеты в целом и для каждой разновидности (блок после
// <div class="anchorFixed" id="coin-<childId>">). Нет строки «Конрос» = обычная монета.
function parseCoinPageHtml(html) {
  const attrs = (block) => ({
    // «Тираж: 1 100 002»; бывает «неизвестен», «—» или пусто → null (иначе в BIGINT уходил NaN)
    mintage: (() => { const m = block.match(/<strong>Тираж:<\/strong>\s*(\d[\d\s]*)/); const n = m ? parseInt(m[1].replace(/\s/g, ''), 10) : NaN; return Number.isFinite(n) ? n : null; })(),
    konros: (() => { const m = block.match(/<strong>Конрос:<\/strong>\s*([^<]+)/); return m ? m[1].trim() : null; })(),
    bitkin: (() => { const m = block.match(/<strong>Биткин:<\/strong>\s*([^<]+)/); return m ? m[1].trim() : null; })(),
  });
  const parts = html.split(/<div class="anchorFixed" id="coin-(\d+)"><\/div>/);
  const top = attrs(parts[0]);
  const variants = {};
  for (let i = 1; i < parts.length; i += 2) {
    const block = parts[i + 1].split('<div class="anchorFixed" id="coin-')[0];
    const title = strip((block.match(/coinView__child-title">([\s\S]*?)<\/h3>/) || [])[1]);
    variants[parts[i]] = { title: title || null, ...attrs(block) };
  }
  return { ...top, variants };
}

async function fetchCoinPage(coinUrl) {
  const html = await fetchHtml(coinUrl);
  return html ? parseCoinPageHtml(html) : null;
}

async function listDenomination(url) {
  const html = await fetchHtml(url);
  return html ? parseListHtml(html) : [];
}

function salesPageUrl(salesUrl, page = 1) {
  const u = new URL(salesUrl);
  u.hash = '';
  if (page > 1) u.searchParams.set('page', String(page));
  return u.toString();
}

async function fetchSalesPage(salesUrl, page = 1) {
  const html = await fetchHtml(salesPageUrl(salesUrl, page));
  return html ? parseSalesHtml(html) : { sales: [], pages: 0, total: null };
}

module.exports = { BASE, fetchHtml, parseListHtml, parseSalesHtml, parseCoinPageHtml, parseDenominationLinks, normalizeGrade, listDenomination, fetchSalesPage, fetchCoinPage, salesPageUrl };
