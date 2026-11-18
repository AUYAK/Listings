// Оценка монеты: цены источников (архив проходов gdenashel.ru, Numista) и наша медиана по похожим лотам
// того же состояния. В нашей базе ориентир — только завершённые торги ay.by того же номинала и года (≥ MIN_SAMPLES);
// цены «купить сейчас» и Kufar — сколько просят, а не сколько платят, они в карточке только для справки.
// Ориентир для «выгодно/нет»:
//   1) наши продажи за последние 12 месяцев (≥ MIN_SAMPLES) — тот же рынок и свежие цены, главнее архива;
//   2) иначе самый низкий из источников с ТОЧНЫМ состоянием лота (наши продажи за любое время — тоже источник);
//   3) иначе ближайшее состояние ниже из каталогов; если нет и его — лот только сохраняется.
// Слабы оцениваются отдельно: только по слабам той же корзины грейда (MS63, MS64, MS65…), а не по сырой UNC.

const { groupKeys, GRADE_ORDER, slabFrom, SLAB_RAW_EQUIV, COPY_SECTION } = require('./parse');

// «Выгодно» — либо разница с ориентиром не меньше BARGAIN_BYN рублей (дорогие лоты: 50 р. с лота за 300 р. — уже
// интересно, хотя это лишь 17%), либо лот дешевле ориентира на BARGAIN_PCT процентов и при этом разница
// не меньше BARGAIN_MIN_BYN (чтобы 30% от монеты за 12 р. не считались выгодой).
const BARGAIN_PCT = parseInt(process.env.COINS_BARGAIN_PCT || '30', 10);
const BARGAIN_BYN = parseFloat(process.env.COINS_BARGAIN_BYN || '50');
const BARGAIN_MIN_BYN = parseFloat(process.env.COINS_BARGAIN_MIN_BYN || '10');
const MIN_SAMPLES = 3;
const MIN_PRICE = 2; // ставки «с рубля» без ставок — не цена
const RECENT_DAYS = 365;
// Слаб дешевле этого — цена почти целиком стоимость слабирования (10–20 коп. 1915 в слабе стоят 45–60 р. при любом грейде)
const SLAB_MIN_BYN = parseFloat(process.env.COINS_SLAB_MIN_BYN || '60');
// Продавцы завышают состояние: «II+ (AU)» на ay.by чаще оказывается XF, а то и VF. Сырую монету с состоянием со слов
// продавца (поле ay.by, заголовок) сравниваем с каталогами на GRADE_DISCOUNT ступеней ниже. Наша база — по заявленному
// состоянию: там те же продавцы и то же завышение, покупатели его уже учли в цене. Слабам и оценке по фото верим.
const GRADE_DISCOUNT = parseInt(process.env.COINS_GRADE_DISCOUNT || '1', 10);
// Тихий лот: аукцион, до конца ≤ QUIET_HOURS, ставок ≤ QUIET_MAX_BIDS, минимальная цена продавца не мешает,
// ориентир ≥ QUIET_MIN_REF. Так покупают опытные продавцы: одна ставка на лот, за который никто не торгуется.
const QUIET_HOURS = parseFloat(process.env.COINS_QUIET_HOURS || '24');
const QUIET_MAX_BIDS = parseInt(process.env.COINS_QUIET_MAX_BIDS || '1', 10);
const QUIET_MIN_REF = parseFloat(process.env.COINS_QUIET_MIN_REF || '30');

// Тысячи через обычный пробел (toLocaleString('ru') ставит узкий неразрывный U+202F, он ломает сравнение строк)
const num = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Цена лота для статистики: продажа на ay.by (sold) или цена, которую просят (фикс-цена ay.by, Kufar — в том числе
// пропавшее объявление: его могли снять и без продажи). Текущая ставка идущего аукциона не берётся: 9 р. за сутки
// до конца — не цена монеты
function usablePrice(r) {
  if (r.outcome === 'sold' && r.source !== 'kufar') return { price: parseFloat(r.final_price ?? r.current_price), sold: true };
  if (r.outcome) return null; // не продан / снят — цена ничего не говорит
  if (r.sale_type === 'auction' || r.sale_type === 'auction_buynow') return null;
  const p = parseFloat(r.current_price);
  return p >= MIN_PRICE ? { price: p, sold: false } : null;
}

// Разбор строки базы. У лотов, сохранённых до разбора слабов, slab нет — восстанавливаем по заголовку,
// иначе слаб MS65 за 900 р. попадал в медиану сырой UNC
function rowParsed(r) {
  const p = typeof r.parsed === 'string' ? JSON.parse(r.parsed) : r.parsed;
  if (p && p.slab === undefined) p.slab = slabFrom(r.title || '', '');
  // лоты из раздела «Копии, новоделы», сохранённые до пометки по разделу, — тоже копии, в медиану не идут
  if (p && COPY_SECTION.test(r.category_path || '') && !(p.flags || []).includes('копия')) p.flags = [...(p.flags || []), 'копия'];
  return p;
}

const bucketOf = (p) => (p && p.slab && p.slab.bucket) || null;

// Наша оценка: медиана продаж по той же группе и тому же состоянию (для слаба — той же корзине грейда);
// группа расширяется (буквы → год), пока не наберётся MIN_SAMPLES продаж — тогда refMedian. «Правление» (любой год)
// ориентиром не бывает. Нет продаж — возвращается первая группа хотя бы с MIN_SAMPLES лотами, для справки
// (refMedian = null, askMedian — сколько просят). recent — продажи за последние RECENT_DAYS дней.
function marketEstimate(rows, parsed, excludeId = null, now = Date.now()) {
  const bucket = bucketOf(parsed);
  if (!bucket && (parsed.slab && parsed.slab.details)) return null; // «UNC details» — не с чем сравнить
  if (!bucket && !parsed.grade) return null;
  const since = now - RECENT_DAYS * 86400e3;
  const candidates = [];
  // лот ay.by может вести и раздел, и монитор продавцов — одна продажа считается один раз (берём копию с итогом)
  const keyOf = (r) => (r.external_id != null ? `${r.source}|${r.external_id}` : null);
  const best = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k && (!best.has(k) || (!best.get(k).outcome && r.outcome))) best.set(k, r);
  }
  for (const r of rows) {
    if (r.id === excludeId || !r.parsed) continue;
    const k = keyOf(r);
    if (k && best.get(k) !== r) continue;
    const p = rowParsed(r);
    if (bucket ? bucketOf(p) !== bucket : (p.slab || r.grade !== parsed.grade)) continue;
    const up = usablePrice(r);
    if (!up || !(up.price > 0)) continue;
    if (p.flags && (p.flags.includes('копия') || p.flags.includes('несколько монет'))) continue;
    const at = r.ended_at || r.last_seen;
    const recent = up.sold && at != null && new Date(at).getTime() >= since;
    candidates.push({ ...up, recent, keys: new Set(groupKeys(p).map((k) => k.key)) });
  }
  let info = null;
  for (const g of groupKeys(parsed)) {
    const inGroup = candidates.filter((c) => c.keys.has(g.key));
    if (inGroup.length < MIN_SAMPLES) continue;
    const sold = inGroup.filter((c) => c.sold).map((c) => c.price);
    const asking = inGroup.filter((c) => !c.sold).map((c) => c.price);
    const recent = inGroup.filter((c) => c.recent).map((c) => c.price);
    const res = {
      label: g.label, level: g.level, grade: bucket ? `слаб ${bucket}` : parsed.grade, n: inGroup.length,
      soldN: sold.length, soldMedian: median(sold), askN: asking.length, askMedian: median(asking),
      refMedian: g.level !== 'ruler' && sold.length >= MIN_SAMPLES ? median(sold) : null,
      recentN: recent.length, recentMedian: median(recent),
    };
    if (res.refMedian != null) return res;
    info ||= res;
  }
  return info;
}

// Состояние, по которому смотреть каталоги: заявленное продавцом — на discount ступеней ниже (не ниже G; PF не трогаем)
function catalogGrade(parsed, discount = GRADE_DISCOUNT) {
  const g = parsed.grade;
  if (!g || !discount || parsed.slab || g === 'PF' || !['ayby', 'title'].includes(parsed.gradeSource)) return g;
  const i = GRADE_ORDER.indexOf(g);
  return i < 0 ? g : GRADE_ORDER[Math.max(0, i - discount)];
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
  if (passes != null) reasons.push(`${passes} прох. за ${String(windowYears).replace('.', ',')} г.`);
  return { ...TIERS[level], konros: konros || null, mintage: mintage || null, passes, reason: reasons.join(' · ') };
}

const sumSamples = (samples) => samples ? Object.values(samples).reduce((s, n) => s + (n || 0), 0) : null;

// Годы, за которые реально есть цены: «2023–2025» (архив прячет цены последних ~12 месяцев, окно «3 года» врёт)
function periodLabel(period) {
  if (!period || !period.from || !period.to) return null;
  const a = String(period.from).slice(0, 4), b = String(period.to).slice(0, 4);
  return a === b ? a : `${a}–${b}`;
}
// Длина периода в годах (для частоты проходов); без периода — заявленное окно
function periodYears(period, fallback) {
  if (!period || !period.from || !period.to) return fallback || null;
  const y = (new Date(period.to) - new Date(period.from)) / (365.25 * 86400e3);
  return Math.max(0.5, Math.round(y * 10) / 10);
}

// Цена, ниже которой лот дорогого типа скорее копия, чем удача: ориентир ≥ SUSPECT_MIN_REF р., цена ≤ SUSPECT_SHARE
// от ориентира. Проверяется только для фиксированных цен — ставка 9 р. в начале аукциона ничего не значит
const SUSPECT_MIN_REF = 100;
const SUSPECT_SHARE = 0.2;

const catalogEntry = (c, cp) => ({ ...cp, source: c.source, title: c.title, samples: c.samples ? c.samples[cp.grade] : null,
  passes: sumSamples(c.samples), windowYears: c.windowYears || null, period: c.period || null, factor: c.factor });

// metal — { metal, grams, value } из coins/metal.js: стоимость металла в монете, нижняя планка при любом состоянии.
// fixedPrice — цена фиксированная (купить сейчас / Kufar), а не текущая ставка аукциона.
function assess({ parsed, price, rows = [], excludeId = null, catalog = null, catalogs = null, coinType = null, metal = null, fixedPrice = false, gradeDiscount = GRADE_DISCOUNT, bargainPct = BARGAIN_PCT, bargainByn = BARGAIN_BYN, minByn = BARGAIN_MIN_BYN, now = Date.now() }) {
  const market = marketEstimate(rows, parsed, excludeId, now);
  const list = catalogs || (catalog ? [catalog] : []);
  const bucket = bucketOf(parsed);
  const slabDetails = Boolean(parsed.slab && parsed.slab.details && !bucket);
  const catGrade = catalogGrade(parsed, gradeDiscount);
  let cats = [];
  if (bucket) {
    // слаб: только та же корзина; нижние корзины (MS60–62, AU50–58…) по цене ≈ сырая монета — её и берём, если слабов нет
    cats = list.filter((c) => c.prices && c.prices[bucket] != null).map((c) => catalogEntry(c, { price: c.prices[bucket], grade: bucket, exact: true }));
    const rawEq = SLAB_RAW_EQUIV[bucket];
    if (!cats.length && rawEq) {
      cats = list.map((c) => { const cp = catalogPrice(c, rawEq); return cp && cp.exact ? { ...catalogEntry(c, cp), rawEquiv: bucket } : null; }).filter(Boolean);
    }
  } else if (!slabDetails) {
    cats = list.map((c) => { const cp = catalogPrice(c, catGrade); return cp ? catalogEntry(c, cp) : null; }).filter(Boolean);
  }
  const cat = cats[0] || null;
  // Ориентир — свежие продажи нашей базы, иначе самый низкий из источников с точным состоянием лота (сравнивать VF
  // с «ближайшим XF» нельзя); ближайшее состояние ниже — только если точного нет ни у кого. Минимум, а не первый
  // источник: архив РФ даёт больше, чем стоит монета у нас, и «выгодно» по завышенному ориентиру ничего не стоит
  let reference = null, referenceSource = null, referenceRecent = false;
  // свежие продажи главнее архива только по тому же номиналу и году: медиана «рубль Николая II» за любой год
  // не заменяет цену конкретного 1899 года
  if (market && market.refMedian != null && market.recentN >= MIN_SAMPLES) {
    reference = market.recentMedian; referenceSource = 'market'; referenceRecent = true;
  } else {
    const asCandidate = (c) => ({ price: c.price, source: c.source });
    const exact = [...cats.filter((c) => c.exact).map(asCandidate), ...(market && market.refMedian != null ? [{ price: market.refMedian, source: 'market' }] : [])];
    const candidates = (exact.length ? exact : cats.map(asCandidate)).filter((c) => c.price > 0).sort((a, b) => a.price - b.price);
    reference = candidates.length ? candidates[0].price : null;
    referenceSource = candidates.length ? candidates[0].source : null;
  }
  // Слабы MS64 по тому же типу — для справки при сырых UNC/AU-лотах: сколько стоила бы монета в слабе
  // ('MS64+' — каталог, пересчитанный до разбивки на корзины)
  const slabbedSrc = !parsed.slab && ['UNC', 'AU'].includes(parsed.grade) ? list.find((c) => c.prices && (c.prices.MS64 != null || c.prices['MS64+'] != null)) : null;
  const slabbedKey = slabbedSrc && (slabbedSrc.prices.MS64 != null ? 'MS64' : 'MS64+');
  const slabbed = slabbedSrc ? { source: slabbedSrc.source, grade: slabbedKey, price: slabbedSrc.prices[slabbedKey], samples: slabbedSrc.samples ? slabbedSrc.samples[slabbedKey] : null, windowYears: slabbedSrc.windowYears || null, period: slabbedSrc.period || null } : null;
  // Похожие продажи: список для карточки; если другого ориентира нет, а продаж той же монеты или серии в том же
  // не меньше SIMILAR_MIN — их медиана и есть ориентир (уровень «тот же вес» ориентиром не становится)
  const similar = similarSales(rows, parsed, { excludeId, fine: metal && metal.grams > 0 && !metal.bulk ? metal.grams : null });
  if (reference == null && similar && similar.tier <= 1 && similar.sameGradeN >= SIMILAR_MIN) {
    reference = similar.ref; referenceSource = 'similar';
  }
  const hasPrice = price != null && price >= MIN_PRICE;
  const deviationPct = reference && hasPrice ? Math.round(((price - reference) / reference) * 100) : null;
  const gainByn = reference && hasPrice ? Math.round(reference - price) : null;
  const gd = list.find((c) => c.source === 'gdenashel');
  const gdYears = gd ? periodYears(gd.period, gd.windowYears) : null;
  const rarity = coinType || gd ? rarityTier({ konros: coinType && coinType.konros, mintage: coinType && coinType.mintage, passes: gd ? sumSamples(gd.samples) : null, windowYears: gdYears }) : null;
  // Металл: не медиана, а пол. Он не участвует в выборе ориентира (иначе VF-рубль за 100 р. выглядел бы «выше
  // ориентира 85 р.»), но лот ниже металла на порог выгоды — выгоден при любом состоянии
  const metalValue = metal && metal.value > 0 ? metal.value : null;
  const belowMetal = metalValue != null && hasPrice && isBargain({ price, reference: metalValue, bargainPct, bargainByn, minByn });
  const metalGain = metalValue != null && hasPrice ? Math.round(metalValue - price) : null;
  // слаб дешёвой монеты: вся цена — стоимость слабирования, перепродать дороже не выйдет
  const slabCheap = Boolean(parsed.slab) && reference != null && reference < SLAB_MIN_BYN;
  const byReference = !slabCheap && isBargain({ price, reference, bargainPct, bargainByn, minByn });
  const suspect = fixedPrice && hasPrice && reference >= SUSPECT_MIN_REF && price <= reference * SUSPECT_SHARE;
  return {
    market, catalog: cat, catalogs: cats, slabbed,
    gradeDeclared: parsed.grade || null, gradeForCatalog: catGrade !== parsed.grade && cats.length ? catGrade : null, rarity, slab: parsed.slab || null, slabCheap, slabDetails,
    reference, referenceSource, referenceRecent, deviationPct, gainByn,
    metal: metalValue != null ? { ...metal, gain: metalGain, below: belowMetal } : null,
    suspect,
    similar,
    isBargain: byReference || belowMetal,
    bargainPct, bargainByn, minByn,
  };
}

// Тихий лот: аукцион без конкуренции под конец торгов. Цена «с рубля» здесь не мешает — смысл как раз в том, чтобы
// забрать его одной ставкой. Возвращает { ref, max, refSource, hoursLeft } или null. max — разумная максимальная
// ставка: ориентир минус BARGAIN_PCT (тот же порог, что и «выгодно»).
function quietLot(est, lot, { now = Date.now(), hours = QUIET_HOURS, maxBids = QUIET_MAX_BIDS, minRef = QUIET_MIN_REF, pct = BARGAIN_PCT } = {}) {
  if (!est || !lot || lot.ended || !/auction/.test(lot.saleType || '')) return null;
  if ((lot.bids || 0) > maxBids || lot.reserve === 'not_met' || est.slabCheap) return null;
  const hoursLeft = lot.endsAt ? (new Date(lot.endsAt).getTime() - now) / 3600e3 : null;
  if (hoursLeft == null || hoursLeft <= 0 || hoursLeft > hours) return null;
  const fromMetal = est.reference == null && est.metal;
  const ref = est.reference != null ? est.reference : fromMetal ? est.metal.value : null;
  if (!(ref >= minRef)) return null;
  const max = Math.floor(ref * (1 - pct / 100));
  if ((lot.price || 0) > max) return null;
  return { ref, max, refSource: fromMetal ? 'metal' : est.referenceSource, hoursLeft };
}

// ---- Похожие продажи ay.by: что показать в карточке рядом с лотом ----
// Уровень сходства: 0 — тот же тип (номинал и год, как в медиане базы); 1 — тот же номинал той же серии (правитель,
// период Германии: Империя / Веймар / Рейх, страна ± 20 лет); 2 — тот же металл и чистый вес ± 15% (цена серебра
// в монетах такого размера). Слабы сравниваются только со слабами. Берётся лучший уровень, где что-то есть.
// Состояние со слов продавца в расчёт не берётся: оно случайно в обе стороны («VF» на UNC и «AU в блеске» на затёртой
// монете), сравнивать — по фото ближайших продаж. Медиана — по всем продажам уровня; у слабов — по той же корзине
// грейда (ему верим). В списке — ближайшие по цене к медиане (продажа за 600 р. рядом с лотом на 170 р. ничего
// не говорит), та же монета раньше серии, затем свежие.
const SIMILAR_MIN = 3;      // столько продаж нужно, чтобы медиана похожих стала ориентиром (решение о цене — за человеком)
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
const SIMILAR_SHOWN = 5;
const dePeriod = (y) => (y <= 1918 ? 1 : y <= 1933 ? 2 : 3);
const SKIP_FLAGS = ['копия', 'несколько монет', 'не монета'];

function similarSales(rows, parsed, { excludeId = null, fine = null, limit = SIMILAR_SHOWN } = {}) {
  if (!parsed || (parsed.flags || []).some((f) => SKIP_FLAGS.includes(f))) return null;
  const own = groupKeys(parsed);
  const ownKeys = new Set(own.filter((k) => k.level !== 'ruler').map((k) => k.key));
  const rulerKey = (own.find((k) => k.level === 'ruler') || {}).key || null;
  const slab = Boolean(parsed.slab);
  const seen = new Set();
  const found = [];
  for (const r of rows) {
    // лот могут вести два монитора (раздел и продавец) — одна продажа показывается один раз
    const dup = r.external_id != null ? `${r.source}|${r.external_id}` : null;
    if (r.id === excludeId || !r.parsed || r.outcome !== 'sold' || r.source === 'kufar' || (dup && seen.has(dup))) continue;
    const price = parseFloat(r.final_price);
    if (!(price >= MIN_PRICE)) continue;
    const p = rowParsed(r);
    if (!p || Boolean(p.slab) !== slab || p.metal !== parsed.metal) continue;
    if ((p.flags || []).some((f) => SKIP_FLAGS.includes(f))) continue;
    const keys = groupKeys(p);
    const rowFine = parseFloat(r.fine_g);
    let tier = null;
    // марки одного года и номинала у разных земель — разные монеты («3 марки 1910» Бадена и Саксен-Веймара): серия
    const otherState = parsed.foreign && p.foreign && parsed.foreign.state && p.foreign.state && parsed.foreign.state !== p.foreign.state;
    if (keys.some((k) => k.level !== 'ruler' && ownKeys.has(k.key))) tier = otherState ? 1 : 0;
    else if (rulerKey && keys.some((k) => k.key === rulerKey)) tier = 1;
    else if (parsed.foreign && p.foreign && parsed.foreign.key === p.foreign.key && parsed.year && p.year && dePeriod(parsed.year) === dePeriod(p.year)) tier = 1;
    else if (parsed.world && p.world && parsed.world.country && p.world.country === parsed.world.country && p.world.unit === parsed.world.unit
      && p.world.value === parsed.world.value && parsed.year && p.year && Math.abs(p.year - parsed.year) <= 20) tier = 1;
    // по весу — только иностранные между собой: рубли Империи и марки Германии того же веса стоят дороже серебра
    // (канадский доллар на 18,66 г рядом с рублём Николая II за 176 р. ничего не говорит)
    else if (fine > 0 && rowFine > 0 && Math.abs(rowFine - fine) / fine <= 0.15
      && parsed.denomKop == null && !parsed.foreign && p.denomKop == null && !p.foreign) tier = 2;
    // серия с другим весом металла — другая монета: полдоллара США 1952 (11,25 г серебра) и Кеннеди 1965–1970 (4,6 г)
    if (tier === 1 && fine > 0 && rowFine > 0 && Math.abs(rowFine - fine) / fine > 0.15) tier = null;
    if (tier == null) continue;
    if (dup) seen.add(dup);
    const gdist = slab ? (bucketOf(p) === bucketOf(parsed) ? 0 : 1) : 0; // сырые монеты — состояние не учитывается
    found.push({
      tier, gdist, price, at: r.ended_at ? new Date(r.ended_at).getTime() : 0, bids: r.final_bids || 0, title: r.title || '', url: r.url || null,
      grade: p.slab ? `слаб ${[p.slab.company, p.slab.grade].filter(Boolean).join(' ') || '?'}` : r.grade || '?',
    });
  }
  if (!found.length) return null;
  let tier = Math.min(...found.map((f) => f.tier));
  let pool = found.filter((f) => f.tier === tier);
  // той же монеты продано мало (в том же состоянии — меньше SIMILAR_MIN): одна-две продажи не ориентир, считаем вместе
  // с серией — «3 марки 1912» с единственной продажей рядом с девятью продажами 3 марок Империи
  if (tier === 0 && pool.filter((f) => f.gdist === 0).length < SIMILAR_MIN && found.some((f) => f.tier === 1)) {
    tier = 1;
    pool = found.filter((f) => f.tier <= 1);
  }
  const g0 = Math.min(...pool.map((f) => f.gdist));
  const nearest = pool.filter((f) => f.gdist === g0);
  // медиана — по всем продажам уровня в ближайшем состоянии, а не только по показанным в карточке
  const ref = median(nearest.map((f) => f.price));
  const off = (f) => Math.abs(Math.log(f.price / ref));
  // в списке та же монета — раньше серии, дальше ближайшие по состоянию и цене
  pool.sort((a, b) => a.gdist - b.gdist || a.tier - b.tier || off(a) - off(b) || b.at - a.at);
  const sorted = nearest.map((f) => f.price).sort((a, b) => a - b);
  // sameGradeN — сколько продаж вошло в медиану (у сырых монет — все продажи уровня); low–high — средняя половина продаж
  return { tier, n: pool.length, ref, sameGradeN: g0 === 0 ? nearest.length : 0, low: quantile(sorted, 0.25), high: quantile(sorted, 0.75), items: pool.slice(0, limit) };
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SIMILAR_WHAT = ['той же монеты', 'того же номинала и серии', 'иностранных монет того же веса металла'];
function similarLines(s) {
  if (!s || !s.items.length) return [];
  const head = `🧾 Похожие продажи ay.by — ${SIMILAR_WHAT[s.tier]}: ${s.n}${s.sameGradeN >= MIN_SAMPLES ? `, медиана ${fmt(s.ref)}${s.sameGradeN >= 4 && s.high > s.low ? `, половина продаж ${num(s.low)}–${fmt(s.high)}` : ''}` : ''}`;
  return [head, ...s.items.map((it) => {
    const day = it.at ? new Date(it.at).toLocaleDateString('ru-BY', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Minsk' }) : '';
    const price = `${String(Math.round(it.price * 100) / 100).replace('.', ',')} р.`;
    const name = escHtml(it.title.replace(/\s+/g, ' ').trim().slice(0, 34));
    return ` • ${it.url ? `<a href="${it.url}">${price}</a>` : price}${day ? ` · ${day}` : ''} · ${escHtml(it.grade)}${it.bids ? ` · ${it.bids} ст.` : ''}${name ? ` · ${name}` : ''}`;
  })];
}

const fmt = (n) => `${num(n)} р.`;
const SOURCE_NAMES = { gdenashel: 'gdenashel.ru, аукционы РФ', numista: 'Numista' };
const srcName = (s) => SOURCE_NAMES[s] || s;
const passesText = (samples, period, windowYears) => {
  if (!samples) return '';
  const p = periodLabel(period);
  return `, ${samples} прох.${p ? `, ${p}` : windowYears ? ` за ${windowYears} г.` : ''}`;
};

// Строки карточки: каждый источник отдельно, чтобы не смешивать; вердикт — по самому низкому ориентиру
function formatEstimateLines(est) {
  if (!est) return [];
  const lines = [];
  for (const c of est.catalogs || []) {
    const k = c.factor && c.factor !== 1 ? `, ×${c.factor}` : '';
    const g = c.rawEquiv ? `${c.grade} без слаба — слабов ${c.rawEquiv} в архиве нет` : est.slab && est.slab.bucket ? `слаб ${c.grade}` : `${c.grade}${c.exact ? '' : ', ближайшее состояние'}`;
    lines.push(`📚 ${srcName(c.source)} (${g}${passesText(c.samples, c.period, c.windowYears)}${k}): ${fmt(c.price)}`);
  }
  if (est.gradeForCatalog) lines.push(`📉 Каталоги — по ${est.gradeForCatalog}, а не ${est.gradeDeclared}: без слаба состояние обычно завышено`);
  if (est.slabbed) {
    lines.push(`🏛 ${srcName(est.slabbed.source).split(',')[0]}, слабы ${est.slabbed.grade}${passesText(est.slabbed.samples, est.slabbed.period, est.slabbed.windowYears)}: ${fmt(est.slabbed.price)} — для справки, не ориентир`);
  }
  if (est.market) {
    const m = est.market;
    const ask = m.askN ? `; просят ${fmt(m.askMedian)} (${m.askN} лот.) — не ориентир` : '';
    const main = est.referenceRecent ? `${fmt(m.recentMedian)} по ${m.recentN} продажам за 12 мес. — основной ориентир`
      : m.refMedian != null ? `${fmt(m.refMedian)} по ${m.soldN} продажам`
        : `продаж ${m.soldN}${m.soldN ? ` (${fmt(m.soldMedian)})` : ''}${m.level === 'ruler' ? ', все годы' : ''}`;
    lines.push(`📊 Наша база (${m.label}, ${m.grade}): ${main}${ask}`);
  } else if (est.slabDetails) {
    lines.push('📊 Слаб с пометкой details (чистка, повреждения) — с обычными не сравнивается');
  } else if (!est.similar) lines.push(`📊 Наша база: похожих лотов ${est.slab && est.slab.bucket ? `в слабе ${est.slab.bucket}` : 'в этом состоянии'} ещё не было`);
  lines.push(...similarLines(est.similar));
  if (est.rarity) lines.push(`💎 Редкость: ${est.rarity.name} ${est.rarity.emoji}${est.rarity.reason ? ` · ${est.rarity.reason}` : ''}`);
  if (est.metal) {
    const m = est.metal;
    const what = `${String(m.grams).replace('.', ',')} г ${m.metal === 'gold' ? 'золота' : 'серебра'}`;
    const bulk = m.bulk ? `вес лота ${String(m.bulk.grams).replace('.', ',')} г × проба ${String(m.bulk.purity).replace('.', ',')}${m.bulk.purityAssumed ? ' (не указана, считаем билон)' : ''} = ` : '';
    const basis = m.basis ? ` — ${m.basis}` : '';
    lines.push(`⚖️ Металл: ${bulk}${what}${basis} ≈ ${fmt(m.value)}${m.pricePerG ? ` (НБРБ ${String(m.pricePerG).replace('.', ',')} р./г)` : ''}`);
  }
  if (est.metal && est.metal.mismatch) {
    const mm = est.metal.mismatch;
    const g = (n) => String(n).replace('.', ',');
    lines.push(`⚠️ Расхождение: по лоту ${g(mm.stated)} г чистого металла${mm.statedBasis ? ` (${mm.statedBasis})` : ''}, по стандарту монеты ${g(mm.table)} г — считаем по стандарту, проверьте`);
  }
  if (est.metal && est.metal.below) {
    lines.push(`🟢 На ${fmt(est.metal.gain)} ниже стоимости металла — выгодно при любом состоянии`);
  } else if (est.slabCheap) {
    lines.push(`⚪ Слаб дешёвой монеты: ориентир ${fmt(est.reference)} меньше ${fmt(SLAB_MIN_BYN)} — это в основном цена слабирования`);
  } else if (est.deviationPct != null) {
    const base = est.referenceSource === 'market' ? 'нашей базы' : est.referenceSource === 'similar' ? 'похожих продаж' : srcName(est.referenceSource).split(',')[0];
    // медиана похожих продаж считается без состояния — «выгодно» здесь значит «посмотрите фото», а не готовый вывод
    if (est.isBargain && est.referenceSource === 'similar') lines.push(`🟢 На ${-est.deviationPct}% (${fmt(est.gainByn)}) ниже медианы похожих продаж — сравните фото: состояние не учтено`);
    else if (est.isBargain) lines.push(`🟢 На ${-est.deviationPct}% (${fmt(est.gainByn)}) ниже ${base} — выгодно`);
    else if (est.deviationPct < 0) lines.push(`🟡 На ${-est.deviationPct}% (${fmt(est.gainByn)}) ниже ${base}`);
    else lines.push(`🔴 На ${est.deviationPct}% выше ${base}`);
  } else if (!est.reference) {
    lines.push(est.metal ? '⚪ Ориентира по состоянию нет, лот выше стоимости металла' : '⚪ Ориентира пока нет: ни каталога, ни трёх продаж на ay.by');
  }
  if (est.suspect) lines.push('⚠️ Подозрительно дёшево для этого типа — проверить подлинность (копии дорогих монет обычны)');
  return lines;
}

module.exports = {
  assess, isBargain, rarityTier, catalogGrade, marketEstimate, similarSales, similarLines, SIMILAR_MIN, catalogPrice, usablePrice, formatEstimateLines, median, quietLot, periodLabel,
  BARGAIN_PCT, BARGAIN_BYN, BARGAIN_MIN_BYN, MIN_SAMPLES, TIERS, SUSPECT_MIN_REF, SUSPECT_SHARE, SLAB_MIN_BYN,
  QUIET_HOURS, QUIET_MAX_BIDS, QUIET_MIN_REF,
};
