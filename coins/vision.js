// Оценка монет по фото моделью с распознаванием изображений: что за монета, состояние по шкале G…UNC, чистка,
// дефекты, риск копии, каких фото не хватает. Два провайдера (COINS_VISION_PROVIDER, по умолчанию — чей ключ есть):
//  - anthropic: ANTHROPIC_API_KEY; через шлюз — ещё ANTHROPIC_BASE_URL (или ANTHROPIC_API_URL), ключ шлюза в
//    ANTHROPIC_API_KEY (x-api-key) или ANTHROPIC_AUTH_TOKEN (Bearer).
//    Ответ строго по JSON-схеме (output_config.format). fallbacks: 'default' — при отказе модели (ложное срабатывание
//    фильтров) запрос сам повторится на запасной; через шлюз по умолчанию выключено. COINS_VISION_FALLBACK=1 / 0;
//  - openai: OPENAI_API_KEY, Chat Completions с response_format json_schema (strict), обычным fetch.
// Без ключа модуль выключен. Фото — подсказка с точностью ±1 ступень: мелкие снимки и свет скрывают потёртость,
// вес по фото не проверить.
const Anthropic = require('@anthropic-ai/sdk').default;
const { parseCoin } = require('./parse');
const { BARGAIN_PCT, formatEstimateLines } = require('./market');

const PROVIDER = process.env.COINS_VISION_PROVIDER
  || (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : null);
const MODEL = process.env.COINS_VISION_MODEL || (PROVIDER === 'openai' ? 'gpt-5.5' : 'claude-opus-5-5');
const EFFORT = process.env.COINS_VISION_EFFORT || 'medium';
const BASE_URL = process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_URL || undefined;
const USE_FALLBACK = process.env.COINS_VISION_FALLBACK ? process.env.COINS_VISION_FALLBACK !== '0' : !BASE_URL;
const MAX_PHOTOS = 10; // альбом Telegram и галерея лота — до 10
const OFFER_SHARE = parseFloat(process.env.COINS_OFFER_SHARE || '0.55'); // предложить продавцу: доля ориентира
// $ за 1M токенов (вход, выход) — для строки расхода в ответе; своя цена: COINS_VISION_PRICE=вход,выход
const PRICES = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-opus-4-8': [5, 25] };
const CUSTOM_PRICE = (process.env.COINS_VISION_PRICE || '').split(',').map(parseFloat);

let client = null;
const enabled = () => (PROVIDER === 'openai' ? Boolean(process.env.OPENAI_API_KEY)
  : PROVIDER === 'anthropic' ? Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) : false);
const api = () => (client ||= new Anthropic({ baseURL: BASE_URL }));

const SYSTEM = `Ты опытный нумизмат-оценщик. Тебе присылают фото монет, которые продают на барахолке или аукционе в Беларуси
(чаще всего Российская империя, СССР, Германия, Польша, памятные монеты Нацбанка РБ и Банка России).
По фото определи каждую монету и оцени её состояние так, как это сделал бы осторожный покупатель.

Шкала состояния: G, VG, F, VF, XF, AU, UNC; PF — только для монет чеканки пруф. Оценивай по износу, а не по блеску:
- G: ободок местами слился с полем и легендой, рисунок — только контуры, часть букв стёрта;
- VG: ободок отделён, легенда читается целиком, но слабо; крупные детали видны контуром, мелких нет;
- F: все крупные детали на месте, мелкие (волосы, перья, складки) стёрты, высокие точки плоские;
- VF: мелкие детали видны на большей части рисунка, износ высоких точек заметен, но не сплошной;
- XF: лёгкий износ только на самых высоких точках, почти все мелкие детали чёткие, местами остатки штемпельного блеска;
- AU: следы обращения едва заметны на высших точках, блеск почти полный;
- UNC: износа нет совсем.
Не тяни оценку к середине шкалы: сильно изношенная монета — смело VG или G, почти не ходившая — AU. В grade — одна
ступень, которую ты считаешь самой вероятной; диапазон («VF–XF») — только в grade_range, если сомневаешься.
Если плохо видно — grade: unknown.

Отдельно отметь:
- problems: дырка, запайка, ушко, гнутость, забоины, сильные царапины, коррозия, зелень, выкусы гурта и т. п.
  Чистку не оценивай и в problems не пиши: по фото её не отличить от света и обработки снимка;
- copy_risk и copy_signs: признаки копии или новодела (литьё: пористость, раковины, шов на гурте; «мыльный» рельеф;
  неверный шрифт или детали; неестественный цвет для металла). Если признаков нет — none.
- metal: металл по виду и по типу монеты (silver, gold, copper — медь и бронза до 1961 г., base — никель, латунь,
  алюминий, сталь; unknown, если не определить).

title — как заголовок лота: номинал, год, буквы двора или минцмейстера, если видны («50 копеек 1925»,
«1 рубль 1898 АГ», «5 марок 1936 A»). Год или буквы не видны — так и напиши («20 копеек, год не виден»).
Если на фото много монет (россыпь), перечисли до 8 самых интересных: серебро, золото, редкие годы, хорошая сохранность.

need_more — каких фото не хватает для уверенной оценки (например «гурт рубля», «реверс крупнее», «без вспышки»).
summary — 1–2 предложения по-русски: что это и стоит ли этим заниматься. Все текстовые поля — по-русски.
Подпись от пользователя (если есть) — подсказка: что за монета и сколько за неё просят; проверяй её по фото.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['coins', 'photo_quality', 'need_more', 'summary'],
  properties: {
    coins: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'country', 'metal', 'grade', 'grade_range', 'confidence', 'problems', 'copy_risk', 'copy_signs', 'notes'],
        properties: {
          title: { type: 'string' },
          country: { type: 'string' },
          metal: { type: 'string', enum: ['silver', 'gold', 'copper', 'base', 'unknown'] },
          grade: { type: 'string', enum: ['G', 'VG', 'F', 'VF', 'XF', 'AU', 'UNC', 'PF', 'unknown'] },
          grade_range: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          problems: { type: 'array', items: { type: 'string' } },
          copy_risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
          copy_signs: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
      },
    },
    photo_quality: { type: 'string', enum: ['good', 'fair', 'poor'] },
    need_more: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

// Схема ещё и в тексте инструкции: шлюз может не передать строгий формат ответа, и тогда модель не знает имён полей
const SYSTEM_FULL = `${SYSTEM}\n\nОтвет — один JSON-объект без пояснений и без обёртки \`\`\`, строго по схеме:\n${JSON.stringify(SCHEMA)}`;
const GRADES = SCHEMA.properties.coins.items.properties.grade.enum;

// Поправка по сверке с экспертами аукциона Конрос (46 монет 1731–1995 гг., 11.2026): «VF» модели у эксперта в среднем
// F (между F и VF, иногда VG), «F» — VG–F; XF и выше совпадают. Сдвигаем вниз, чтобы ориентир не завышался.
// Чистку по фото модель не различает (на сверке — угадывание), её не спрашиваем. COINS_VISION_CALIBRATE=0 — без поправки.
const CALIBRATE = process.env.COINS_VISION_CALIBRATE !== '0';
const GRADE_CALIBRATION = { VF: 'F', F: 'VG' };

// Листы 2×2: модель (через шлюз — точно) берёт за картинку почти одинаково, ~4,7 тыс. токенов, хоть 500 px, хоть
// 1500 px, поэтому фото склеиваются по 4 в лист с клетками TILE px — не мельче снимков ay.by и Kufar (650–700 px).
// 2 фото — одна картинка вместо двух, 10 — три вместо десяти. Без sharp фото уходят по одному.
let sharp = null;
try { sharp = require('sharp'); } catch { /* без склейки */ }
const TILE = 768;
const PER_SHEET = 4;

async function toSheets(images) {
  if (!sharp || images.length < 2) return { images, sheets: false };
  const out = [];
  for (let i = 0; i < images.length; i += PER_SHEET) {
    const group = images.slice(i, i + PER_SHEET);
    if (group.length === 1) { out.push(group[0]); continue; }
    const rows = Math.ceil(group.length / 2);
    const tiles = await Promise.all(group.map((img) => sharp(Buffer.from(img.data, 'base64')).rotate()
      .resize(TILE, TILE, { fit: 'contain', background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer()));
    const buf = await sharp({ create: { width: 2 * TILE, height: rows * TILE, channels: 3, background: '#ffffff' } })
      .composite(tiles.map((t, k) => ({ input: t, left: (k % 2) * TILE, top: Math.floor(k / 2) * TILE })))
      .jpeg({ quality: 88 }).toBuffer();
    out.push({ data: buf.toString('base64'), mediaType: 'image/jpeg' });
  }
  return { images: out, sheets: true };
}

// images — [{ data: base64, mediaType: 'image/jpeg' }]; hint — подпись пользователя.
// Возвращает { result, model, usage: { input_tokens, output_tokens, … }, costUsd }. Отказ модели — ошибка.
async function gradePhotos(images, hint = '') {
  if (!enabled()) throw new Error('нет ключа модели в .env (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN или OPENAI_API_KEY)');
  const prepared = await toSheets(images.slice(0, MAX_PHOTOS)).catch(() => ({ images: images.slice(0, MAX_PHOTOS), sheets: false }));
  const photos = prepared.images;
  const hintText = (prepared.sheets ? 'Фото склеены в листы по 4 (2×2): каждая клетка — отдельный снимок, порядок слева направо, сверху вниз.\n' : '')
    + (hint ? `Подпись пользователя: ${hint}` : 'Подписи нет.');
  const r = PROVIDER === 'openai' ? await callOpenAI(photos, hintText) : await callAnthropic(photos, hintText);
  return { result: parseResult(r.text), model: r.model, usage: r.usage, costUsd: costOf(r.model, r.usage) };
}

// ---- СССР 1961–1991: буква монетного двора и цвет металла (разновидности и перепутки) ----
// Сверка на 17 лотах ay.by с буквой в заголовке (11.2026): фото по одному в полном размере — 16 из 16 верно; в листах
// 2×2 (ужатые до 768 px) мелкая «Л» читалась как «М» — поэтому здесь листы не склеиваются. «Без буквы» на сверке
// не было (нет образцов в базе) — первые такие находки проверять глазами.
const LETTER_SYSTEM = `Ты нумизмат, специалист по монетам СССР 1961–1991. На аверсе монет 1990–1991 годов под гербом справа
(между лентами и надписью «СССР») бывает маленькая буква монетного двора: М (Москва) или Л (Ленинград); у части монет буквы
нет вовсе. Посмотри на фото и ответь, какая буква видна; если аверса нет на фото или место под гербом нечёткое —
not_visible. Не угадывай по подписи или типу монеты: только то, что видно.
Отдельно — цвет металла: 1–5 копеек должны быть жёлто-красными (латунь, бронза), 10–20 копеек, 50 копеек и рубль —
белыми (мельхиор, нейзильбер). Монета не того цвета для своего номинала — перепутка (отчеканена на кружке другого
номинала), color_ok: false. Цвет на фото искажают свет и патина: false — только если отличие явное.
Ответ — один JSON-объект без пояснений и без обёртки \`\`\`, строго по схеме:`;
const LETTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['denomination', 'year', 'letter', 'letter_confidence', 'where', 'color', 'color_ok'],
  properties: {
    denomination: { type: 'string' },
    year: { type: 'string' },
    letter: { type: 'string', enum: ['M', 'L', 'none', 'not_visible'] },
    letter_confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    where: { type: 'string' },
    color: { type: 'string' },
    color_ok: { type: 'boolean' },
  },
};
const LETTER_PHOTOS = 4;

async function checkMintLetter(images, hint = '') {
  if (!enabled()) throw new Error('нет ключа модели в .env (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN или OPENAI_API_KEY)');
  const photos = images.slice(0, LETTER_PHOTOS); // по одному, без склейки: иначе мелкая буква не читается
  const opts = { system: `${LETTER_SYSTEM}\n${JSON.stringify(LETTER_SCHEMA)}`, schema: LETTER_SCHEMA, name: 'mint_letter' };
  const hintText = hint ? `Лот: ${hint}` : 'Подписи нет.';
  const r = PROVIDER === 'openai' ? await callOpenAI(photos, hintText, opts) : await callAnthropic(photos, hintText, opts);
  const t = String(r.text || '');
  let result = null;
  try { result = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { /* ниже */ }
  if (!result || !LETTER_SCHEMA.properties.letter.enum.includes(result.letter)) throw new Error(`модель ответила не по формату: ${t.slice(0, 120)}`);
  return { result, model: r.model, usage: r.usage, costUsd: costOf(r.model, r.usage) };
}

// ---- Вес драгметалла по тексту лота (coins/content.js, последний шаг после нашей базы и Numista) ----
// Без фото, глубина рассуждения low: справочный вопрос «сколько чистого серебра/золота в этой монете»
const CONTENT_SYSTEM = `Ты нумизматический справочник. По заголовку лота (и описанию, если есть) определи монету
и её стандартный вес и пробу по каталогам (Krause, Numista, сайты монетных дворов и центробанков).
known: true — только если монету можно определить однозначно (страна, номинал, год, серия или тираж) и у неё один
стандартный вес. Если под таким номиналом и годом выпускались монеты разного веса (1 oz и 1/2 oz, пруф и
обычная), а заголовок не говорит какая, — known: false. Не угадывай: лучше known: false, чем неверный вес.
weight_g — полный вес монеты в граммах, purity — проба долей (0.999, 0.925, 0.9), fine_g — чистого металла в граммах
(weight_g × purity). Неизвестное — 0. confidence: high — монета и её вес известны точно; medium — монета известна,
вес из памяти; low — сомнения. coin — что за монета (страна, номинал, год, серия). note — откуда вес или почему нельзя.
Ответ — один JSON-объект без пояснений и без обёртки \`\`\`, строго по схеме:`;
const CONTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['known', 'coin', 'metal', 'weight_g', 'purity', 'fine_g', 'confidence', 'note'],
  properties: {
    known: { type: 'boolean' },
    coin: { type: 'string' },
    metal: { type: 'string', enum: ['silver', 'gold', 'other'] },
    weight_g: { type: 'number' },
    purity: { type: 'number' },
    fine_g: { type: 'number' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    note: { type: 'string' },
  },
};
// справочный вопрос — Sonnet: ≈ $0,008 за вопрос против ≈ $0,06 у Opus; Haiku (≈ $0,0004) на проверке 2026-11-16 уверенно
// выдал вес унции за памятный доллар Канады 2021 (23,17 г), Sonnet в том же случае честно ответил «не знаю»
const CONTENT_MODEL = process.env.COINS_CONTENT_MODEL || (PROVIDER === 'openai' ? MODEL : 'claude-sonnet-5-5');

async function askContent(title, description = '') {
  if (!enabled()) return null;
  const opts = { system: `${CONTENT_SYSTEM}\n${JSON.stringify(CONTENT_SCHEMA)}`, schema: CONTENT_SCHEMA, name: 'coin_content', model: CONTENT_MODEL, effort: 'low', fallback: false };
  const text = `Заголовок: ${title}${description ? `\nОписание: ${String(description).slice(0, 800)}` : ''}`;
  const r = PROVIDER === 'openai' ? await callOpenAI([], text, opts) : await callAnthropic([], text, opts);
  const t = String(r.text || '');
  let result = null;
  try { result = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { /* ниже */ }
  if (!result || typeof result.known !== 'boolean') throw new Error(`модель ответила не по формату: ${t.slice(0, 120)}`);
  return { result, model: r.model, usage: r.usage, costUsd: costOf(r.model, r.usage) };
}

const LETTER_RU = { M: 'М (Москва)', L: 'Л (Ленинград)', none: 'нет буквы', not_visible: 'не видно' };
// Ответ на «буква»: что видно и что это значит для этого номинала и года (coins/parse.ussrVariety)
function formatLetterCheck({ result: r, model, usage, costUsd }, variety = null) {
  const lines = [
    `🔤 <b>Буква двора: ${LETTER_RU[r.letter]}</b>, уверенность ${RU[r.letter_confidence] || r.letter_confidence}${r.where ? ` · ${esc(r.where)}` : ''}`,
    `🎨 Цвет: ${esc(r.color)}${r.color_ok ? '' : ' — <b>не тот для номинала: возможна перепутка</b>'}`,
    `🔎 На фото: ${esc(r.denomination)} ${esc(r.year)}`,
  ];
  if (variety) lines.push(`💎 Для этого номинала и года ищут: ${esc(variety)}`);
  if (r.letter === 'none') lines.push('⚠️ «Без буквы» бот на эталоне ещё не проверял — посмотрите фото сами или попросите макроснимок под гербом');
  if (r.letter === 'not_visible') lines.push('📸 Попросите у продавца крупный снимок аверса под гербом');
  const tokens = usage ? `${(usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)} + ${usage.output_tokens || 0} токенов` : '';
  lines.push(`🤖 ${esc(model)}${tokens ? ` · ${tokens}` : ''}${costUsd != null ? ` ≈ $${costUsd.toFixed(3)}` : ''}`);
  return lines.join('\n');
}

// Ответ модели → объект. Строгая схема соблюдается не везде: шлюз может её не передать, и модель отвечает JSON
// в обёртке «```json … ```» или с текстом вокруг — берём объект от первой «{» до последней «}».
function parseResult(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  let obj = null;
  try { obj = JSON.parse(t); } catch {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { obj = JSON.parse(t.slice(a, b + 1)); } catch { /* ниже — ошибка */ } }
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.coins)) {
    throw new Error(`модель ответила не по формату: ${t.slice(0, 120).replace(/\s+/g, ' ')}…`);
  }
  for (const c of obj.coins) {
    c.problems = Array.isArray(c.problems) ? c.problems : [];
    c.copy_signs = Array.isArray(c.copy_signs) ? c.copy_signs : [];
    if (!GRADES.includes(c.grade)) { // «VF+», «XF-AU», «EF» → ступень шкалы
      const m = String(c.grade || '').toUpperCase().match(/^(UNC|AU|XF|EF|VF|VG|PF|G|F)/);
      c.grade = m ? (m[1] === 'EF' ? 'XF' : m[1]) : 'unknown';
    }
    const cal = CALIBRATE ? GRADE_CALIBRATION[c.grade] : null;
    if (cal) { c.grade_model = c.grade; c.grade = cal; }
  }
  obj.need_more = Array.isArray(obj.need_more) ? obj.need_more : [];
  return obj;
}

// Chat Completions: картинки data-URL, ответ по схеме (strict). Рассуждающим моделям (gpt-5+, o-серия) — reasoning_effort.
async function callOpenAI(images, hintText, { system = SYSTEM_FULL, schema = SCHEMA, name = 'coin_grading', model = MODEL, effort = EFFORT } = {}) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [
        ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}`, detail: 'high' } })),
        { type: 'text', text: hintText },
      ] },
    ],
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
    max_completion_tokens: 16000,
  };
  if (/^(gpt-[5-9]|o\d)/.test(model)) body.reasoning_effort = effort;
  const res = await fetch(`${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(data.error && data.error.message) || 'ошибка запроса'}`);
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('OpenAI: пустой ответ');
  if (choice.message.refusal) throw new Error(`модель отказалась оценивать: ${choice.message.refusal}`);
  if (choice.finish_reason === 'length') throw new Error('ответ модели обрезан (max_completion_tokens)');
  const u = data.usage || {};
  return { text: choice.message.content, model: data.model || model, usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 } };
}

async function callAnthropic(images, hintText, { system = SYSTEM_FULL, schema = SCHEMA, model = MODEL, effort = EFFORT, fallback = USE_FALLBACK } = {}) {
  const content = [
    ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
    { type: 'text', text: hintText },
  ];
  const params = {
    model,
    max_tokens: 16000,
    system,
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  };
  const response = fallback
    ? await api().beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await api().messages.create(params);
  if (response.stop_reason === 'refusal') {
    const d = response.stop_details;
    throw new Error(`модель отказалась оценивать${d && d.category ? ` (${d.category})` : ''}`);
  }
  if (response.stop_reason === 'max_tokens') throw new Error('ответ модели обрезан (max_tokens)');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, model: response.model, usage: response.usage };
}

function costOf(model, usage) {
  if (!usage) return null;
  const key = Object.keys(PRICES).find((k) => String(model || '').startsWith(k));
  const [inP, outP] = CUSTOM_PRICE.length === 2 && CUSTOM_PRICE.every((n) => n >= 0) ? CUSTOM_PRICE : key ? PRICES[key] : [null, null];
  if (inP == null) return null;
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  return (input * inP + (usage.output_tokens || 0) * outP) / 1e6;
}

const METAL_SPEC = { silver: 'Серебро', gold: 'Золото', copper: 'Медь', base: 'Медно-никель' };

// Монета из ответа модели → разбор как у лота (coins/parse.js), состояние — по фото
function parsedFromVision(coin) {
  const specs = METAL_SPEC[coin.metal] ? { 'Металл': METAL_SPEC[coin.metal] } : {};
  const parsed = parseCoin({ title: coin.title, sectionPath: coin.country || null, specs });
  if (coin.grade && coin.grade !== 'unknown') { parsed.grade = coin.grade; parsed.gradeSource = 'photo'; }
  return parsed;
}

// Цена из подписи: «просит 60», «цена 60», «за 60», «60 р.» (годы и номиналы не цена)
function captionPrice(text) {
  const t = (text || '').toLowerCase().replace(/ё/g, 'е');
  const m = t.match(/(?:просит|прос\p{L}*|цена|хочет|за)\s*:?\s*(\d+(?:[.,]\d+)?)(?!\s*(?:коп|г\.|год))/u)
    || t.match(/(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(?:р\.?|руб\p{L}*|byn)(?!\p{L})/u);
  const n = m ? parseFloat(m[1].replace(',', '.')) : null;
  return n > 0 && n < 100000 ? n : null;
}

// Сколько предлагать продавцу: OFFER_SHARE от ориентира (маржа на перепродаже), но не меньше стоимости металла
// (обещание в объявлении); максимум — ориентир минус BARGAIN_PCT. Без ориентира — по металлу.
function offerFor(est) {
  if (!est) return null;
  const ref = est.reference > 0 ? est.reference : null;
  const metal = est.metal && est.metal.value > 0 ? est.metal.value : null;
  if (!ref && !metal) return null;
  const max = ref ? Math.floor(ref * (1 - BARGAIN_PCT / 100)) : Math.round(metal);
  const offer = Math.min(max, Math.max(ref ? Math.round(ref * OFFER_SHARE) : 0, metal ? Math.round(metal) : 0));
  return { offer, max, byMetal: !ref };
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const RU = { low: 'низкая', medium: 'средняя', high: 'высокая', none: 'нет', good: 'хорошее', fair: 'среднее', poor: 'плохое' };
const METAL_RU = { silver: 'серебро', gold: 'золото', copper: 'медь', base: 'недрагоценный металл', unknown: 'металл не определён' };

// Чистка, дефекты, риск копии одной строкой; чистку модель часто повторяет и в problems — там она лишняя
function flagsOf(coin) {
  const problems = (coin.problems || []).filter((p) => !/чист/i.test(p)).map(esc); // чистку по фото не определяем
  const copy = coin.copy_risk && coin.copy_risk !== 'none'
    ? `риск копии: ${RU[coin.copy_risk]}${coin.copy_signs && coin.copy_signs.length ? ` (${coin.copy_signs.map(esc).join(', ')})` : ''}` : null;
  return [...problems, copy].filter(Boolean);
}

// «F (модель видит VF–XF, −1 по сверке с экспертами)» или «XF (XF–AU)»
function gradeText(coin, unknown) {
  if (coin.grade === 'unknown') return unknown;
  const seen = coin.grade_range || coin.grade_model;
  if (coin.grade_model) return `${coin.grade} (модель видит ${esc(seen)}, −1 по сверке с экспертами)`;
  return `${coin.grade}${coin.grade_range && coin.grade_range !== coin.grade ? ` (${esc(coin.grade_range)})` : ''}`;
}

// Ответ в Telegram: по монете — что это, состояние по фото, проблемы, ориентиры, сколько предложить.
// items — [{ coin, est }] (est может быть null), price — цена из подписи. Возвращает массив сообщений (≤ 4000 символов).
function formatReport({ result, model, usage, costUsd }, items, price = null) {
  const blocks = items.map(({ coin, est }, i) => {
    const grade = gradeText(coin, 'состояние по фото не определить');
    const flags = flagsOf(coin);
    const offer = coin.copy_risk === 'high' ? null : offerFor(est);
    const lines = [
      `<b>${i + 1}. ${esc(coin.title)}</b> · ${METAL_RU[coin.metal] || ''} · 📷 ${grade}, уверенность ${RU[coin.confidence] || coin.confidence}`,
      flags.length ? `⚠️ ${flags.join(' · ')}` : null,
      coin.notes ? `📝 ${esc(coin.notes)}` : null,
      ...(est ? formatEstimateLines(est) : ['⚪ Монету не удалось сопоставить с базой — ориентира нет']),
      coin.copy_risk === 'high' ? '⛔ Высокий риск копии — без проверки веса и размеров не покупать'
        : offer ? `💬 Предложить ≈ ${offer.offer} р., максимум ${offer.max} р.${offer.byMetal ? ' (только по металлу)' : ''}${price != null && items.length === 1 ? ` · просят ${price} р.${price <= offer.max ? ' — можно брать' : ' — дорого'}` : ''}` : null,
    ].filter(Boolean);
    return lines.join('\n');
  });
  const tokens = usage ? `${(usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)} + ${usage.output_tokens || 0} токенов` : '';
  const footer = [
    result.summary ? `🧾 ${esc(result.summary)}` : null,
    `📸 Фото: ${RU[result.photo_quality] || result.photo_quality}${result.need_more && result.need_more.length ? `. Дозапросить: ${result.need_more.map(esc).join('; ')}` : ''}`,
    `🤖 ${esc(model)}${tokens ? ` · ${tokens}` : ''}${costUsd != null ? ` ≈ $${costUsd.toFixed(3)}` : ''} · по фото ±1 ступень (сверка с экспертами: 93%); чистку по фото не определить — просите снимок под углом к свету`,
  ].filter(Boolean).join('\n');
  const head = items.length ? '' : '🔍 Монет на фото не нашёл.\n';
  // склейка блоков в сообщения до 4000 символов
  const messages = [];
  let cur = head;
  for (const b of [...blocks, footer]) {
    if (cur && (cur + '\n\n' + b).length > 4000) { messages.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) messages.push(cur);
  return messages;
}

// ---- Дооценка лота с карточки бота: монета известна по заголовку, нужно только физическое состояние ----

// Подсказка модели: заявленное продавцом состояние не передаём, чтобы не подталкивать оценку вверх
const lotHint = (title) => `Это все фото одного лота: «${title}». Монета известна — оцени только её физическое состояние `
  + '(износ, чистка, дефекты, признаки копии). title — как в заголовке лота, если фото ему не противоречат; '
  + 'если на фото другой год или монета — напиши, что видно на самом деле. Состояние, заявленное продавцом, не учитывай.';

// Ответ на «фото» под карточкой лота. before / after — оценки (coins/market.assess) по состоянию продавца и по фото;
// auction — аукцион (подсказка: разумный максимум для снайпа), иначе фикс-цена (сколько предложить продавцу).
function formatLotRegrade({ result, model, usage, costUsd }, { lot, declared = null, before = null, after = null, auction = false }) {
  const coin = (result.coins || [])[0];
  const lines = [];
  if (!coin) lines.push('🔍 На фото лота монету не нашёл.');
  else {
    const grade = gradeText(coin, 'не определить');
    lines.push(`📷 <b>Состояние по фото: ${grade}</b>, уверенность ${RU[coin.confidence] || coin.confidence} · продавец: ${declared ? esc(declared) : 'не указал'}`);
    lines.push(`🔎 ${esc(coin.title)}${result.coins.length > 1 ? ` (на фото ${result.coins.length} монет, оценка по первой)` : ''}`);
    const flags = flagsOf(coin);
    if (flags.length) lines.push(`⚠️ ${flags.join(' · ')}`);
    if (coin.notes) lines.push(`📝 ${esc(coin.notes)}`);
    if (coin.copy_risk === 'high') lines.push('⛔ Высокий риск копии — без проверки веса и размеров не брать');
    else if (after) {
      lines.push(...formatEstimateLines(after));
      const now = offerFor(after);
      const was = before && declared !== coin.grade ? offerFor(before) : null;
      const wasText = was && was.max !== (now && now.max) ? ` (по ${esc(declared)} было бы ${was.max} р.)` : '';
      if (now && auction) lines.push(`🎯 Разумный максимум по ${coin.grade}: ≈ ${now.max} р.${now.byMetal ? ' (только по металлу)' : ''}${wasText} — ответьте числом на карточку лота, бот поставит`);
      else if (now) {
        const price = lot && lot.current_price != null ? Number(lot.current_price) : null;
        lines.push(`💬 Предложить ≈ ${now.offer} р., максимум ${now.max} р.${now.byMetal ? ' (только по металлу)' : ''}${wasText}${price != null ? ` · просят ${price} р.${price <= now.max ? ' — можно брать' : ' — дорого'}` : ''}`);
      }
    } else if (coin.grade !== 'unknown') lines.push('⚪ Пересчитать не удалось: монета не сопоставилась с базой');
  }
  const tokens = usage ? `${(usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)} + ${usage.output_tokens || 0} токенов` : '';
  lines.push(`📸 Фото: ${RU[result.photo_quality] || result.photo_quality}${result.need_more && result.need_more.length ? `. Не хватает: ${result.need_more.map(esc).join('; ')}` : ''}`);
  lines.push(`🤖 ${esc(model)}${tokens ? ` · ${tokens}` : ''}${costUsd != null ? ` ≈ $${costUsd.toFixed(3)}` : ''} · по фото ±1 ступень (сверка с экспертами: 93%); чистку по фото не определить — просите снимок под углом к свету`);
  const text = lines.join('\n');
  return text.length <= 4000 ? [text] : [text.slice(0, 3990) + '…'];
}

module.exports = { enabled, gradePhotos, checkMintLetter, askContent, formatLetterCheck, parseResult, toSheets, parsedFromVision, captionPrice, offerFor, formatReport, lotHint, formatLotRegrade, costOf, SCHEMA, MODEL, PROVIDER, MAX_PHOTOS };
