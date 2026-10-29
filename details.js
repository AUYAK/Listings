// Характеристики и описание со страницы объявления Kufar + их разбор в поля для сравнения цен.

const SPEC_LABELS = {
  cpu: 'Процессор',
  ram: 'Оперативная память',
  ssd: 'Ёмкость накопителя',
  screen: 'Диагональ экрана',
  condition: 'Состояние',
  battery: 'Время автономной работы',
  resolution: 'Разрешение экрана',
  trade: 'Возможен обмен',
};

// Runs in the browser page. Returns { gone, specs, description }.
async function fetchListingDetails(page, url) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const code = resp ? resp.status() : 0;
  if (code === 404) return { gone: true, specs: {}, description: null };
  if (code !== 200) throw new Error(`HTTP ${code}`);
  await page.waitForSelector('[class*="parameter_wrapper"], h1', { timeout: 8000 }).catch(() => {});

  return await page.evaluate(() => {
    if (/объявление не найдено|снято с публикации/i.test(document.body.innerText)) {
      return { gone: true, specs: {}, description: null };
    }
    const specs = {};
    for (const row of document.querySelectorAll('[class*="parameter_wrapper"]')) {
      if (row.children.length !== 2) continue;
      const k = row.children[0].textContent.trim();
      const v = row.children[1].textContent.trim();
      if (k && v) specs[k] = v;
    }
    const leaf = [...document.querySelectorAll('h2,h3,h4,div,span,p')]
      .find((el) => el.children.length === 0 && /^Описание$/.test(el.textContent.trim()));
    const description = leaf
      ? leaf.parentElement.innerText.replace(/^Описание\s*/, '').trim().slice(0, 4000)
      : null;
    return { gone: false, specs, description };
  });
}

function num(str) {
  if (!str) return null;
  const m = String(str).replace(',', '.').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// Kufar пишет «1000 Гб» и «2000 ГБ и более», продавцы — «1 ТБ» и «1024»: приводим к одному ряду,
// иначе один и тот же объём даёт разные ключи группировки.
const SSD_STEPS = [128, 256, 512, 1024, 2048, 4096];
function normalizeSsd(gb) {
  if (gb == null) return null;
  for (const s of SSD_STEPS) if (Math.abs(gb - s) / s <= 0.1) return s; // 1000 → 1024, 2000 → 2048
  return Math.round(gb);
}

// "512 ГБ" → 512, "1 ТБ" → 1024, "2tb" → 2048. kind: 'ssd' | 'ram'.
// Эвристика «число ≤ 8 — это терабайты» верна только для накопителя: «8 ГБ» оперативной
// памяти превращалась в 8192 (замерено: 46 из 134 объявлений с «8 ТБ» памяти).
function toGb(str, kind = 'ssd') {
  if (!str) return null;
  const n = num(str);
  if (n == null) return null;
  const tb = /тб|tb|тера/i.test(str) || (kind === 'ssd' && n <= 8);
  const gb = Math.round(tb ? n * 1024 : n);
  return kind === 'ssd' ? normalizeSsd(gb) : gb;
}

// «13.3'' / 33.8 см» → 13; 15.4 → 15; 16.1 → 16. Для сравнения цен важен класс диагонали, не десятые.
function screenSize(inches) {
  if (inches == null || !(inches > 0)) return null;
  return String(Math.floor(inches + 0.3)); // 13.3 → 13, 15.4 → 15, 16.1 → 16, 11.6 → 11
}

// Номера моделей Apple (A2251 и т.п.) продавцы часто пишут в заголовке — по ним надёжно
// известны линейка, диагональ и год, даже если в заголовке больше ничего нет.
const APPLE_MODELS = {
  A1278: { line: 'pro', size: '13', year: '2012' }, A1286: { line: 'pro', size: '15', year: '2012' },
  A1398: { line: 'pro', size: '15', year: '2015' }, A1425: { line: 'pro', size: '13', year: '2013' },
  A1502: { line: 'pro', size: '13', year: '2015' }, A1706: { line: 'pro', size: '13', year: '2017' },
  A1708: { line: 'pro', size: '13', year: '2017' }, A1707: { line: 'pro', size: '15', year: '2017' },
  A1989: { line: 'pro', size: '13', year: '2019' }, A1990: { line: 'pro', size: '15', year: '2019' },
  A2159: { line: 'pro', size: '13', year: '2019' }, A2141: { line: 'pro', size: '16', year: '2019' },
  A2251: { line: 'pro', size: '13', year: '2020' }, A2289: { line: 'pro', size: '13', year: '2020' },
  A2338: { line: 'pro', size: '13', year: '2020' }, A2442: { line: 'pro', size: '14', year: '2021' },
  A2485: { line: 'pro', size: '16', year: '2021' }, A2779: { line: 'pro', size: '14', year: '2023' },
  A2780: { line: 'pro', size: '16', year: '2023' }, A2918: { line: 'pro', size: '14', year: '2023' },
  A2992: { line: 'pro', size: '14', year: '2023' }, A2991: { line: 'pro', size: '16', year: '2023' },
  A3112: { line: 'pro', size: '14', year: '2024' }, A3186: { line: 'pro', size: '16', year: '2024' },
  A1465: { line: 'air', size: '11', year: '2015' }, A1466: { line: 'air', size: '13', year: '2017' },
  A1932: { line: 'air', size: '13', year: '2019' }, A2179: { line: 'air', size: '13', year: '2020' },
  A2337: { line: 'air', size: '13', year: '2020' }, A2681: { line: 'air', size: '13', year: '2022' },
  A2941: { line: 'air', size: '15', year: '2023' }, A3113: { line: 'air', size: '13', year: '2024' },
  A3114: { line: 'air', size: '15', year: '2024' }, A3240: { line: 'air', size: '13', year: '2025' },
  A3241: { line: 'air', size: '15', year: '2025' }, A1534: { line: 'macbook', size: '12', year: '2017' },
};
function appleModelFromText(text) {
  const m = String(text || '').toUpperCase().match(/\bA(\d{4})\b/);
  return m ? APPLE_MODELS['A' + m[1]] || null : null;
}

function chipFromText(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  // «М1 Мах», «м2 про» — продавцы набирают латинские буквы кириллицей
  const m = t.match(/(?<![a-zа-я])[mм]([1-5])\s*(pro|max|ultra|про|макс|мах|ультра)?(?![a-zа-я\d])/);
  if (m) {
    const suffix = { pro: 'Pro', про: 'Pro', max: 'Max', макс: 'Max', мах: 'Max', ultra: 'Ultra', ультра: 'Ultra' }[m[2]];
    return 'M' + m[1] + (suffix ? ' ' + suffix : '');
  }
  if (/intel|core\s*i[3579]|\bi[3579]\b/.test(t)) return 'Intel';
  return null;
}

// RAM/SSD written as "16/512", "8gb/256", "16 гб / 1 тб" in title or description
function memoryFromText(text) {
  if (!text) return {};
  const t = text.toLowerCase();
  // "16/512", "8gb/256", "16 гб / 1 тб", "24Gb 512Gb"
  const pair = t.match(/\b(4|8|16|18|24|32|36|48|64|96|128)\s*(?:гб|gb|г)?\s*\/\s*(128|256|512|1|2|4|1024|2048)\s*(тб|tb|гб|gb)?(?![\p{L}\d])/u)
    || t.match(/\b(4|8|16|18|24|32|36|48|64|96|128)\s*(?:гб|gb)[\s,]+(128|256|512|1|2|4|1024|2048)\s*(тб|tb|гб|gb)(?![\p{L}\d])/u);
  if (pair) {
    const ssdRaw = parseInt(pair[2], 10);
    const ssd = /тб|tb/.test(pair[3] || '') || ssdRaw <= 8 ? ssdRaw * 1024 : ssdRaw;
    return { ramGb: parseInt(pair[1], 10), ssdGb: normalizeSsd(ssd) };
  }
  const out = {};
  const ram = t.match(/\b(4|8|16|18|24|32|36|48|64|96|128)\s*(?:гб|gb)\s*(?:озу|ram|оператив)/) || t.match(/(?:озу|ram|оперативн\w*)\s*[:\-–]?\s*(4|8|16|18|24|32|36|48|64|96|128)\b/);
  if (ram) out.ramGb = parseInt(ram[1], 10);
  const ssd = t.match(/\b(128|256|512|1024|2048)\s*(?:гб|gb)\b/) || t.match(/\b([124])\s*(?:тб|tb)\b/);
  if (ssd) out.ssdGb = normalizeSsd(ssd[0].match(/тб|tb/) ? parseInt(ssd[1], 10) * 1024 : parseInt(ssd[1], 10));
  return out;
}

function conditionFrom(specs, title, description) {
  const c = specs[SPEC_LABELS.condition];
  if (c) {
    if (/нов/i.test(c)) return 'new';
    if (/б\/у|бу|б у/i.test(c)) return 'used';
  }
  // \b does not work with Cyrillic, so word edges are checked with letter lookarounds
  // «как новый», «новый аккумулятор», «новое зарядное» — это б/у (замерено: 13 таких из 123 б/у),
  // поэтому по описанию «новым» считаем только запечатанное/неактивированное, а по заголовку —
  // «новый» без признаков б/у и без «как/почти/состояние».
  const t = `${title || ''} ${description || ''}`;
  if (/(?<!\p{L})(б\/у|бу)(?!\p{L})|цикл/iu.test(t)) return 'used';
  if (/(?<!\p{L})(не ?активирован\w*|запечатан\w*|sealed|новый в коробке|new in box)(?!\p{L})/iu.test(t)) return 'new';
  if (/(?<!\p{L})(новый|новая|новое|new)(?!\p{L})/iu.test(title || '') && !/как нов|почти нов|состояни/iu.test(title || '')) return 'new';
  if (/состояни/iu.test(t)) return 'used';
  return null;
}

// «300 циклов», «количество циклов перезарядки: 335», «циклов зарядки аккумулятора 53»
function batteryCyclesFrom(description) {
  if (!description) return null;
  const t = description.replace(/\s+/g, ' ');
  // \w is ASCII-only in JS even with the u flag, so Cyrillic word tails are matched with \p{L}*
  const m = t.match(/(\d{1,4})\s*(?:циклов|цикла|цикл)(?![\p{L}])/iu)
    || t.match(/цикл\p{L}*(?:\s+(?:пере)?зарядк\p{L}*)?(?:\s+(?:аккумулятора|батареи|акб))?\s*[:\-–~≈=]?\s*(?:около|примерно|всего|где-то|~)?\s*(\d{1,4})(?!\s*%)/iu);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 && n < 5000 ? n : null;
}

// «ёмкость 83%», «батарея 91 %», «здоровье аккумулятора: 88%», «83% ёмкости»
function batteryHealthFrom(description) {
  if (!description) return null;
  const t = description.replace(/\s+/g, ' ');
  const m = t.match(/(?:батаре\p{L}*|аккум\p{L}*|акб|[её]мкост\p{L}*|здоровь\p{L}*|health|capacity)[^.%\d]{0,40}?(\d{2,3})\s*%/iu)
    || t.match(/(\d{2,3})\s*%[^.\d]{0,25}?(?:батаре|аккум|акб|[её]мкост|health|capacity)/iu)
    || t.match(/цикл\p{L}*[^.\d]{0,15}?(\d{2,3})\s*%/iu); // «200 циклов, 88%»
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 30 && n <= 100 ? n : null;
}

// Year of the model: title first, then description («2019 года», «mid 2019»), then Apple model number
function yearFrom(title, description) {
  const re = /(?<!\d)(20(?:0[6-9]|1[0-9]|2[0-9]))(?!\d)/;
  const inTitle = (title || '').match(re);
  if (inTitle) return inTitle[1];
  const am = appleModelFromText(title);
  if (am) return am.year;
  const inDesc = (description || '').match(/(?<!\d)(20(?:0[6-9]|1[0-9]|2[0-9]))\s*(?:г\.?|год|года|году|year|выпуск)/iu)
    || (description || '').match(/(?:mid|late|early|выпуск\w*|год\w*)\s*[:\-–]?\s*(20(?:0[6-9]|1[0-9]|2[0-9]))(?!\d)/iu);
  return inDesc ? inDesc[1] : null;
}

// 'ideal' | 'marks' | 'damaged' | null — what the seller says about the body
function bodyConditionFrom(title, description, issues = []) {
  if (issues.includes('дефект') || issues.includes('на запчасти')) return 'damaged';
  const raw = `${title || ''} ${description || ''}`.toLowerCase().replace(/ё/g, 'е');
  // «без царапин», «нет сколов», «ни царапины» — это плюс, а не минус; убираем до проверки на следы
  const marks = '(?:царапин|скол|потертост|вмятин|следов|дефект)\\p{L}*';
  const t = raw.replace(new RegExp(`(?:без|нет|ни одной|ни)\\s+(?:единой\\s+|каких[- ]либо\\s+)?${marks}(?:\\s*(?:,|и)\\s*${marks})*`, 'gu'), ' ');
  if (/царапин|скол|потертост|вмятин|след\w* (эксплуатац|использован|носк)|трещин на корпус|облез|затерт/.test(t)) return 'marks';
  if (/идеал|как нов|без следов|без царапин|без сколов|отличн\w* состоян|состоян\w* отличн|состоян\w* нов|нет царапин|ни царапин/.test(raw)) return 'ideal';
  return null;
}

const WEAK_BATTERY_SPEC = /1 час и меньше|1-2 часа|2-4 часа/i;
const NON_RETINA_RES = /1440\s*[xх×]\s*900|1366\s*[xх×]\s*768|1280\s*[xх×]\s*800|1680\s*[xх×]\s*1050/i;

// Short facts worth seeing before opening the listing (kit, haggling, known model weak spots)
function flagsFrom(specs, title, description, parsed = {}) {
  const t = `${title || ''}\n${description || ''}`.toLowerCase().replace(/ё/g, 'е');
  const has = (re) => re.test(t);
  const flags = [];

  if (has(/зарядк|блок питания|адаптер|magsafe/) && !has(/без зарядк|нет зарядк|зарядки нет|зарядка не/)) flags.push('зарядка');
  if (has(/коробк/) && !has(/без коробк|коробки нет/)) flags.push('коробка');
  if (has(/(?<!\p{L})чек|гарант/u) && !has(/без чека|чека нет|без гарантии|гарантии нет|гарантия закончил|не на гарантии/)) flags.push('чек/гарантия');
  if (has(/гравировк|русск\w* (раскладк|клавиатур|буквы)|ru раскладк|раскладка ru|кириллиц/)) {
    flags.push(has(/без гравировк|нет гравировк/) ? 'US-раскладка' : 'гравировка RU');
  } else if (has(/us раскладк|раскладка us|американск\w* раскладк|английск\w* раскладк|англ\.? раскладк/)) {
    flags.push('US-раскладка');
  }
  if (has(/торг/) && !has(/без торга|торга нет|торг неуместен|не торг|торг не уместен|цена окончательн|цена финальн/)) flags.push('торг');
  if (/^да/i.test(specs[SPEC_LABELS.trade] || '') || has(/обменяю|обмен на|возможен обмен|рассмотрю обмен/)) flags.push('обмен');

  // Butterfly keyboard: Pro 2016–2019, Air 2018–2019
  // «про» only as a word: «продам», «проблем» must not make everything a Pro
  const cleaned = t.replace(/(iphone|airpods|ipad)\s*\d*\s*pro/g, '');
  const line = /\bair\b|эйр/.test(t.replace(/airpods/g, '')) ? 'air'
    : /macbook\s*pro|макбук\s*про|\bpro\b|(?<!\p{L})про(?!\p{L})/u.test(cleaned) ? 'pro' : null;
  const y = parseInt(parsed.year || yearFrom(title, description) || '0', 10);
  const butterfly = (line === 'pro' && y >= 2016 && y <= 2019) || (line === 'air' && y >= 2018 && y <= 2019) || has(/бабочк|butterfly/);
  if (butterfly && !(parsed.chip && parsed.chip !== 'Intel')) flags.push('клавиатура-бабочка');

  if (NON_RETINA_RES.test(specs[SPEC_LABELS.resolution] || '')) flags.push('без Retina');

  const cycles = parsed.batteryCycles ?? batteryCyclesFrom(description);
  const health = parsed.batteryHealthPct ?? batteryHealthFrom(description);
  if (WEAK_BATTERY_SPEC.test(specs[SPEC_LABELS.battery] || '') || (cycles && cycles > 800) || (health && health < 80)) flags.push('батарея слабая');

  return flags;
}

// specs + free text → normalized fields
function parseDetails(title, specs = {}, description = null) {
  const cpu = specs[SPEC_LABELS.cpu] || null;
  const mem = memoryFromText(`${title || ''}\n${description || ''}`);
  const issues = issuesFrom(title, description);
  const d = {
    specs,
    description,
    condition: conditionFrom(specs, title, description),
    cpu,
    chip: chipFromText(cpu) || chipFromText(title) || chipFromText(description),
    ramGb: specs[SPEC_LABELS.ram] ? toGb(specs[SPEC_LABELS.ram], 'ram') : mem.ramGb ?? null,
    ssdGb: specs[SPEC_LABELS.ssd] ? toGb(specs[SPEC_LABELS.ssd], 'ssd') : normalizeSsd(mem.ssdGb ?? null),
    screenIn: num(specs[SPEC_LABELS.screen]),
    year: yearFrom(title, description),
    batteryCycles: batteryCyclesFrom(description),
    batteryHealthPct: batteryHealthFrom(description),
    issues,
    bodyCondition: bodyConditionFrom(title, description, issues),
  };
  d.flags = flagsFrom(specs, title, description, d);
  return d;
}

function gbLabel(gb) {
  return gb >= 1024 ? `${gb / 1024} ТБ` : `${gb} ГБ`;
}

// Red flags in the seller's text: the usual reasons for a price far below the group
const ISSUE_PATTERNS = [
  ['на запчасти', /з\/ч|запчаст|на разбор|донор/iu],
  ['дефект', /дефект|неисправ|не включается|не работает|не заряжается|разбит|трещин|залит|залив|сломан/iu],
  ['экран/батарея', /засвет|полос[ыа]|пятн|вздут|battery service|обслужива\w* батаре/iu],
  ['обмен', /обменяю|обмен на|возможен обмен|рассмотрю обмен/iu],
  ['блокировка', /icloud|activation lock|заблокирован|под паролем/iu],
];

function issuesFrom(title, description) {
  const t = `${title || ''}\n${description || ''}`;
  return ISSUE_PATTERNS.filter(([, re]) => re.test(t)).map(([label]) => label);
}

const BODY_LABEL = { ideal: 'корпус в идеале', marks: 'есть следы на корпусе', damaged: 'повреждения' };

// Lines for the Telegram caption. Rows saved before migration 010 lack the new fields,
// so anything missing is recomputed from the stored description/specs on the fly.
function formatDetailsLines(d) {
  if (!d) return [];
  const specs = d.specs || {};
  const issues = d.issues || issuesFrom('', d.description);
  const body = d.bodyCondition || bodyConditionFrom('', d.description, issues);
  const health = d.batteryHealthPct ?? batteryHealthFrom(d.description);
  const cycles = d.batteryCycles ?? batteryCyclesFrom(d.description);
  const year = d.year || yearFrom('', d.description);
  const flags = d.flags || flagsFrom(specs, '', d.description, { ...d, year, batteryCycles: cycles, batteryHealthPct: health });
  const lines = [];

  if (issues.length) lines.push(`⚠️ В описании: ${issues.join(', ')}`);

  const cond = d.condition === 'new' ? '🆕 Новое' : d.condition === 'used' ? '♻️ Б/у' : null;
  if (cond) lines.push(body && d.condition !== 'new' ? `${cond} · ${BODY_LABEL[body]}` : cond);

  const spec = [
    d.cpu || d.chip,
    d.ramGb ? gbLabel(d.ramGb) : null,
    d.ssdGb ? `SSD ${gbLabel(d.ssdGb)}` : null,
    d.screenIn ? `${d.screenIn}''` : null,
    year,
  ].filter(Boolean);
  if (spec.length) lines.push(`⚙️ ${spec.join(' · ')}`);

  const bat = [cycles ? `~${cycles} циклов` : null, health ? `${health}%` : null].filter(Boolean);
  if (flags.includes('батарея слабая')) bat.push(bat.length ? 'слабая' : `слабая (${specs[SPEC_LABELS.battery] || 'по описанию'})`);
  if (bat.length) lines.push(`🔋 ${bat.join(' · ')}`);

  if (flags.includes('клавиатура-бабочка')) lines.push('⌨️ Клавиатура-бабочка (2016–2019): проверить залипание клавиш');
  if (flags.includes('без Retina')) lines.push('🖥 Экран без Retina');
  const kit = flags.filter((f) => ['зарядка', 'коробка', 'чек/гарантия'].includes(f));
  if (kit.length) lines.push(`📦 ${kit.join(', ')}`);
  const deal = flags.filter((f) => ['торг', 'обмен', 'US-раскладка', 'гравировка RU'].includes(f));
  if (deal.length) lines.push(`💬 ${deal.join(', ')}`);
  return lines;
}

module.exports = {
  fetchListingDetails, parseDetails, formatDetailsLines, chipFromText, memoryFromText, gbLabel,
  toGb, normalizeSsd, screenSize, appleModelFromText,
  batteryCyclesFrom, batteryHealthFrom, yearFrom, bodyConditionFrom, flagsFrom, issuesFrom,
};
