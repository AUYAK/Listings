// Офлайн-проверка разбора монет (coins/parse.js) и разбора карточек ay.by. Запуск: node test-coins.js
const assert = require('assert');
const { parseCoin, groupKeys, denominationFrom, gradeFromTitle, gradeFromAyby, metalFrom } = require('./coins/parse');
const { parseTimeLeft, parsePrice } = require('./coins/ayby');
const { decideOutcome, worthNotifying, notifyTiming, AUCTION_NOTIFY_HOURS } = require('./coins');

let passed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
};

console.log('номинал:');
check('копейки, рубли, словесные названия', () => {
  assert.strictEqual(denominationFrom('50 копеек 1912 ЭБ аUNC Сохран!!!'), 50);
  assert.strictEqual(denominationFrom('25 копеек 1896 год.'), 25);
  assert.strictEqual(denominationFrom('Рубль 300 лет дому Романовых'), 100);
  assert.strictEqual(denominationFrom('1 рубль 1898 АГ'), 100);
  assert.strictEqual(denominationFrom('Полтина 1859 СПБ ФБ'), 50);
  assert.strictEqual(denominationFrom('Полуполтинник 1765'), 25);
  assert.strictEqual(denominationFrom('Полтинник 1924 ПЛ'), 50);
  assert.strictEqual(denominationFrom('1,5 рубля 10 злотых 1836'), 150);
});
check('дробные номиналы не путаются с целыми', () => {
  assert.strictEqual(denominationFrom('1/2 копейки 1898, UNC, Штемпельный блеск'), 0.5);
  assert.strictEqual(denominationFrom('1/4 копейки 1910'), 0.25);
  assert.strictEqual(denominationFrom('2 копейки 1851 ЕМ'), 2);
});

console.log('разбор лота:');
check('полтина Николая II из раздела «Серебро (полтины)»', () => {
  const p = parseCoin({ title: '50 копеек 1912 ЭБ аUNC Сохран!!!', sectionPath: 'Монеты › Россия › Российская Империя (до 1917) › 1894-1917 (Николай II) › Серебро (полтины)', conditionText: 'II+ (Как новое, AU)' });
  assert.strictEqual(p.denomKop, 50);
  assert.strictEqual(p.year, 1912);
  assert.strictEqual(p.mintmaster, 'ЭБ');
  assert.strictEqual(p.ruler, 'Николай II');
  assert.strictEqual(p.metal, 'silver');
  assert.strictEqual(p.conditionCode, 'II+');
  assert.strictEqual(p.grade, 'AU');
  assert.strictEqual(p.gradeSource, 'ayby');
  assert.strictEqual(p.titleGrade, 'AU');
});
check('состояние ay.by главнее заголовка', () => {
  const p = parseCoin({ title: '25 копеек 1896 год. UNC!', sectionPath: 'Серебро (копейки)', conditionText: 'III (Коллекционное, VF)' });
  assert.strictEqual(p.grade, 'VF');
  assert.strictEqual(p.titleGrade, 'UNC');
  assert.deepStrictEqual(gradeFromAyby('0 (Полировка, Proof)'), { code: '0', grade: 'PF' });
  assert.deepStrictEqual(gradeFromAyby('I (Новое, Unc)'), { code: 'I', grade: 'UNC' });
  assert.deepStrictEqual(gradeFromAyby('IV (Обращение, F)'), { code: 'IV', grade: 'F' });
});
check('подсказки из заголовка', () => {
  assert.strictEqual(gradeFromTitle('15 копеек 1912, aUNC, Штемпельный блеск!'), 'AU');
  assert.strictEqual(gradeFromTitle('5 копеек 1788 КМ, UNC, Отличная!'), 'UNC');
  assert.strictEqual(gradeFromTitle('10 копеек 1913 ВС. Состояние. БЕЗ МЦ'), null);
  assert.strictEqual(gradeFromTitle('1 рубль 1898 Франц Иосиф'), null); // «анц» внутри слова — не UNC
  assert.strictEqual(gradeFromTitle('Полтина 1859 XF+'), 'XF');
});
check('металл: раздел, год и знак двора', () => {
  assert.strictEqual(metalFrom('5 копеек 1784 ЕМ, aUNC', null, 5, 1784), 'copper');
  assert.strictEqual(metalFrom('5 копеек 1784', 'Медь', 5, 1784), 'copper');
  assert.strictEqual(metalFrom('15 копеек 1925г Федорин 33', 'СССР › 1921-1941 › 15 копеек', 15, 1925), 'silver');
  assert.strictEqual(metalFrom('20 копеек 1932', 'СССР › 1921-1941 › 20 копеек', 20, 1932), 'base');
  assert.strictEqual(metalFrom('Полтинник 1924 ПЛ', 'СССР › 1921-1941 › Полтинники', 50, 1924), 'silver');
  assert.strictEqual(metalFrom('1 рубль 1898 АГ', null, 100, 1898), 'silver');
  // поле «Металл» лота главнее всего
  assert.strictEqual(metalFrom('5 копеек 1784 ЕМ', 'Медь', 5, 1784, 'Серебро'), 'silver');
  assert.strictEqual(parseCoin({ title: '20 копеек 1932', sectionPath: null, specs: { 'Металл': 'Медно-никель' } }).metal, 'base');
});
check('флаги и правитель', () => {
  const p = parseCoin({ title: '25 пенни 1916 s, лот из 9 шт! UNC! Кладовые', sectionPath: 'Русско-финские' });
  assert.ok(p.flags.includes('несколько монет'));
  const c = parseCoin({ title: '1 рубль 1912 КОПИЯ', sectionPath: null });
  assert.ok(c.flags.includes('копия'));
  // стартовая ставка «с 1 рубля» — не номинал; набор из нескольких монет — флаг
  const set = parseCoin({ title: 'С 1 РУБЛЯ! ОДНИМ ЛОТОМ 3 МОНЕТЫ РОССИЙСКАЯ ИМПЕРИЯ 20 15 10 КОПЕЕК 1875 1867 1910 ГОД СЕРЕБРО', sectionPath: null });
  assert.notStrictEqual(set.denomKop, 100);
  assert.ok(set.flags.includes('несколько монет'));
  assert.strictEqual(parseCoin({ title: 'От 1 руб. 50 копеек 1912 ЭБ', sectionPath: null }).denomKop, 50);
  assert.strictEqual(parseCoin({ title: 'Старт 1 р. Полтинник 1924 ПЛ', sectionPath: null }).denomKop, 50);
  assert.strictEqual(parseCoin({ title: 'Рубль 1913 с рубля', sectionPath: null }).denomKop, 100);
  const isSet = (t) => parseCoin({ title: t, sectionPath: null }).flags.includes('несколько монет');
  assert.strictEqual(isSet('3 монеты 1921-1931 серебро'), true);
  assert.strictEqual(isSet('1 и 2 копейки 1913'), true);
  assert.strictEqual(isSet('Лот 5 копеек 1899 и 10 копеек 1913'), true);
  assert.strictEqual(isSet('7 рублей 50 копеек 1897'), false);
  assert.strictEqual(isSet('1/2 копейки 1912'), false);
  assert.strictEqual(isSet('1 рубль 1924 ПЛ цена 90 руб'), false);
  assert.strictEqual(isSet('Монета 1 рубль 1912 300 лет 1613-1913'), false);
  assert.strictEqual(parseCoin({ title: '1 рубль 1768 СПБ', sectionPath: null }).ruler, 'Екатерина II');
  assert.strictEqual(parseCoin({ title: 'Полтинник 1924 ПЛ', sectionPath: 'СССР' }).ruler, 'СССР');
});
check('ключи группировки от узкого к широкому', () => {
  const p = parseCoin({ title: '1 рубль 1898 АГ', sectionPath: 'Серебро (рубли)' });
  assert.deepStrictEqual(groupKeys(p).map((k) => k.key), ['100|1898|АГ', '100|1898', '100|Николай II']);
  assert.strictEqual(groupKeys(p)[0].label, '1 рубль 1898 АГ');
  assert.deepStrictEqual(groupKeys(parseCoin({ title: 'Монета старинная', sectionPath: null })), []);
});

console.log('карточки и итоги:');
check('время до конца и цена из карточки', () => {
  assert.strictEqual(parseTimeLeft('6 д'), 6 * 86400e3);
  assert.strictEqual(parseTimeLeft('1 д 3 ч'), 86400e3 + 3 * 3600e3);
  assert.strictEqual(parseTimeLeft('23 мин'), 23 * 60e3);
  assert.strictEqual(parseTimeLeft('12 ч 24 м'), 12 * 3600e3 + 24 * 60e3);
  assert.strictEqual(parseTimeLeft('6  д'), 6 * 86400e3);
  assert.strictEqual(parseTimeLeft(''), null);
  assert.strictEqual(parsePrice('1 250,00'), 1250);
  assert.strictEqual(parsePrice('890,00 бел. руб.'), 890);
});
check('итог торгов и фильтр уведомлений', () => {
  assert.strictEqual(decideOutcome({ bids: 0 }, { statusText: 'Лот продан', bids: 0 }), 'sold');
  assert.strictEqual(decideOutcome({ bids: 2 }, { statusText: null, bids: 2 }), 'sold');
  assert.strictEqual(decideOutcome({ bids: 0 }, { statusText: 'Торги завершены без ставок', bids: 0 }), 'unsold');
  const monitor = { metals: ['silver'] };
  assert.strictEqual(worthNotifying(monitor, { isSilver: true, metal: 'silver', flags: [] }, { ended: false }), true);
  assert.strictEqual(worthNotifying(monitor, { isSilver: false, metal: 'copper', flags: [] }, { ended: false }), false);
  assert.strictEqual(worthNotifying(monitor, { isSilver: true, metal: 'silver', flags: ['копия'] }, { ended: false }), false);
  assert.strictEqual(worthNotifying(monitor, { isSilver: true, metal: 'silver', flags: [] }, { ended: true }), false);
});
check('когда слать: фикс-цена сразу, аукцион — за ≤12 ч до конца', () => {
  const monitor = { metals: ['silver'] };
  const silver = { isSilver: true, metal: 'silver', flags: [] };
  const h = (n) => new Date(Date.now() + n * 3600e3);
  assert.strictEqual(notifyTiming(monitor, silver, { ended: false, saleType: 'buy_now', endsAt: h(72) }), 'now');
  assert.strictEqual(notifyTiming(monitor, silver, { ended: false, saleType: 'auction_buynow', endsAt: h(72) }), 'now');
  assert.strictEqual(notifyTiming(monitor, silver, { ended: false, saleType: 'auction', endsAt: h(72) }), 'closing');
  assert.strictEqual(notifyTiming(monitor, silver, { ended: false, saleType: 'auction', endsAt: h(AUCTION_NOTIFY_HOURS - 1) }), 'now');
  assert.strictEqual(notifyTiming(monitor, { isSilver: false, metal: 'copper', flags: [] }, { ended: false, saleType: 'auction', endsAt: h(1) }), 'never');
});
check('фильтр монет для Kufar по заголовку', () => {
  const { parseCoin } = require('./coins/parse');
  const ok = (t) => { const p = parseCoin({ title: t, sectionPath: null }); return p.isSilver && !p.flags.includes('копия') && !p.flags.includes('несколько монет'); };
  assert.strictEqual(ok('1 рубль 1898 АГ Николай II серебро'), true);
  assert.strictEqual(ok('Полтинник 1924 ПЛ'), true);
  assert.strictEqual(ok('Монеты разных стран очень дешево'), false);
  assert.strictEqual(ok('5 копеек 1784 ЕМ'), false);
  assert.strictEqual(ok('Рубль 1912 копия'), false);
  assert.strictEqual(ok('Набор 10 шт 20 копеек 1925'), false);
  // Нацбанк РБ: 20 рублей серебро, 1 рубль медно-никель
  assert.strictEqual(ok('Памятная монета 20 рублей НБ РБ Беларусь серебро 2010'), true);
  assert.strictEqual(ok('20 рублей Беларусь Слуцкие пояса'), true);
  assert.strictEqual(ok('УНОВИС. Редкая монета НБ РБ. 1 рубль.'), false);
});

check('завершённый лот ay.by: «Завершён … Лот продан за …» → продан, итоговая цена, дата окончания', () => {
  const { interpretLot, parseEndedAt } = require('./coins/ayby');
  const base = { title: '1/2 копейки 1899 СПБ.', timerSeconds: 0, priceText: '3,50 руб.', bidsText: '1 сделка', hasBidButton: false, hasBuyNow: false, bargain: false, specs: { 'Состояние': 'III (Коллекционное, VF)' }, photos: [], titleAreaText: '1/2 копейки 1899 СПБ. Завершён26 октября в 16:09:04', categoryPath: 'Монеты › Россия Российская Империя (до 1917) 1894-1917 (Николай II) Медь 1/2 копейки 1899 СПБ.' };
  const sold = interpretLot({ ...base, endedAtText: '26 октября в 16:09:04', soldText: 'Лот продан за 3,50 бел. руб. 26 октября в 16:09:04, победитель Wolf71', unsoldText: null, statusHint: 'Лот продан за 3,50 бел' }, 200);
  assert.strictEqual(sold.ended, true);
  assert.strictEqual(sold.sold, true);
  assert.strictEqual(sold.finalPrice, 3.5);
  assert.strictEqual(sold.price, 3.5);
  assert.strictEqual(sold.endsAt, null);
  assert.strictEqual(sold.categoryPath, 'Монеты › Россия Российская Империя (до 1917) 1894-1917 (Николай II) Медь');
  assert.strictEqual(sold.endedAt.toISOString(), `${new Date().getUTCFullYear()}-10-26T13:09:04.000Z`); // минское 16:09 = 13:09 UTC
  assert.strictEqual(decideOutcome({ bids: 0 }, sold), 'sold');
  const auction = interpretLot({ ...base, priceText: '261,00 руб.', bidsText: '16 ставок', endedAtText: '28 октября в 22:19:02', soldText: 'Лот продан за 261,00 бел. руб. 28 октября в 22:19:02, победитель Кирилл', unsoldText: null, statusHint: null }, 200);
  assert.strictEqual(auction.bids, 16);
  assert.strictEqual(auction.finalPrice, 261);
  const unsold = interpretLot({ ...base, timerSeconds: null, endedAtText: '28 октября в 22:19:02', soldText: null, unsoldText: 'Торги завершены без ставок', statusHint: null }, 200);
  assert.strictEqual(unsold.ended, true);
  assert.strictEqual(unsold.sold, false);
  assert.strictEqual(decideOutcome({ bids: 0 }, unsold), 'unsold');
  const live = interpretLot({ ...base, timerSeconds: 3600, endedAtText: null, soldText: null, unsoldText: null, statusHint: null }, 200);
  assert.strictEqual(live.ended, false);
  assert.ok(live.endsAt instanceof Date);
  assert.strictEqual(parseEndedAt('5 января 2025 в 9:05').toISOString(), '2025-01-05T06:05:00.000Z');
  assert.strictEqual(parseEndedAt('когда-нибудь'), null);
});

console.log('оценка:');
const cm = require('./coins/market');
const row = (title, grade, price, o = {}) => ({ id: o.id || Math.random(), source: o.source || 'ayby', status: o.status || 'active', sale_type: o.sale || 'buy_now', grade, current_price: price, final_price: o.final ?? null, outcome: o.outcome ?? null, bids: o.bids ?? 0, parsed: parseCoin({ title, sectionPath: 'Серебро' }) });
const rows = [
  row('1 рубль 1898 АГ', 'VF', 120), row('Рубль 1898 АГ', 'VF', 130), row('1 рубль 1898 АГ', 'VF', 110, { outcome: 'sold', final: 100 }),
  row('1 рубль 1898 АГ', 'XF', 300), row('1 рубль 1898 АГ', 'XF', 320), row('1 рубль 1898 АГ', 'XF', 280),
  row('1 рубль 1899 ФЗ', 'VF', 125), row('1 рубль 1897 АГ', 'VF', 115, { sale: 'auction', bids: 0 }), // старт без ставок — не цена
  row('1 рубль 1898 АГ копия', 'VF', 20), // копии в оценку не идут
];
check('наша оценка: та же группа и то же состояние, узкая группа при ≥3 лотах', () => {
  const p = parseCoin({ title: '1 рубль 1898 АГ', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' });
  const m = cm.marketEstimate(rows, p);
  assert.strictEqual(m.label, '1 рубль 1898 АГ');
  assert.strictEqual(m.n, 3);
  assert.strictEqual(m.refMedian, 120);
  const x = cm.marketEstimate(rows, parseCoin({ title: 'Рубль 1898 АГ XF', sectionPath: 'Серебро', conditionText: 'II (Эстетическое, XF)' }));
  assert.strictEqual(x.refMedian, 300);
  assert.strictEqual(cm.marketEstimate(rows, parseCoin({ title: '1 рубль 1898 АГ', sectionPath: 'Серебро' })), null); // без состояния — нет оценки
  assert.strictEqual(cm.marketEstimate(rows, parseCoin({ title: 'Полтина 1898', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' })), null);
});
check('ориентир — самый низкий из источников, порог выгоды 30%', () => {
  const p = parseCoin({ title: '1 рубль 1898 АГ', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' });
  const catalog = { source: 'numista', title: '1 Rouble - Nicholas II', prices: { F: 60, VF: 150, XF: 400 } };
  const e = cm.assess({ parsed: p, price: 100, rows: [], catalog }); // только каталог
  assert.strictEqual(e.referenceSource, 'numista');
  assert.strictEqual(e.reference, 150);
  assert.strictEqual(e.deviationPct, -33);
  assert.strictEqual(e.isBargain, true);
  const both = cm.assess({ parsed: p, price: 100, rows, catalog }); // каталог 150, наша медиана 120 → берём 120
  assert.strictEqual(both.referenceSource, 'market');
  assert.strictEqual(both.reference, 120);
  assert.strictEqual(both.isBargain, false);
  const e2 = cm.assess({ parsed: p, price: 100, rows }); // без каталога — наша медиана 120
  assert.strictEqual(e2.referenceSource, 'market');
  assert.strictEqual(e2.deviationPct, -17);
  assert.strictEqual(e2.isBargain, false);
  const e3 = cm.assess({ parsed: parseCoin({ title: 'Полтина 1898', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' }), price: 50, rows });
  assert.strictEqual(e3.reference, null);
  assert.strictEqual(e3.isBargain, false);
  // состояние AU, каталог знает только до XF → ближайшее ниже
  const au = cm.assess({ parsed: parseCoin({ title: '1 рубль 1898 АГ', sectionPath: 'Серебро', conditionText: 'II+ (Как новое, AU)' }), price: 200, rows, catalog });
  assert.strictEqual(au.catalog.grade, 'XF');
  assert.strictEqual(au.catalog.exact, false);
});
check('строки оценки в карточке', () => {
  const p = parseCoin({ title: '1 рубль 1898 АГ', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' });
  const lines = cm.formatEstimateLines(cm.assess({ parsed: p, price: 100, rows, catalog: { source: 'numista', prices: { VF: 150 } } }));
  assert.deepStrictEqual(lines, ['📚 Numista (VF): 150 р.', '📊 Наша база (1 рубль 1898 АГ, VF): 120 р. по 3 лотам, продаж 1', '🟡 На 17% (20 р.) ниже нашей базы']);
  assert.deepStrictEqual(cm.formatEstimateLines(cm.assess({ parsed: p, price: 100, rows: [] })), ['📊 Наша база: похожих лотов в этом состоянии ещё не было', '⚪ Ориентира пока нет: ни каталога, ни трёх похожих лотов']);
  // несколько источников — каждый своей строкой, вердикт по самому низкому (Numista 140), редкость из справочника типа
  const multi = cm.assess({ parsed: p, price: 100, rows: [], coinType: { konros: 'R1+', mintage: 1100002 },
    catalogs: [{ source: 'gdenashel', prices: { VF: 150, XF: 400 }, samples: { VF: 42, XF: 17 }, windowYears: 3 }, { source: 'numista', prices: { VF: 140 } }] });
  assert.strictEqual(multi.reference, 140);
  assert.strictEqual(multi.referenceSource, 'numista');
  assert.strictEqual(multi.catalogs.length, 2);
  assert.deepStrictEqual(cm.formatEstimateLines(multi), [
    '📚 gdenashel.ru, аукционы РФ (VF, 42 прох. за 3 г.): 150 р.',
    '📚 Numista (VF): 140 р.',
    '📊 Наша база: похожих лотов в этом состоянии ещё не было',
    '💎 Редкость: эпическая 🟣 · Конрос R1+ · тираж 1 100 002 · 59 прох. за 3 г.',
    '🟡 На 29% (40 р.) ниже Numista', // 29% < 30% и 40 р. < 50 р. — ещё не выгода
  ]);
  // слабы MS64+ из архива РФ: не ориентир для UNC-лота, только строка для справки; ориентир — наша база
  const unc = parseCoin({ title: '15 копеек 1908', sectionPath: 'Серебро', conditionText: 'I (Новое, Unc)' });
  const uncRows = [row('15 копеек 1908', 'UNC', 100), row('15 копеек 1908', 'UNC', 110), row('15 копеек 1908', 'UNC', 90)];
  const slab = cm.assess({ parsed: unc, price: 9, rows: uncRows,
    catalogs: [{ source: 'gdenashel', prices: { 'MS64+': 458, XF: 40 }, samples: { 'MS64+': 4, XF: 6 }, windowYears: 3 }] });
  assert.strictEqual(slab.catalog.grade, 'XF'); // ближайшее состояние ниже UNC, MS64+ не в шкале
  assert.strictEqual(slab.reference, 100); // точное состояние есть только у нашей базы → она ориентир, а не «ближайший XF»
  assert.strictEqual(slab.referenceSource, 'market');
  const slabLines = cm.formatEstimateLines(slab);
  assert.ok(slabLines.includes('🏛 gdenashel.ru, слабы MS64+, 4 прох. за 3 г.: 458 р. — для справки, не ориентир'), slabLines.join('\n'));
  assert.ok(slabLines.at(-1).startsWith('🟢 На 91% (91 р.) ниже нашей базы'), slabLines.at(-1));
  // точного состояния нет ни у кого → ближайшее ниже из каталога
  const nearest = cm.assess({ parsed: unc, price: 9, rows: [], catalogs: [{ source: 'gdenashel', prices: { XF: 40 } }] });
  assert.strictEqual(nearest.reference, 40);
  assert.strictEqual(nearest.catalog.exact, false);
  // ставка идущего аукциона — не цена для нашей базы; итог торгов и фикс-цена — да
  assert.strictEqual(cm.usablePrice({ sale_type: 'auction', current_price: 9, bids: 5, outcome: null }), null);
  assert.deepStrictEqual(cm.usablePrice({ sale_type: 'auction', current_price: 9, final_price: 120, bids: 12, outcome: 'sold' }), { price: 120, sold: true });
  assert.deepStrictEqual(cm.usablePrice({ sale_type: 'buy_now', current_price: 95, outcome: null }), { price: 95, sold: false });
});
check('редкость: шкала Конроса, иначе частота проходов', () => {
  assert.strictEqual(cm.rarityTier({}).name, 'обычная');
  assert.strictEqual(cm.rarityTier({ konros: 'R' }).name, 'редкая');
  assert.strictEqual(cm.rarityTier({ konros: 'R1+' }).name, 'эпическая');
  assert.strictEqual(cm.rarityTier({ konros: 'R2' }).name, 'легендарная');
  assert.strictEqual(cm.rarityTier({ konros: 'R3' }).name, 'реликвия');
  assert.strictEqual(cm.rarityTier({ konros: 'R4' }).level, 4);
  assert.strictEqual(cm.rarityTier({ passes: 5, windowYears: 3 }).name, 'редкая');   // < 3 проходов в год
  assert.strictEqual(cm.rarityTier({ passes: 40, windowYears: 3 }).name, 'обычная');
  assert.strictEqual(cm.rarityTier({ passes: 40, windowYears: 3, mintage: 1000 }).reason, 'тираж 1 000 · 40 прох. за 3 г.');
});
check('выгода: 50 р. с дорогого лота достаточно, 30% с дешёвого — только если это ≥10 р.', () => {
  const o = { bargainPct: 30, bargainByn: 50, minByn: 10 };
  assert.strictEqual(cm.isBargain({ price: 250, reference: 300, ...o }), true);   // 17%, но 50 р.
  assert.strictEqual(cm.isBargain({ price: 260, reference: 300, ...o }), false);  // 13%, 40 р.
  assert.strictEqual(cm.isBargain({ price: 12, reference: 20, ...o }), false);    // 40%, но 8 р.
  assert.strictEqual(cm.isBargain({ price: 30, reference: 45, ...o }), true);     // 33%, 15 р.
  assert.strictEqual(cm.isBargain({ price: 1, reference: 300, ...o }), false);    // «с рубля» без ставок — не цена
  assert.strictEqual(cm.isBargain({ price: 100, reference: null, ...o }), false);
  const e = cm.assess({ parsed: parseCoin({ title: '1 рубль 1898 АГ', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' }), price: 400, rows: [], catalog: { source: 'gdenashel', prices: { VF: 460 } }, ...o });
  assert.strictEqual(e.deviationPct, -13);
  assert.strictEqual(e.gainByn, 60);
  assert.strictEqual(e.isBargain, true);
});

console.log('архив проходов gdenashel.ru:');
const gd = require('./coins/gdenashel');
check('состояния источника → наша шкала: числовой грейд — корзина слаба, буквенный — сырая монета', () => {
  assert.strictEqual(gd.normalizeGrade('MS64'), 'MS64');
  assert.strictEqual(gd.normalizeGrade('MS67'), 'MS66+');
  assert.strictEqual(gd.normalizeGrade('MS63'), 'MS63');
  assert.strictEqual(gd.normalizeGrade('MS61'), 'MS60-62');
  assert.strictEqual(gd.normalizeGrade('MS 65'), 'MS65');
  assert.strictEqual(gd.normalizeGrade('MS62BN'), 'MS60-62');
  assert.strictEqual(gd.normalizeGrade('UNC'), 'UNC');
  assert.strictEqual(gd.normalizeGrade('UNC PL'), 'UNC');
  assert.strictEqual(gd.normalizeGrade('AU58'), 'AU50-58');
  assert.strictEqual(gd.normalizeGrade('AU-58'), 'AU50-58');
  assert.strictEqual(gd.normalizeGrade('AU'), 'AU');
  assert.strictEqual(gd.normalizeGrade('AU DETAILS'), null); // проблемный слаб — не в ориентир
  assert.strictEqual(gd.normalizeGrade('XF'), 'XF');
  assert.strictEqual(gd.normalizeGrade('XF45'), 'XF40-45');
  assert.strictEqual(gd.normalizeGrade('VF25'), 'VF20-35');
  assert.strictEqual(gd.normalizeGrade('F15'), 'F12-15');
  assert.strictEqual(gd.normalizeGrade('PROOF'), 'PF');
  assert.strictEqual(gd.normalizeGrade('PF63'), 'PF60-64');
  assert.strictEqual(gd.normalizeGrade('PF69'), 'PF68+');
  assert.strictEqual(gd.normalizeGrade('PF55'), 'PF');  // вне корзин — буквенное состояние, а не потеря прохода
  assert.strictEqual(gd.normalizeGrade('AU45'), 'AU');
  assert.strictEqual(gd.normalizeGrade('VF10'), 'VF');
  assert.strictEqual(gd.normalizeGrade(''), null);
});
check('страница номинала: монета, буквы, разновидность, ссылка на проходы', () => {
  const html = `
    <tr class="coinTableAdapt-v2__row">
      <td class="coinTableAdapt-v2__cell coinTableAdapt-v2__cell--name  text-center"  rowspan="2" "><a href="https://gdenashel.ru/coins/imperiya/nikolay-ii/serebro/1-rubl/1-rubl-1895-14898">1 рубль 1895</a></td>
      <td class="coinTableAdapt-v2__cell" ></td>
      <td class="coinTableAdapt-v2__cell coinTableAdapt-v2__cell--link" onclick="x"><span>Г:</span> Гладкий</td>
      <td class="coinTableAdapt-v2__cell coinTableAdapt-v2__cell--price">&nbsp;<br>&nbsp;</td>
    </tr>
    <tr class="coinTableAdapt-v2__row">
      <td class="coinTableAdapt-v2__cell" >АГ</td>
      <td class="coinTableAdapt-v2__cell coinTableAdapt-v2__cell--link" onclick="x"></td>
      <td class="coinTableAdapt-v2__cell coinTableAdapt-v2__cell--price"><a href="https://gdenashel.ru/coins/imperiya/nikolay-ii/serebro/1-rubl/1-rubl-1895-14898?child_id=1663#sales">13 000 руб.<br><small>(209 результатов торгов)</small></a></td>
    </tr>`;
  const rows = gd.parseListHtml(html);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual({ ...rows[0] }, {
    coinUrl: 'https://gdenashel.ru/coins/imperiya/nikolay-ii/serebro/1-rubl/1-rubl-1895-14898', name: '1 рубль 1895', year: 1895, denomKop: 100,
    letters: 'АГ', variety: null, childId: '1663', salesUrl: 'https://gdenashel.ru/coins/imperiya/nikolay-ii/serebro/1-rubl/1-rubl-1895-14898?child_id=1663#sales', passes: 209, avgRub: 13000,
  });
  // монета без разновидностей: ссылка на проходы без child_id; пробные выпуски пропускаются
  const simple = `
    <tr class="coinTableAdapt-v2__row"><td class="coinTableAdapt-v2__cell coinTableAdapt-v2__cell--name  text-center" "><a href="https://gdenashel.ru/coins/imperiya/nikolay-ii/serebro/25-kopeek/25-kopeek-1895-3754">25 копеек 1895</a></td>
      <td class="coinTableAdapt-v2__cell coinTableAdapt-v2__cell--price"><a href="https://gdenashel.ru/coins/imperiya/nikolay-ii/serebro/25-kopeek/25-kopeek-1895-3754#sales">14 000 руб.<br><small>(527 результатов торгов)</small></a></td></tr>
    <tr class="coinTableAdapt-v2__row"><td class="coinTableAdapt-v2__cell coinTableAdapt-v2__cell--name  text-center" "><a href="https://gdenashel.ru/coins/imperiya/nikolay-ii/serebro/25-kopeek/25-kopeek-1916-9999">25 копеек 1916 Пробные</a></td>
      <td class="coinTableAdapt-v2__cell coinTableAdapt-v2__cell--price"><a href="https://gdenashel.ru/coins/imperiya/nikolay-ii/serebro/25-kopeek/25-kopeek-1916-9999#sales">1 000 000 руб.<br><small>(1 результат торгов)</small></a></td></tr>`;
  const s = gd.parseListHtml(simple);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].childId, null);
  assert.strictEqual(s[0].passes, 527);
  assert.strictEqual(gd.salesPageUrl(s[0].salesUrl, 1), 'https://gdenashel.ru/coins/imperiya/nikolay-ii/serebro/25-kopeek/25-kopeek-1895-3754');
  assert.strictEqual(gd.salesPageUrl(s[0].salesUrl, 3), 'https://gdenashel.ru/coins/imperiya/nikolay-ii/serebro/25-kopeek/25-kopeek-1895-3754?page=3');
  assert.strictEqual(gd.salesPageUrl(rows[0].salesUrl, 2), 'https://gdenashel.ru/coins/imperiya/nikolay-ii/serebro/1-rubl/1-rubl-1895-14898?child_id=1663&page=2');
});
check('страница проходов: дата, дом, состояние, слаб, цена, фото, число страниц', () => {
  const row = (id, date, grade, slab, price) => `
    <div class="row coin-sales__row" onclick="window.location.href = 'https://gdenashel.ru/sale/${id}';">
      <div class="col-12 col-md-4 coin-sales__cell coin-sales__cell--image"><img class="coin-sales__image lozad" data-src="https://gdenashel.ru/storage/resized/200x/sale/a/${id}-1.jpg" src="x"><img class="lozad" data-src="https://gdenashel.ru/storage/resized/200x/sale/a/${id}-2.jpg" src="x"></div>
      <div class="col-12 col-md coin-sales__cell coin-sales__cell--info d-flex"><a href="https://gdenashel.ru/sale/${id}" style="color: black;"><strong style="display: inline-block;">1 рубль 1895 года</strong><br><strong>${date}</strong><br><span>Конрос Аукцион 1 Лот №22</span></a></div>
      <div class="col-6 col-md coin-sales__cell coin-sales__cell--grade-slab-safety d-flex"><div><strong class="grade-cost">${grade}</strong>${slab ? `<br><span class="slab-cost">${slab}</span>` : ''}</div></div>
      <div class="col-6 col-md coin-sales__cell coin-sales__cell--price d-flex"><div><strong>${price}</strong></div></div>
    </div>`;
  const html = row('11111111-1111-1111-1111-111111111111', '29.01.2025', 'VF', '', '16 500 RUB') + row('22222222-2222-2222-2222-222222222222', '03.10.2026', 'MS64', 'ННР', '&mdash; &mdash;')
    + '<ul class="pagination"><a href="?child_id=1663&amp;page=2">2</a><a href="?child_id=1663&amp;page=7">7</a></ul>';
  const r = gd.parseSalesHtml(html);
  assert.strictEqual(r.pages, 7);
  assert.strictEqual(r.sales.length, 2);
  assert.deepStrictEqual(r.sales[0], { saleId: '11111111-1111-1111-1111-111111111111', title: '1 рубль 1895 года', soldOn: '2025-01-29', house: 'Конрос Аукцион 1 Лот №22', gradeRaw: 'VF', grade: 'VF', slab: null, priceRub: 16500, photos: ['https://gdenashel.ru/storage/resized/200x/sale/a/11111111-1111-1111-1111-111111111111-1.jpg', 'https://gdenashel.ru/storage/resized/200x/sale/a/11111111-1111-1111-1111-111111111111-2.jpg'] });
  assert.strictEqual(r.sales[1].priceRub, null);
  assert.strictEqual(r.sales[1].grade, 'MS64');
  assert.strictEqual(r.sales[1].slab, 'ННР');
});

check('страница монеты: тираж и Конрос для типа и разновидностей', () => {
  const html = `<h1>1 рубль 1895 года</h1><strong>Тираж:</strong> 1 100 002<br>
    <div class="anchorFixed" id="coin-1663"></div><h3 class="coinView__child-title">1 рубль 1895 года АГ </h3>
    <strong>Тираж:</strong> 1 100 002<br><strong>Конрос:</strong> R1+<br>
    <div class="anchorFixed" id="coin-1664"></div><h3 class="coinView__child-title">1 рубль 1895 года  Гурт: Гладкий</h3><strong>Конрос:</strong> R3<br>`;
  const c = gd.parseCoinPageHtml(html);
  assert.strictEqual(c.mintage, 1100002);
  assert.strictEqual(c.konros, null);
  assert.deepStrictEqual(c.variants['1663'], { title: '1 рубль 1895 года АГ', mintage: 1100002, konros: 'R1+', bitkin: null });
  assert.deepStrictEqual(c.variants['1664'], { title: '1 рубль 1895 года Гурт: Гладкий', mintage: null, konros: 'R3', bitkin: null });
  assert.deepStrictEqual(gd.parseCoinPageHtml('<h1>25 копеек 1895</h1><strong>Тираж:</strong> 1 000 004').variants, {});
  // тираж не указан числом (рубль 1730: «неизвестен», пусто) → null, а не NaN
  assert.strictEqual(gd.parseCoinPageHtml('<strong>Тираж:</strong> неизвестен<br>').mintage, null);
  assert.strictEqual(gd.parseCoinPageHtml('<strong>Тираж:</strong> \n<br><strong>Конрос:</strong> R2<br>').mintage, null);
  assert.strictEqual(gd.parseCoinPageHtml('<strong>Тираж:</strong> —<br>').mintage, null);
});

console.log('фото лотов на диске:');
check('лимит папки: сначала удаляются непроданные, потом старые; проданные — последними', () => {
  const fs = require('fs'), path = require('path'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-photos-'));
  process.env.COINS_PHOTO_DIR = dir;
  process.env.COINS_PHOTO_MAX_MB = String(5 / 1024); // 5 КБ
  delete require.cache[require.resolve('./coins/photos')];
  const ph = require('./coins/photos');
  fs.mkdirSync(path.join(dir, '2026-09'));
  fs.mkdirSync(path.join(dir, '2026-10'));
  const put = (rel, kb, ageSec) => { const f = path.join(dir, rel); fs.writeFileSync(f, Buffer.alloc(kb * 1024)); const t = (Date.now() - ageSec * 1000) / 1000; fs.utimesSync(f, t, t); };
  put('2026-09/111_1.jpg', 2, 3000); // старый, продан
  put('2026-09/222_1.jpg', 2, 2000); // старый, не продан
  put('2026-10/333_1.jpg', 2, 1000); // новый, не продан
  put('2026-10/444_1.jpg', 2, 10);   // новый, продан
  assert.strictEqual(ph.inventory().bytes, 8 * 1024);
  const r = ph.enforceLimit(new Set(['111', '444']));
  assert.ok(r.bytes <= 5 * 1024 * 0.9 + 1, `занято ${r.bytes}`);
  assert.deepStrictEqual([...r.removedIds].sort(), ['222', '333']);
  assert.ok(fs.existsSync(path.join(dir, '2026-09/111_1.jpg')) && fs.existsSync(path.join(dir, '2026-10/444_1.jpg')));
  assert.strictEqual(ph.enforceLimit(new Set()).removed, 0); // уже в лимите — ничего не трогаем
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('золото и металл:');
check('золотые номиналы и металл по году', () => {
  assert.strictEqual(denominationFrom('7 рублей 50 копеек 1897'), 750);
  assert.strictEqual(denominationFrom('Чевонец Сеятель 1982 год! Золото!'), 1000);
  assert.strictEqual(denominationFrom('Полуимпериал 1896'), 500);
  const gold = (t) => parseCoin({ title: t, sectionPath: null });
  assert.strictEqual(gold('10 рублей 1899 года АГ Николай 2').metal, 'gold');
  assert.strictEqual(gold('5 рублей 1902г. NGC AU58').isGold, true);
  assert.strictEqual(gold('3 рубля 1875').metal, 'gold');
  assert.strictEqual(gold('Червонец 1923').metal, 'gold');
  assert.strictEqual(gold('1 рубль 1898 АГ').isPrecious, true);
  assert.strictEqual(gold('1 рубль 1898 АГ').isGold, false);
  assert.strictEqual(gold('10 рублей 2005 Беларусь серебро').metal, 'silver'); // НБ РБ: 10 рублей — серебро, не золотой империал
  assert.strictEqual(gold('20 лир 1863 Италия. Золотая монета').denomKop, null);
});
check('содержание металла и стоимость по НБРБ', () => {
  const { fineContent, metalValue } = require('./coins/metal');
  const P = { gold: 366.94, silver: 4.51 };
  const v = (t) => metalValue(parseCoin({ title: t, sectionPath: null }), P);
  assert.deepStrictEqual(fineContent(parseCoin({ title: '1 рубль 1898 АГ', sectionPath: null })), { metal: 'silver', grams: 18 });
  assert.strictEqual(v('1 рубль 1898 АГ').value, 81.18);
  assert.strictEqual(v('Полтинник 1924 ПЛ').grams, 9);
  assert.strictEqual(v('15 копеек 1908').grams, 1.35);
  assert.strictEqual(v('20 копеек 1861').grams, 3);        // до 1867 — 750/868 проба
  assert.strictEqual(v('10 рублей 1899 АГ').value, 2840.12);
  assert.strictEqual(v('10 рублей 1894 АГ').grams, 11.61);  // до 1897 — 12,9 г
  assert.strictEqual(v('5 рублей 1902').grams, 3.87);
  assert.strictEqual(v('Червонец Сеятель 1979 ЛМД').grams, 7.74);
  assert.strictEqual(v('20 копеек 1932'), null);            // не драгметалл
  assert.strictEqual(v('1 рубль 1965'), null);
  assert.strictEqual(metalValue(parseCoin({ title: '1 рубль 1898', sectionPath: null }), null), null);
});
check('оценка: металл — нижняя планка, не ориентир; подозрительно дёшево', () => {
  const rub = parseCoin({ title: '1 рубль 1898 АГ', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' });
  const metal = { metal: 'silver', grams: 18, pricePerG: 4.51, value: 81.18 };
  // ориентир 150 (VF), лот 100: выше металла, ниже ориентира на 33% → выгодно по ориентиру; металл не ориентир
  const a = cm.assess({ parsed: rub, price: 100, rows: [], catalog: { source: 'gdenashel', prices: { VF: 150 } }, metal });
  assert.strictEqual(a.reference, 150);
  assert.strictEqual(a.metal.below, false);
  assert.strictEqual(a.isBargain, true);
  // ориентира нет, лот 100 выше металла 81 → не выгодно, без красной строки
  const b = cm.assess({ parsed: rub, price: 100, rows: [], metal });
  assert.strictEqual(b.reference, null);
  assert.strictEqual(b.isBargain, false);
  const bl = cm.formatEstimateLines(b);
  assert.ok(bl.includes('⚖️ Металл: 18 г серебра ≈ 81 р. (НБРБ 4,51 р./г)'), bl.join('\n'));
  assert.ok(bl.includes('⚪ Ориентира по состоянию нет, лот выше стоимости металла'), bl.join('\n'));
  // лот 25 р. ниже металла на 56 р. → выгодно при любом состоянии, даже без ориентира
  const c = cm.assess({ parsed: rub, price: 25, rows: [], metal });
  assert.strictEqual(c.isBargain, true);
  assert.strictEqual(c.metal.below, true);
  assert.ok(cm.formatEstimateLines(c).includes('🟢 На 56 р. ниже стоимости металла — выгодно при любом состоянии'));
  // золото: 10 рублей 1899 за 2 500 при металле 2 840 → ниже металла на 340 → выгодно
  const ten = parseCoin({ title: '10 рублей 1899 АГ', sectionPath: null, conditionText: 'II (Эстетическое, XF)' });
  const g = cm.assess({ parsed: ten, price: 2500, rows: [], metal: { metal: 'gold', grams: 7.74, pricePerG: 366.94, value: 2840.12 } });
  assert.strictEqual(g.isBargain, true);
  assert.ok(cm.formatEstimateLines(g).includes('⚖️ Металл: 7,74 г золота ≈ 2 840 р. (НБРБ 366,94 р./г)'));
  // подозрительно дёшево: фикс-цена 15 р. при ориентире 150 → флаг; та же цена как ставка аукциона — без флага
  const s = cm.assess({ parsed: rub, price: 15, rows: [], catalog: { source: 'gdenashel', prices: { VF: 150 } }, fixedPrice: true });
  assert.strictEqual(s.suspect, true);
  assert.ok(cm.formatEstimateLines(s).at(-1).startsWith('⚠️ Подозрительно дёшево'));
  assert.strictEqual(cm.assess({ parsed: rub, price: 15, rows: [], catalog: { source: 'gdenashel', prices: { VF: 150 } } }).suspect, false);
  assert.strictEqual(cm.assess({ parsed: rub, price: 15, rows: [], catalog: { source: 'gdenashel', prices: { VF: 60 } }, fixedPrice: true }).suspect, false); // дешёвый тип — не копируют
});
check('монитор: металл и страна по пути раздела', () => {
  const { matchesMonitor } = require('./coins');
  const goldMon = { metals: ['gold'], countries: [/Росси/i, /СССР/i] };
  const ten = parseCoin({ title: '10 рублей 1899 АГ', sectionPath: null });
  assert.strictEqual(matchesMonitor(goldMon, ten, 'Монеты › Россия › Российская Империя (до 1917) › 1894-1917 (Николай II)'), true);
  assert.strictEqual(matchesMonitor(goldMon, parseCoin({ title: 'Червонец Сеятель 1980', sectionPath: null }), 'Монеты › СССР › 1961-1991'), true);
  assert.strictEqual(matchesMonitor(goldMon, parseCoin({ title: 'Соверен 1883', sectionPath: null, specs: { 'Металл': 'Золото' } }), 'Монеты › Европа › Великобритания'), false);
  assert.strictEqual(matchesMonitor(goldMon, parseCoin({ title: '1 рубль 1898 АГ', sectionPath: null }), 'Монеты › Россия'), false); // серебро — не для золотого монитора
  assert.strictEqual(matchesMonitor({ metals: ['silver'] }, parseCoin({ title: '1 рубль 1898 АГ', sectionPath: null })), true);
});

check('избранное ay.by: строка в карточке, выключено без логина', () => {
  const { buildCaption } = require('./coins');
  const favorites = require('./coins/favorites');
  assert.strictEqual(favorites.enabled(), favorites.hasCredentials() || favorites.hasSession());
  assert.ok(favorites.FAV_BUTTON.test(' В избранное ') && favorites.FAV_BUTTON.test('Добавить в избранное') && !favorites.FAV_BUTTON.test('Избранное'));
  const mon = { name: 'Монеты (золото)', emoji: '🥇' };
  const lot = { title: '10 рублей 1899 АГ', price: 2500, saleType: 'buy_now', url: 'https://ay.by/lot/x-1.html', photos: [] };
  const parsed = parseCoin({ title: lot.title, sectionPath: null });
  assert.ok(buildCaption(mon, lot, parsed, false, null, { ok: true, note: 'добавлено' }).includes('⭐ Добавлено в избранное ay.by'));
  assert.ok(buildCaption(mon, lot, parsed, false, null, { ok: false, note: 'сессия слетела' }).includes('⭐ В избранное не добавлено: сессия слетела'));
  assert.ok(!buildCaption(mon, lot, parsed, false, null, null).includes('⭐'));
});

check('снайп: разбор ответа в Telegram', () => {
  const { parseBidReply } = require('./coins/bid');
  assert.deepStrictEqual(parseBidReply('150'), { max: 150 });
  assert.deepStrictEqual(parseBidReply('150 р.'), { max: 150 });
  assert.deepStrictEqual(parseBidReply('Макс 150,50 руб'), { max: 150.5 });
  assert.deepStrictEqual(parseBidReply('до 2 500'), { max: 2500 });
  assert.deepStrictEqual(parseBidReply('отмена'), { cancel: true });
  assert.deepStrictEqual(parseBidReply('0'), { cancel: true });
  assert.strictEqual(parseBidReply('спасибо'), null);
  assert.strictEqual(parseBidReply('1898 АГ хорошая'), null);
  assert.strictEqual(parseBidReply(''), null);
});

console.log('слабы, лоты на вес, марки:');
const { slabFrom, weightFrom } = require('./coins/parse');
check('слаб: фирма и корзина грейда из заголовков ay.by', () => {
  const b = (t) => { const s = slabFrom(t); return s && `${s.company}|${s.bucket}`; };
  assert.strictEqual(b('5 рублей 1902 АР, Николай II. В слабе NGC MS65'), 'NGC|MS65');
  assert.strictEqual(b('1 рубль 1924 MS-64 NGC'), 'NGC|MS64');
  assert.strictEqual(b('3 марки 1911 Вюртемберг - свадьба - ms 66 ННР - патина!'), 'ННР|MS66+');
  assert.strictEqual(b('10 рублей 1903г.  NGC  AU-58'), 'NGC|AU50-58');
  assert.strictEqual(b('Германия 5 марок 1934 года. Буква F. Шиллер. Состояние aUNC. В слабе NGC 58'), 'NGC|AU50-58'); // только число
  assert.strictEqual(b('10 долларов 1910 США Слаб PCGC=MS61="Индеец"'), 'PCGS|MS60-62'); // опечатка в фирме
  assert.strictEqual(b('Полтинник 1924 ПЛ МС-64 слаб'), 'null|MS64'); // кириллическое «МС»
  assert.strictEqual(b('2 копейки 1974 в слабе ННР PL 64'), 'ННР|MS64'); // PL из банковских наборов
  assert.strictEqual(b('Польша. 200 злотых 1983 года MW "Ян Собесский" слаб NCG PR69 ULTRA CAMEO'), 'NGC|PF68+');
  assert.strictEqual(b('Доллар Моргана 1880. Крупное серебро! Слаб NGC!'), 'NGC|null'); // слаб без грейда
  const det = slabFrom('5 копеек 1971 UNC DET в мини-слабе ННР');
  assert.ok(det.details && det.bucket === null);
  // не слабы
  assert.strictEqual(slabFrom('5 марок 1898 Саксония. Монета уровня MS-61. Вынута из слаба RNGA'), null);
  assert.strictEqual(slabFrom('15 копеек 1915 слабый чекан'), null);
  assert.strictEqual(slabFrom('1 рубль 1898 АГ'), null);
  assert.strictEqual(slabFrom('1 рубль 1898 АГ', 'Монета не в слабе, можно слабировать'), null);
  assert.strictEqual(slabFrom('5 рублей 1902', 'Монета в слабе NGC MS64').bucket, 'MS64'); // описание: фирма + грейд
  assert.ok(!parseCoin({ title: '15 копеек 1915 слабый чекан', sectionPath: null }).flags.includes('слаб'));
  assert.ok(parseCoin({ title: '1 рубль 1924 MS-64 NGC', sectionPath: null }).flags.includes('слаб'));
  // «из набора» — одна монета, не подборка
  assert.ok(!parseCoin({ title: '10 копеек 1974 ННР PL 63 из набора ГБ СССР', sectionPath: null }).flags.includes('несколько монет'));
});
check('лот на вес: серебро по весу и пробе, вес одной монеты и год — не вес лота', () => {
  const w = (t, d = '') => parseCoin({ title: t, sectionPath: null, description: d }).weight;
  assert.deepStrictEqual(w('Серебро 500 гр'), { grams: 500, purity: 0.5, purityAssumed: true, fineGrams: 250 });
  assert.deepStrictEqual(w('Лом серебра 875 пр. 100 г'), { grams: 100, purity: 0.875, purityAssumed: false, fineGrams: 87.5 });
  assert.strictEqual(w('Набор 10 монет, серебро 900, общий вес 100 гр').fineGrams, 90);
  assert.strictEqual(w('Серебряные монеты 1 кг').grams, 1000);
  assert.strictEqual(w('Лом серебра', 'Общий вес 34,5 г, проба 875').fineGrams, 30.2);
  assert.strictEqual(w('1 рубль 1898 АГ серебро 20 г'), null);          // одна монета
  assert.strictEqual(w('20 копеек 1925 г серебро'), null);              // «1925 г» — год
  assert.strictEqual(w('Монеты мира 4 кг., без СССР'), null);           // не серебро
  const p = parseCoin({ title: 'Набор 10 монет, серебро 900, общий вес 100 гр', sectionPath: null });
  assert.strictEqual(p.metal, 'silver');
  assert.ok(p.flags.includes('несколько монет')); // подборка, но с весом серебра — её оценивает металл
  assert.strictEqual(weightFrom('Серебро 925', '', { denomKop: null }), null); // веса нет
});
check('Германия: марки, буква двора, земля, металл; нотгельды и марки почты — не монеты', () => {
  const p = parseCoin({ title: '3 марки 1911 A Пруссия. Университет Бреслау', sectionPath: null });
  assert.deepStrictEqual(p.foreign, { unit: 'марка', value: 3, key: 'M3', mint: 'A', state: 'Пруссия' });
  assert.strictEqual(p.metal, 'silver');
  assert.strictEqual(p.denomination, '3 марки');
  assert.deepStrictEqual(groupKeys(p).map((k) => k.key), ['M3|1911|A|Пруссия', 'M3|1911|A', 'M3|1911']);
  assert.strictEqual(parseCoin({ title: 'С рубля без мц! 2 марки 1911 Луитпольд Баварский - блеск!', sectionPath: null }).foreign.state, 'Бавария');
  assert.strictEqual(parseCoin({ title: '5 марок 1934 года. Буква F. Шиллер', sectionPath: 'Монеты › Европа › Германия › 1919-1945' }).foreign.mint, 'F');
  assert.strictEqual(parseCoin({ title: 'Германия 25 пфеннигов 1910 год, " F ", Раскол штемпеля', sectionPath: null }).foreign.mint, 'F');
  assert.strictEqual(parseCoin({ title: '2 рейхс марки 1926 год. F .Серебро .С рубля', sectionPath: 'Монеты › Европа › Германия' }).foreign.mint, 'F');
  assert.strictEqual(parseCoin({ title: '1 марка 1914 год.Серебро .С рубля', sectionPath: 'Монеты › Европа › Германия' }).foreign.mint, null);
  assert.strictEqual(parseCoin({ title: '20 марок 1913 A Пруссия', sectionPath: null }).metal, 'gold');
  assert.strictEqual(parseCoin({ title: '1 рейхсмарка 1937 A Германия', sectionPath: null }).metal, null); // 1933–1939 — никель
  assert.strictEqual(parseCoin({ title: 'Германия. 3 рейх марки 1928 D. слаб CPRC MS63', sectionPath: null }).foreign.key, 'M3');
  assert.strictEqual(parseCoin({ title: 'Нотгельд 50 пфеннигов 1921 год Ганновер. Веймарская республика', sectionPath: null }).foreign, null);
  assert.strictEqual(parseCoin({ title: 'Беляев в космосе! СССР 1965 год 1 марка', sectionPath: null }).foreign, null);
  assert.strictEqual(parseCoin({ title: '1 марка 1914 D MS-67 PCGS', sectionPath: null }).foreign, null); // без Германии в заголовке и разделе
  assert.strictEqual(parseCoin({ title: '1 марка 1914 D MS-67 PCGS', sectionPath: 'Монеты › Европа › Германия › 1871-1918' }).foreign.mint, 'D');
});
check('«без МЦ» из заголовка', () => {
  const f = (t) => parseCoin({ title: t, sectionPath: null }).noReserve;
  assert.strictEqual(f('5 копеек 1852 года (Е.М.). СОСТОЯНИЕ! Старт с 1 рубля!!! Без МЦ.'), true);
  assert.strictEqual(f('1 рубль 2013г. Аукцион 5 дней с 1 рубля без мнц.'), true);
  assert.strictEqual(f('2 марки 1901 Любек. АУКЦИОН С 1 РУБЛЯ БЕЗ МПЦ!!!'), true);
  assert.strictEqual(f('Америго Веспуччи 20 рублей 2010. С 1 рубля, Без мин.цены!'), true);
  assert.strictEqual(f('Турция 5 лир, 1975. С 20 копеек. Распродажа коллекции.'), false);
  assert.strictEqual(f('20 копеек 1925 без минусов'), false);
});
check('ревью: номинал после фирмы — не грейд; одна монета и ложка — не лот на вес; общее правило отсева', () => {
  const { notifyBlocker } = require('./coins/parse');
  assert.strictEqual(slabFrom('NGC 15 копеек 1915 ВС').bucket, null);
  assert.strictEqual(slabFrom('Слаб ННР 20 копеек 1923').bucket, null);
  assert.strictEqual(slabFrom('PCGS 50 копеек 1924 ПЛ UNC').bucket, null);
  assert.strictEqual(slabFrom('PCGS 63 50 копеек 1924').bucket, 'MS63');
  assert.strictEqual(parseCoin({ title: '2 марки 1876 A Пруссия серебро 11,1 г', sectionPath: null }).weight, null);
  assert.strictEqual(parseCoin({ title: 'Ложка серебро 875 пр. 50 г', sectionPath: null }).weight, null);
  assert.strictEqual(parseCoin({ title: 'Множество монет серебро 500 гр', sectionPath: null }).weight.grams, 500); // «нож» внутри слова — не ложка
  const p = (t) => parseCoin({ title: t, sectionPath: null });
  assert.strictEqual(notifyBlocker(p('1 рубль 1912 копия'), 'auction'), 'копия');
  assert.strictEqual(notifyBlocker(p('Набор 10 шт 20 копеек 1925'), 'auction'), 'подборка / несколько монет');
  assert.strictEqual(notifyBlocker(p('Набор 10 монет, серебро 900, общий вес 100 гр'), 'auction'), null);
  assert.ok(notifyBlocker(p('1 рубль 1924 MS-64 NGC'), 'buy_now'));
  assert.ok(notifyBlocker(p('1 рубль 1924 MS-64 NGC'), 'fixed'));
  assert.strictEqual(notifyBlocker(p('1 рубль 1924 MS-64 NGC'), 'auction_buynow'), null);
  // фильтр монитора СССР 1961–1991 UNC
  const f = require('./config').MONITORS.find((m) => m.key === 'coins-ussr-unc').titleFilter;
  assert.strictEqual(f.test('15 копеек 1980 UNC #1 Супер!'), true);
  assert.strictEqual(f.test('3 копейки 1977 aUNC #K'), true);
  assert.strictEqual(f.test('50 копеек 1990 Люкс!'), true);
  assert.strictEqual(f.test('20 копеек 1966 MS-64 в мини-слабе ННР'), true);
  assert.strictEqual(f.test('1 рубль 1970 штемпельный блеск'), true);
  assert.strictEqual(f.test('20 копеек 1961 штемпель 1.2'), false);
  assert.strictEqual(f.test('5 копеек 1961 слабый удар'), false);
  assert.strictEqual(f.test('10 копеек 1975'), false);
});
check('ревью: свежие продажи «за правление» не заменяют цену года; одна продажа из двух мониторов — один раз', () => {
  const p = parseCoin({ title: '1 рубль 1899', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' });
  const day = (n) => new Date(Date.now() - n * 86400e3);
  const sold = (title, price, o = {}) => ({ id: Math.random(), source: 'ayby', external_id: o.ext ?? String(Math.random()), sale_type: 'auction', grade: 'VF', current_price: price, final_price: price, outcome: o.outcome ?? 'sold', ended_at: day(10), title, parsed: parseCoin({ title, sectionPath: 'Серебро' }) });
  const otherYears = [sold('1 рубль 1897', 500), sold('1 рубль 1898', 500), sold('1 рубль 1900', 500)];
  const e = cm.assess({ parsed: p, price: 300, rows: otherYears, catalog: { source: 'gdenashel', prices: { VF: 250 } } });
  assert.strictEqual(e.market.level, 'ruler');
  assert.strictEqual(e.referenceRecent, false);
  assert.strictEqual(e.reference, 250);
  assert.strictEqual(e.isBargain, false);
  // одна и та же продажа в двух мониторах (раздел и продавец) — один голос; копия без итога уступает копии с итогом
  const dup = [sold('1 рубль 1899', 100, { ext: '501' }), sold('1 рубль 1899', 100, { ext: '501', outcome: null }), sold('1 рубль 1899', 300, { ext: '502' }), sold('1 рубль 1899', 300, { ext: '503' })];
  const m = cm.marketEstimate(dup, p);
  assert.strictEqual(m.n, 3);
  assert.strictEqual(m.soldN, 3);
  assert.strictEqual(m.refMedian, 300);
});

console.log('оценка слабов, свежих продаж, тихих лотов:');
check('слаб: ориентир — слабы той же корзины, сырые и слабы в нашей базе не смешиваются', () => {
  const ms64 = parseCoin({ title: '1 рубль 1924 MS-64 NGC', sectionPath: 'Серебро', conditionText: 'I (Новое, Unc)' });
  const cat = { source: 'gdenashel', prices: { UNC: 204, MS63: 548, MS64: 447, MS65: 892 }, samples: { UNC: 36, MS64: 8 }, windowYears: 3, period: { from: '2022-01-10', to: '2025-10-30' } };
  const e = cm.assess({ parsed: ms64, price: 300, rows: [], catalogs: [cat] });
  assert.strictEqual(e.reference, 447);
  assert.strictEqual(e.catalog.grade, 'MS64');
  assert.strictEqual(e.isBargain, true); // 300 при 447: −33%, 147 р.
  assert.ok(cm.formatEstimateLines(e).includes('📚 gdenashel.ru, аукционы РФ (слаб MS64, 8 прох., 2022–2025): 447 р.'), cm.formatEstimateLines(e).join('\n'));
  // в нашей базе: три сырых UNC по 200 и три слаба MS64 по 600 — для слаба считаются только слабы, для сырой — только сырые
  const r = (t, cond, price) => ({ id: Math.random(), source: 'ayby', sale_type: 'buy_now', grade: 'UNC', current_price: price, outcome: null, title: t, parsed: parseCoin({ title: t, sectionPath: 'Серебро', conditionText: cond }) });
  const base = [r('1 рубль 1924', 'I (Новое, Unc)', 200), r('1 рубль 1924', 'I (Новое, Unc)', 210), r('1 рубль 1924', 'I (Новое, Unc)', 190),
    r('1 рубль 1924 NGC MS64', 'I (Новое, Unc)', 600), r('1 рубль 1924 MS-64 ННР', 'I (Новое, Unc)', 620), r('1 рубль 1924 слаб NGC MS 64', 'I (Новое, Unc)', 580)];
  assert.strictEqual(cm.marketEstimate(base, ms64).refMedian, 600);
  assert.strictEqual(cm.marketEstimate(base, parseCoin({ title: '1 рубль 1924', sectionPath: 'Серебро', conditionText: 'I (Новое, Unc)' })).refMedian, 200);
  // старые строки базы без поля slab: слаб восстанавливается по заголовку
  const legacy = base.map((x) => ({ ...x, parsed: { ...x.parsed, slab: undefined } }));
  assert.strictEqual(cm.marketEstimate(legacy, ms64).refMedian, 600);
  // нижняя корзина без слабов в архиве → сырая монета того же уровня
  const ms61 = parseCoin({ title: '1 рубль 1924 NGC MS61', sectionPath: 'Серебро', conditionText: 'I (Новое, Unc)' });
  const low = cm.assess({ parsed: ms61, price: 100, rows: [], catalogs: [{ source: 'gdenashel', prices: { UNC: 204 }, samples: { UNC: 36 } }] });
  assert.strictEqual(low.reference, 204);
  assert.ok(cm.formatEstimateLines(low)[0].includes('UNC без слаба — слабов MS60-62 в архиве нет'));
  // MS65 без слабов этой корзины — ориентира нет (сырая UNC его не заменяет)
  const ms65 = cm.assess({ parsed: parseCoin({ title: '1 рубль 1924 MS-65 ННР', sectionPath: 'Серебро' }), price: 100, rows: [], catalogs: [{ source: 'gdenashel', prices: { UNC: 204 } }] });
  assert.strictEqual(ms65.reference, null);
  // слаб дешёвой монеты: ориентир < 60 р. — не выгодно, сколько бы ни стоил лот
  const cheap = cm.assess({ parsed: parseCoin({ title: '15 копеек 1915 ВС MS-65 ННР', sectionPath: 'Серебро' }), price: 10, rows: [], catalogs: [{ source: 'gdenashel', prices: { MS65: 56 } }] });
  assert.strictEqual(cheap.slabCheap, true);
  assert.strictEqual(cheap.isBargain, false);
  // details — не с чем сравнить
  const det = cm.assess({ parsed: parseCoin({ title: 'Рубль 1913 NGC UNC det', sectionPath: 'Серебро', conditionText: 'I (Новое, Unc)' }), price: 100, rows: base, catalogs: [cat] });
  assert.strictEqual(det.reference, null);
  // слаб без грейда — как сырая монета того же состояния (слаб не дешевле сырой)
  const nograde = cm.assess({ parsed: parseCoin({ title: '1 рубль 1924 UNC слаб ННР', sectionPath: 'Серебро', conditionText: 'I (Новое, Unc)' }), price: 100, rows: [], catalogs: [cat] });
  assert.strictEqual(nograde.reference, 204);
});
check('свежие продажи нашей базы (12 мес., ≥3) — основной ориентир, даже если архив дешевле', () => {
  const p = parseCoin({ title: '1 рубль 1898 АГ', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' });
  const day = (n) => new Date(Date.now() - n * 86400e3);
  const sold = (price, ago) => ({ id: Math.random(), source: 'ayby', sale_type: 'auction', grade: 'VF', current_price: price, final_price: price, outcome: 'sold', ended_at: day(ago), title: '1 рубль 1898 АГ', parsed: parseCoin({ title: '1 рубль 1898 АГ', sectionPath: 'Серебро' }) });
  const recent = [sold(180, 10), sold(170, 40), sold(190, 100)];
  const e = cm.assess({ parsed: p, price: 120, rows: recent, catalog: { source: 'gdenashel', prices: { VF: 150 } } });
  assert.strictEqual(e.reference, 180);
  assert.strictEqual(e.referenceRecent, true);
  assert.ok(cm.formatEstimateLines(e).includes('📊 Наша база (1 рубль 1898 АГ, VF): 180 р. по 3 продажам за 12 мес. — основной ориентир'));
  // старые продажи (больше года) — обычный порядок: самый низкий источник
  const old = [sold(180, 400), sold(170, 500), sold(190, 600)];
  const o = cm.assess({ parsed: p, price: 120, rows: old, catalog: { source: 'gdenashel', prices: { VF: 150 } } });
  assert.strictEqual(o.reference, 150);
  assert.strictEqual(o.referenceRecent, false);
  assert.strictEqual(cm.periodLabel({ from: '2025-02-01', to: '2025-11-01' }), '2025');
});
check('лот на вес: стоимость серебра — ориентир, ниже неё — выгодно', () => {
  const { metalValue } = require('./coins/metal');
  const p = parseCoin({ title: 'Серебро 500 гр', sectionPath: null });
  const m = metalValue(p, { silver: 4.5, gold: 360 });
  assert.deepStrictEqual(m, { metal: 'silver', grams: 250, bulk: { grams: 500, purity: 0.5, purityAssumed: true }, pricePerG: 4.5, value: 1125 });
  const e = cm.assess({ parsed: p, price: 700, rows: [], metal: m });
  assert.strictEqual(e.isBargain, true);
  assert.ok(cm.formatEstimateLines(e).includes('⚖️ Металл: вес лота 500 г × проба 0,5 (не указана, считаем билон) = 250 г серебра ≈ 1 125 р. (НБРБ 4,5 р./г)'), cm.formatEstimateLines(e).join('\n'));
});
check('тихий лот: аукцион без конкуренции за сутки до конца, разумный максимум', () => {
  const p = parseCoin({ title: '1 рубль 1898 АГ. С 1 рубля без МЦ', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' });
  const est = cm.assess({ parsed: p, price: 1, rows: [], catalog: { source: 'gdenashel', prices: { VF: 150 } } });
  assert.strictEqual(est.isBargain, false); // 1 р. без ставок — не цена
  const now = Date.now();
  const lot = (o) => ({ saleType: 'auction', price: 1, bids: 0, endsAt: new Date(now + 10 * 3600e3), reserve: null, ...o });
  assert.deepStrictEqual(cm.quietLot(est, lot(), { now }), { ref: 150, max: 105, refSource: 'gdenashel', hoursLeft: 10 });
  assert.ok(cm.quietLot(est, lot({ bids: 1, price: 60 }), { now }));
  assert.strictEqual(cm.quietLot(est, lot({ bids: 2 }), { now }), null);                     // уже торгуются
  assert.strictEqual(cm.quietLot(est, lot({ reserve: 'not_met' }), { now }), null);          // минимальная цена не пройдена
  assert.strictEqual(cm.quietLot(est, lot({ endsAt: new Date(now + 40 * 3600e3) }), { now }), null); // рано
  assert.strictEqual(cm.quietLot(est, lot({ saleType: 'buy_now' }), { now }), null);
  assert.strictEqual(cm.quietLot(est, lot({ price: 120, bids: 1 }), { now }), null);         // уже дороже разумного максимума
  const small = cm.assess({ parsed: p, price: 1, rows: [], catalog: { source: 'gdenashel', prices: { VF: 20 } } });
  assert.strictEqual(cm.quietLot(small, lot(), { now }), null);                              // ориентир < 30 р.
});
check('монитор: тихое окно, слаб по фикс-цене, лот на вес, сбор цен без уведомлений', () => {
  const { notifyTiming: nt, worthNotifying: wn, buildCaption, endsAtNight } = require('./coins');
  const mon = { metals: ['silver'] };
  const silver = parseCoin({ title: '1 рубль 1898 АГ', sectionPath: null });
  const h = (n) => new Date(Date.now() + n * 3600e3);
  assert.strictEqual(nt(mon, silver, { ended: false, saleType: 'auction', endsAt: h(20) }), 'quiet');
  assert.strictEqual(nt(mon, silver, { ended: false, saleType: 'auction', endsAt: h(30) }), 'closing');
  const slab = parseCoin({ title: '1 рубль 1924 MS-64 NGC', sectionPath: null });
  assert.strictEqual(wn(mon, slab, { ended: false, saleType: 'buy_now' }), false);
  assert.strictEqual(wn(mon, slab, { ended: false, saleType: 'auction' }), true);
  assert.strictEqual(wn(mon, parseCoin({ title: 'Набор 10 монет, серебро 900, общий вес 100 гр', sectionPath: null }), { ended: false, saleType: 'auction' }), true);
  assert.strictEqual(wn(mon, parseCoin({ title: 'Набор 10 монет серебро 1924', sectionPath: null }), { ended: false, saleType: 'auction' }), false);
  assert.strictEqual(wn({ ...mon, notify: false }, silver, { ended: false, saleType: 'auction' }), false);
  assert.strictEqual(endsAtNight(new Date('2026-11-10T22:00:00Z')), true);  // 01:00 Минск
  assert.strictEqual(endsAtNight(new Date('2026-11-10T12:00:00Z')), false); // 15:00 Минск
  const lot = { title: '1 рубль 1924 MS-64 NGC', price: 1, bids: 0, saleType: 'auction', endsAt: new Date('2026-11-10T22:00:00Z'), url: 'https://ay.by/lot/x-1.html', photos: [], seller: 'Новичок', sellerRating: 3 };
  const cap = buildCaption({ name: 'Монеты (серебро)', emoji: '🪙' }, lot, { ...slab, noReserve: true }, false, null, null, { ref: 447, max: 312 });
  assert.ok(cap.includes('🤫 Тихий лот — Монеты (серебро)'), cap);
  assert.ok(cap.includes('🏛 Слаб NGC MS64'), cap);
  assert.ok(cap.includes('🤫 Тихий лот: ставок нет, без МЦ, заканчивается ночью. Разумный максимум ≈ 312 р. (ориентир 447 р. минус 30%)'), cap);
  assert.ok(cap.includes('👤 Новичок, рейтинг 3 — ⚠️ мало отзывов, выше риск подделки (слабы тоже подделывают)'), cap);
});
check('страница лота: продавец с рейтингом, победитель, минимальная цена', () => {
  const { interpretLot } = require('./coins/ayby');
  const base = { title: '15 копеек 1921 РСФСР', timerSeconds: 3600, priceText: '100,00 руб.', bidsText: '2 ставки', hasBidButton: true, hasBuyNow: false, bargain: false, specs: {}, photos: [], titleAreaText: '', categoryPath: null,
    seller: 'DimaMinsk', sellerNick: 'DimaMinsk', sellerId: '33853463', sellerRating: 241, winner: null, winnerId: null, reserveText: 'Минимальная цена не пройдена' };
  const live = interpretLot(base);
  assert.deepStrictEqual([live.seller, live.sellerId, live.sellerRating, live.reserve], ['DimaMinsk', '33853463', 241, 'not_met']);
  assert.strictEqual(interpretLot({ ...base, reserveText: 'Минимальная цена пройдена' }).reserve, 'met');
  assert.strictEqual(interpretLot({ ...base, reserveText: null }).reserve, null);
  const sold = interpretLot({ ...base, timerSeconds: 0, reserveText: null, soldText: 'Лот продан за 2,50 бел. руб. 8 октября в 21:15:02, победитель Литовец', winner: 'Литовец', winnerId: '8923151' });
  assert.deepStrictEqual([sold.sold, sold.winner, sold.winnerId], [true, 'Литовец', '8923151']);
  assert.strictEqual(interpretLot({ ...base, timerSeconds: 0, soldText: 'Лот продан за 2,50 бел. руб. 8 октября в 21:15:02, победитель Литовец' }).winner, 'Литовец'); // без ссылки — из текста
});

console.log('серебро и золото всех стран, Kufar, лента ay.by:');
check('содержание металла: таблицы стран, текст лота, памятные — нижняя планка', () => {
  const { fineContent } = require('./coins/metal');
  const fc = (title, sectionPath, specs = {}, description = '') => {
    const r = fineContent(parseCoin({ title, sectionPath, specs, description }));
    return r ? r.grams : null;
  };
  const S = { 'Металл': 'Серебро' }, G = { 'Металл': 'Золото' };
  assert.strictEqual(fc('1 доллар 1921 Морган', 'Монеты › Америка', S), 24.06);
  assert.strictEqual(fc('США 50 центов 1967 года . Кенеди.Серебро', 'Монеты › Америка США', { ...S, 'Номинал': '50 центов' }), 4.6);
  assert.strictEqual(fc('С рубля! 1 доллар 2013 США - шагающая свобода - Унция серебра чистоты!', 'Монеты › Америка США', S), 31.1);
  assert.strictEqual(fc('Соверен 1912 Георг V', 'Монеты › Европа', G), 7.32);
  assert.strictEqual(fc('20 франков 1910 Франция', 'Монеты › Европа', G), 5.8);
  assert.strictEqual(fc('5 марок 1936 A Гинденбург', 'Монеты › Европа › Германия', S), 12.5);
  assert.strictEqual(fc('5 злотых 1934 Пилсудский', 'Монеты › Европа › Польша', S), 8.25);
  assert.strictEqual(fc('3 рубля 1995 Ag 900 34,88 г', 'Монеты › Россия', S), 31.39);       // текст важнее таблицы
  assert.strictEqual(fc('20 рублей 2019 Европейские игры', 'Беларусь (после 1991) Серебро', S), 26.1); // нижний из весов
  assert.strictEqual(fc('Белая синица. 10 рублей. Серебро.', 'Беларусь', S), 15.5);           // без года
  assert.strictEqual(fc('Монета 1/2 oz серебро 999', null, S), 15.55);
  assert.strictEqual(fc('Медаль', null, S, 'Ag 925, вес монеты 28,28 г'), 26.16);
  assert.strictEqual(fc('20 лир 1970 Италия', 'Европа', {}), null);                          // металл неизвестен — не золото
  assert.strictEqual(fc('1 рубль 1898 АГ', null), 18);                                       // Империя — по-прежнему таблица
  const p = parseCoin({ title: '20 франков 1910', sectionPath: 'Европа', specs: G });
  assert.strictEqual(p.ruler, null); // иностранная монета — не «Николай II»
});
check('после 1991: ни нашей медианы, ни архивов по номиналу и году (под ними разные памятные)', () => {
  const { catalogKeys } = require('./coins/store');
  const by = parseCoin({ title: '20 рублей 2018 Финансовая система Беларуси серебро', sectionPath: null });
  assert.deepStrictEqual(groupKeys(by), []);
  assert.deepStrictEqual(catalogKeys(by), []);
  assert.ok(groupKeys(parseCoin({ title: '1 рубль 1898 АГ', sectionPath: null })).length > 0);
});
check('Kufar: коллекции, альбомы, россыпь; не «из коллекции» и не пустые альбомы', () => {
  const { collectionHint } = require('./coins/parse');
  assert.strictEqual(collectionHint('Коллекция монет СССР'), 'коллекция');
  assert.strictEqual(collectionHint('Кляссер с монетами'), 'альбом / кляссер');
  assert.strictEqual(collectionHint('Монеты россыпью 2 кг'), 'россыпь');
  assert.strictEqual(collectionHint('Монеты от деда, разные'), 'наследство');
  assert.strictEqual(collectionHint('Монеты 150 шт'), 'много монет');
  assert.strictEqual(collectionHint('Монеты старые'), 'много монет');
  assert.strictEqual(collectionHint('50 копеек 1925 из моей коллекции'), null);
  assert.strictEqual(collectionHint('Альбом для монет, новый'), null);
  assert.strictEqual(collectionHint('Коллекция банкнот'), null);
  assert.strictEqual(collectionHint('монета 50 копеек 1925'), null);
});
check('ay.by: ник продавца из карточки, страницы продавца, сортировка «Новые»', () => {
  const { authorNick, sellerPageUrl } = require('./coins/ayby');
  assert.strictEqual(authorNick('maybach - 888 99.8%'), 'maybach - 888');
  assert.strictEqual(authorNick('onos 100%'), 'onos');
  assert.strictEqual(sellerPageUrl('6332437'), 'https://ay.by/whoiswho.phtml?id=6332437&show=auction_active&auctions_limit=100');
  assert.strictEqual(sellerPageUrl('6332437', 3), 'https://ay.by/whoiswho.phtml?id=6332437&show=auction_active&auctions_limit=100&page=3');
  const { listUrl } = require('./coins');
  assert.strictEqual(listUrl('https://coins.ay.by/sssr/1921-1941/'), 'https://coins.ay.by/sssr/1921-1941/?order=create');
  assert.strictEqual(listUrl('https://coins.ay.by/topic.phtml?f=1&ti1=6', 2), 'https://coins.ay.by/topic.phtml?f=1&ti1=6&order=create&page=2');
});
check('лента: какие карточки открывать и каким мониторам отдавать лот', () => {
  const { feedCandidate, feedOwners } = require('./coins');
  const nicks = new Set(['onos']);
  assert.strictEqual(feedCandidate({ title: '2 гривны 2005г. Песчаный слепыш', author: 'Panas 100%' }, nicks), false);
  assert.strictEqual(feedCandidate({ title: 'Обыкновенная горлица. 10 рублей. Серебро.', author: 'x 99%' }, nicks), true);
  assert.strictEqual(feedCandidate({ title: 'Рубль 1892 (АГ)', author: 'x 99%' }, nicks), true);     // металл по номиналу и году
  assert.strictEqual(feedCandidate({ title: '1 копейка 1937', author: 'onos 100%' }, nicks), true); // продавец из списка
  const silver = parseCoin({ title: '5 злотых 1934', sectionPath: 'Европа › Польша', specs: { 'Металл': 'Серебро' } });
  const keys = (lot, p) => feedOwners(lot, p).map((m) => m.key);
  assert.ok(keys({ sellerId: '1', categoryPath: 'Монеты › Европа › Польша' }, silver).includes('coins-silver'));
  assert.ok(!keys({ sellerId: '1', categoryPath: 'Монеты › Европа › Польша' }, silver).includes('coins-sellers'));
  assert.ok(keys({ sellerId: '6332437', categoryPath: 'Монеты › СССР' }, parseCoin({ title: '1 копейка 1937', sectionPath: null })).includes('coins-sellers'));
  assert.ok(!keys({ sellerId: '1', categoryPath: 'Монеты › Европа' }, silver).includes('coins-germany')); // сбор цен — без ленты
});

console.log(`\nпроверок пройдено: ${passed}`);
