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
  const monitor = { silverOnly: true };
  assert.strictEqual(worthNotifying(monitor, { isSilver: true, flags: [] }, { ended: false }), true);
  assert.strictEqual(worthNotifying(monitor, { isSilver: false, flags: [] }, { ended: false }), false);
  assert.strictEqual(worthNotifying(monitor, { isSilver: true, flags: ['копия'] }, { ended: false }), false);
  assert.strictEqual(worthNotifying(monitor, { isSilver: true, flags: [] }, { ended: true }), false);
});
check('когда слать: фикс-цена сразу, аукцион — за ≤12 ч до конца', () => {
  const monitor = { silverOnly: true };
  const silver = { isSilver: true, flags: [] };
  const h = (n) => new Date(Date.now() + n * 3600e3);
  assert.strictEqual(notifyTiming(monitor, silver, { ended: false, saleType: 'buy_now', endsAt: h(72) }), 'now');
  assert.strictEqual(notifyTiming(monitor, silver, { ended: false, saleType: 'auction_buynow', endsAt: h(72) }), 'now');
  assert.strictEqual(notifyTiming(monitor, silver, { ended: false, saleType: 'auction', endsAt: h(72) }), 'closing');
  assert.strictEqual(notifyTiming(monitor, silver, { ended: false, saleType: 'auction', endsAt: h(AUCTION_NOTIFY_HOURS - 1) }), 'now');
  assert.strictEqual(notifyTiming(monitor, { isSilver: false, flags: [] }, { ended: false, saleType: 'auction', endsAt: h(1) }), 'never');
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
check('каталог главнее рынка, порог выгоды 30%', () => {
  const p = parseCoin({ title: '1 рубль 1898 АГ', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' });
  const catalog = { source: 'numista', title: '1 Rouble - Nicholas II', prices: { F: 60, VF: 150, XF: 400 } };
  const e = cm.assess({ parsed: p, price: 100, rows, catalog });
  assert.strictEqual(e.referenceSource, 'catalog');
  assert.strictEqual(e.reference, 150);
  assert.strictEqual(e.deviationPct, -33);
  assert.strictEqual(e.isBargain, true);
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
  assert.deepStrictEqual(lines, ['📚 Numista (VF): 150 р.', '📊 Наша база (1 рубль 1898 АГ, VF): 120 р. по 3 лотам, продаж 1', '🟢 На 33% (50 р.) ниже Numista — выгодно']);
  assert.deepStrictEqual(cm.formatEstimateLines(cm.assess({ parsed: p, price: 100, rows: [] })), ['📊 Наша база: похожих лотов в этом состоянии ещё не было', '⚪ Ориентира пока нет: ни каталога, ни трёх похожих лотов']);
  // несколько источников — каждый своей строкой, вердикт по первому (gdenashel), редкость из справочника типа
  const multi = cm.assess({ parsed: p, price: 100, rows, coinType: { konros: 'R1+', mintage: 1100002 },
    catalogs: [{ source: 'gdenashel', prices: { VF: 150, XF: 400 }, samples: { VF: 42, XF: 17 }, windowYears: 3 }, { source: 'numista', prices: { VF: 140 } }] });
  assert.strictEqual(multi.reference, 150);
  assert.strictEqual(multi.catalogs.length, 2);
  assert.deepStrictEqual(cm.formatEstimateLines(multi), [
    '📚 gdenashel.ru, аукционы РФ (VF, 42 прох. за 3 г.): 150 р.',
    '📚 Numista (VF): 140 р.',
    '📊 Наша база (1 рубль 1898 АГ, VF): 120 р. по 3 лотам, продаж 1',
    '💎 Редкость: эпическая 🟣 · Конрос R1+ · тираж 1 100 002 · 59 прох. за 3 г.',
    '🟢 На 33% (50 р.) ниже gdenashel.ru — выгодно',
  ]);
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
check('состояния источника → наша шкала', () => {
  assert.strictEqual(gd.normalizeGrade('MS64'), 'UNC');
  assert.strictEqual(gd.normalizeGrade('AU58'), 'AU');
  assert.strictEqual(gd.normalizeGrade('XF'), 'XF');
  assert.strictEqual(gd.normalizeGrade('VF25'), 'VF');
  assert.strictEqual(gd.normalizeGrade('F15'), 'F');
  assert.strictEqual(gd.normalizeGrade('PROOF'), 'PF');
  assert.strictEqual(gd.normalizeGrade('PF63'), 'PF');
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
  assert.strictEqual(r.sales[1].grade, 'UNC');
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

console.log(`\nпроверок пройдено: ${passed}`);
