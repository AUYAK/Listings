// Содержание драгметалла в монете (граммы чистого металла) и стоимость металла в BYN по ценам слитков НБРБ.
// Это нижняя планка: монета не может стоить дешевле металла в ней, при любом состоянии. Для золота
// (обычные годы торгуются около металла) — ещё и основной ориентир, пока нет архива проходов.
// Веса — стандарты чеканки; для старых серий, где стопа менялась, взят осторожный (меньший) вес.

const { metalPrices } = require('./rates');

// [номинал в копейках, год от, год до, грамм чистого металла]
const SILVER = [
  [100, 1700, 1917, 18.0],   // рубль: 20 г 900 (1886–1917), 20,73 г 868 (1810–1885), ранее близко к 18 г чистого
  [50, 1700, 1917, 9.0],
  [25, 1700, 1917, 4.5],
  [20, 1867, 1917, 1.8],     // билон 500: 3,6 г
  [20, 1700, 1866, 3.0],     // 868/750 пробы, 4,1 г
  [15, 1867, 1917, 1.35],
  [15, 1700, 1866, 2.3],
  [10, 1867, 1917, 0.9],
  [10, 1700, 1866, 1.5],
  [5, 1867, 1915, 0.45],
  [5, 1700, 1866, 0.9],
  [100, 1921, 1924, 18.0],   // СССР: рубль 20 г 900
  [50, 1921, 1927, 9.0],     // полтинник 10 г 900
  [20, 1921, 1931, 1.8],     // билон 500
  [15, 1921, 1931, 1.35],
  [10, 1921, 1931, 0.9],
];
const GOLD = [
  [1000, 1897, 1911, 7.74],  // 10 рублей: 8,6 г 900
  [1000, 1886, 1896, 11.61], // 10 рублей: 12,9 г 900
  [1000, 1755, 1885, 11.0],  // империал, стопа менялась — осторожно
  [1500, 1897, 1897, 11.61], // 15 рублей 1897
  [750, 1897, 1897, 5.81],   // 7 рублей 50 копеек 1897
  [500, 1897, 1911, 3.87],   // 5 рублей: 4,3 г 900
  [500, 1886, 1896, 5.81],   // 5 рублей: 6,45 г 900
  [500, 1755, 1885, 6.0],    // полуимпериал: 6,54 г 917
  [300, 1869, 1885, 3.6],    // 3 рубля: 3,93 г 917
  [2500, 1876, 1908, 29.0],  // 25 рублей (1876, 1896, 1908)
  [3750, 1902, 1902, 29.0],  // 37 рублей 50 копеек 1902
  [1000, 1923, 1925, 7.74],  // червонец 1923 (и пробные 1925)
  [1000, 1975, 1982, 7.74],  // червонец «Сеятель» 1975–1982
];

// Памятные СССР 1977–1991, России и Беларуси после 1991: у одного номинала бывают разные веса — берётся меньший
// из ходовых (это нижняя планка). Точнее — по тексту лота (parse.contentFrom), он важнее этой таблицы.
// [номинал в копейках, год от, год до, грамм чистого металла]
const MODERN_SILVER = [
  [300, 1987, 2100, 31.1],   // 3 рубля: СССР 1987–1991 и Россия 34,56–34,88 г 900
  [500, 1977, 1980, 15.0],   // 5 рублей Олимпиада-80: 16,67 г 900
  [500, 1988, 1991, 31.1],   // 5 рублей СССР 1988–1991: 34,56 г 900
  [1000, 1977, 1980, 30.0],  // 10 рублей Олимпиада-80: 33,3 г 900
  [1000, 1992, 2100, 15.5],  // 10 рублей НБРБ: 16,81 г 925 (бывают и 33,62 г)
  [2000, 1992, 2100, 26.1],  // 20 рублей НБРБ: 28,28 г 925 (чаще 33,62 г)
];
const MODERN_GOLD = [
  [2500, 1992, 2100, 3.1],   // 25 рублей: 3,11 г 999
  [5000, 1977, 2100, 7.7],   // 50 рублей: СССР 8,64 г 900, «Победоносец» 7,78 г 999
  [10000, 1977, 2100, 15.5], // 100 рублей: 17,28 г 900 / 15,55 г 999
];
// Германия 1871–1945 по ключу номинала parse.foreignFrom: [номинал, год от, год до, металл, грамм]
const GERMAN = [
  [0.5, 1905, 1919, 'silver', 2.5], [1, 1873, 1916, 'silver', 5.0], [2, 1876, 1915, 'silver', 10.0], [3, 1908, 1918, 'silver', 15.0],
  [5, 1874, 1915, 'silver', 25.0], [1, 1925, 1927, 'silver', 2.5], [2, 1925, 1939, 'silver', 5.0], [3, 1924, 1933, 'silver', 7.5],
  [5, 1925, 1939, 'silver', 12.5], [10, 1871, 1915, 'gold', 3.58], [20, 1871, 1915, 'gold', 7.17],
];
// «14,14 г × проба 500 (билон)» — как посчитан чистый металл; билон — проба 500 и ниже (половина и больше — медь)
function purityBasis(grams, purity) {
  const mil = Math.round(purity * 1000);
  return `${String(Math.round(grams * 100) / 100).replace('.', ',')} г × проба ${mil}${mil <= 500 ? ' (билон)' : ''}`;
}

// Великобритания: серебро 925 (1816–1919), 500 (1920–1946), с 1947 — медно-никель. [единица, номинал, вес монеты]
const UK_SILVER = [['крона', 1, 28.28], ['крона', 0.5, 14.14], ['шиллинг', 2, 11.31], ['шиллинг', 1, 5.65], ['пенс', 6, 2.83], ['пенс', 3, 1.41]];
const UK = UK_SILVER.flatMap(([unit, value, gross]) => [[1816, 1919, 0.925], [1920, 1946, 0.5]].map(([from, to, purity]) =>
  ['Великобритания', unit, value, from, to, 'silver', Math.round(gross * purity * 100) / 100, purityBasis(gross, purity)]));

// Иностранные монеты (parse.worldFrom): [страна или null — любая, единица, номинал, год от, год до, металл, грамм,
// пояснение — необязательно]. Применяется только если металл монеты уже известен (поле «Металл» ay.by, заголовок или
// правило года в parse.metalFrom): «20 лир» 1970-х — не золото.
// Канада: доллар 1935–1967 — 23,33 г 800; памятные серебряные 1971–1991 — 23,33 г 500 (тот же номинал бывает
// никелевым — строка работает, только если серебро уже известно); 1992–2011 — 25,175 г 925; 10/25/50 центов
// 1920–1967 — серебро 800 (до 1919 — 925)
const CANADA = [
  ['Канада', 'доллар', 1, 1935, 1967, 'silver', 18.66, purityBasis(23.33, 0.8)], ['Канада', 'доллар', 1, 1971, 1991, 'silver', 11.66, purityBasis(23.33, 0.5)],
  ['Канада', 'доллар', 1, 1992, 2011, 'silver', 23.29, purityBasis(25.175, 0.925), 'loose'], // с 2003 бывают и 9999
  ['Канада', 'цент', 50, 1920, 1967, 'silver', 9.33, purityBasis(11.66, 0.8)], ['Канада', 'доллар', 0.5, 1920, 1967, 'silver', 9.33, purityBasis(11.66, 0.8)],
  ['Канада', 'цент', 25, 1920, 1967, 'silver', 4.67, purityBasis(5.83, 0.8)],
  ['Канада', 'цент', 10, 1920, 1967, 'silver', 1.87, purityBasis(2.33, 0.8)],
];

const WORLD = [
  ...UK, ...CANADA,
  ['США', 'доллар', 1, 1878, 1935, 'silver', 24.06], ['США', 'доллар', 1, 1986, 2100, 'silver', 31.1, null, 'loose'], // Морган/Пис; Silver Eagle (памятные доллары — 24,06 г)
  ['США', 'цент', 50, 1892, 1964, 'silver', 11.25], ['США', 'цент', 50, 1965, 1970, 'silver', 4.6],
  ['США', 'цент', 25, 1892, 1964, 'silver', 5.62], ['США', 'цент', 10, 1892, 1964, 'silver', 2.25],
  ['США', 'доллар', 20, 1850, 1933, 'gold', 30.09], ['США', 'доллар', 10, 1838, 1933, 'gold', 15.04],
  ['США', 'доллар', 5, 1839, 1929, 'gold', 7.52], ['США', 'доллар', 2.5, 1840, 1929, 'gold', 3.76],
  ['Польша', 'злотый', 10, 1932, 1939, 'silver', 16.5], ['Польша', 'злотый', 5, 1932, 1938, 'silver', 8.25], ['Польша', 'злотый', 2, 1932, 1936, 'silver', 3.3],
  [null, 'соверен', 1, 1817, 2100, 'gold', 7.32], [null, 'соверен', 0.5, 1817, 2100, 'gold', 3.66],
  [null, 'франк', 20, 1803, 1936, 'gold', 5.8], [null, 'франк', 10, 1850, 1914, 'gold', 2.9], [null, 'лира', 20, 1861, 1927, 'gold', 5.8],
  [null, 'гульден', 10, 1875, 1933, 'gold', 6.05], [null, 'дукат', 1, 1600, 1915, 'gold', 3.44], [null, 'дукат', 4, 1600, 1915, 'gold', 13.76],
  [null, 'крона', 100, 1908, 1915, 'gold', 30.48], [null, 'крона', 20, 1873, 1931, 'gold', 6.09], [null, 'крона', 10, 1873, 1917, 'gold', 3.04],
  [null, 'песо', 50, 1921, 1947, 'gold', 37.5], [null, 'песо', 20, 1917, 1959, 'gold', 15.0], [null, 'песо', 10, 1905, 1959, 'gold', 7.5],
  [null, 'песо', 5, 1905, 1955, 'gold', 3.75], [null, 'песо', 2.5, 1918, 1948, 'gold', 1.87], [null, 'песо', 2, 1919, 1948, 'gold', 1.5],
  [null, 'крюгерранд', 1, 1967, 2100, 'gold', 31.1],
  ['Финляндия', 'пенни', 25, 1865, 1917, 'silver', 0.96], ['Финляндия', 'пенни', 50, 1864, 1917, 'silver', 1.91],
  ['Финляндия', 'марка', 1, 1864, 1915, 'silver', 4.5], ['Финляндия', 'марка', 2, 1865, 1908, 'silver', 9.0],
  ['Финляндия', 'марка', 10, 1878, 1913, 'gold', 2.9], ['Финляндия', 'марка', 20, 1878, 1913, 'gold', 5.81],
];

const byDenom = (table, p) => table.find(([d, from, to]) => d === p.denomKop && p.year >= from && p.year <= to);

// Стандарт чеканки из таблиц: Империя/СССР до 1931, марки Германии, иностранные. { metal, grams, basis? } или null
function tableContent(parsed) {
  if (!parsed || (parsed.metal !== 'silver' && parsed.metal !== 'gold')) return null;
  if (parsed.denomKop != null && parsed.year) {
    const row = byDenom(parsed.metal === 'gold' ? GOLD : SILVER, parsed);
    if (row) return { metal: parsed.metal, grams: row[3] };
  }
  const f = parsed.foreign;
  if (f && f.unit === 'марка' && parsed.year) {
    const row = GERMAN.find(([v, from, to, m]) => v === f.value && parsed.year >= from && parsed.year <= to && m === parsed.metal);
    if (row) return { metal: parsed.metal, grams: row[4] };
  }
  const w = parsed.world;
  if (w) {
    const row = WORLD.find(([c, u, v, from, to, m]) => u === w.unit && v === w.value && m === parsed.metal && (!c || c === w.country)
      && (!parsed.year || (parsed.year >= from && parsed.year <= to)) && (parsed.year || c === null));
    // 'loose' — под этим номиналом и годом бывают монеты другого веса: текст лота главнее такой строки
    if (row) return { metal: parsed.metal, grams: row[6], ...(row[7] ? { basis: row[7] } : {}), ...(row[8] === 'loose' ? { loose: true } : {}) };
  }
  return null;
}

// Продавец пишет одно, таблица стандартов — другое (расхождение больше MISMATCH_PCT): считаем по таблице, а разницу
// показываем в карточке и храним в базе (parsed.contentMismatch) — такие лоты потом сверяются вручную.
// { table, stated, statedBasis } или null
const MISMATCH_PCT = 10;
function contentMismatch(parsed, table = undefined) {
  const stated = parsed && parsed.content && parsed.content.fineGrams > 0 ? parsed.content : null;
  if (!stated || (parsed.weight && parsed.weight.fineGrams > 0)) return null;
  if (table === undefined) table = tableContent(parsed);
  // нестрогая строка таблицы — не стандарт, сверять не с чем
  if (!table || table.loose || Math.abs(stated.fineGrams - table.grams) / table.grams * 100 <= MISMATCH_PCT) return null;
  return { table: table.grams, stated: stated.fineGrams, statedBasis: stated.basis || null };
}

// { metal: 'silver'|'gold', grams, basis?, mismatch? } или null, если монета не из драгметалла или стандарт неизвестен.
// Лот на вес («Серебро 500 гр», parse.weightFrom): чистое серебро = вес × проба, bulk — из чего посчитано.
// Порядок: таблицы стандартов (они главнее слов продавца) → текст лота (унции, вес × проба) → современные
// памятные (нижняя планка по номиналу).
function fineContent(parsed) {
  if (parsed && parsed.weight && parsed.weight.fineGrams > 0) {
    const w = parsed.weight;
    return { metal: 'silver', grams: w.fineGrams, bulk: { grams: w.grams, purity: w.purity, purityAssumed: w.purityAssumed } };
  }
  if (!parsed || (parsed.metal !== 'silver' && parsed.metal !== 'gold')) return null;
  const stated = parsed.content && parsed.content.fineGrams > 0 ? parsed.content : null;
  const found = tableContent(parsed);
  if (found && !(found.loose && stated)) {
    const { loose, ...table } = found;
    const mismatch = contentMismatch(parsed, found);
    return mismatch ? { ...table, mismatch } : table;
  }
  if (stated) return { metal: parsed.metal, grams: parsed.content.fineGrams, basis: parsed.content.basis };
  if (parsed.denomKop != null) {
    // без года («Белая синица. 10 рублей. Серебро.») — наименьший вес номинала за все годы
    const table2 = parsed.metal === 'gold' ? MODERN_GOLD : MODERN_SILVER;
    const rows = parsed.year ? [byDenom(table2, parsed)].filter(Boolean) : table2.filter(([d]) => d === parsed.denomKop);
    if (rows.length) return { metal: parsed.metal, grams: Math.min(...rows.map((r) => r[3])), basis: 'наименьший из ходовых весов этого номинала' };
  }
  return null;
}

// { metal, grams, pricePerG, value } — стоимость металла в BYN; null, если содержание или цена неизвестны
function metalValue(parsed, prices) {
  const fc = fineContent(parsed);
  if (!fc || !prices) return null;
  const pricePerG = prices[fc.metal];
  if (!(pricePerG > 0)) return null;
  return { ...fc, pricePerG, value: Math.round(fc.grams * pricePerG * 100) / 100 };
}

// То же, но цены подтягиваются с НБРБ (кэш на сутки); при недоступности API — из .env или null
async function metalValueLive(parsed) {
  if (!fineContent(parsed)) return null;
  const prices = await metalPrices().catch(() => null);
  return metalValue(parsed, prices);
}

module.exports = { fineContent, tableContent, contentMismatch, metalValue, metalValueLive, purityBasis, SILVER, GOLD, MODERN_SILVER, MODERN_GOLD, GERMAN, WORLD };
