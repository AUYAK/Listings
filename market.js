// Рыночная сводка по объявлению: медиана цены среди похожих объявлений того же монитора.
// Модель берётся из характеристик (listing_details), а если их нет — из заголовка.
// Группы от узкой к широкой: линейка+чип(или год)+экран+память → …+экран → линейка+чип(или год)
// → линейка → все. Экран обязателен как уровень: замерено на 134 объявлениях, что Pro Intel
// 13"/15"/16" стоят 820/1050/1500 р., а Pro M-Pro 14" и 16" — 2750 и 5890 р.
// Берётся самая узкая группа, где набралось MIN_SAMPLES объявлений с ценой того же
// состояния (новые сравниваются с новыми, б/у и неизвестные — между собой).

const store = require('./store');
const { chipFromText, memoryFromText, gbLabel, screenSize, appleModelFromText, normalizeSsd } = require('./details');

const MIN_SAMPLES = 3;
const MAX_ACTIVE_AGE_DAYS = 90; // старые «висяки» в медиану активных не берём
const HAGGLE_PCT = 10;          // цены в объявлениях — запрос продавца; реальная сделка обычно ниже примерно на столько
const MIN_PRICE_BYN = 100;      // «1 р.» и «обмен» — не цена; в медиану не берём
const SUSPICIOUS_PCT = -30;     // ниже этого от медианы — чаще всего дефект, запчасти или обмен, а не находка
const LIQUIDITY_DAYS = 14;      // окно для строки «похожие уходят за N дней»

function parseModel(title) {
  const t = (title || '').toLowerCase().replace(/ё/g, 'е');
  const m = {};
  // кириллицу тоже понимаем: «макбук эйр», «макбук про»; «airpods pro» в заголовке — не линейка
  if (/\bair\b|эйр|эир/.test(t.replace(/airpods/g, ''))) m.line = 'air';
  else if (/macbook\s*pro|макбук\s*про|\bpro\s*(11|13|14|15|16)|\b(13|14|15|16)\s*pro\b|\bm[1-5]\s*pro\b|\bpro\b/.test(t.replace(/(iphone|airpods|ipad)\s*\d*\s*pro/g, ''))) m.line = 'pro';
  const chip = chipFromText(t);
  if (chip) m.chip = chip;
  const year = t.match(/\b(20(?:0[6-9]|1[0-9]|2[0-9]))\b/);
  if (year) m.year = year[1];
  const size = t.match(/\b(?:air|pro|эйр|про)\s*(11|12|13|14|15|16)(?:[.,]\d)?\b/) || t.match(/\b(11|12|13|14|15|16)(?:[.,]\d)?\s*(?:''|"|”|дюйм|-?inch)/)
    // «MacBook 14 M3», «макбук 16 2019» — число сразу после названия, но не память («MacBook 16/512», «macbook 16 гб»)
    || t.match(/(?:macbook|макбук)\s*(11|12|13|14|15|16)(?:[.,]\d)?(?!\d|\s*\/|\s*(?:gb|гб|g\b|tb|тб))/);
  if (size) m.size = size[1];
  // номер модели Apple заполняет то, чего в заголовке не было
  const am = appleModelFromText(t);
  if (am) {
    if (!m.line && am.line !== 'macbook') m.line = am.line;
    if (!m.size) m.size = am.size;
    if (!m.year) m.year = am.year;
  }
  return m;
}

// Merge title-derived model with parsed details (details win)
// base (M1…M5) | pro (Mx Pro) | max (Mx Max/Ultra) | null for Intel/unknown
function chipTier(chip) {
  if (!chip || chip === 'Intel') return null;
  if (/Max|Ultra/.test(chip)) return 'max';
  if (/Pro/.test(chip)) return 'pro';
  return 'base';
}

function describe(title, details) {
  const m = parseModel(title);
  const mem = memoryFromText(title);
  let ramGb = (details && details.ramGb) || mem.ramGb || null;
  // страховка от старых строк listing_details, где «8 ГБ» записано как 8192
  if (ramGb && ramGb >= 1024) ramGb = Math.round(ramGb / 1024);
  const chip = (details && details.chip) || m.chip || null;
  const size = (details && screenSize(details.screenIn)) || m.size || null;
  let line = m.line || null;
  // Линейка не написана («MacBook M1 Max 16 32/512»): чипы Pro/Max и экраны 14"/16" бывают только
  // у MacBook Pro, 11" — только у Air. Без этого M1 Max сравнивался с обычным M1.
  if (!line) {
    const tier = chipTier(chip);
    if (tier === 'pro' || tier === 'max' || size === '14' || size === '16') line = 'pro';
    else if (size === '11') line = 'air';
  }
  return {
    line,
    chip,
    year: m.year || (details && details.year ? String(details.year) : null),
    size,
    ramGb,
    ssdGb: normalizeSsd((details && details.ssdGb) || mem.ssdGb || null),
    condition: (details && details.condition) || null,
  };
}

function lineLabel(line) {
  return line ? `MacBook ${line === 'air' ? 'Air' : 'Pro'}` : 'MacBook';
}

// Ordered [{key, label}] from most specific to broadest.
//
// Уровни «вся линейка» и «вся категория» убраны намеренно: на них M1 Max за 5 400 р.
// сравнивался с Intel 2015 за 1 000 р. и получал «на 440% выше рынка». Лучше не дать
// сводку вовсе, чем дать такую. Запасные уровни теперь — та же эпоха (Apple Silicon
// или Intel) той же линейки, сначала с той же диагональю.
function groupKeys(d) {
  const keys = [];
  const line = d.line || 'unknown';
  const L = lineLabel(d.line);
  const silicon = Boolean(d.chip && d.chip !== 'Intel');
  const intel = d.chip === 'Intel' || (!d.chip && d.year && Number(d.year) <= 2020);
  const sz = d.size ? { key: '|' + d.size + '"', label: ' ' + d.size + '"' } : null;
  const mem = d.ramGb && d.ssdGb ? { key: '|' + d.ramGb + '/' + d.ssdGb, label: ' ' + gbLabel(d.ramGb) + '/' + gbLabel(d.ssdGb) } : null;
  const push = (key, label) => keys.push({ key, label });

  if (silicon) {
    // чип задаёт модель почти целиком: чип+экран+память → чип+экран → чип+память → чип → все M-чипы линейки (с экраном, без)
    const base = { key: line + '|' + d.chip, label: L + ' ' + d.chip };
    if (sz && mem) push(base.key + sz.key + mem.key, base.label + sz.label + mem.label);
    if (sz) push(base.key + sz.key, base.label + sz.label);
    if (mem) push(base.key + mem.key, base.label + mem.label);
    push(base.key, base.label);
    // запасной уровень — по классу чипа: базовые M-чипы, Pro и Max живут в разных ценовых мирах
    const tier = chipTier(d.chip);
    const tierLabel = { base: 'Apple Silicon', pro: 'Apple Silicon Pro', max: 'Apple Silicon Max' }[tier];
    if (sz) push(line + '|silicon-' + tier + sz.key, L + ' ' + tierLabel + sz.label);
    push(line + '|silicon-' + tier, L + ' ' + tierLabel);
    if (tier !== 'base') push(line + '|silicon-promax', L + ' Apple Silicon Pro/Max');
  } else if (d.year) {
    // Intel (или чип неизвестен, но год есть): год+экран+память → год+экран → Intel+экран → год → Intel
    const base = { key: line + '|y' + d.year, label: L + ' ' + d.year };
    if (sz && mem) push(base.key + sz.key + mem.key, base.label + sz.label + mem.label);
    if (sz) push(base.key + sz.key, base.label + sz.label);
    if (sz && intel) push(line + '|intel' + sz.key, L + ' Intel' + sz.label);
    push(base.key, base.label);
    if (intel) push(line + '|intel', L + ' Intel');
  } else if (intel) {
    if (sz && mem) push(line + '|intel' + sz.key + mem.key, L + ' Intel' + sz.label + mem.label);
    if (sz) push(line + '|intel' + sz.key, L + ' Intel' + sz.label);
    push(line + '|intel', L + ' Intel');
  }
  // ни чипа, ни года — сравнивать не с чем; лучше без сводки
  return keys;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// listing: { title, details? }. Returns null when there is not enough data.
async function getMarketStats(monitorKey, listing, excludeListingId = null) {
  const rows = await store.getMarketRows(monitorKey);
  const cutoff = Date.now() - MAX_ACTIVE_AGE_DAYS * 86400e3;
  const target = describe(listing.title, listing.details);
  const targetNew = target.condition === 'new';

  // Listings seeded at monitor start have an unknown real posting date: skip them in liquidity
  const seedCut = Math.min(...rows.map((r) => new Date(r.first_seen).getTime())) + 2 * 3600e3;
  const liqCut = Date.now() - LIQUIDITY_DAYS * 86400e3;

  const indexed = rows
    .filter((r) => r.id !== excludeListingId && r.price_byn != null && parseFloat(r.price_byn) >= MIN_PRICE_BYN)
    .map((r) => {
      const d = describe(r.title, {
        chip: r.chip, ramGb: r.ram_gb, ssdGb: r.ssd_gb, condition: r.condition, year: r.year,
        screenIn: r.screen_in != null ? parseFloat(r.screen_in) : null,
      });
      const firstSeen = new Date(r.first_seen).getTime();
      return {
        price: parseFloat(r.price_byn),
        sold: r.status === 'inactive',
        fresh: new Date(r.last_seen).getTime() >= cutoff,
        isNew: d.condition === 'new',
        keys: new Set(groupKeys(d).map((k) => k.key)),
        recent: firstSeen >= liqCut && firstSeen > seedCut,
        daysToGone: r.gone_at ? (new Date(r.gone_at).getTime() - firstSeen) / 86400e3 : null,
      };
    })
    .filter((r) => r.isNew === targetNew);

  for (const g of groupKeys(target)) {
    const inGroup = indexed.filter((r) => r.keys.has(g.key));
    const active = inGroup.filter((r) => !r.sold && r.fresh).map((r) => r.price);
    const sold = inGroup.filter((r) => r.sold).map((r) => r.price);
    if (active.length + sold.length < MIN_SAMPLES) continue;
    const recent = inGroup.filter((r) => r.recent);
    const gone = recent.filter((r) => r.sold && r.daysToGone != null);
    return {
      label: `${g.label}, ${targetNew ? 'новые' : 'б/у'}`,
      activeN: active.length,
      activeMedian: median(active),
      soldN: sold.length,
      soldMedian: median(sold),
      // reference price: sold listings once there are enough, otherwise everything on the market
      refMedian: sold.length >= MIN_SAMPLES ? median(sold) : median([...active, ...sold]),
      refSource: sold.length >= MIN_SAMPLES ? 'sold' : 'all',
      // liquidity: how the same group behaved over the last LIQUIDITY_DAYS
      liquidity: { days: LIQUIDITY_DAYS, appeared: recent.length, gone: gone.length, medianDays: median(gone.map((r) => r.daysToGone)) },
    };
  }
  return null;
}

function fmt(n) {
  return `${Math.round(n).toLocaleString('ru')} р.`;
}

// Text block for the Telegram caption (HTML). Empty string when no data.
function formatMarketBlock(stats, priceByn) {
  if (!stats) return '';
  const lines = [`📊 Рынок (${stats.label}):`];
  if (stats.activeN) lines.push(`• в продаже: медиана ${fmt(stats.activeMedian)} по ${stats.activeN} объявл.`);
  if (stats.soldN) lines.push(`• продано: медиана ${fmt(stats.soldMedian)} по ${stats.soldN} объявл.`);
  // «1 р.» при обмене — не цена: медианы показываем, сравнение с ней нет
  if (priceByn != null && priceByn >= MIN_PRICE_BYN && stats.refMedian) {
    const pct = Math.round(((priceByn - stats.refMedian) / stats.refMedian) * 100);
    const base = stats.refSource === 'sold' ? 'проданных' : 'рынка';
    if (Math.abs(pct) < 3) lines.push(`➡️ В рынке (медиана ${base})`);
    else if (pct < 0) lines.push(`🟢 На ${-pct}% ниже медианы ${base}`);
    else lines.push(`🔴 На ${pct}% выше медианы ${base}`);
    if (pct <= SUSPICIOUS_PCT) lines.push('⚠️ Слишком дёшево для группы: проверьте описание (дефект, запчасти, обмен)');
    lines.push(`🤝 Ориентир сделки с торгом −${HAGGLE_PCT}%: ~${fmt(stats.refMedian * (1 - HAGGLE_PCT / 100))}`);
  }
  const liq = stats.liquidity;
  if (liq && liq.appeared >= MIN_SAMPLES) {
    const speed = liq.medianDays != null ? `, обычно за ~${liq.medianDays < 1 ? 'сутки' : Math.round(liq.medianDays) + ' дн.'}` : '';
    lines.push(`⏱ Похожих за ${liq.days} дн.: ${liq.appeared}, ушло ${liq.gone}${speed}`);
  }
  return '\n' + lines.join('\n') + '\n';
}

// Deviation shown to the user, or null when the price is not a real one
function deviationPct(stats, priceByn) {
  if (!stats || !stats.refMedian || priceByn == null || priceByn < MIN_PRICE_BYN) return null;
  return Math.round(((priceByn - stats.refMedian) / stats.refMedian) * 100);
}

module.exports = { parseModel, describe, groupKeys, median, getMarketStats, formatMarketBlock, deviationPct, MIN_SAMPLES, MIN_PRICE_BYN };
