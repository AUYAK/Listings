// Сколько чистого металла в монете, которой нет в таблицах coins/metal.js и вес которой не написан в лоте
// (современные памятные и инвестиционные разных стран: «240 франков Конго 2013 серебро», «1 доллар Ниуэ 2015»).
// Без веса нет стоимости металла, а значит, нет и повода прислать лот — такие лоты раньше молча пропадали.
// Цепочка: кэш → наша база (такая же монета, у которой вес был в тексте лота) → Numista (вес × проба, кандидаты
// по номиналу и году должны совпасть) → модель по тексту лота (только known и confidence high/medium; в карточке
// пометка «проверьте вес»). Ответ и «не нашли» кэшируются в listings.coin_catalog (source='content').
// COINS_CONTENT_LOOKUP=0 — выключить Numista и модель (наша база работает всегда).
const { pool } = require('../store');
const numista = require('./numista');
const vision = require('./vision');
const { fineContent, purityBasis } = require('./metal');

const LOOKUP = process.env.COINS_CONTENT_LOOKUP !== '0';
const MODEL_PER_DAY = parseInt(process.env.COINS_CONTENT_MODEL_PER_DAY || '100', 10); // предел запросов к модели в сутки
const MISS_TTL_DAYS = 30; // «не нашли» — спросить снова через месяц (мог появиться тип в Numista)
const memo = new Map();   // ключ → { at, content } — чтобы не ходить в базу на каждый лот
const MEMO_MS = 3600e3;
let modelDay = '', modelCalls = 0;

// Нужно ли искать: драгметалл, одна монета, а таблицы и текст лота веса не дали
const needsLookup = (parsed) => Boolean(parsed && parsed.isPrecious && !parsed.weight && !parsed.slab
  && !(parsed.flags || []).some((f) => f === 'копия' || f === 'не монета' || f === 'несколько монет') && !fineContent(parsed));

// Ключ кэша: страна + номинал + год, если всё известно; иначе — нормализованный заголовок
function cacheKey(parsed, title) {
  const w = parsed.world;
  if (w && w.country && parsed.year) return `content|${parsed.metal}|${w.country}|${w.unit}|${w.value}|${parsed.year}`;
  const norm = String(title || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\d]+/gu, ' ').trim().slice(0, 120);
  return norm ? `content|${parsed.metal}|${norm}` : null;
}

async function fromCache(key) {
  const res = await pool.query(`SELECT raw, fetched_at FROM listings.coin_catalog WHERE type_key = $1 AND source = 'content'`, [key]);
  const r = res.rows[0];
  if (!r || !r.raw) return undefined;
  if (r.raw.none && Date.now() - new Date(r.fetched_at).getTime() > MISS_TTL_DAYS * 86400e3) return undefined;
  return r.raw.none ? null : { fineGrams: Number(r.raw.fineGrams), basis: r.raw.basis };
}

async function saveCache(key, title, content, extra = {}) {
  await pool.query(
    `INSERT INTO listings.coin_catalog (type_key, source, title, prices, raw, fetched_at)
     VALUES ($1, 'content', $2, '{}'::jsonb, $3, NOW())
     ON CONFLICT (type_key, source) DO UPDATE SET title = EXCLUDED.title, raw = EXCLUDED.raw, fetched_at = NOW()`,
    [key, String(title || '').slice(0, 300), JSON.stringify(content ? { ...content, ...extra } : { none: true, ...extra })]
  );
}

// Наша база: та же страна, номинал и год, вес из текста другого лота (parse.contentFrom). Самый частый вес.
async function fromOurBase(parsed) {
  const w = parsed.world;
  if (!w || !w.country || !parsed.year) return null;
  const res = await pool.query(
    `SELECT (a.parsed->'content'->>'fineGrams')::numeric AS g, count(*)::int AS n
     FROM listings.coin_lots a
     WHERE a.parsed->>'metal' = $1 AND a.parsed->'world'->>'country' = $2 AND a.parsed->'world'->>'unit' = $3
       AND (a.parsed->'world'->>'value')::numeric = $4 AND a.parsed->>'year' = $5
       AND jsonb_typeof(a.parsed->'content') = 'object'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 2`,
    [parsed.metal, w.country, w.unit, w.value, String(parsed.year)]
  );
  const [top, second] = res.rows;
  if (!top || !(Number(top.g) > 0)) return null;
  if (second && second.n >= top.n) return null; // два веса поровну — под номиналом разные монеты
  return { fineGrams: Number(top.g), basis: `по нашей базе (${top.n} лот${top.n === 1 ? '' : top.n < 5 ? 'а' : 'ов'} с весом в описании)` };
}

async function fromModel(parsed, title, description) {
  if (!vision.enabled()) return null;
  const day = new Date().toISOString().slice(0, 10);
  if (day !== modelDay) { modelDay = day; modelCalls = 0; }
  if (modelCalls >= MODEL_PER_DAY) return undefined; // предел на сегодня — не кэшировать как «не нашли»
  modelCalls++;
  const r = await vision.askContent(title, description);
  const a = r.result;
  console.log(`  [Вес] модель: «${title.slice(0, 70)}» → ${a.known ? `${a.fine_g} г (${a.weight_g} г × ${a.purity}, ${a.confidence})` : 'не знает'} · ${a.note.slice(0, 80)} · ≈ $${r.costUsd != null ? r.costUsd.toFixed(4) : '?'}`);
  if (!a.known || a.confidence === 'low' || a.metal !== parsed.metal) return null;
  const fine = a.fine_g > 0 ? a.fine_g : a.weight_g * a.purity;
  if (!(fine >= 0.3 && fine <= 1100)) return null;
  // вес × проба должны сходиться с чистым весом — иначе ответ невнятный
  if (a.weight_g > 0 && a.purity > 0 && Math.abs(a.weight_g * a.purity - fine) / fine > 0.05) return null;
  const how = a.weight_g > 0 && a.purity > 0 ? `, ${purityBasis(a.weight_g, a.purity)}` : '';
  return { fineGrams: Math.round(fine * 100) / 100, basis: `по модели: ${a.coin}${how} — проверьте вес`, guess: true };
}

// { fineGrams, basis } или null. Ошибки источников не роняют оценку: шаг пропускается.
async function resolveContent(parsed, title, description = '') {
  if (!needsLookup(parsed) || !title) return null;
  const key = cacheKey(parsed, title);
  if (!key) return null;
  const m = memo.get(key);
  if (m && Date.now() - m.at < MEMO_MS) return m.content;
  const remember = (content) => { memo.set(key, { at: Date.now(), content }); return content; };

  const cached = await fromCache(key).catch(() => undefined);
  if (cached !== undefined) return remember(cached);

  const base = await fromOurBase(parsed).catch((err) => { console.warn(`  [Вес] база: ${err.message}`); return null; });
  if (base) { await saveCache(key, title, base, { via: 'base' }).catch(() => {}); return remember(base); }
  if (!LOOKUP) return remember(null);

  const nm = await numista.contentFor(parsed).catch((err) => { console.warn(`  [Вес] Numista: ${err.message}`); return undefined; });
  if (nm) { await saveCache(key, title, nm, { via: 'numista' }).catch(() => {}); return remember(nm); }

  const ai = await fromModel(parsed, title, description).catch((err) => { console.warn(`  [Вес] модель: ${err.message}`); return undefined; });
  if (ai) { await saveCache(key, title, ai, { via: 'model' }).catch(() => {}); return remember(ai); }
  if (ai === undefined || nm === undefined) return null; // сбой или предел — спросим в следующий раз, не кэшируем
  await saveCache(key, title, null, { via: 'none' }).catch(() => {});
  return remember(null);
}

module.exports = { resolveContent, needsLookup, cacheKey };
