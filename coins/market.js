// Оценка монеты: каталожная цена (Numista) и наша медиана по похожим лотам того же состояния.
// Ориентир для «выгодно/нет» — каталог; если каталога нет — наша оценка; если нет и её — лот
// только сохраняется, уведомление не уходит.

const { groupKeys, GRADE_ORDER } = require('./parse');

// «Выгодно» — либо разница с ориентиром не меньше BARGAIN_BYN рублей (дорогие лоты: 50 р. с лота за 300 р. — уже
// интересно, хотя это лишь 17%), либо лот дешевле ориентира на BARGAIN_PCT процентов и при этом разница
// не меньше BARGAIN_MIN_BYN (чтобы 30% от монеты за 12 р. не считались выгодой).
const BARGAIN_PCT = parseInt(process.env.COINS_BARGAIN_PCT || '30', 10);
const BARGAIN_BYN = parseFloat(process.env.COINS_BARGAIN_BYN || '50');
const BARGAIN_MIN_BYN = parseFloat(process.env.COINS_BARGAIN_MIN_BYN || '10');
const MIN_SAMPLES = 3;
const MIN_PRICE = 2; // ставки «с рубля» без ставок — не цена

// Тысячи через обычный пробел (toLocaleString('ru') ставит узкий неразрывный U+202F, он ломает сравнение строк)
const num = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Цена лота, пригодная для статистики: итог продажи; фикс-цена; ставка, если ставки были
function usablePrice(r) {
  const sold = r.outcome === 'sold' || (r.source === 'kufar' && r.status === 'inactive');
  if (sold) return { price: parseFloat(r.final_price ?? r.current_price), sold: true };
  if (r.outcome) return null; // не продан / снят — цена ничего не говорит
  if (r.sale_type === 'auction' && !(r.bids > 0)) return null;
  const p = parseFloat(r.current_price);
  return p >= MIN_PRICE ? { price: p, sold: false } : null;
}

// Наша оценка: медиана по той же группе и тому же состоянию; группа сужается, пока хватает данных
function marketEstimate(rows, parsed, excludeId = null) {
  if (!parsed.grade) return null;
  const candidates = [];
  for (const r of rows) {
    if (r.id === excludeId || !r.parsed || r.grade !== parsed.grade) continue;
    const up = usablePrice(r);
    if (!up || !(up.price > 0)) continue;
    const p = typeof r.parsed === 'string' ? JSON.parse(r.parsed) : r.parsed;
    if (p.flags && (p.flags.includes('копия') || p.flags.includes('несколько монет'))) continue;
    candidates.push({ ...up, keys: new Set(groupKeys(p).map((k) => k.key)) });
  }
  for (const g of groupKeys(parsed)) {
    const inGroup = candidates.filter((c) => c.keys.has(g.key));
    if (inGroup.length < MIN_SAMPLES) continue;
    const sold = inGroup.filter((c) => c.sold).map((c) => c.price);
    const all = inGroup.map((c) => c.price);
    return {
      label: g.label, grade: parsed.grade, n: all.length, soldN: sold.length,
      median: median(all), soldMedian: median(sold),
      refMedian: sold.length >= MIN_SAMPLES ? median(sold) : median(all),
      refSource: sold.length >= MIN_SAMPLES ? 'sold' : 'all',
    };
  }
  return null;
}

// Каталожная цена для состояния лота; если такого состояния нет — ближайшее ниже
function catalogPrice(catalog, grade) {
  if (!catalog || !catalog.prices || !grade) return null;
  const prices = catalog.prices;
  const idx = GRADE_ORDER.indexOf(grade);
  for (let i = idx; i >= 0; i--) {
    const g = GRADE_ORDER[i];
    if (prices[g] != null) return { price: prices[g], grade: g, exact: g === grade };
  }
  return null;
}

function isBargain({ price, reference, bargainPct = BARGAIN_PCT, bargainByn = BARGAIN_BYN, minByn = BARGAIN_MIN_BYN }) {
  if (!(reference > 0) || !(price >= MIN_PRICE)) return false;
  const gain = reference - price;
  if (gain >= bargainByn) return true;
  return gain >= minByn && (price - reference) / reference <= -bargainPct / 100;
}

// Редкость: по шкале Конроса (нет отметки → обычная, R → редкая, R1 → эпическая, R2 → легендарная, R3/R4 → реликвия).
// Без отметки Конроса ориентируемся на частоту проходов: меньше RARE_PASSES_PER_YEAR в год — редкая.
const TIERS = [
  { level: 0, name: 'обычная', emoji: '⚪' }, { level: 1, name: 'редкая', emoji: '🟢' }, { level: 2, name: 'эпическая', emoji: '🟣' },
  { level: 3, name: 'легендарная', emoji: '🟠' }, { level: 4, name: 'реликвия', emoji: '🔴' },
];
const RARE_PASSES_PER_YEAR = 3;

function rarityTier({ konros = null, passes = null, windowYears = null, mintage = null } = {}) {
  const reasons = [];
  let level = 0;
  if (konros) {
    const m = String(konros).toUpperCase().match(/R\s*(\d)?/);
    if (m) level = m[1] == null ? 1 : Math.min(4, parseInt(m[1], 10) + 1);
    reasons.push(`Конрос ${konros}`);
  } else if (passes != null && windowYears > 0 && passes / windowYears < RARE_PASSES_PER_YEAR) {
    level = 1;
  }
  if (mintage) reasons.push(`тираж ${num(mintage)}`);
  if (passes != null) reasons.push(`${passes} прох. за ${windowYears} г.`);
  return { ...TIERS[level], konros: konros || null, mintage: mintage || null, passes, reason: reasons.join(' · ') };
}

const sumSamples = (samples) => samples ? Object.values(samples).reduce((s, n) => s + (n || 0), 0) : null;

function assess({ parsed, price, rows = [], excludeId = null, catalog = null, catalogs = null, coinType = null, bargainPct = BARGAIN_PCT, bargainByn = BARGAIN_BYN, minByn = BARGAIN_MIN_BYN }) {
  const market = marketEstimate(rows, parsed, excludeId);
  const list = catalogs || (catalog ? [catalog] : []);
  const cats = list.map((c) => {
    const cp = catalogPrice(c, parsed.grade);
    return cp ? { ...cp, source: c.source, title: c.title, samples: c.samples ? c.samples[cp.grade] : null, passes: sumSamples(c.samples), windowYears: c.windowYears || null, factor: c.factor } : null;
  }).filter(Boolean);
  const cat = cats[0] || null;
  const reference = cat ? cat.price : market ? market.refMedian : null;
  const referenceSource = cat ? 'catalog' : market ? 'market' : null;
  const hasPrice = price != null && price >= MIN_PRICE;
  const deviationPct = reference && hasPrice ? Math.round(((price - reference) / reference) * 100) : null;
  const gainByn = reference && hasPrice ? Math.round(reference - price) : null;
  const gd = list.find((c) => c.source === 'gdenashel');
  const rarity = coinType || gd ? rarityTier({ konros: coinType && coinType.konros, mintage: coinType && coinType.mintage, passes: gd ? sumSamples(gd.samples) : null, windowYears: gd ? gd.windowYears : null }) : null;
  return {
    market, catalog: cat, catalogs: cats, rarity,
    reference, referenceSource, deviationPct, gainByn,
    isBargain: isBargain({ price, reference, bargainPct, bargainByn, minByn }),
    bargainPct, bargainByn, minByn,
  };
}

const fmt = (n) => `${num(n)} р.`;
const SOURCE_NAMES = { gdenashel: 'gdenashel.ru, аукционы РФ', numista: 'Numista' };
const srcName = (s) => SOURCE_NAMES[s] || s;

// Строки карточки: каждый источник отдельно, чтобы не смешивать; вердикт — по первому доступному
function formatEstimateLines(est) {
  if (!est) return [];
  const lines = [];
  for (const c of est.catalogs || []) {
    const n = c.samples ? `, ${c.samples} прох.${c.windowYears ? ` за ${c.windowYears} г.` : ''}` : '';
    const k = c.factor && c.factor !== 1 ? `, ×${c.factor}` : '';
    lines.push(`📚 ${srcName(c.source)} (${c.grade}${c.exact ? '' : ', ближайшее состояние'}${n}${k}): ${fmt(c.price)}`);
  }
  if (est.market) lines.push(`📊 Наша база (${est.market.label}, ${est.market.grade}): ${fmt(est.market.refMedian)} по ${est.market.refSource === 'sold' ? `${est.market.soldN} продажам` : `${est.market.n} лотам`}${est.market.refSource !== 'sold' && est.market.soldN ? `, продаж ${est.market.soldN}` : ''}`);
  else lines.push('📊 Наша база: похожих лотов в этом состоянии ещё не было');
  if (est.rarity) lines.push(`💎 Редкость: ${est.rarity.name} ${est.rarity.emoji}${est.rarity.reason ? ` · ${est.rarity.reason}` : ''}`);
  if (est.deviationPct != null) {
    const base = est.referenceSource === 'catalog' ? srcName(est.catalog.source).split(',')[0] : 'нашей базы';
    if (est.isBargain) lines.push(`🟢 На ${-est.deviationPct}% (${fmt(est.gainByn)}) ниже ${base} — выгодно`);
    else if (est.deviationPct < 0) lines.push(`🟡 На ${-est.deviationPct}% (${fmt(est.gainByn)}) ниже ${base}`);
    else lines.push(`🔴 На ${est.deviationPct}% выше ${base}`);
  } else if (!est.reference) {
    lines.push('⚪ Ориентира пока нет: ни каталога, ни трёх похожих лотов');
  }
  return lines;
}

module.exports = { assess, isBargain, rarityTier, marketEstimate, catalogPrice, usablePrice, formatEstimateLines, median, BARGAIN_PCT, BARGAIN_BYN, BARGAIN_MIN_BYN, MIN_SAMPLES, TIERS };
