// Офлайн-проверка разбора монет (coins/parse.js) и разбора карточек ay.by. Запуск: node test-coins.js
const assert = require('assert');
// скидку на завышенное состояние проверяет отдельный тест (gradeDiscount), остальные — по заявленному состоянию
process.env.COINS_GRADE_DISCOUNT = '0';
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

check('русско-финские: пенни и марки — серебро/золото до 1917, ключ рынка', () => {
  const { parseCoin } = require('./coins/parse');
  const { fineContent } = require('./coins/metal');
  const sp = 'Монеты › Россия › Российская Империя (до 1917) › 1894-1917 (Николай II) › Русско-финские';
  const p = parseCoin({ title: '25 pennia 1916 года-1.', sectionPath: sp });
  assert.strictEqual(p.metal, 'silver');
  assert.strictEqual(fineContent(p).grams, 0.96);
  assert.deepStrictEqual(groupKeys(p).map((k) => k.key), ['W|Финляндия|пенни25|1916']);
  assert.strictEqual(parseCoin({ title: '1 марка 1915', sectionPath: sp }).metal, 'silver');
  assert.strictEqual(parseCoin({ title: '20 марок 1913 Финляндия', sectionPath: null }).metal, 'gold');
  assert.strictEqual(parseCoin({ title: '25 пенни 1921', sectionPath: null }).metal, null); // после 1917 — медно-никель
  assert.strictEqual(parseCoin({ title: '2 марки 1911 Бавария', sectionPath: null }).foreign.unit, 'марка'); // германские — как были
});

check('все разделы ay.by: карточки только серебро/золото, без копий', () => {
  const { cardWanted } = require('./coins');
  const { MONITORS } = require('./config');
  const silver = MONITORS.find((m) => m.key === 'coins-silver');
  const gold = MONITORS.find((m) => m.key === 'coins-gold');
  assert.ok(!silver.sections.some((s) => /kopii/.test(s.url)) && silver.sections.length >= 10);
  assert.strictEqual(cardWanted(silver, { title: '25 pennia 1916 года-1.', short: 'Серебро, 1916' }), true);
  assert.strictEqual(cardWanted(silver, { title: 'Талер 1765 Австрия', short: 'Серебро, 1765' }), true); // металл из карточки
  assert.strictEqual(cardWanted(silver, { title: '1 рубль 1898 АГ', short: '' }), true);                 // по заголовку
  assert.strictEqual(cardWanted(silver, { title: '2 копейки 1964 года СССР', short: '' }), false);
  assert.strictEqual(cardWanted(silver, { title: 'Рубль 1898 копия', short: 'Серебро, 1898' }), false);
  assert.strictEqual(cardWanted(gold, { title: '10 гульденов 1912 Нидерланды', short: 'Золото, 1912' }), true);
  assert.strictEqual(cardWanted(gold, { title: '1 рубль 1898 АГ', short: '' }), false);
  // сертификат без монеты (ay.by 5040457095): не серебро, хотя в карточке «Серебро»
  assert.strictEqual(cardWanted(silver, { title: 'Сертификат к памятной монете Церковь–крепость Сынковичи. Серия "Памятники архитектуры Беларуси" 20 рублей 2000 год', short: 'Серебро, 2000' }), false);
  assert.strictEqual(cardWanted(silver, { title: 'Футляр и сертификат для монеты 20 рублей Полоцк 1998', short: 'Серебро' }), false);
  assert.strictEqual(cardWanted(silver, { title: 'Буклет к монете 20 рублей 2000, без монеты', short: 'Серебро' }), false);
  // ay.by 5041540156: «Буклеты разные к серии …» и раздел «Буклеты, сертификаты»
  assert.strictEqual(cardWanted(silver, { title: 'Буклеты разные к серии Праваслаўныя цудатворныя іконы. 20 рублей и 500 р. Серебро .', short: 'Серебро' }), false);
  assert.ok(parseCoin({ title: '20 рублей 2010 Икона', sectionPath: 'Монеты › Беларусь (после 1991) › Буклеты, сертификаты' }).flags.includes('не монета'));
  assert.ok(!parseCoin({ title: '20 рублей 2010 Икона', sectionPath: 'Монеты › Беларусь (после 1991) › Серебро' }).flags.includes('не монета'));
  // ay.by 5041929853: «Серебро 999.Унция» — унция чистого серебра
  const congo = parseCoin({ title: '240 франков Республики Конго 2013года.Китайский лунный календарь-Год змеи. Серебро 999.Унция .', sectionPath: null });
  assert.strictEqual(congo.content && congo.content.fineGrams, 31.1);
  assert.strictEqual(parseCoin({ title: 'Панда 2015 серебро 999 унция', sectionPath: null }).content.fineGrams, 31.1);
  assert.strictEqual(parseCoin({ title: 'Британия 1 / 2 унции серебро 2020', sectionPath: null }).content.fineGrams, 15.55);
  assert.strictEqual(cardWanted(silver, { title: '20 рублей 1998 Полоцк в капсуле с сертификатом', short: 'Серебро, 1998' }), true);
  // «1 / 2 марки» с пробелами — половина марки (2,5 г серебра), не 2 марки (ay.by 5041902713)
  const half = parseCoin({ title: 'Германия 1 / 2 марки 1914 А ( серебро ) Состояние СУПЕР', sectionPath: null });
  assert.strictEqual(half.foreign.value, 0.5);
  assert.strictEqual(half.foreign.mint, 'A');
  assert.strictEqual(half.denomination, '½ марки');
  assert.strictEqual(parseCoin({ title: 'Германия 1914 2 марки A', sectionPath: null }).foreign.value, 2);
  // обратная косая черта (ay.by 5038444213): «1 \ 2 марки» — тоже половина
  assert.strictEqual(parseCoin({ title: 'Германия 1 \\ 2 марки 1907 А ( отличное состояние )', sectionPath: null }).foreign.value, 0.5);
  assert.strictEqual(parseCoin({ title: '1\\2 копейки 1899', sectionPath: null }).denomKop, 0.5);
  const { notifyBlocker } = require('./coins/parse');
  assert.strictEqual(notifyBlocker(parseCoin({ title: 'Коробка для монеты 20 рублей 2000', sectionPath: null }), 'buy_now'), 'не монета (сертификат, футляр)');
});

check('Kufar: оценивается только конкретная монета из серебра или золота', () => {
  const { coinListingBlocker } = require('./listings');
  const why = (title, description = '') => coinListingBlocker(parseCoin({ title, sectionPath: null, description }), title);
  // конкретные монеты — оцениваются
  for (const title of ['Монета рубль серебро 1924 г.', 'Один полтинник 1924г', 'Монета 2 марки 1901 серебро Пруссия', '3 марки 1909', 'Серебряная монета НБРБ "Телец"']) assert.strictEqual(why(title), null, title);
  // россыпь, подборки, лоты на вес, общие заголовки
  for (const title of ['монеты СССР. серебро. цена за всё', '20 копеек разных годов ссср серебро', 'монеты РИ (серебро) 5 шт', 'Серебряные монеты НБРБ 2008 г.в.',
    'Солнечная система. Комплект серебряных монет РБ', 'Серебро лом 500 гр', 'Коллекция серебряных монет', 'Рубли серебро одним лотом']) assert.strictEqual(why(title), 'россыпь / несколько монет', title);
  assert.strictEqual(why('Монеты иностранные см.описание и фото', '50 копеек 1924г. 25р.'), 'не серебро и не золото');
  assert.strictEqual(why('Монеты СССР'), 'не серебро и не золото');
  assert.strictEqual(why('Копия 1 рубль 1924 серебро'), 'копия');
  // медный пятак Екатерины II — не серебро; серебряные 5 копеек XIX века — серебро
  assert.strictEqual(why('5 копеек 1778'), 'не серебро и не золото');
  assert.strictEqual(why('монета 5 копеек 1880г Александра 2'), null);
});
check('перевыставленный «купить сейчас» без покупателя по той же цене — не выгодный лот', () => {
  const { staleBuyNow } = require('./coins');
  const noBuyer = { outcome: 'unsold', final_bids: 0, bids: 0, start_price: 18, last_price: 18 };
  assert.strictEqual(staleBuyNow(18, [noBuyer]), true);
  assert.strictEqual(staleBuyNow(20, [noBuyer]), true);
  assert.strictEqual(staleBuyNow(15, [noBuyer]), false); // цену снизили — смотреть заново
  assert.strictEqual(staleBuyNow(18, []), false);
  assert.strictEqual(staleBuyNow(18, [{ outcome: 'unsold', final_bids: 4, last_price: 50, start_price: 1 }]), false); // были ставки — другой случай
  assert.strictEqual(staleBuyNow(18, [{ outcome: 'sold', final_bids: 0, start_price: 18 }]), false);
});
check('подборки по годам: «сборный лот», «погодовка», список годов; годы события на памятной монете — нет', () => {
  const { flagsFrom } = require('./coins/parse');
  const multi = (title) => flagsFrom(title, '').includes('несколько монет');
  for (const title of ['Сборный лот монет 10 копеек. 1924, 1925, 1927, 1928', 'Монеты СССР 10 копеек 1924-1957 погодовка', 'С рубля без мц! 10 копеек 1924, 27 и 30', '15 копеек 1925, 1927', '10 копеек 1895г и 1899г']) assert.strictEqual(multi(title), true, title);
  for (const title of ['СССР 10 копеек 1924', '1 рубль 1965 20 лет Победы 1941-1945', '3 марки 1913 Саксония. Битва народов 1813-1913', 'Рубль 1913 300 лет дома Романовых, 1613-1913', '1 рубль 1924, СССР, серебро']) assert.strictEqual(multi(title), false, title);
});
check('Kufar: названа ли монета в заголовке (иначе — опознание по фото)', () => {
  const { coinNamed } = require('./listings');
  const named = (title) => coinNamed(parseCoin({ title, sectionPath: null }));
  for (const title of ['Монета рубль серебро 1924 г.', '3 марки 1909', 'Канада 1 доллар 1987г серебро']) assert.strictEqual(named(title), true, title);
  for (const title of ['Монета. Серебро.', 'Памятная монета НБРБ СЕРЕБРО', 'серебряная монета Швеции', 'Рубль серебро', 'МОНЕТА СЕРЕБРО 1910']) assert.strictEqual(named(title), false, title);
});
check('«не копия» в описании — не копия', () => {
  const { flagsFrom } = require('./coins/parse');
  assert.strictEqual(flagsFrom('1 рубль 1924', 'Оригинал, не копия, не подделка').includes('копия'), false);
  assert.strictEqual(flagsFrom('1 рубль 1924', 'копия хорошего качества').includes('копия'), true);
  assert.strictEqual(flagsFrom('1 рубль 1924', 'не оригинал').includes('копия'), true);
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
  assert.strictEqual(sold.saleType, 'buy_now'); // «1 сделка» — выкуплен, а не аукцион с одной ставкой
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
const row = (title, grade, price, o = {}) => ({ id: o.id || Math.random(), source: o.source || 'ayby', status: o.status || 'active', sale_type: o.sale || 'buy_now', grade, current_price: price, final_price: o.final ?? (o.outcome === 'sold' ? price : null), outcome: o.outcome ?? null, bids: o.bids ?? 0, parsed: parseCoin({ title, sectionPath: 'Серебро' }) });
const SOLD = { outcome: 'sold', sale: 'auction' };
const rows = [
  row('1 рубль 1898 АГ', 'VF', 120, SOLD), row('Рубль 1898 АГ', 'VF', 130, SOLD), row('1 рубль 1898 АГ', 'VF', 110, { ...SOLD, final: 100 }),
  row('1 рубль 1898 АГ', 'VF', 400), row('1 рубль 1898 АГ', 'VF', 450, { source: 'kufar', status: 'inactive' }), // просят — не ориентир
  row('1 рубль 1898 АГ', 'XF', 300, SOLD), row('1 рубль 1898 АГ', 'XF', 320, SOLD), row('1 рубль 1898 АГ', 'XF', 280, SOLD),
  row('1 рубль 1899 ФЗ', 'VF', 125), row('1 рубль 1897 АГ', 'VF', 115, { sale: 'auction', bids: 0 }), // старт без ставок — не цена
  row('1 рубль 1898 АГ копия', 'VF', 20), // копии в оценку не идут
];
check('наша оценка: та же группа и то же состояние, медиана продаж ay.by; цены «просят» отдельно', () => {
  const p = parseCoin({ title: '1 рубль 1898 АГ', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' });
  const m = cm.marketEstimate(rows, p);
  assert.strictEqual(m.label, '1 рубль 1898 АГ');
  assert.strictEqual(m.soldN, 3);
  assert.strictEqual(m.refMedian, 120);
  assert.strictEqual(m.askN, 2);
  assert.strictEqual(m.askMedian, 425);
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
  const notSimilar = (l) => !l.startsWith('🧾') && !l.startsWith(' • '); // похожие продажи проверяет свой тест
  const lines = cm.formatEstimateLines(cm.assess({ parsed: p, price: 100, rows, catalog: { source: 'numista', prices: { VF: 150 } } })).filter(notSimilar);
  assert.deepStrictEqual(lines, ['📚 Numista (VF): 150 р.', '📊 Наша база (1 рубль 1898 АГ, VF): 120 р. по 3 продажам; просят 425 р. (2 лот.) — не ориентир', '🟡 На 17% (20 р.) ниже нашей базы']);
  assert.deepStrictEqual(cm.formatEstimateLines(cm.assess({ parsed: p, price: 100, rows: [] })), ['📊 Наша база: похожих лотов в этом состоянии ещё не было', '⚪ Ориентира пока нет: ни каталога, ни трёх продаж на ay.by']);
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
  const uncRows = [row('15 копеек 1908', 'UNC', 100, SOLD), row('15 копеек 1908', 'UNC', 110, SOLD), row('15 копеек 1908', 'UNC', 90, SOLD)];
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
  // пропавшее объявление Kufar — не продажа: могли снять и так
  assert.deepStrictEqual(cm.usablePrice({ source: 'kufar', status: 'inactive', current_price: 60, outcome: null }), { price: 60, sold: false });
});
check('ориентир не из цен «купить сейчас»: 20 копеек 1862 AU за 99 р. при 8 лотах «просят 160» и одной продаже', () => {
  const p = parseCoin({ title: '20 копеек 1862', sectionPath: 'Серебро', conditionText: 'II+ (Как новое, AU)' });
  const ask = (t, price) => ({ id: Math.random(), source: 'ayby', sale_type: 'buy_now', grade: 'AU', current_price: price, outcome: null, title: t, parsed: parseCoin({ title: t, sectionPath: 'Серебро' }) });
  const base = [ask('20 копеек 1861', 150), ask('20 копеек 1863', 160), ask('20 копеек 1867', 170), ask('20 копеек 1870', 160), ask('20 копеек 1875', 155),
    { ...ask('20 копеек 1879', 140), sale_type: 'auction', final_price: 140, outcome: 'sold' }];
  const e = cm.assess({ parsed: p, price: 99, rows: base, catalogs: [{ source: 'numista', prices: { AU: 173 } }] });
  assert.strictEqual(e.market.level, 'ruler');
  assert.strictEqual(e.market.refMedian, null);
  assert.strictEqual(e.reference, 173); // Numista, а не медиана «просят» по всем годам
  assert.ok(cm.formatEstimateLines(e).includes('📊 Наша база (20 копеек, Александр II, AU): продаж 1 (140 р.), все годы; просят 160 р. (5 лот.) — не ориентир'), cm.formatEstimateLines(e).join('\n'));
  // три продажи того же года — ориентир, «просят» по-прежнему только для справки
  const sold = (price) => ({ ...ask('20 копеек 1862', price), sale_type: 'auction', final_price: price, outcome: 'sold' });
  const y = cm.assess({ parsed: p, price: 99, rows: [...base, sold(120), sold(130), sold(110), ask('20 копеек 1862', 300)] });
  assert.strictEqual(y.market.label, '20 копеек 1862');
  assert.strictEqual(y.market.refMedian, 120);
  assert.strictEqual(y.reference, 120);
});
check('состояние со слов продавца: каталоги на ступень ниже, слабам и фото верим', () => {
  const numista = { source: 'numista', prices: { F: 40, VF: 60, XF: 95, AU: 173 } };
  const p = parseCoin({ title: '20 копеек 1862', sectionPath: 'Серебро', conditionText: 'II+ (Как новое, AU)' });
  const e = cm.assess({ parsed: p, price: 99, rows: [], catalogs: [numista], gradeDiscount: 1 });
  assert.strictEqual(e.catalog.grade, 'XF');
  assert.strictEqual(e.reference, 95);
  assert.strictEqual(e.isBargain, false); // 99 при 95 — не выгодно, а при AU 173 было бы «−43%»
  assert.ok(cm.formatEstimateLines(e).includes('📉 Каталоги — по XF, а не AU: без слаба состояние обычно завышено'), cm.formatEstimateLines(e).join('\n'));
  // фото, слаб, предположение F для Kufar — без скидки; G ниже не уходит
  assert.strictEqual(cm.catalogGrade({ ...p, gradeSource: 'photo' }, 1), 'AU');
  assert.strictEqual(cm.catalogGrade({ ...p, gradeSource: null }, 1), 'AU');
  assert.strictEqual(cm.catalogGrade({ ...p, slab: { bucket: null } }, 1), 'AU');
  assert.strictEqual(cm.catalogGrade({ ...p, grade: 'G' }, 1), 'G');
  assert.strictEqual(cm.catalogGrade(parseCoin({ title: '1 рубль 1924 XF', sectionPath: 'Серебро' }), 1), 'VF');
  assert.strictEqual(cm.catalogGrade(p, 0), 'AU');
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

check('аккаунт ay.by: включён при логине или сессии; в избранное лоты не добавляются', () => {
  const { buildCaption } = require('./coins');
  const favorites = require('./coins/favorites');
  assert.strictEqual(favorites.enabled(), favorites.hasCredentials() || favorites.hasSession());
  assert.strictEqual(favorites.add, undefined);
  const lot = { title: '10 рублей 1899 АГ', price: 2500, saleType: 'buy_now', url: 'https://ay.by/lot/x-1.html', photos: [] };
  assert.ok(!buildCaption({ name: 'Монеты (золото)', emoji: '🥇' }, lot, parseCoin({ title: lot.title, sectionPath: null })).includes('⭐'));
});

check('снайп: разбор ответа в Telegram', () => {
  const { parseBidReply } = require('./coins/bid');
  assert.deepStrictEqual(parseBidReply('150'), { max: 150 });
  assert.deepStrictEqual(parseBidReply('150 р.'), { max: 150 });
  assert.deepStrictEqual(parseBidReply('Макс 150,50 руб'), { max: 150.5 });
  assert.deepStrictEqual(parseBidReply('мц 120'), { max: 120 });
  // ставка по ссылке: номер лота из ссылки с хвостом ?from=main
  const { LOT_LINK } = require('./poll');
  const lm = 'https://ay.by/lot/240-frankov-respubliki-kongo-2013goda-kitajskij-lunnyj-kalendar-god-zmei-serebro-999-unciya-5041929853.html?from=main мц 120'.match(LOT_LINK);
  assert.strictEqual(lm[1], '5041929853');
  assert.deepStrictEqual(parseBidReply(lm.input.replace(lm[0], ' ').trim()), { max: 120 });
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
  // без Германии в заголовке и разделе: серебряный номинал своего года — германская марка (так пишут на Kufar)
  assert.strictEqual(parseCoin({ title: '1 марка 1914 D MS-67 PCGS', sectionPath: null }).foreign.mint, 'D');
  assert.strictEqual(parseCoin({ title: 'СССР 1925 год 1 марка', sectionPath: null }).foreign, null);
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
  const r = (t, cond, price) => ({ id: Math.random(), source: 'ayby', sale_type: 'auction', grade: 'UNC', current_price: price, final_price: price, outcome: 'sold', title: t, parsed: parseCoin({ title: t, sectionPath: 'Серебро', conditionText: cond }) });
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
  const cap = buildCaption({ name: 'Монеты (серебро)', emoji: '🪙' }, lot, { ...slab, noReserve: true }, false, null, { ref: 447, max: 312 });
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

check('раздел ay.by «Копии, новоделы» — копия, даже без слова в заголовке; в нашу медиану не идёт', () => {
  const { notifyBlocker } = require('./coins/parse');
  const p = parseCoin({ title: '1 1/2 рубля 1836 год', sectionPath: 'Монеты › Копии, новоделы Российская Империя', conditionText: 'III (Коллекционное, VF)' });
  assert.ok(p.flags.includes('копия'));
  assert.strictEqual(notifyBlocker(p, 'buy_now'), 'копия');
  assert.ok(!parseCoin({ title: 'Рубль 1898 АГ', sectionPath: 'Монеты › Россия › Российская Империя (до 1917)' }).flags.includes('копия'));
  // старая строка базы без пометки, но из раздела копий: не попадает в медиану
  const sold = (title, price, cat = null) => ({ id: Math.random(), source: 'ayby', sale_type: 'auction', grade: 'VF', current_price: price, final_price: price, outcome: 'sold', title, category_path: cat, parsed: parseCoin({ title, sectionPath: 'Серебро' }) });
  const pv = parseCoin({ title: 'Рубль 1898 АГ', sectionPath: 'Серебро', conditionText: 'III (Коллекционное, VF)' });
  const rows = [sold('Рубль 1898 АГ', 300), sold('Рубль 1898 АГ', 320), sold('Рубль 1898 АГ', 310), sold('Рубль 1898 АГ', 20, 'Монеты › Копии, новоделы Российская Империя')];
  assert.strictEqual(cm.marketEstimate(rows, pv).soldN, 3);
});

console.log('СССР: медь и мельхиор 1921–1958, разновидности 1961–1991:');
check('15 коп. 1935 мельхиор — монитор coins-ussr-base, а не «не серебро»; полкопейки — номинал', () => {
  const { matchesMonitor } = require('./coins');
  const { MONITORS } = require('./config');
  const base = MONITORS.find((m) => m.key === 'coins-ussr-base');
  const silver = MONITORS.find((m) => m.key === 'coins-silver');
  const p = parseCoin({ title: '15 КОПЕЕК 1935 СОХРАН!', sectionPath: 'Монеты › СССР › 1921-1941 › 15 копеек', specs: { 'Металл': 'Медно-никелевый сплав' } });
  assert.deepStrictEqual([p.denomKop, p.year, p.metal], [15, 1935, 'base']);
  assert.strictEqual(matchesMonitor(base, p), true);
  assert.strictEqual(matchesMonitor(silver, p), false);
  assert.strictEqual(matchesMonitor(base, parseCoin({ title: '15 копеек 1927', sectionPath: null, specs: { 'Металл': 'Серебро' } })), false); // серебро — coins-silver
  assert.strictEqual(denominationFrom('Полкопейки 1925'), 0.5);
});
check('таблица разновидностей 1961–1991 и сбор лотов ay.by без уведомлений', () => {
  const { ussrVariety } = require('./coins/parse');
  const v = (t) => ussrVariety(parseCoin({ title: t, sectionPath: null }));
  assert.match(v('20 копеек 1991'), /без буквы/);
  assert.match(v('5 копеек 1990'), /буква М/);
  assert.match(v('3 копейки 1990'), /белая/);
  assert.strictEqual(v('2 копейки 1975'), null);
  assert.strictEqual(v('Рубль 1924'), null); // серебро, не 1961–1991
  const { MONITORS } = require('./config');
  const m = MONITORS.find((x) => x.key === 'coins-ussr-unc');
  assert.strictEqual(m.notify, false);
  assert.deepStrictEqual(['20 копеек 1991', '2 копейки 1975 UNC', '2 копейки 1975', 'штемпель 1.2 3 копейки 1975'].map((t) => m.titleFilter.test(t)), [true, true, false, false]);
});
check('ответ «буква»: буква, цвет, что искать у этого номинала', () => {
  const { formatLetterCheck } = require('./coins/vision');
  const text = formatLetterCheck({ result: { denomination: '20 копеек', year: '1991', letter: 'none', letter_confidence: 'medium', where: 'под гербом справа', color: 'белый', color_ok: true }, model: 'm', usage: null, costUsd: null }, 'без буквы; Л на кружке 15 коп.');
  assert.ok(text.includes('Буква двора: нет буквы') && text.includes('ищут: без буквы') && text.includes('посмотрите фото сами'), text);
  const odd = formatLetterCheck({ result: { denomination: '3 копейки', year: '1990', letter: 'M', letter_confidence: 'high', where: '', color: 'белый', color_ok: false }, model: 'm', usage: null, costUsd: null });
  assert.ok(odd.includes('возможна перепутка'), odd);
});

console.log('оценка по фото (без вызова API):');
check('подпись: цена, а не год и не номинал', () => {
  const { captionPrice } = require('./coins/vision');
  assert.strictEqual(captionPrice('50 копеек 1925, просят 60'), 60);
  assert.strictEqual(captionPrice('рубль 1898 за 120'), 120);
  assert.strictEqual(captionPrice('полтинник 1924 — 45 р.'), 45);
  assert.strictEqual(captionPrice('20 копеек 1914'), null);
  assert.strictEqual(captionPrice(''), null);
});
check('сколько предложить: доля ориентира, не меньше металла, не больше максимума', () => {
  const { offerFor } = require('./coins/vision');
  assert.deepStrictEqual(offerFor({ reference: 75, metal: { value: 43 } }), { offer: 43, max: 52, byMetal: false }); // металл выше 55%
  assert.deepStrictEqual(offerFor({ reference: 200, metal: { value: 87 } }), { offer: 110, max: 140, byMetal: false });
  assert.deepStrictEqual(offerFor({ reference: null, metal: { value: 150.4 } }), { offer: 150, max: 150, byMetal: true });
  assert.strictEqual(offerFor({ reference: null, metal: null }), null);
});
check('ответ модели → разбор монеты и текст отчёта', () => {
  const { parsedFromVision, formatReport } = require('./coins/vision');
  const coin = { title: '50 копеек 1925', country: 'СССР', metal: 'silver', grade: 'VF', grade_range: 'VF–XF', confidence: 'medium', problems: ['царапина на реверсе'], copy_risk: 'none', copy_signs: [], notes: 'гурт не виден' };
  const p = parsedFromVision(coin);
  assert.deepStrictEqual([p.denomKop, p.year, p.metal, p.grade, p.gradeSource], [50, 1925, 'silver', 'VF', 'photo']);
  const est = { reference: 75, referenceSource: 'market', deviationPct: null, catalogs: [], metal: { metal: 'silver', grams: 9, value: 43, pricePerG: 4.83 }, market: null };
  const graded = { result: { coins: [coin], photo_quality: 'fair', need_more: ['гурт'], summary: 'Обычный полтинник.' }, model: 'claude-opus-5-5', usage: { input_tokens: 5000, output_tokens: 1000 }, costUsd: 0.04 };
  const [text] = formatReport(graded, [{ coin, est }], 40);
  assert.ok(text.includes('<b>1. 50 копеек 1925</b> · серебро · 📷 VF (VF–XF), уверенность средняя'), text);
  assert.ok(text.includes('⚠️ царапина на реверсе'), text);
  assert.ok(text.includes('чистку по фото не определить'), text);
  assert.ok(text.includes('💬 Предложить ≈ 43 р., максимум 52 р. · просят 40 р. — можно брать'), text);
  assert.ok(text.includes('Дозапросить: гурт'), text);
  assert.ok(text.includes('5000 + 1000 токенов ≈ $0.040'), text);
  const risky = formatReport(graded, [{ coin: { ...coin, copy_risk: 'high', copy_signs: ['литьё'] }, est }])[0];
  assert.ok(risky.includes('⛔ Высокий риск копии'), risky);
  assert.ok(!risky.includes('💬'), risky);
});
check('«фото» на карточку лота: состояние по фото против продавца, максимум для снайпа', () => {
  const { formatLotRegrade, lotHint } = require('./coins/vision');
  const coin = { title: '20 копеек 1862 СПБ МИ', country: 'Россия', metal: 'silver', grade: 'VF', grade_range: 'F–VF', confidence: 'medium', problems: ['следы чистки по полю', 'забоина на гурте'], copy_risk: 'none', copy_signs: [], notes: '' };
  const graded = { result: { coins: [coin], photo_quality: 'good', need_more: [], summary: '' }, model: 'claude-opus-5-5', usage: { input_tokens: 3000, output_tokens: 500 }, costUsd: 0.022 };
  const p = parseCoin({ title: '20 копеек 1862', sectionPath: 'Серебро', conditionText: 'II+ (Как новое, AU)' });
  const numista = [{ source: 'numista', prices: { F: 40, VF: 60, XF: 95, AU: 173 } }];
  const before = cm.assess({ parsed: p, price: 99, rows: [], catalogs: numista, gradeDiscount: 0 });
  const after = cm.assess({ parsed: { ...p, grade: 'VF', gradeSource: 'photo' }, price: 99, rows: [], catalogs: numista, gradeDiscount: 1 });
  assert.strictEqual(after.reference, 60); // фото — без скидки на завышение
  const [text] = formatLotRegrade(graded, { lot: { current_price: 99 }, declared: 'AU', before, after, auction: true });
  assert.ok(text.includes('📷 <b>Состояние по фото: VF (F–VF)</b>, уверенность средняя · продавец: AU'), text);
  assert.ok(text.includes('⚠️ забоина на гурте') && !text.includes('чистки по полю'), text); // чистку по фото не пишем, даже если модель упомянула
  assert.ok(text.includes('🎯 Разумный максимум по VF: ≈ 42 р. (по AU было бы 121 р.)'), text);
  const [fixed] = formatLotRegrade(graded, { lot: { current_price: 99 }, declared: null, before: null, after, auction: false });
  assert.ok(fixed.includes('продавец: не указал') && fixed.includes('💬 Предложить ≈ 33 р., максимум 42 р. · просят 99 р. — дорого'), fixed);
  assert.ok(!lotHint('20 копеек 1862').includes('AU')); // заявленное состояние модели не подсказываем
});
check('ответ модели без строгой схемы: обёртка ```json, текст вокруг, «VF+»', () => {
  const { parseResult } = require('./coins/vision');
  const body = '{"coins":[{"title":"20 копеек 1862","grade":"VF+","cleaned":false}],"photo_quality":"good","summary":"ок"}';
  const r = parseResult('```json\n' + body + '\n```');
  assert.strictEqual(r.coins[0].grade, 'F'); // «VF+» → VF → поправка по сверке с экспертами → F
  assert.strictEqual(r.coins[0].grade_model, 'VF');
  assert.deepStrictEqual(r.coins[0].problems, []);
  assert.deepStrictEqual(r.need_more, []);
  assert.strictEqual(parseResult('Вот оценка:\n' + body + '\nУдачи!').coins.length, 1);
  assert.strictEqual(parseResult(body.replace('VF+', 'EF-AU')).coins[0].grade, 'XF');
  assert.throws(() => parseResult('не могу оценить'), /не по формату/);
  // поправка: F → VG, XF и выше без изменений
  assert.deepStrictEqual(['F', 'XF', 'AU', 'VG'].map((g) => parseResult(body.replace('VF+', g)).coins[0].grade), ['VG', 'XF', 'AU', 'VG']);
  const { formatLotRegrade } = require('./coins/vision');
  const shown = formatLotRegrade({ result: { coins: [{ ...r.coins[0], grade_range: 'VF–XF', confidence: 'medium' }], photo_quality: 'good', need_more: [] }, model: 'm', usage: null, costUsd: null }, { lot: {} })[0];
  assert.ok(shown.includes('Состояние по фото: F (модель видит VF–XF, −1 по сверке с экспертами)'), shown);
});
check('злотые — Польша и без раздела: серебро считается по таблице', () => {
  const { fineContent } = require('./coins/metal');
  const p = parseCoin({ title: '5 злотых 1934 серебро', sectionPath: 'Монеты' });
  assert.strictEqual(p.world.country, 'Польша');
  assert.deepStrictEqual(fineContent(p), { metal: 'silver', grams: 8.25 });
});
check('Олимпиада-80: 5 и 10 рублей — серебро, «Сеятель» — золото', () => {
  const { fineContent } = require('./coins/metal');
  // ay.by 5041865834: считался золотом на 2 876 р.
  const oly = parseCoin({ title: '10 рублей 1978 прыжки с шестом', sectionPath: null });
  assert.strictEqual(oly.metal, 'silver');
  assert.strictEqual(fineContent(oly).grams, 30);
  assert.strictEqual(parseCoin({ title: '5 рублей 1977 Олимпиада Москва', sectionPath: null }).metal, 'silver');
  assert.strictEqual(parseCoin({ title: '10 рублей 1978 Сеятель', sectionPath: null }).metal, 'gold');
  assert.strictEqual(parseCoin({ title: 'Червонец 10 рублей 1977', sectionPath: null }).metal, 'gold');
  assert.strictEqual(parseCoin({ title: '10 рублей 1976', sectionPath: null }).metal, 'gold');
  assert.strictEqual(parseCoin({ title: '100 рублей 1978 Олимпиада', sectionPath: null }).metal, 'gold');
});
check('Великобритания до 1946: вес из таблицы с пробой, без модели; с 1947 — не серебро', () => {
  const { fineContent } = require('./coins/metal');
  const { needsLookup } = require('./coins/content');
  // ay.by 5042027770: 7,07 г пришли «по модели — проверьте вес», без пробы
  const hc = parseCoin({ title: 'С рубля без мц! 1/2 кроны 1944 Великобритания - Георг 6 - UNC - серебро! Блестящая!', sectionPath: null });
  assert.deepStrictEqual(fineContent(hc), { metal: 'silver', grams: 7.07, basis: '14,14 г × проба 500 (билон)' });
  assert.strictEqual(needsLookup(hc), false);
  const fl = parseCoin({ title: 'Флорин 1914 Англия Георг V', sectionPath: null });
  assert.strictEqual(fl.metal, 'silver');
  assert.deepStrictEqual(fineContent(fl), { metal: 'silver', grams: 10.46, basis: '11,31 г × проба 925' });
  assert.strictEqual(fineContent(parseCoin({ title: 'Великобритания 1 шиллинг 1943', sectionPath: null })).grams, 2.83);
  assert.strictEqual(fineContent(parseCoin({ title: 'Half crown 1937 Великобритания', sectionPath: null })).grams, 7.07);
  assert.notStrictEqual(parseCoin({ title: '1/2 кроны 1950 Великобритания', sectionPath: null }).metal, 'silver');
});
check('«0.375 troy oz» и «чистого серебра 11,66 г» — не унция', () => {
  // ay.by 5041988499: Канада 1 доллар 1972, металл считался по 1 унции (31,1 г вместо 11,66 г)
  const { contentFrom } = require('./coins/parse');
  const desc = 'Металл: Серебро 500 пробы\nОбщая масса: 23,33 г\nЧистого серебра (в чистоте): 11,66 г (0.375 troy oz)\nДиаметр: 36,07 мм';
  assert.strictEqual(contentFrom('Канада 1 доллар 1972, Вояжёр (Voyageur)', desc).fineGrams, 11.66);
  assert.strictEqual(contentFrom('Монета', 'вес 0.5 troy oz серебра').fineGrams, 15.55);
  assert.strictEqual(contentFrom('2 доллара Ниуэ 1 oz серебро 999', '').fineGrams, 31.1);
});
check('Канада: доллары и центы по таблице', () => {
  const { fineContent } = require('./coins/metal');
  const fc = (title, specs = {}) => fineContent(parseCoin({ title, sectionPath: null, specs }));
  assert.deepStrictEqual(fc('Канада 1 доллар 1965 год, AU. Елизавета II. Индейцы. Каноэ.'), { metal: 'silver', grams: 18.66, basis: '23,33 г × проба 800' });
  assert.strictEqual(fc('Канада 1 доллар 1977, Серебряный юбилей', { 'Металл': 'Серебро' }).grams, 11.66);
  assert.strictEqual(fc('Канада 1 доллар 1973'), null); // никель, серебро не указано
  assert.strictEqual(fc('Канада 50 центов (1/2 доллар) 1964 год, AU').grams, 9.33);
  assert.strictEqual(parseCoin({ title: 'Канада 1 доллар 1958 год. Королева Великобритании', sectionPath: null }).world.country, 'Канада');
});
check('«Завершен неудачно»: ставки были, минимальная цена не пройдена — не продажа', () => {
  const { interpretLot } = require('./coins/ayby');
  const raw = { title: '3 марки 1908', timerSeconds: 0, priceText: null, bidsText: '3 ставки', hasBidButton: false, hasBuyNow: false, specs: {}, photos: [], titleAreaText: '3 марки 1908 Завершён10 ноября в 21:00:00',
    endedAtText: '10 ноября в 21:00:00', soldText: null, unsoldText: 'Завершен неудачно', reserveText: 'Минимальная цена не была преодолена.', statusHint: null };
  const lot = interpretLot(raw, 200);
  assert.strictEqual(lot.sold, false);
  assert.strictEqual(lot.reserve, 'not_met');
  assert.strictEqual(decideOutcome({ bids: 3 }, lot), 'unsold');
  assert.strictEqual(decideOutcome({ bids: 3 }, { ...lot, statusText: '3 марки 1908 Завершён10 ноября', reserve: 'not_met' }), 'unsold');
});
check('некруглый довесок к максимуму: размер, круглые и некруглые числа, предохранитель', () => {
  const { oddAmount } = require('./coins/bid');
  assert.deepStrictEqual([3, 7, 9.5, 10, 13, 33, 49.5].map(oddAmount), [3.07, 7.07, 9.57, 10.57, 13.57, 33.57, 50.07]);
  assert.deepStrictEqual([50, 85, 130, 190, 2876].map(oddAmount), [51.07, 86.07, 131.07, 191.07, 2877.07]);
  // некруглое число от человека не трогаем; мусор не превращается в ставку
  assert.deepStrictEqual([81.58, 13.03, 0, -5].map(oddAmount), [81.58, 13.03, 0, -5]);
  assert.strictEqual(oddAmount('85'), 86.07);
  // предохранитель: довесок никогда не больше 1,07 р. и 6% максимума, ставка не ниже максимума
  for (let m = 0.5; m <= 5000; m += 0.5) {
    const a = oddAmount(m);
    assert.ok(a >= m && a - m <= 1.0701 && a - m <= m * 0.06 + 1e-6, `${m} → ${a}`);
  }
  assert.strictEqual(oddAmount(1), 1); // 0,07 от рубля — больше 6%
});
check('похожие продажи: уровень сходства, ближайшие по состоянию и цене, ориентир', () => {
  const cm = require('./coins/market');
  const sold = (id, title, price, cc, extra = {}) => {
    const parsed = parseCoin({ title, sectionPath: null, conditionText: cc });
    return { id, external_id: String(id), source: 'ayby', title, outcome: 'sold', final_price: price, final_bids: 5, ended_at: new Date('2026-11-10'), grade: parsed.grade, parsed, url: `https://ay.by/lot/x-${id}.html`, ...extra };
  };
  const VF = 'III (Коллекционное, VF)', UNC = 'I (Новое, Unc)';
  const rows = [
    sold(1, '3 марки 1912 Пруссия', 125, VF), sold(2, '3 марки 1909 Пруссия', 70, VF), sold(3, '3 марки 1910 Пруссия', 90, VF),
    sold(4, '3 марки 1911 Пруссия', 100, VF), sold(5, '3 марки 1908 Пруссия', 110, VF), sold(6, '3 марки 1913 Пруссия', 600, UNC),
    sold(7, '3 марки 1929 Германия Веймар', 220, VF), // другой период — не та серия
    sold(8, '3 марки 1912 Пруссия слаб ННР MS63', 400, UNC), // слаб с сырой монетой не сравнивается
    sold(9, 'Канада 1 доллар 1965', 120, VF, { fine_g: 18.66 }),
  ];
  const lot = parseCoin({ title: '3 марки 1912 Пруссия Вильгельм', sectionPath: null, conditionText: VF });
  // та же монета есть — показывается она
  // та же монета продана один раз — мало: считается вместе с серией, но в списке она первая; медиана — по всем продажам,
  // состояние со слов продавца не учитывается
  const same = cm.similarSales(rows, lot, { excludeId: 99 });
  assert.strictEqual(same.tier, 1);
  assert.strictEqual(same.items[0].price, 125);
  assert.deepStrictEqual([same.n, same.sameGradeN, same.ref], [6, 6, 105]);
  // три продажи той же монеты в том же состоянии — хватает их самих, серия не подмешивается
  const three = cm.similarSales([...rows, sold(11, '3 марки 1912 Пруссия', 130, VF), sold(12, '3 марки 1912 A Пруссия', 115, VF)], lot);
  assert.deepStrictEqual([three.tier, three.n, three.ref], [0, 3, 125]);
  // без неё — серия: 3 марки Империи; сначала VF, ближайшие к медиане 95, UNC за 600 — последним
  const series = cm.similarSales(rows.filter((r) => r.id !== 1), lot);
  assert.strictEqual(series.tier, 1);
  assert.strictEqual(series.n, 5);
  assert.deepStrictEqual([series.ref, series.low, series.high], [100, 90, 110]);
  assert.deepStrictEqual(series.items.map((i) => i.price), [100, 110, 90, 70, 600]); // ближайшие к медиане — первыми
  // трёх продаж в том же состоянии ещё нет — ориентиром не становится; с третьей — становится
  const few = cm.assess({ parsed: lot, price: 50, rows: rows.filter((r) => ![1, 4, 5, 6].includes(r.id)) });
  assert.strictEqual(few.reference, null);
  assert.strictEqual(cm.SIMILAR_MIN, 3);
  const more = cm.assess({ parsed: lot, price: 50, rows: [...rows.filter((r) => r.id !== 1), sold(10, '3 марки 1914 Пруссия', 95, VF)] });
  assert.strictEqual(more.referenceSource, 'similar');
  assert.strictEqual(more.reference, 97.5);
  assert.strictEqual(more.isBargain, true);
  const text = cm.formatEstimateLines(more).join(' | ');
  assert.ok(text.includes('🧾 Похожие продажи ay.by — того же номинала и серии: 6, медиана 98 р., половина продаж 90–110 р.'), text);
  assert.ok(text.includes('<a href="https://ay.by/lot/x-10.html">95 р.</a> · 10.11 · VF · 5 ст. · 3 марки 1914 Пруссия'), text);
  assert.ok(text.includes('ниже медианы похожих продаж — сравните фото: состояние не учтено'), text);
  assert.ok(!text.includes('ещё не было'));
  // минимальная цена продавца не пройдена — карточка с предупреждением
  const { buildCaption } = require('./coins');
  const cap = buildCaption({ name: 'Монеты (серебро)', emoji: '🪙' }, { title: '3 марки 1912 Пруссия', price: 50, saleType: 'auction', bids: 3, reserve: 'not_met', url: 'https://ay.by/lot/x-11.html', photos: [] }, lot, true, more);
  assert.ok(cap.includes('⚠️ Минимальная цена продавца не пройдена'), cap);
  assert.ok(cap.includes('ниже медианы похожих продаж — сравните фото'), cap);
  // серия с другим весом серебра — не та монета: полдоллара 1952 (11,25 г) и Кеннеди 1968 (4,6 г)
  const half = parseCoin({ title: '50 центов 1952 США Карвер серебро', sectionPath: null, conditionText: UNC });
  const halves = [sold(20, '50 центов 1968 США Кеннеди серебро', 50, UNC, { fine_g: 4.6 }), sold(21, '50 центов 1964 США Кеннеди серебро', 90, UNC, { fine_g: 11.25 })];
  assert.deepStrictEqual(cm.similarSales(halves, half, { fine: 11.25 }).items.map((i) => i.price), [90]);
  // «MS66» в уточнении к состоянию — слаб, сравнивается только со слабами
  const slabbed = parseCoin({ title: '50 центов 1952 США Карвер серебро', sectionPath: null, conditionText: UNC, specs: { 'Состояние: уточнение': 'MS66' } });
  assert.strictEqual(slabbed.slab.grade, 'MS66');
  assert.strictEqual(cm.similarSales(halves, slabbed, { fine: 11.25 }), null);
  assert.strictEqual(parseCoin({ title: '50 центов 1952 США', sectionPath: null, specs: { 'Состояние: уточнение': 'небольшие царапины' } }).slab, null);
  // ни типа, ни серии — серебро того же веса
  const world = cm.similarSales(rows, parseCoin({ title: 'Австралия 1 флорин 1950 серебро', sectionPath: null, conditionText: VF }), { fine: 18 });
  assert.strictEqual(world.tier, 2);
  assert.deepStrictEqual(world.items.map((i) => i.price), [120]);
});
check('металл лота для базы: чистый вес, проба, вес монеты, источник', () => {
  const { contentRecord } = require('./coins/metal');
  const rec = (title, description = '') => contentRecord(parseCoin({ title, sectionPath: null, description }));
  assert.deepStrictEqual(rec('1/2 кроны 1944 Великобритания серебро'), { metal: 'silver', fineG: 7.07, purity: 0.5, grossG: 14.14, source: 'table', basis: '14,14 г × проба 500 (билон)', mismatch: null });
  const m = rec('3 марки 1912 Пруссия');
  assert.deepStrictEqual([m.fineG, m.purity, m.grossG, m.source], [15, 0.9, 16.67, 'table']);
  const k = rec('20 копеек 1915 ВС');
  assert.deepStrictEqual([k.fineG, k.purity, k.grossG], [1.8, 0.5, 3.6]);
  assert.strictEqual(rec('Рубль 1842 СПБ АЧ').purity, null); // проба у рублей до 1885 другая — не выдумываем
  const lot = rec('2 доллара Ниуэ 2010 серебро', 'Вес 31,1 г, проба 999');
  assert.deepStrictEqual([lot.source, lot.purity, lot.grossG], ['lot', 0.999, 31.1]);
  assert.strictEqual(contentRecord({ ...parseCoin({ title: '50 эскудо 1968 Португалия серебро', sectionPath: null }), content: { fineGrams: 11.7, basis: 'по Numista: Portugal, 50 Escudos, 18 г × проба 650' } }).source, 'numista');
  assert.strictEqual(rec('50 эскудо 1968 Португалия серебро'), null);
  const kr = rec('1 крюгерранд 2018 г. Южно-Африканская республика. Унция чистого серебра');
  assert.deepStrictEqual([kr.fineG, kr.purity, kr.grossG, kr.source], [31.07, 0.999, 31.1, 'table']);
});
check('Kufar: германские марки без слова «Германия»', () => {
  const { fineContent } = require('./coins/metal');
  const k = (title) => parseCoin({ title, sectionPath: null });
  assert.strictEqual(fineContent(k('3 марки 1909')).grams, 15);
  assert.strictEqual(fineContent(k('1/2 марки 1913 года. Серебро.')).grams, 2.5);
  assert.strictEqual(fineContent(k('Монета 5 марок 1907')).grams, 25);
  assert.strictEqual(k('2 марки 1888 года').metal, 'silver');
  // другая страна, другой год, раздел другой страны — не Германия
  assert.strictEqual(k('монета 2 марки 1874 Финляндия, серебро').foreign, null);
  assert.strictEqual(k('Шведская серебряная монета 2 марки 1905').foreign, null);
  assert.strictEqual(k('1 марка 1961').foreign, null);
  assert.strictEqual(k('10 марок 1923 Польша').foreign, null);
  assert.strictEqual(parseCoin({ title: '1 марка 1890', sectionPath: 'Монеты › Европа Финляндия' }).foreign, null);
  assert.strictEqual(parseCoin({ title: '3 марки 1911', sectionPath: 'Монеты › Европа Германия 1871-1918' }).foreign.value, 3);
});
check('«С 20 копеек» — стартовая ставка, а не номинал', () => {
  // распродажи Kukarzinio: иностранная мелочь попадала в серебро как «20 копеек 1923»
  const d = parseCoin({ title: 'Данциг 10 пфеннигов, 1923. С 20 копеек. Распродажа коллекции. Смотрите другие лоты.', sectionPath: null });
  assert.strictEqual(d.denomKop, null);
  assert.notStrictEqual(d.metal, 'silver');
  assert.notStrictEqual(parseCoin({ title: 'Великобритания 1 фартинг, 1927. С 20 копеек. Распродажа коллекции.', sectionPath: null }).metal, 'silver');
  assert.strictEqual(parseCoin({ title: 'Старт 50 коп! 15 копеек 1925', sectionPath: null }).denomKop, 15);
  // настоящие 20 копеек остаются
  const k = parseCoin({ title: '20 копеек 1923. С 20 копеек. Распродажа коллекции.', sectionPath: null });
  assert.strictEqual(k.denomKop, 20);
  assert.strictEqual(k.metal, 'silver');
  assert.strictEqual(parseCoin({ title: 'С рубля! 20 копеек 1915 ВС', sectionPath: null }).denomKop, 20);
});
check('«копейки серебром» 1839–1848 — медь, а не серебро', () => {
  // ay.by 5032544116: «1/2 серебром 1840 СПМ» за 5 р. пришёл как серебро на 39 р. (вес придумала модель)
  const half = parseCoin({ title: '1/2 серебром 1840 СПМ', sectionPath: null });
  assert.strictEqual(half.metal, 'copper');
  assert.strictEqual(half.denomKop, 0.5);
  assert.strictEqual(half.isPrecious, false);
  assert.strictEqual(parseCoin({ title: '2 копейки серебром 1842 ЕМ', sectionPath: null }).metal, 'copper');
  assert.strictEqual(parseCoin({ title: '3 копейки серебром 1840', sectionPath: null, specs: { 'Металл': 'Серебро' } }).metal, 'copper');
  // настоящее серебро тех же лет не задето
  assert.strictEqual(parseCoin({ title: '20 копеек 1840 СПБ НГ серебро', sectionPath: null }).metal, 'silver');
  assert.strictEqual(parseCoin({ title: 'Рубль 1842 СПБ АЧ', sectionPath: null }).metal, 'silver');
});
check('история продаж: какие сделки из отзывов открывать', () => {
  const { historyCandidate } = require('./coins');
  assert.strictEqual(historyCandidate('С рубля без мц! 50 эскудо 1968 Португалия - Кабрал - серебро!'), true);
  assert.strictEqual(historyCandidate('3 марки 1911 Пруссия'), true); // серебро по таблице, слова «серебро» нет
  assert.strictEqual(historyCandidate('Шри-Ланка 10 рупий 2013'), false);
  assert.strictEqual(historyCandidate('Сертификат к монете 20 рублей 2008 серебро'), false);
  assert.strictEqual(historyCandidate('Копия 1 рубль 1924 серебро'), false);
});
check('расхождение лота с таблицей стандартов: считаем по таблице, отметка в разборе и карточке', () => {
  const { fineContent } = require('./coins/metal');
  const cm = require('./coins/market');
  const p = parseCoin({ title: 'Канада 1 доллар 1965 Вояжёр', sectionPath: null, description: 'Чистого серебра: 31,1 г' });
  assert.deepStrictEqual(p.contentMismatch, { table: 18.66, stated: 31.1, statedBasis: 'указано 31,1 г чистого металла' });
  assert.strictEqual(fineContent(p).grams, 18.66);
  const est = cm.assess({ parsed: p, price: 100, metal: { ...fineContent(p), pricePerG: 4.37, value: 81.5 } });
  assert.ok(cm.formatEstimateLines(est).some((l) => l.startsWith('⚠️ Расхождение: по лоту 31,1 г') && l.includes('по стандарту монеты 18,66 г')));
  // под «1 доллар США 1986+» бывает и унция, и памятный доллар 24,06 г: строка нестрогая, главнее текст лота
  const us = parseCoin({ title: 'США 1 доллар 1987 серебро Конституция', sectionPath: null, description: 'Вес 26,73 г. Проба 900' });
  assert.strictEqual(us.contentMismatch, undefined);
  assert.strictEqual(fineContent(us).grams, 24.06);
  assert.deepStrictEqual(fineContent(parseCoin({ title: 'США 1 доллар 1990 серебро Шагающая Свобода', sectionPath: null })), { metal: 'silver', grams: 31.1 });
  // совпадает с таблицей — отметки нет
  assert.strictEqual(parseCoin({ title: 'Канада 1 доллар 1965', sectionPath: null, description: 'Чистого серебра: 18,66 г' }).contentMismatch, undefined);
});
check('«без забоин», «отсутствуют… следы износа», «не чищена» — не дефект', () => {
  const { flagsFrom } = require('./coins/parse');
  // ay.by 5041988554, 5041988499: «⚠️ повреждения» по заверениям продавца
  assert.deepStrictEqual(flagsFrom('Канада 1 доллар 1977', 'Отсутствуют грубые дефекты, забоины или следы износа. Отчеканена в Оттаве.'), []);
  assert.deepStrictEqual(flagsFrom('Канада 1 доллар 1972', 'Отличное состояние, без забоин и следов обращения.'), []);
  assert.deepStrictEqual(flagsFrom('1 рубль 1924', 'Монета не чищена.'), []);
  assert.deepStrictEqual(flagsFrom('1 рубль 1924', 'Нет коробки, есть царапины.'), ['повреждения']);
  assert.deepStrictEqual(flagsFrom('1 рубль 1924 царапины', ''), ['повреждения']);
  assert.deepStrictEqual(flagsFrom('1 рубль 1924', 'Без коробки. Забоина на гурте.'), ['повреждения']);
  assert.deepStrictEqual(flagsFrom('1 рубль 1924', 'Без коробки, царапина на аверсе'), ['повреждения']);
  // «без мц» в заголовке — не отрицание дефекта
  assert.deepStrictEqual(flagsFrom('1 рубль 1898 без мц с отверстием', ''), ['отверстие']);
  assert.deepStrictEqual(flagsFrom('Полтинник 1924 без мц чищен', ''), ['чистка']);
  assert.deepStrictEqual(flagsFrom('С рубля без мц 1 рубль 1924 царапины', ''), ['повреждения']);
  assert.deepStrictEqual(flagsFrom('1 рубль 1924', 'Отсутствует сертификат, есть следы обращения'), ['повреждения']);
  assert.deepStrictEqual(flagsFrom('1 рубль 1924', 'Без грубых забоин'), []);
  assert.deepStrictEqual(flagsFrom('20 копеек 1925 чищеная', ''), ['чистка']);
});
check('СССР 20 копеек: 1930 — серебро, 1931 — никель, если серебро не указано', () => {
  const { fineContent } = require('./coins/metal');
  const c1930 = parseCoin({ title: '20 копеек 1930 года, СССР', sectionPath: null });
  assert.strictEqual(c1930.metal, 'silver');
  assert.strictEqual(fineContent(c1930).grams, 1.8);
  assert.strictEqual(parseCoin({ title: '20 копеек 1931 СССР', sectionPath: null }).metal, 'base');
  assert.strictEqual(parseCoin({ title: '15 копеек 1931 серебро', sectionPath: null }).metal, 'silver');
});
check('годы до/нашей эры и диапазон лет — не граммы', () => {
  // ay.by 2026-11-16: «Коммод 177-192 г.н.э Денарий серебро» считался лотом серебра на вес 192 г
  assert.strictEqual(parseCoin({ title: 'Коммод 177-192 г.н.э Денарий серебро Рим Римская империя', sectionPath: null }).weight, null);
  assert.strictEqual(parseCoin({ title: 'Драхма серебро 336-323 г. до н.э. Александр', sectionPath: null }).weight, null);
  assert.strictEqual(parseCoin({ title: 'Денарий серебро 200 г. н. э.', sectionPath: null }).weight, null);
  // настоящий вес по-прежнему читается
  assert.strictEqual(parseCoin({ title: 'Серебро лом 875 пр. 192 г', sectionPath: null }).weight.grams, 192);
  assert.strictEqual(parseCoin({ title: 'Серебро россыпь 150 г.', sectionPath: null }).weight.grams, 150);
});
check('перевыставленный лот: прошлые раунды в карточке', () => {
  const { roundsLine } = require('./coins');
  assert.strictEqual(roundsLine([]), null);
  const r1 = { ended_at: '2026-11-09T16:35:00Z', outcome: 'unsold', final_bids: 4, last_price: 50, reserve: 'not_met', start_price: 1 };
  assert.strictEqual(roundsLine([r1]), '🔁 Перевыставлен: 09.11 — 4 ставки до 50 р., мин. цена не пройдена');
  const r0 = { ended_at: '2026-11-02T16:35:00Z', outcome: 'unsold', final_bids: 0, bids: 0, last_price: 60, start_price: 60 };
  assert.strictEqual(roundsLine([r0, r1]), '🔁 Перевыставлен (2-й раз): 09.11 — 4 ставки до 50 р., мин. цена не пройдена; 02.11 — без ставок, старт 60 р.');
  assert.ok(roundsLine([{ ended_at: '2026-11-09T16:35:00Z', outcome: 'sold', final_price: 120, final_bids: 7 }]).includes('продан за 120 р. (видимо, не выкупили)'));
});
check('вес металла без таблицы: когда искать, ключ кэша, проба из Numista', () => {
  const { needsLookup, cacheKey } = require('./coins/content');
  const { fineFromType } = require('./coins/numista');
  // серебро без таблицы и без веса в тексте — искать; с унцией в тексте, по таблице, копия, сертификат — нет
  const niue = parseCoin({ title: '1 доллар 2015 Ниуэ Год козы серебро', sectionPath: null });
  assert.strictEqual(needsLookup(niue), true);
  assert.strictEqual(needsLookup(parseCoin({ title: '240 франков Конго 2013 Серебро 999.Унция', sectionPath: null })), false);
  assert.strictEqual(needsLookup(parseCoin({ title: '1 рубль 1898 АГ', sectionPath: null })), false);
  assert.strictEqual(needsLookup(parseCoin({ title: '1 доллар 2015 Ниуэ серебро копия', sectionPath: null })), false);
  assert.strictEqual(needsLookup(parseCoin({ title: '2 копейки 1964', sectionPath: null })), false);
  // ключ: страна известна — номинал и год; неизвестна — заголовок
  assert.strictEqual(cacheKey(parseCoin({ title: '10 злотых 1995 серебро', sectionPath: null }), 'x'), 'content|silver|Польша|злотый|10|1995');
  assert.strictEqual(cacheKey(niue, '1 доллар 2015 Ниуэ «Год козы», серебро!'), 'content|silver|1 доллар 2015 ниуэ год козы серебро');
  // проба из состава Numista
  assert.strictEqual(fineFromType({ weight: 31.1, composition: { text: 'Silver (.999)' } }, 'silver'), 31.07);
  assert.strictEqual(fineFromType({ weight: 28.28, composition: { text: 'Silver (.925)' } }, 'silver'), 26.16);
  assert.strictEqual(fineFromType({ weight: 7.98, composition: { text: 'Gold (.9167)' } }, 'gold'), 7.32);
  assert.strictEqual(fineFromType({ weight: 20, composition: { text: 'Silver 900' } }, 'silver'), 18);
  assert.strictEqual(fineFromType({ weight: 20, composition: { text: 'Silver' } }, 'silver'), null);
  assert.strictEqual(fineFromType({ weight: 20, composition: { text: 'Copper-nickel' } }, 'silver'), null);
});

// листы 2×2 для модели — асинхронно (sharp)
const sheetsCheck = (async () => {
  const { toSheets } = require('./coins/vision');
  let sharp = null;
  try { sharp = require('sharp'); } catch { return; } // без sharp склейки нет — проверять нечего
  const img = async (w, h) => ({ data: (await sharp({ create: { width: w, height: h, channels: 3, background: '#888' } }).jpeg().toBuffer()).toString('base64'), mediaType: 'image/jpeg' });
  const five = await Promise.all([img(650, 650), img(700, 690), img(1280, 960), img(400, 600), img(650, 650)]);
  const r = await toSheets(five);
  assert.strictEqual(r.sheets, true);
  assert.strictEqual(r.images.length, 2); // 4 в лист + 1 отдельно
  const meta = await sharp(Buffer.from(r.images[0].data, 'base64')).metadata();
  assert.deepStrictEqual([meta.width, meta.height], [1536, 1536]);
  const two = await toSheets(five.slice(0, 2));
  const m2 = await sharp(Buffer.from(two.images[0].data, 'base64')).metadata();
  assert.deepStrictEqual([two.images.length, m2.width, m2.height], [1, 1536, 768]);
  assert.strictEqual((await toSheets(five.slice(0, 1))).sheets, false);
})().then(() => { passed++; console.log('  ok  листы 2×2: 5 фото → 2 картинки, 2 фото → одна 1536×768'); },
  (e) => { console.error('  FAIL листы 2×2: ' + e.message); process.exitCode = 1; });

sheetsCheck.then(() => console.log(`\nпроверок пройдено: ${passed}`));
