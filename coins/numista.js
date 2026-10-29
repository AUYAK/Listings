// Каталожные цены Numista (api.numista.com/api/v3) с кэшем в listings.coin_catalog (source='numista').
// Нужен ключ NUMISTA_API_KEY в .env (бесплатный план: 2000 запросов в месяц, регистрация на numista.com → API).
// Без ключа модуль молча возвращает null. Цены в v3 привязаны к выпуску (issue = год + знак двора):
// /types?q=… → /types/{id}/issues → /types/{id}/issues/{issue_id}/prices. Формат ответов проверяется защитно.
const { pool } = require('../store');
const { toByn } = require('./rates');

const KEY = process.env.NUMISTA_API_KEY || '';
const BASE = 'https://api.numista.com/api/v3';
const CACHE_DAYS = 30;
const NUMISTA_GRADES = { g: 'G', vg: 'VG', f: 'F', vf: 'VF', xf: 'XF', au: 'AU', unc: 'UNC' };
const DENOM_EN = { 5: '5 kopecks', 10: '10 kopecks', 15: '15 kopecks', 20: '20 kopecks', 25: '25 kopecks', 50: '50 kopecks', 100: '1 rouble', 150: '1½ roubles', 1000: '10 roubles', 2000: '20 roubles' };

let warned = false;
const warnOnce = (msg, raw) => { if (!warned) { warned = true; console.warn(`[Numista] ${msg}: ${JSON.stringify(raw).slice(0, 400)}`); } };

async function api(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'Numista-API-Key': KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Numista ${res.status}: ${data.error_message || ''}`);
  return data;
}

function typeKey(parsed) {
  return parsed.denomKop != null && parsed.year ? `${parsed.denomKop}|${parsed.year}` : null;
}

async function cached(key) {
  const res = await pool.query(`SELECT * FROM listings.coin_catalog WHERE type_key = $1 AND source = 'numista'`, [key]);
  const r = res.rows[0];
  if (!r) return null;
  if (Date.now() - new Date(r.fetched_at).getTime() > CACHE_DAYS * 86400e3) return null;
  return r;
}

async function saveCache(key, entry) {
  await pool.query(
    `INSERT INTO listings.coin_catalog (type_key, source, external_id, title, currency, prices, raw, fetched_at)
     VALUES ($1, 'numista', $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (type_key, source) DO UPDATE SET external_id = EXCLUDED.external_id, title = EXCLUDED.title,
       currency = EXCLUDED.currency, prices = EXCLUDED.prices, raw = EXCLUDED.raw, fetched_at = NOW()`,
    [key, entry.externalId, entry.title, entry.currency, JSON.stringify(entry.prices || {}), JSON.stringify(entry.raw || null)]
  );
}

// Выпуск типа по году (и знаку двора/минцмейстера, если указан)
function pickIssue(issues, parsed) {
  const byYear = issues.filter((i) => (i.year == null || +i.year === parsed.year) && (i.min_year == null || i.min_year <= parsed.year) && (i.max_year == null || i.max_year >= parsed.year));
  if (!byYear.length) return null;
  const mark = parsed.mintmaster || parsed.mint;
  return (mark && byYear.find((i) => (i.mint_letter || '').toUpperCase().includes(mark.toUpperCase()))) || byYear[0];
}

// Подбор типа по номиналу и году (Российская империя / СССР), затем цены выпуска по состояниям в BYN.
// Возвращает { source:'numista', title, prices:{VF:…}, currency:'BYN' } или null.
async function lookup(parsed) {
  if (!KEY) return null;
  const key = typeKey(parsed);
  if (!key) return null;
  const hit = await cached(key);
  if (hit) return hit.prices && Object.keys(hit.prices).length ? { source: 'numista', title: hit.title, prices: hit.prices, currency: 'BYN' } : null;

  const q = `${DENOM_EN[parsed.denomKop] || parsed.denomination} ${parsed.year}`;
  let search;
  try { search = await api('/types', { q, lang: 'en', count: 20, category: 'coin' }); }
  catch (err) { console.warn(`[Numista] search failed for "${q}": ${err.message}`); return null; }
  const types = Array.isArray(search.types) ? search.types : null;
  if (!types) { warnOnce('unexpected search response', search); return null; }
  const year = parsed.year;
  const ruType = types.find((t) => /russia|soviet|ussr|российск|ссср/i.test(`${t.issuer?.name || ''} ${t.title || ''}`) && (!t.min_year || t.min_year <= year) && (!t.max_year || t.max_year >= year))
    || types.find((t) => /russia|soviet|ussr/i.test(`${t.issuer?.name || ''} ${t.title || ''}`));
  if (!ruType) { await saveCache(key, { externalId: null, title: null, currency: null, prices: {}, raw: { q, count: types.length } }); return null; }

  let pr;
  try {
    const issuesRes = await api(`/types/${ruType.id}/issues`, { lang: 'en' });
    const issues = Array.isArray(issuesRes) ? issuesRes : Array.isArray(issuesRes.issues) ? issuesRes.issues : null;
    if (!issues) { warnOnce('unexpected issues response', issuesRes); return null; }
    const issue = pickIssue(issues, parsed);
    if (!issue) { await saveCache(key, { externalId: String(ruType.id), title: ruType.title, currency: null, prices: {}, raw: { type: ruType, issues: issues.length } }); return null; }
    pr = await api(`/types/${ruType.id}/issues/${issue.id}/prices`, { currency: 'EUR', lang: 'en' });
  } catch (err) { console.warn(`[Numista] prices failed for type ${ruType.id}: ${err.message}`); return null; }
  const list = Array.isArray(pr.prices) ? pr.prices : null;
  if (!list) { warnOnce('unexpected prices response', pr); return null; }
  const currency = pr.currency || 'EUR';
  const prices = {};
  for (const p of list) {
    const g = NUMISTA_GRADES[String(p.grade || '').toLowerCase()];
    const v = parseFloat(p.price);
    if (g && v > 0) prices[g] = Math.round(await toByn(v, currency) * 100) / 100;
  }
  await saveCache(key, { externalId: String(ruType.id), title: ruType.title, currency: 'BYN', prices, raw: { type: ruType, prices: pr } });
  return Object.keys(prices).length ? { source: 'numista', title: ruType.title, prices, currency: 'BYN' } : null;
}

module.exports = { lookup, typeKey, pickIssue, isConfigured: () => Boolean(KEY) };
