// Разбор монеты из заголовка лота и пути раздела: номинал, год, знак минцмейстера/двора,
// правитель, металл, состояние (шкала ay.by и подсказки из заголовка), флаги.
// Внимание: \w и \b в JS не знают кириллицу — границы слов проверяются через \p{L}.

const RULERS = [
  ['1682', '1725', 'Пётр I'], ['1725', '1727', 'Екатерина I'], ['1727', '1730', 'Пётр II'],
  ['1730', '1740', 'Анна'], ['1741', '1761', 'Елизавета'], ['1762', '1762', 'Пётр III'],
  ['1762', '1796', 'Екатерина II'], ['1796', '1801', 'Павел I'], ['1801', '1825', 'Александр I'],
  ['1825', '1855', 'Николай I'], ['1855', '1881', 'Александр II'], ['1881', '1894', 'Александр III'],
  ['1894', '1917', 'Николай II'], ['1921', '1991', 'СССР'],
];

// Шкала состояния ay.by → общепринятые буквы
const AYBY_GRADES = { '0': 'PF', 'I': 'UNC', 'II+': 'AU', 'II': 'XF', 'III': 'VF', 'IV': 'F', 'V': 'VG' };
const GRADE_ORDER = ['G', 'VG', 'F', 'VF', 'XF', 'AU', 'UNC', 'PF'];

const W = (s) => `(?<!\\p{L})(?:${s})(?!\\p{L})`;

function rulerFor(year) {
  if (!year) return null;
  for (const [from, to, name] of RULERS) if (year >= +from && year <= +to) return name;
  return null;
}

// Номинал в копейках: «50 копеек», «полтина», «1 рубль», «1,5 рубля», «25 пенни» (финские — не берём)
function denominationFrom(title) {
  const t = (title || '').toLowerCase().replace(/ё/g, 'е');
  // дробные: «1/2 копейки», «1/4 копейки», «½ копейки» — иначе «2 копейки» ловится из «1/2»
  const frac = t.match(/(?:(1)\s*\/\s*([24])|½|¼)\s*коп/u);
  if (frac) return frac[2] ? 1 / parseInt(frac[2], 10) : (frac[0].startsWith('½') ? 0.5 : 0.25);
  const m = t.match(/(?<![\d\/])(\d+(?:[.,]\d+)?)\s*(коп|руб|р\.|рубл)/u);
  if (m) {
    const n = parseFloat(m[1].replace(',', '.'));
    return m[2].startsWith('коп') ? Math.round(n) : Math.round(n * 100);
  }
  if (new RegExp(W('полтин\\p{L}*'), 'u').test(t)) return 50;
  if (new RegExp(W('полуполтин\\p{L}*|четвертак\\p{L}*'), 'u').test(t)) return 25;
  if (new RegExp(W('двугривенн\\p{L}*'), 'u').test(t)) return 20;
  if (new RegExp(W('пятиалтынн\\p{L}*'), 'u').test(t)) return 15;
  if (new RegExp(W('гривенник\\p{L}*'), 'u').test(t)) return 10;
  if (new RegExp(W('рубль|рубля|рублей'), 'u').test(t)) return 100;
  if (new RegExp(W('червонец|червонца'), 'u').test(t)) return 1000;
  return null;
}

function denominationLabel(kop) {
  if (kop == null) return null;
  if (kop === 0.5) return '½ копейки';
  if (kop === 0.25) return '¼ копейки';
  if (kop >= 100 && kop % 100 === 0) { const r = kop / 100; return `${r} ${r === 1 ? 'рубль' : r < 5 ? 'рубля' : 'рублей'}`; }
  if (kop >= 100) return `${(kop / 100).toString().replace('.', ',')} рубля`;
  const last = kop % 10, tens = kop % 100;
  const word = tens >= 11 && tens <= 14 ? 'копеек' : last === 1 ? 'копейка' : last >= 2 && last <= 4 ? 'копейки' : 'копеек';
  return `${kop} ${word}`;
}

function yearFrom(title) {
  const m = (title || '').match(/(?<!\d)(1[6-9]\d\d|20[0-2]\d)(?!\d)/);
  return m ? parseInt(m[1], 10) : null;
}

// Знак минцмейстера / двора: «1912 ЭБ», «СПБ АГ», «ЕМ», «ПЛ» (СССР на гурте)
const MINT_MARKS = ['СПБ', 'ЕМ', 'КМ', 'АМ', 'ММ', 'СМ', 'ВМ', 'ТМ', 'ИМ', 'МД', 'БМ', 'ММД', 'ЛМД'];
const MINTMASTERS = ['АГ', 'ЭБ', 'ФЗ', 'ВС', 'НФ', 'НІ', 'НI', 'НИ', 'МИ', 'ФБ', 'ДС', 'СШ', 'АИ', 'МФ', 'НГ', 'ПС', 'ЯИ', 'АР', 'ПЛ', 'ТР', 'ПФ', 'АЯ', 'СП', 'ХФ', 'ПД', 'АБ', 'ПУ', 'ДМ', 'СА', 'КБ', 'ЯВ', 'ПГ', 'ВН', 'ГР', 'ЕИ'];
function mintFrom(title) {
  const t = (title || '').toUpperCase().replace(/\./g, '');
  const out = {};
  for (const mm of MINT_MARKS) if (new RegExp(W(mm), 'u').test(t)) { out.mint = mm; break; }
  if (!out.mint && /С\s?П\s?Б/.test(t)) out.mint = 'СПБ';
  for (const mm of MINTMASTERS) if (new RegExp(W(mm), 'u').test(t)) { out.mintmaster = mm.replace('I', 'І'); break; }
  return out;
}

function metalFrom(title, sectionPath, denomKop, year, specMetal = null) {
  // поле «Металл» лота ay.by — самый надёжный источник
  const sm = (specMetal || '').toLowerCase();
  if (/серебр/.test(sm)) return 'silver';
  if (/золот/.test(sm)) return 'gold';
  if (/никел|бронз|латун|алюмин|сталь|цинк|медно-/.test(sm)) return 'base'; // «медно-никель» — не медь
  if (/медь|медн/.test(sm)) return 'copper';
  const s = `${sectionPath || ''}`.toLowerCase();
  const t = (title || '').toLowerCase();
  if (/серебр/.test(s) || /серебр|silver|\bag\b|ag\s*\d{3}/u.test(t)) return 'silver';
  // Памятные монеты Нацбанка РБ: 10 и 20 рублей — серебро, 1 и 2 рубля — медно-никель
  if (/нб ?рб|нацбанк|беларус|белорус|рб\b|беларусь/u.test(t) || /беларусь/.test(s)) {
    if (denomKop === 1000 || denomKop === 2000) return 'silver';
    if (denomKop === 100 || denomKop === 200) return 'base';
  }
  if (/золот/.test(s) || /золот|gold|\bau\s*\d{3}/u.test(t)) return 'gold';
  if (/медь|медн/.test(s) || /медь|медн|copper/.test(t)) return 'copper';
  // Екатеринбург, Сузун, Аннинск, Таврида, Ижора чеканили медь: знак двора в заголовке = медная монета
  if (/(?<!\p{L})(ЕМ|КМ|АМ|ТМ|ИМ)(?!\p{L})/u.test((title || '').toUpperCase())) return 'copper';
  // СССР: серебро — 10/15/20 коп 1921–1931, полтинники 1921–1927, рубли 1921–1924
  if (year >= 1921 && year <= 1931 && [10, 15, 20].includes(denomKop)) return 'silver';
  if (year >= 1921 && year <= 1927 && denomKop === 50) return 'silver';
  if (year >= 1921 && year <= 1924 && denomKop === 100) return 'silver';
  if (year >= 1932 && year <= 1991 && denomKop != null && denomKop <= 100) return 'base';
  // Империя: рубли/полтины/25/20/15/10/5 коп с 1867 — серебро (5 коп серебряные до 1915 в билоне)
  if (year >= 1700 && year <= 1917 && [100, 50, 25, 20, 15, 10, 5].includes(denomKop) && !/медь|медн/.test(t)) return 'silver';
  return null;
}

// Состояние по шкале ay.by: «II+ (Как новое, AU)» → { code: 'II+', grade: 'AU' }
function gradeFromAyby(conditionText) {
  if (!conditionText) return {};
  const m = String(conditionText).trim().match(/^(0|II\+|II|III|IV|V|I)(?![\w+])/);
  if (!m) return {};
  return { code: m[1], grade: AYBY_GRADES[m[1]] || null };
}

// Подсказка из заголовка: UNC/aUNC/XF/VF/F, «штемпельный блеск», «анц»
function gradeFromTitle(title) {
  const t = (title || '').replace(/ё/g, 'е');
  const tok = (s) => new RegExp(`(?<![\\p{L}])(?:${s})(?![\\p{L}])`, 'iu');
  if (tok('proof|пруф').test(t)) return 'PF';
  if (tok('[aа]\\s?unc|[aа]унц').test(t)) return 'AU';
  if (tok('unc|анц|унц').test(t) || /штемпельн\p{L}*\s*блеск|штемп\.?\s*блеск/iu.test(t)) return 'UNC';
  if (tok('au').test(t)) return 'AU';
  if (tok('xf\\+?|ef\\+?').test(t)) return 'XF';
  if (tok('vf\\+?').test(t)) return 'VF';
  if (tok('vg').test(t)) return 'VG';
  if (tok('f').test(t) && /(?<!\d)\d{4}(?!\d)/.test(t)) return 'F';
  return null;
}

const FLAG_PATTERNS = [
  ['копия', /копи[яи]|новодел|реплик|муляж|сувенир|фальш|подделк|не оригинал/iu],
  ['отверстие', /дырк|дыроч|отверст|подвес|запа[йя]|пайк|ушк/iu],
  ['чистка', /чищен|чистк|почищ|полиров|зачищ/iu],
  ['повреждения', /царап|забоин|потерт|вмятин|гнут|изгиб|коррози|окисл|пятн|следы/iu],
  ['слаб', /\bngc\b|\bpcgs\b|ннр|рнга|слаб/iu],
  ['несколько монет', /лот из \d|подборк|набор|\d+\s*шт\b|\d+\s*штук/iu],
  ['редкая', /редк|\bR\b|\bR[1-9]\b|биткин\s*r/iu],
];
function flagsFrom(title, description) {
  const t = `${title || ''}\n${description || ''}`;
  const flags = [];
  for (const [label, re] of FLAG_PATTERNS) if (re.test(t)) flags.push(label);
  return flags;
}

function parseCoin({ title, sectionPath, conditionText, description, specs = {} }) {
  const denomKop = denominationFrom(title);
  const year = yearFrom(title);
  const mint = mintFrom(title);
  const metal = metalFrom(title, sectionPath, denomKop, year, specs['Металл'] || null);
  const ay = gradeFromAyby(conditionText);
  const titleGrade = gradeFromTitle(title);
  return {
    denomKop,
    denomination: denominationLabel(denomKop),
    year,
    ruler: year ? rulerFor(year) : (sectionPath && /ссср/i.test(sectionPath) ? 'СССР' : null),
    mint: mint.mint || null,
    mintmaster: mint.mintmaster || null,
    metal,
    isSilver: metal === 'silver',
    conditionCode: ay.code || null,
    grade: ay.grade || titleGrade || null,
    gradeSource: ay.grade ? 'ayby' : titleGrade ? 'title' : null,
    titleGrade,
    flags: flagsFrom(title, description),
  };
}

// Ключи группировки от узкого к широкому (состояние — отдельное измерение)
function groupKeys(p) {
  const keys = [];
  if (p.denomKop == null) return keys;
  const d = p.denomination;
  if (p.year && p.mintmaster) keys.push({ key: `${p.denomKop}|${p.year}|${p.mintmaster}`, label: `${d} ${p.year} ${p.mintmaster}` });
  if (p.year) keys.push({ key: `${p.denomKop}|${p.year}`, label: `${d} ${p.year}` });
  if (p.ruler) keys.push({ key: `${p.denomKop}|${p.ruler}`, label: `${d}, ${p.ruler}` });
  return keys;
}

module.exports = {
  parseCoin, groupKeys, denominationFrom, denominationLabel, yearFrom, mintFrom, metalFrom,
  gradeFromAyby, gradeFromTitle, flagsFrom, rulerFor, GRADE_ORDER, AYBY_GRADES,
};
