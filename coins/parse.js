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

// Номинал в копейках: «50 копеек», «полтина», «1 рубль», «1,5 рубля»; «25 пенни» — не копейки (Финляндия, worldFrom)
// Стартовая ставка аукциона в заголовке: «С 1 РУБЛЯ!», «от 1 руб.», «старт 1 р.», «с рубля», «С 20 копеек» — не номинал
// («Данциг 10 пфеннигов, 1923. С 20 копеек. Распродажа коллекции» читался как 20 копеек 1923 — серебро СССР)
const START_BID_RE = /(?<!\p{L})(?:с|от|старт\p{L}*|(?:начальная\s+|стартовая\s+)?цена)\s*:?\s*(?:(?:\d+(?:[.,]\d+)?\s*)?(?:бел\.?\s*)?(?:руб\p{L}*|р\.|byn)|\d+\s*коп\p{L}*\.?)(?!\p{L})/giu;
function stripStartBid(t) {
  return t.replace(START_BID_RE, ' ');
}

function denominationFrom(title) {
  const t = stripStartBid((title || '').toLowerCase().replace(/ё/g, 'е'));
  // дробные: «1/2 копейки», «1/4 копейки», «½ копейки» — иначе «2 копейки» ловится из «1/2»
  // «1/2 серебром 1840» — полкопейки серебром (медь 1839–1848), слово «копейки» продавцы опускают
  const frac = t.match(/(?:(1)\s*[\/\\]\s*([24])|½|¼)\s*(?:коп|серебром)/u);
  if (frac) return frac[2] ? 1 / parseInt(frac[2], 10) : (frac[0].startsWith('½') ? 0.5 : 0.25);
  // «7 рублей 50 копеек» (золото 1897) → 750
  const rk = t.match(/(?<![\d\/])(\d+)\s*руб\p{L}*\s+(\d{1,2})\s*коп/u);
  if (rk) return parseInt(rk[1], 10) * 100 + parseInt(rk[2], 10);
  // «1р 1921» — «р» без точки только перед годом (иначе «… 100 р» — цена, а не номинал)
  const m = t.match(/(?<![\d\/])(\d+(?:[.,]\d+)?)\s*(коп|руб|р\.|рубл|р(?=\s*1[6-9]\d\d(?!\d)))/u);
  if (m) {
    const n = parseFloat(m[1].replace(',', '.'));
    return m[2].startsWith('коп') ? Math.round(n) : Math.round(n * 100);
  }
  if (new RegExp(W('полкопе\\p{L}*'), 'u').test(t)) return 0.5;
  if (new RegExp(W('полтин\\p{L}*'), 'u').test(t)) return 50;
  if (new RegExp(W('полуполтин\\p{L}*|четвертак\\p{L}*'), 'u').test(t)) return 25;
  if (new RegExp(W('двугривенн\\p{L}*'), 'u').test(t)) return 20;
  if (new RegExp(W('пятиалтынн\\p{L}*'), 'u').test(t)) return 15;
  if (new RegExp(W('гривенник\\p{L}*'), 'u').test(t)) return 10;
  if (new RegExp(W('рубль|рубля|рублей'), 'u').test(t)) return 100;
  if (new RegExp(W('червонец|червонца|сеятель'), 'u').test(t)) return 1000;
  if (new RegExp(W('полуимпериал\\p{L}*'), 'u').test(t)) return 500;
  if (new RegExp(W('империал\\p{L}*'), 'u').test(t)) return 1000;
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

// ---- Германия 1871–1945: марки и пфенниги (номинал не в копейках, отдельный ключ группировки) ----
const GERMAN_STATES = ['Пруссия', 'Бавария', 'Саксония', 'Вюртемберг', 'Баден', 'Гессен', 'Мекленбург', 'Гамбург', 'Любек', 'Бремен',
  'Ольденбург', 'Ангальт', 'Брауншвейг', 'Шварцбург', 'Липпе', 'Рейсс', 'Вальдек', 'Саксен-Веймар', 'Саксен-Мейнинген', 'Саксен-Альтенбург', 'Саксен-Кобург'];
// земля ищется по началу названия («бавар» ловит «Бавария», «Баварский»), составные — целиком
const stateKey = (s) => (s.includes('-') ? s.toLowerCase() : s.toLowerCase().slice(0, 5));
const GERMAN_HINT = new RegExp(`герман|рейх|веймар|${GERMAN_STATES.map(stateKey).join('|')}`, 'u');
const NOT_COIN = /нотгельд|банкнот|(?<!\p{L})бон[аыу]?(?!\p{L})|купюр|облигац|почтов/iu;

const OTHER_MARK_COUNTRY = /финл|финск|finland|suomi|markk|penni|польш|polsk|эстон|eesti|гдр|фрг|данциг|латв|литв|швец|швед|норвег|босни|ссср|ussr|российск\p{L}*\s+импер/iu;

// «3 марки 1911 A Пруссия» → { unit: 'марка', value: 3, key: 'M3', mint: 'A', state: 'Пруссия' }.
// Только 1871–1945. Германия — по разделу, земле или слову в заголовке; без них — только серебряные и золотые номиналы
// своих лет и только без раздела и без признаков другой страны («1 марка 2005» — почтовая марка или другая страна).
function foreignFrom(title, sectionPath, year) {
  if (!year || year < 1871 || year > 1945) return null;
  const t = stripStartBid((title || '').toLowerCase().replace(/ё/g, 'е'));
  if (NOT_COIN.test(t)) return null; // нотгельды, банкноты — бумага, не монеты
  const german = GERMAN_HINT.test(t) || /германи/i.test(sectionPath || '');
  // раздел другой страны или её признак в заголовке — не Германия (марки были у Финляндии, Польши, Эстонии)
  if (!german && (sectionPath || OTHER_MARK_COUNTRY.test(t))) return null;
  // «1 / 2 марки» с пробелами — половина марки, а не «2 марки» (ay.by 5041902713)
  const m = t.match(/(?<![\d\/\\.,]|[\/\\]\s+)(\d+(?:[.,]\d+)?|½|1\s*[\/\\]\s*2)\s*(рейхс?\s*мар\p{L}*|марк\p{L}*|марок|пфен+и?н?г\p{L}*)/u);
  if (!m) return null;
  const value = m[1] === '½' || /^1\s*[\/\\]\s*2$/.test(m[1]) ? 0.5 : parseFloat(m[1].replace(',', '.'));
  if (!(value > 0 && value <= 1000)) return null;
  const unit = /^пф/.test(m[2]) ? 'пфенниг' : 'марка';
  // без слова «Германия» и без раздела (Kufar: «3 марки 1909», «1/2 марки 1913 года. Серебро») — только серебряные
  // и золотые номиналы своих лет из GERMAN_METAL: «N марок» такого года без другой страны — германские
  if (!german && !(unit === 'марка' && GERMAN_METAL.some(([v, from, to]) => v === value && year >= from && year <= to))) return null;
  // буква двора отдельно после года: «1911 A», «1911A», «1904 А» (кириллица), «1913 г. A», «1926 год. F», «1910 год, " F "»;
  // «1934 года. Буква F» — по слову «буква»
  const up = (title || '').toUpperCase();
  const mm = up.match(/(?<![\p{L}\d])(?:18[7-9]\d|19[0-4]\d)(?:\s*(?:Г\.?|ГОДА?)(?=[\s.,]))?(?:[\s.,]+|[\s.,]*[«"(]\s*)?([ADEFGJАЕ])(?![\p{L}\d])/u)
    || up.match(/БУКВА\s*[«"]?([ADEFGJАЕ])(?![\p{L}])/u);
  const mint = mm ? ({ А: 'A', Е: 'E' }[mm[1]] || mm[1]) : null;
  const state = [...GERMAN_STATES].sort((a, b) => stateKey(b).length - stateKey(a).length).find((s) => t.includes(stateKey(s))) || null;
  return { unit, value, key: `${unit === 'марка' ? 'M' : 'PF'}${value}`, mint, state };
}

function foreignLabel(f) {
  if (!f) return null;
  const v = String(f.value).replace('.', ',');
  if (f.unit === 'пфенниг') return `${v} пфеннигов`;
  if (f.value === 0.5) return '½ марки';
  const word = f.value === 1 ? 'марка' : f.value < 5 && Number.isInteger(f.value) ? 'марки' : 'марок';
  return `${v} ${word}`;
}

// ---- Слабы: фирма и грейд по шкале Шелдона ----
// Корзины грейда: цена слаба резко растёт с каждым баллом выше MS63 (архив 2022–2025: MS60–62 ≈ сырая UNC,
// MS63–64 ≈ ×2, MS65+ ≈ ×4–10), поэтому сравнивать можно только внутри своей корзины.
function slabBucket(scale, num) {
  if (!Number.isFinite(num) || num < 1 || num > 70) return null;
  switch (scale) {
    case 'MS': return num >= 66 ? 'MS66+' : num === 65 ? 'MS65' : num === 64 ? 'MS64' : num === 63 ? 'MS63' : num >= 60 ? 'MS60-62' : null;
    case 'PF': return num >= 68 ? 'PF68+' : num >= 65 ? 'PF65-67' : num >= 60 ? 'PF60-64' : null;
    case 'AU': return num >= 50 && num < 60 ? 'AU50-58' : null;
    case 'XF': return num >= 40 && num < 50 ? 'XF40-45' : null;
    case 'VF': return num >= 20 && num < 40 ? 'VF20-35' : null;
    case 'F': return num >= 12 && num < 20 ? 'F12-15' : null;
    default: return null;
  }
}
// Корзина слаба → сырое состояние, которому она примерно равна по цене (только нижние корзины)
const SLAB_RAW_EQUIV = { 'MS60-62': 'UNC', 'AU50-58': 'AU', 'XF40-45': 'XF', 'VF20-35': 'VF', 'F12-15': 'F' };

const scaleOf = (s) => {
  const u = s.toUpperCase().replace(/[МС]/g, (c) => ({ М: 'M', С: 'S' }[c])).replace(/[АХЕР]/g, (c) => ({ А: 'A', Х: 'X', Е: 'E', Р: 'P' }[c]));
  if (/^M[SC]$/.test(u) || u === 'SP' || u === 'PL') return 'MS'; // PL — «prooflike» из банковских наборов ННР
  if (u === 'PF' || u === 'PR') return 'PF';
  if (u === 'EF') return 'XF';
  return u;
};
// «MS-64», «ms 66», «МС64», «AU 58», «PF70», «PR68 ULTRA CAMEO», «MS62BN»
const GRADE_TOKEN = /(?<![\p{L}\d])([MМ][SСC]|[PР][FR]|SP|PL|[AА]U|[XХ]F|[EЕ]F|VF|F)\s*[-–=:]?\s*(\d{1,2})(?!\d)/iu;
const SLAB_COMPANIES = [
  ['NGC', /(?<!\p{L})(?:NGC|HGC|NCG|НГС)(?!\p{L})/iu],
  ['PCGS', /(?<!\p{L})(?:PCGS|PCGC)(?!\p{L})/iu],
  ['ННР', /(?<!\p{L})(?:ННР|HHP|NNR)(?!\p{L})/iu],
  ['RNGA', /(?<!\p{L})(?:RNGA|РНГА)(?!\p{L})/iu],
  ['CPRC', /(?<!\p{L})CPRC(?!\p{L})/iu],
  ['NRG', /(?<!\p{L})(?:NRG|НРГ)(?!\p{L})/iu],
  ['ANACS', /(?<!\p{L})ANACS(?!\p{L})/iu],
  ['ICG', /(?<!\p{L})ICG(?!\p{L})/iu],
];
// «NGC 58», «PCGS 63» — грейд одним числом; но «NGC 15 копеек 1915» — это номинал, не грейд
const COMPANY_NUMBER = /(?<!\p{L})(?:NGC|HGC|NCG|PCGS|PCGC|ННР|HHP|NNR|RNGA|РНГА|CPRC|NRG|НРГ|ICG)\s*[-–=:]?\s*(\d{2})(?!\d)(?!\s*(?:коп|руб|марк|марок|пфен|цент|долл|франк|крон|шилл|злот|лир|пенн|грош|эре|сантим|пес|тенге|фунт|талер|дукат|гульден|рейх))/iu;
// «слаб», «в слабе», «мини-слаб», «слабирована» — но не «слабый чекан»
const SLAB_WORD = /(?<!\p{L})(?:мини-?)?слаб(?:е|ы|а|ах|ом|ов)?(?!\p{L})|слабирова\p{L}*/iu;
const NOT_SLAB = /вынут\p{L}*\s+из\s+(?:мини-?)?слаба|без\s+слаба|не\s+в\s+(?:мини-?)?слабе|из-под\s+слаба/iu;
const DETAILS = /(?<![\p{L}])(?:det(?:ails?)?|дет)(?![\p{L}])/iu;

function gradeTokenFrom(text) {
  const m = (text || '').match(GRADE_TOKEN);
  if (!m) return null;
  const scale = scaleOf(m[1]);
  const num = parseInt(m[2], 10);
  return { scale, num, grade: `${scale}${num}`, bucket: slabBucket(scale, num) };
}

// «5 рублей 1902 АР, Николай II. В слабе NGC MS65» → { company: 'NGC', grade: 'MS65', bucket: 'MS65', details: false }.
// Слаб без грейда («Слаб NGC!») → bucket null: корзины нет, оценивается как сырая монета того же состояния —
// нижняя оценка (слаб не дешевле сырой). «UNC details» → bucket null, details: не оценивается. «Вынута из слаба» — не слаб.
// Описание учитывается только при сильном признаке (фирма + числовой грейд): там бывает «можно слабировать».
function slabFrom(title, description = '') {
  const t = title || '';
  const d = description || '';
  if (NOT_SLAB.test(t)) return null;
  const companyIn = (s) => (SLAB_COMPANIES.find(([, re]) => re.test(s)) || [null])[0];
  let text = null;
  let company = companyIn(t);
  if (company || SLAB_WORD.test(t)) text = t;
  else if (!NOT_SLAB.test(d) && companyIn(d) && GRADE_TOKEN.test(d)) { text = d; company = companyIn(d); }
  if (!text) return null;
  let g = gradeTokenFrom(text);
  if (!g && text === t && d && !NOT_SLAB.test(d)) g = gradeTokenFrom(d);
  if (!g) {
    // «NGC 58», «PCGS 63»: шкала по числу; одним числом пишут только высокие грейды (XF40 и выше)
    const n = text.match(COMPANY_NUMBER);
    if (n && parseInt(n[1], 10) >= 40) {
      const num = parseInt(n[1], 10);
      const scale = num >= 60 ? (/proof|пруф|cam(?:eo)?(?!\p{L})/iu.test(text) ? 'PF' : 'MS') : num >= 50 ? 'AU' : num >= 40 ? 'XF' : num >= 20 ? 'VF' : 'F';
      g = { scale, num, grade: `${scale}${num}`, bucket: slabBucket(scale, num) };
    }
  }
  const details = DETAILS.test(text);
  return {
    company: company || null,
    grade: g ? g.grade : null,
    scale: g ? g.scale : null,
    num: g ? g.num : null,
    bucket: g && !details ? g.bucket : null, // «UNC details» — проблемная монета, корзины нет
    details,
  };
}

// ---- Лоты на вес: «Серебро 500 гр», «лом серебра 875 пр. 100 г» ----
const SILVER_HINT = /серебр|(?<![\p{L}])ag(?![\p{L}])|билон/iu;
const BULK_HINT = /лом|россып|на вес|вес лота|общ\p{L}*\s+вес|общим весом|(?<![\p{L}])кг(?![\p{L}])|килограм/iu;
const PURITIES = [999, 960, 958, 925, 916, 900, 875, 868, 835, 830, 800, 750, 720, 625, 600, 583, 500];
const PURITY_DEFAULT = 0.5; // проба не указана: считаем по билону 500 — нижняя оценка смешанного серебра

// «г» после числа — год, а не граммы: «177-192 г.н.э», «III в. до н.э.», «1898 г.в.», диапазон лет «1894-1917 г»
// (ay.by 2026-11-16: «Коммод 177-192 г.н.э Денарий серебро» стал лотом серебра на вес 192 г)
const YEAR_AFTER = /^\s*\.?\s*(?:н\.?\s*э|до\s*н\.?\s*э|в\.|г\.)/u;
const RANGE_BEFORE = /\d\s*[-–—]\s*$/u;
function gramsFrom(text) {
  const low = (text || '').toLowerCase();
  for (const m of low.matchAll(/(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(кг|килограм\p{L}*|грамм\p{L}*|гр|г)(?!\p{L})/gu)) {
    const n = parseFloat(m[1].replace(',', '.'));
    if (!(n > 0)) continue;
    const kg = /^к/.test(m[2]);
    if (!kg && m[2] === 'г' && Number.isInteger(n) && n >= 1000 && n <= 2100) continue; // «1898 г» — год
    if (m[2] === 'г' && (YEAR_AFTER.test(low.slice(m.index + m[0].length)) || RANGE_BEFORE.test(low.slice(0, m.index)))) continue;
    return kg ? n * 1000 : n;
  }
  return null;
}

// «Ag 925», «проба 900», «серебро 0,999», «Au 585», «925 пр.», «900°»
function purityFrom(text) {
  const t = (text || '').toLowerCase();
  const m = t.match(/(?<!\p{L})(?:ag|au|проб\p{L}*|пр\.?|серебр\p{L}*|золот\p{L}*)\s*[-:]?\s*(?:0?[.,])?(\d{3})(?!\s*(?:г|гр|кг|грамм))(?!\d)|(?<![\d.,])(?:0?[.,])?(\d{3})\s*(?:проб\p{L}*|пр\.|°)/u);
  const n = m ? parseInt(m[1] || m[2], 10) : null;
  return n && PURITIES.includes(n) ? n / 1000 : null;
}

// ---- Содержание металла одной монеты по тексту лота (иностранные и современные монеты, где нет таблицы) ----
// «1 oz», «Унция серебра», «1/2 унции» → чистый металл в унциях; «чистого серебра 31,1 г» → как написано;
// «Ag 925» + «Вес монеты: 33,62 г» (поле ay.by или текст) → вес × проба. Возвращает { fineGrams, basis } или null.
const OUNCE_G = 31.1035;
// «Серебро 999.Унция» (ay.by 5041929853): проверка «перед числом не цифра/точка» — только для числа, не для слова
// «0.375 troy oz» — число через «troy»/«тройская» (ay.by 5041988499: читалось как «oz» без числа = 1 унция)
const OUNCE = /(?:(?<![\d.,\/])(1\s*\/\s*(?:2|4|10|20)|½|¼|\d+(?:[.,]\d+)?)\s*)?(?:(?:тройск\p{L}*|troy)\s+)?(?:унци\p{L}*|oz)(?!\p{L})/iu;
const PURITY_NUMBER = /^(?:9999|999|958|925|916|900|875|835|800|750|585|583|500)$/;
const STATED_FINE = /(?:чист\p{L}*\s+(?:серебр|золот|металл)\p{L}*|содержани\p{L}*\s+(?:чист\p{L}*\s+)?(?:серебр|золот|металл)\p{L}*)[^\d\n]{0,15}(\d+(?:[.,]\d+)?)\s*(?:г|гр|грамм\p{L}*)(?!\p{L})/iu;
const GROSS = /(?:вес|масса)\p{L}*[^\d\n]{0,12}(\d+(?:[.,]\d+)?)\s*(?:г|гр|грамм\p{L}*)(?!\p{L})/iu;
const fracValue = (s) => (!s ? 1 : s === '½' ? 0.5 : s === '¼' ? 0.25 : s.includes('/') ? 1 / parseInt(s.split('/')[1], 10) : parseFloat(s.replace(',', '.')));
const fmtG = (n) => String(Math.round(n * 100) / 100).replace('.', ',');

function contentFrom(title, description, specs = {}) {
  const texts = [title || '', description || ''];
  // «Чистого серебра: 11,66 г» точнее унций: в том же описании бывает «(0.375 troy oz)»
  for (const t of texts) {
    const m = t.match(STATED_FINE);
    const g = m ? parseFloat(m[1].replace(',', '.')) : null;
    if (g > 0.5 && g <= 1100) return { fineGrams: g, basis: `указано ${fmtG(g)} г чистого металла` };
  }
  for (const [i, t] of texts.entries()) {
    const m = t.match(OUNCE);
    if (m) {
      // «Серебро 999 унция» — 999 это проба, а не 999 унций
      const oz = m[1] && PURITY_NUMBER.test(m[1]) ? 1 : fracValue(m[1] && m[1].replace(/\s/g, ''));
      if (oz > 0 && oz <= 5) return { fineGrams: Math.round(oz * OUNCE_G * 100) / 100, basis: `${i ? 'описание' : 'заголовок'}: ${String(oz).replace('.', ',')} унц.` };
    }
  }
  const purity = purityFrom(title) ?? purityFrom(description);
  if (!purity) return null;
  const specW = specs['Вес монеты'] || specs['Вес'] || specs['Масса'] || '';
  const gm = specW.match(/(\d+(?:[.,]\d+)?)/) || (title || '').match(GROSS) || (description || '').match(GROSS);
  const grams = gm ? parseFloat(gm[1].replace(',', '.')) : gramsFrom(title); // «3 рубля 1995 Ag 900 34,88 г»
  if (!(grams > 0.5 && grams <= 1100)) return null;
  return { fineGrams: Math.round(grams * purity * 100) / 100, basis: require('./metal').purityBasis(grams, purity) };
}

// ---- Иностранные номиналы (кроме марок): для таблицы содержания металла (coins/metal.js WORLD) ----
const WORLD_UNITS = [
  ['доллар', /доллар\p{L}*|dollars?(?!\p{L})/u], ['цент', /цент\p{L}*|cents?(?!\p{L})/u], ['франк', /франк\p{L}*|francs?(?!\p{L})/u],
  ['лира', /лир(?:а|ы|е)?(?!\p{L})|lire(?!\p{L})/u], ['гульден', /гульден\p{L}*/u], ['дукат', /дукат\p{L}*/u], ['крона', /крон(?:а|ы|ен|ер)?(?!\p{L})/u],
  ['песо', /песо(?!\p{L})/u], ['злотый', /злот\p{L}*/u], ['соверен', /соверен\p{L}*|sovereign/u],
  // Финляндия в составе Империи: «25 pennia 1916», «50 пенни 1916 S», «1 markka 1915», «20 марок 1913» (германские
  // марки разбирает раньше foreignFrom — по слову «Германия»/земле или разделу)
  ['пенни', /пенни\p{L}*|penni\p{L}*/u], ['марка', /мар(?:ка|ки|ок)(?!\p{L})|markk\p{L}*/u],
  // Великобритания: «1 шиллинг 1943», «6 пенсов 1936»
  ['шиллинг', /шиллинг\p{L}*|shillings?(?!\p{L})/u], ['пенс', /пенс(?:а|ов)?(?!\p{L})|pence(?!\p{L})/u],
];
const WORLD_WORDS = [
  [/полсоверен|1\/2\s*соверен|half\s*sovereign/u, 'соверен', 0.5], [/(?<!\p{L})соверен|sovereign/u, 'соверен', 1],
  [/полдоллар|half\s*dollar/u, 'цент', 50], [/квотер|quarter/u, 'цент', 25], [/(?<!\p{L})(?:дайм|dime)(?!\p{L})/u, 'цент', 10],
  [/морган|morgan|peace\s*dollar/u, 'доллар', 1], [/крюгерр?анд|krugerrand/u, 'крюгерранд', 1],
  [/полкрон|half\s*crown/u, 'крона', 0.5], [/(?<!\p{L})crown(?!\p{L})/u, 'крона', 1],
  [/(?<!\p{L})(?:флорин|florin)/u, 'шиллинг', 2], [/sixpence|шестипенс/u, 'пенс', 6], [/threepence|тр[её]хпенс/u, 'пенс', 3],
];
const COUNTRIES = [
  ['США', /(?<!\p{L})(?:сша|usa)(?!\p{L})|соединенн\p{L}*\s+штат|морган|morgan|кеннеди|kennedy|peace\s*dollar/iu],
  ['Польша', /польш|polsk/iu], ['Беларусь', /беларус|белорус|нб\s?рб|нацбанк/iu], ['Германия', /германи|рейх/iu],
  ['Канада', /канад|canada/iu], // раньше Великобритании: «Канада … Королева Великобритании»
  ['Великобритания', /британ|англи/iu], ['Финляндия', /финл|финск|finland|suomi|markk|penni/iu],
];

// Номинал одной страны: страна понятна и без раздела («5 злотых 1934» на Kufar)
const UNIT_COUNTRY = { 'злотый': 'Польша', 'пенни': 'Финляндия' };

// Финляндия 1864–1917 (русско-финские): серебро 750 (25, 50 пенни) и 868 (1, 2 марки), золото 10 и 20 марок.
// После 1917 — медь и медно-никель. [единица, номинал, год от, год до, металл]
const FINLAND_METAL = [
  ['пенни', 25, 1865, 1917, 'silver'], ['пенни', 50, 1864, 1917, 'silver'], ['марка', 1, 1864, 1915, 'silver'],
  ['марка', 2, 1865, 1908, 'silver'], ['марка', 10, 1878, 1913, 'gold'], ['марка', 20, 1878, 1913, 'gold'],
];

function worldFrom(title, sectionPath, specs = {}) {
  const t = stripStartBid(`${title || ''} ${specs['Номинал'] || ''}`.toLowerCase().replace(/ё/g, 'е'));
  let unit = null, value = null;
  for (const [u, re] of WORLD_UNITS) {
    const m = t.match(new RegExp(`(?<![\\d\\/\\\\.,]|[\\/\\\\]\\s+)(\\d+(?:[.,]\\d+)?|1\\s*[\\/\\\\]\\s*2|½)\\s*(?:${re.source})`, 'u'));
    if (m) { unit = u; value = fracValue(m[1].replace(/\s/g, '').replace('\\', '/')); break; }
  }
  if (!unit) for (const [re, u, v] of WORLD_WORDS) if (re.test(t)) { unit = u; value = v; break; }
  if (!unit) return null;
  const where = `${sectionPath || ''} ${title || ''}`;
  const country = (COUNTRIES.find(([, re]) => re.test(where)) || [null])[0] || UNIT_COUNTRY[unit] || null;
  return { unit, value, country };
}

function worldLabel(w) {
  return w ? `${String(w.value).replace('.', ',')} ${w.unit}${w.country ? ` (${w.country})` : ''}` : null;
}

// Не монеты: столовое серебро и украшения с весом в заголовке — не лот монет на вес
const NOT_BULK_COINS = /(?<!\p{L})(?:ложк|вилк|нож|кольц|серьг|цепоч|браслет|подстакан|рюмк|стопк|столов|ювелир|кулон|брош|часы|портсигар|оклад|икон)/iu;

// Вес серебра в лоте: только если это действительно лот на вес — нет номинала (ни копеек, ни марок), подборка или
// «лом / россыпь / кг» в заголовке. Вес одной монеты («1 рубль 1898, 20 г», «2 марки 1876, 11,1 г») сюда не попадает.
function weightFrom(title, description, { denomKop = null, single = false, isSet = false } = {}) {
  const t = title || '';
  if (!SILVER_HINT.test(t) || NOT_BULK_COINS.test(t)) return null;
  if (!((denomKop == null && !single) || isSet || BULK_HINT.test(t))) return null;
  let grams = gramsFrom(t);
  if (grams == null && BULK_HINT.test(t)) {
    const dm = (description || '').match(/(?:общ\p{L}*\s+)?(?:вес|масса)\p{L}*[^.\n\d]{0,20}(\d+(?:[.,]\d+)?\s*(?:кг|гр?|грамм\p{L}*))(?!\p{L})/iu);
    if (dm) grams = gramsFrom(dm[1]);
  }
  if (!(grams > 0)) return null;
  const p = purityFrom(t) ?? purityFrom(description);
  const purity = p ?? PURITY_DEFAULT;
  return { grams, purity, purityAssumed: p == null, fineGrams: Math.round(grams * purity * 10) / 10 };
}

// «без МЦ», «без мин. цены», «без МПЦ» — продавец не ставил минимальную (резервную) цену
const NO_RESERVE = /(?<!\p{L})без\s*(?:мин(?:имальн\p{L}*)?\.?\s*(?:цен\p{L}*)?|м\.?\s?[пн]?\.?\s?ц\.?|резерв\p{L}*)(?!\p{L})/iu;

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

// Германия: серебряные марки Империи и Веймара/Рейха, золотые 10 и 20 марок до 1915. [номинал, год от, год до, металл]
const GERMAN_METAL = [
  [0.5, 1905, 1919, 'silver'], [1, 1873, 1916, 'silver'], [1, 1925, 1927, 'silver'], [2, 1876, 1915, 'silver'], [2, 1925, 1939, 'silver'],
  [3, 1908, 1918, 'silver'], [3, 1924, 1933, 'silver'], [5, 1874, 1915, 'silver'], [5, 1925, 1939, 'silver'], [10, 1871, 1915, 'gold'], [20, 1871, 1915, 'gold'],
];

function metalFrom(title, sectionPath, denomKop, year, specMetal = null, foreign = null, world = null) {
  // «¼, ½, 1, 2, 3 копейки серебром» 1839–1848 (дворы ЕМ, СМ, СПМ) — медь: «серебром» — счёт на серебряный рубль,
  // а не металл (ay.by 5032544116 «1/2 серебром 1840 СПМ» пришёл как серебро на 9 г). Раньше поля «Металл» и слова
  // «серебро»: продавцы выбирают металл по надписи на монете
  if (/серебром/.test((title || '').toLowerCase()) && (denomKop == null || denomKop <= 3)
    && (year ? year >= 1839 && year <= 1848 : denomKop != null)) return 'copper';
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
  // СССР: серебро 500 пробы — 10/15/20 коп 1921–1930, полтинники 1921–1927, рубли 1921–1924. 10/15/20 коп 1931 —
  // массово медно-никелевые, серебряные 1931 — редкость: серебро только по слову в заголовке или поле «Металл»
  if (year >= 1921 && year <= 1930 && [10, 15, 20].includes(denomKop)) return 'silver';
  if (year >= 1921 && year <= 1927 && denomKop === 50) return 'silver';
  if (year >= 1921 && year <= 1924 && denomKop === 100) return 'silver';
  // СССР, Олимпиада-80 (1977–1980): 5 и 10 рублей — серебро (16,67 и 33,3 г 900, тиражи — миллионы), 50 и 100 — золото.
  // «Сеятель» 10 рублей 1975–1982 — золото, но в 1977–1980 под тем же номиналом и олимпийское серебро
  // (ay.by 5041865834 «10 рублей 1978 прыжки с шестом» считался золотом на 2 876 р.): там золото — только по слову
  if (year >= 1977 && year <= 1980 && (denomKop === 500 || denomKop === 1000)) return /сеятел|червон/.test(t) ? 'gold' : 'silver';
  if (year >= 1977 && year <= 1980 && (denomKop === 5000 || denomKop === 10000)) return 'gold';
  // СССР: червонец 1923 и «Сеятель» 1975–1976, 1981–1982 — золото
  if (denomKop === 1000 && (year === 1923 || (year >= 1975 && year <= 1982))) return 'gold';
  if (year >= 1931 && year <= 1991 && denomKop != null && denomKop <= 100) return 'base';
  // 5 копеек 1758–1796 — медный пятак Елизаветы и Екатерины II, серебряных 5 копеек в эти годы не чеканили
  if (denomKop === 5 && year >= 1758 && year <= 1796) return 'copper';
  // Империя: рубли/полтины/25/20/15/10/5 коп с 1867 — серебро (5 коп серебряные до 1915 в билоне)
  if (year >= 1700 && year <= 1917 && [100, 50, 25, 20, 15, 10, 5].includes(denomKop) && !/медь|медн/.test(t)) return 'silver';
  // Империя: 3, 5, 7½, 10, 15, 25, 37½ рублей — только золото (серебряных монет таких номиналов не было)
  if (year >= 1700 && year <= 1917 && [300, 500, 750, 1000, 1500, 2500, 3750].includes(denomKop)) return 'gold';
  if (foreign && foreign.unit === 'марка') {
    const row = GERMAN_METAL.find(([v, from, to]) => v === foreign.value && year >= from && year <= to);
    if (row) return row[3];
  }
  if (world && world.country === 'Финляндия' && year) {
    const row = FINLAND_METAL.find(([u, v, from, to]) => u === world.unit && v === world.value && year >= from && year <= to);
    if (row) return row[4];
  }
  // Великобритания до 1946: кроны, полукроны, флорины, шиллинги, 6 пенсов — серебро (3 пенса с 1937 бывают латунные —
  // только по слову). С 1947 — медно-никель
  if (world && world.country === 'Великобритания' && year >= 1816 && year <= 1946
    && (['крона', 'шиллинг'].includes(world.unit) || (world.unit === 'пенс' && world.value === 6))) return 'silver';
  // Канада: доллар 1935–1967, 10/25/50 центов 1920–1967 — серебро 800. Позже — никель (памятные серебряные — по слову)
  if (world && world.country === 'Канада' && year >= 1920 && year <= 1967
    && ((world.unit === 'доллар' && world.value === 1 && year >= 1935) || (world.unit === 'доллар' && world.value === 0.5)
      || (world.unit === 'цент' && [10, 25, 50].includes(world.value)))) return 'silver';
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
  // «не копия», «не подделка» в описании — наоборот, заверение продавца
  ['копия', /(?<!не\s+)(?:копи[яи]|новодел|реплик|муляж|сувенир|фальш|подделк)|не\s+оригинал/iu],
  ['отверстие', /дырк|дыроч|отверст|подвес|запа[йя]|пайк|ушк/iu],
  ['чистка', /чищен|чистк|почищ|полиров|зачищ/iu],
  ['повреждения', /царап|забоин|потерт|вмятин|гнут|изгиб|коррози|окисл|пятн|следы/iu],
  // флаг «слаб» ставит parseCoin по slabFrom: простое «слаб» ловило «слабый чекан»
  // «лот из 3», «одним лотом 3 монеты», «3 монеты», «20 15 10 копеек», «1 и 2 копейки»
  // «из набора ГБ СССР» — одна монета из банковского набора, не подборка
  // «Сборный лот монет 10 копеек. 1924, 1925, 1927», «10 копеек 1924-1957 погодовка», «10 копеек 1924, 27 и 30» —
  // несколько монет: их цена попадала в медиану одной монеты (ay.by 5041197350: «10 копеек 1924» за 18 р. «выгодно»)
  ['несколько монет', /сборн\p{L}*\s+лот|погодовк|лот\s+монет|(?:1[6-9]\d\d|20\d\d)\s*(?:г\.?\s*)?(?:[,;&]|\sи\s)\s*(?:1[6-9]\d\d|20\d\d)(?!\d)|(?:1[6-9]\d\d|20\d\d)\s*,\s*\d{2}\s*(?:,|\sи\s)\s*\d{2}(?!\d)|лот из \d|подборк|(?<!из\s+(?:\p{L}+\s+)?)набор|\d+\s*шт(?!\p{L})|\d+\s*штук|одним лотом|(?<![\d\/])(?:[2-9]|[1-9]\d{1,2})\s*монет|(?<![\d\/])(?:\d{1,2}[\s,;]+(?:и\s+)?)+\d{1,2}\s*коп/iu],
  ['редкая', /редк|\bR\b|\bR[1-9]\b|биткин\s*r/iu],
];
const COPY_SECTION = /копи[ия]|новодел|реплик|сувенир/iu;
// Не монета, а принадлежность к ней: «Сертификат к памятной монете … 20 рублей 2000», «Футляр и сертификат для монеты»,
// «… без монеты». «Монета в капсуле с сертификатом» — монета (заголовок начинается не с принадлежности)
// «Буклеты разные к серии …» — до трёх слов между принадлежностью и «к/для»
const ACCESSORY = /^\s*(?:сертификат|футляр|коробк|коробочк|капсул|буклет|упаковк|бланк|подложк|вкладыш)\p{L}*(?:[\s,]+[\p{L}-]+){0,3}?[\s,]+(?:к|для|от|на|из-под)(?!\p{L})|без\s+(?:самой\s+)?монет/iu;
// раздел ay.by «Монеты › Беларусь (после 1991) › Буклеты, сертификаты» — надёжнее заголовка (виден со страницы лота)
const ACCESSORY_SECTION = /буклет|сертификат/iu;

// «без забоин», «Отсутствуют грубые дефекты, забоины или следы износа», «не чищена» — продавец заверяет, что дефекта нет
// (ay.by 5041988554: «⚠️ повреждения» по такому описанию). «без / нет / не» — вплотную перед словом дефекта, между
// ними не больше двух слов без запятых и цифр («без грубых забоин», «без забоин и следов»; «без коробки, царапина»
// и «без мц с отверстием» — дефект: «без МЦ» вырезается заранее). «Отсутствуют …» — до конца предложения, пока
// не встретилось «есть / но / имеются» («отсутствует сертификат, есть следы обращения» — дефект).
const NEGATABLE = new Set(['отверстие', 'чистка', 'повреждения']);
const NEGATION_NEAR = /(?<!\p{L})(?:без|нет|не|ни)\s+(?:[\p{L}-]+\s+){0,2}$/iu;
const NEGATION_LIST = /(?<!\p{L})отсутству\p{L}*(?![^]*(?<!\p{L})(?:есть|но|имеются|имеется)(?!\p{L}))/iu;
function hasDefect(text, re) {
  const t = text.replace(new RegExp(NO_RESERVE.source, 'giu'), ' ');
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of t.matchAll(g)) {
    const before = t.slice(0, m.index);
    const sentence = before.slice(before.search(/[^.!?\n]*$/));
    if (!NEGATION_NEAR.test(sentence) && !NEGATION_LIST.test(sentence)) return true;
  }
  return false;
}

function flagsFrom(title, description) {
  const t = `${title || ''}\n${description || ''}`;
  const flags = [];
  for (const [label, re] of FLAG_PATTERNS) if (NEGATABLE.has(label) ? hasDefect(t, re) : re.test(t)) flags.push(label);
  // Два и более номинала в заголовке («5 копеек 1899 и 10 копеек 1913») — тоже набор; «7 рублей 50 копеек» — один
  if (!flags.includes('несколько монет')) {
    const tt = stripStartBid((title || '').toLowerCase().replace(/ё/g, 'е')).replace(/\d+\s*руб\p{L}*\s+\d{1,2}\s*коп\p{L}*/gu, 'X');
    const denoms = tt.match(/(?<![\d\/.,])\d+(?:[.,]\d+)?\s*(?:коп|руб)/gu) || [];
    if (denoms.length >= 2) flags.push('несколько монет');
  }
  return flags;
}

function parseCoin({ title, sectionPath, conditionText, description, specs = {} }) {
  const denomKop = denominationFrom(title);
  const year = yearFrom(title);
  const mint = mintFrom(title);
  const foreign = denomKop == null ? foreignFrom(title, sectionPath, year) : null;
  const world = denomKop == null && !foreign ? worldFrom(title, sectionPath, specs) : null;
  const metal = metalFrom(title, sectionPath, denomKop, year, specs['Металл'] || null, foreign, world);
  const ay = gradeFromAyby(conditionText);
  const titleGrade = gradeFromTitle(title);
  const flags = flagsFrom(title, description);
  // раздел ay.by «Монеты › Копии, новоделы» (и сувенирные): в заголовке «копия» продавцы часто не пишут
  if (!flags.includes('копия') && COPY_SECTION.test(sectionPath || '')) flags.push('копия');
  // сертификат или футляр без монеты: металла нет, в мониторы серебра и золота не попадает
  if (ACCESSORY.test(title || '') || ACCESSORY_SECTION.test(sectionPath || '')) {
    flags.push('не монета');
    return { denomKop, denomination: null, year, ruler: null, mint: null, mintmaster: null, foreign: null, world: null, content: null,
      metal: null, isSilver: false, isGold: false, isPrecious: false, conditionCode: ay.code || null, grade: null, gradeSource: null,
      titleGrade, slab: null, weight: null, noReserve: NO_RESERVE.test(title || ''), flags };
  }
  // числовой грейд в уточнении к состоянию («MS66» под полем «Состояние») — монета в слабе, даже если в заголовке
  // о слабе ни слова; служба неизвестна
  const condNote = specs['Состояние: уточнение'] || '';
  const slab = slabFrom(title, description) || (/(?<!\p{L})(?:MS|PF|PR|AU|XF|VF)\s?-?\d{2}(?!\d)/iu.test(condNote) ? slabFrom(`слаб ${condNote}`, '') : null);
  if (slab) flags.push('слаб');
  const weight = weightFrom(title, description, { denomKop, single: Boolean(foreign || world), isSet: flags.includes('несколько монет') });
  const finalMetal = weight ? 'silver' : metal;
  // одна монета из драгметалла: содержание по тексту (унции, «чистого серебра N г», вес × проба)
  const content = !weight && (finalMetal === 'silver' || finalMetal === 'gold') && !flags.includes('несколько монет')
    ? contentFrom(title, description, specs) : null;
  const parsed = {
    denomKop,
    denomination: denominationLabel(denomKop) || foreignLabel(foreign) || worldLabel(world),
    year,
    // правитель — только у монет в копейках/рублях: «20 франков 1910» не Николай II
    ruler: year && denomKop != null ? rulerFor(year) : (!year && sectionPath && /ссср/i.test(sectionPath) ? 'СССР' : null),
    mint: mint.mint || null,
    mintmaster: mint.mintmaster || null,
    foreign,
    world,
    content,
    metal: finalMetal,
    isSilver: Boolean(weight) || metal === 'silver',
    isGold: !weight && metal === 'gold',
    isPrecious: Boolean(weight) || metal === 'silver' || metal === 'gold',
    conditionCode: ay.code || null,
    grade: ay.grade || titleGrade || null,
    gradeSource: ay.grade ? 'ayby' : titleGrade ? 'title' : null,
    titleGrade,
    slab,
    weight,
    noReserve: NO_RESERVE.test(title || ''),
    flags,
  };
  // продавец пишет другой вес чистого металла, чем стандарт чеканки из таблиц (coins/metal.js): отметка для сверки
  const mismatch = content ? require('./metal').contentMismatch(parsed) : null;
  if (mismatch) parsed.contentMismatch = mismatch;
  return parsed;
}

// СССР 1961–1991, недрагметалл: номинал (коп.) → год → что искать. Деньги здесь не в типе, а в букве двора, цвете
// металла (перепутка — монета на кружке другого номинала), гурте и редких годах. Цены — дилерская таблица raritetus
// (без даты): 20 коп. 1991 без буквы 13,8–27,7 тыс. ₽, 5 и 10 коп. 1990 М до 26–30 тыс., белые 2/3 коп. 12–75 тыс.
const USSR_VARIETIES = {
  1: { 1963: 'приподнятый герб' },
  2: { 1986: 'белая (на кружке 10 коп.)', 1988: 'белая (на кружке 10 коп.)', 1989: 'белая (на кружке 10 коп.)', 1990: 'белая (на кружке 10 коп.)', 1991: 'белая (на кружке 10 коп.)' },
  3: { 1961: 'белая', 1971: 'без уступа на колосьях', 1983: 'белая', 1986: 'частый гурт', 1989: 'белая (на кружке 20 коп.)', 1990: 'белая (на кружке 20 коп.)', 1991: 'белая с буквой М' },
  5: { 1970: 'редкий год', 1990: 'буква М' },
  10: { 1987: '«колос не касается шара»', 1990: 'буква М', 1991: 'без буквы; жёлтая (на кружке 1 коп.)' },
  15: { 1970: 'редкий год', 1980: '«волосатая»', 1987: '«лысая» (без остей)' },
  20: { 1965: 'редкий год', 1970: 'редкий год', 1972: 'редкий год', 1986: 'жёлтая (на кружке 3 коп.)', 1989: 'жёлтая', 1990: 'жёлтая', 1991: 'без буквы; Л на кружке 15 коп.' },
  50: { 1971: 'редкий год', 1986: 'гурт с годом 1985', 1988: 'гурт с годом 1987', 1989: 'гурт с годом 1988', 1990: 'на кружке 20 коп.' },
  100: { 1967: 'гурт с годом 1966', 1984: 'ошибка («Ломоносов»)', 1986: '«шалаш»', 1990: 'гурт с годом 1989; ошибка («Лебедев»)' },
};
// Что искать у монеты СССР 1961–1991 (строка) или null — не из таблицы / драгметалл
function ussrVariety(parsed) {
  if (!parsed || parsed.isPrecious || !(parsed.year >= 1961 && parsed.year <= 1991)) return null;
  return (USSR_VARIETIES[parsed.denomKop] || {})[parsed.year] || null;
}

// Почему лот нельзя присылать при любой цене (общее правило для ay.by, Kufar, отчёта и фото): копия; подборка,
// если это не лот серебра на вес; слаб не на аукционе (фиксированные цены на слабы завышены, подделки обычны).
// null — препятствий нет. saleType: 'auction' | 'auction_buynow' | 'buy_now' | 'fixed' (Kufar).
function notifyBlocker(parsed, saleType = null) {
  if (!parsed) return 'не разобрано';
  const flags = parsed.flags || [];
  if (flags.includes('копия')) return 'копия';
  if (flags.includes('не монета')) return 'не монета (сертификат, футляр)';
  if (flags.includes('несколько монет') && !parsed.weight) return 'подборка / несколько монет';
  if (parsed.slab && !/auction/.test(saleType || '')) return 'слаб по фиксированной цене (только аукционы)';
  return null;
}

// Ключи группировки от узкого к широкому (состояние — отдельное измерение). level: variant (буквы/земля),
// type (номинал и год), ruler (номинал за всё правление — только как последний запасной вариант)
function groupKeys(p) {
  const keys = [];
  if (p.denomKop == null) {
    // марки: «M3|1911|A|Пруссия» → «M3|1911|A» → «M3|1911» (памятные разных земель одного года не смешиваются, пока есть данные)
    const f = p.foreign;
    // иностранные с известной страной («25 пенни (Финляндия) 1916», «5 злотых (Польша) 1934»): номинал и год
    const w = p.world;
    if (!f && w && w.country && p.year && p.year <= 1991) {
      keys.push({ key: `W|${w.country}|${w.unit}${w.value}|${p.year}`, label: `${p.denomination} ${p.year}`, level: 'type' });
      return keys;
    }
    if (!f || !p.year) return keys;
    const d = p.denomination;
    if (f.mint && f.state) keys.push({ key: `${f.key}|${p.year}|${f.mint}|${f.state}`, label: `${d} ${p.year} ${f.mint}, ${f.state}`, level: 'variant' });
    if (f.mint) keys.push({ key: `${f.key}|${p.year}|${f.mint}`, label: `${d} ${p.year} ${f.mint}`, level: 'variant' });
    keys.push({ key: `${f.key}|${p.year}`, label: `${d} ${p.year}`, level: 'type' });
    return keys;
  }
  // после 1991 (памятные НБРБ и Банка России): под одним номиналом и годом — десятки разных монет, сравнивать нельзя
  if (p.year > 1991) return keys;
  const d = p.denomination;
  if (p.year && p.mintmaster) keys.push({ key: `${p.denomKop}|${p.year}|${p.mintmaster}`, label: `${d} ${p.year} ${p.mintmaster}`, level: 'variant' });
  if (p.year) keys.push({ key: `${p.denomKop}|${p.year}`, label: `${d} ${p.year}`, level: 'type' });
  if (p.ruler) keys.push({ key: `${p.denomKop}|${p.ruler}`, label: `${d}, ${p.ruler}`, level: 'ruler' });
  return keys;
}

module.exports = {
  parseCoin, groupKeys, notifyBlocker, denominationFrom, denominationLabel, yearFrom, mintFrom, metalFrom,
  gradeFromAyby, gradeFromTitle, flagsFrom, rulerFor, slabFrom, gradeTokenFrom, weightFrom, contentFrom, worldFrom, purityFrom, ussrVariety,
  GRADE_ORDER, AYBY_GRADES, SLAB_RAW_EQUIV, COPY_SECTION,
};
