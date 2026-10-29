// Офлайн-проверка разбора заголовков/характеристик и ключей группировки для рыночной сводки.
// Сети и базы не требует. Запуск: node test-market.js

const assert = require('assert');
const { parseModel, describe, groupKeys } = require('./market');
const { parseDetails, toGb, normalizeSsd, screenSize, memoryFromText } = require('./details');

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + ': ' + e.message);
    process.exitCode = 1;
  }
};

console.log('единицы памяти:');
check('«8 ГБ» оперативной — это 8, а не 8192', () => {
  assert.strictEqual(toGb('8 ГБ', 'ram'), 8);
  assert.strictEqual(toGb('4 ГБ', 'ram'), 4);
  assert.strictEqual(toGb('Более 64 ГБ', 'ram'), 64);
});
check('накопитель: «1 ТБ», «1000 Гб», «1024» — один ключ', () => {
  assert.strictEqual(toGb('1 ТБ', 'ssd'), 1024);
  assert.strictEqual(toGb('1000 Гб', 'ssd'), 1024);
  assert.strictEqual(toGb('2000 ГБ и более', 'ssd'), 2048);
  assert.strictEqual(toGb('128 ГБ и менее', 'ssd'), 128);
  assert.strictEqual(normalizeSsd(1000), 1024);
  assert.strictEqual(normalizeSsd(512), 512);
});
check('память из заголовка «16/1tb»', () => {
  assert.deepStrictEqual(memoryFromText('MacBook Pro 16 2019 i9 16/1tb'), { ramGb: 16, ssdGb: 1024 });
  assert.deepStrictEqual(memoryFromText('Air M1 8/256'), { ramGb: 8, ssdGb: 256 });
});
check('класс диагонали', () => {
  assert.strictEqual(screenSize(13.3), '13');
  assert.strictEqual(screenSize(15.4), '15');
  assert.strictEqual(screenSize(16.1), '16');
  assert.strictEqual(screenSize(11.6), '11');
  assert.strictEqual(screenSize(null), null);
});

console.log('заголовки:');
check('линейка, чип, год, экран', () => {
  const m = parseModel('MacBook Pro 16 2019 i9 16/1tb');
  assert.strictEqual(m.line, 'pro');
  assert.strictEqual(m.chip, 'Intel');
  assert.strictEqual(m.year, '2019');
  assert.strictEqual(m.size, '16');
});
check('номер модели Apple заполняет пропуски', () => {
  const m = parseModel('Ноутбук MacBook 13 pro 2020 A2251');
  assert.strictEqual(m.line, 'pro');
  assert.strictEqual(m.size, '13');
  const m2 = parseModel('Ноутбук Apple A2141');
  assert.deepStrictEqual([m2.line, m2.size, m2.year], ['pro', '16', '2019']);
});
check('«airpods pro» и «iphone 15 pro» в заголовке — не линейка', () => {
  assert.strictEqual(parseModel('MacBook Air 13 M1 + AirPods Pro').line, 'air');
  assert.strictEqual(parseModel('Продам ноутбук 2015, обмен на iPhone 15 Pro').line, undefined);
});
check('кириллица', () => {
  assert.strictEqual(parseModel('Макбук эйр 13 M2 8/256').line, 'air');
  assert.strictEqual(parseModel('Макбук про 14 M1 Pro').line, 'pro');
});

console.log('состояние:');
check('«как новый» и «новый аккумулятор» — б/у', () => {
  assert.strictEqual(parseDetails('MacBook Pro 13 состояние как новый', {}, 'Новый аккумулятор').condition, 'used');
  assert.strictEqual(parseDetails('MacBook Pro 15 2011', {}, 'Новый АКБ, зарядное в комплекте').condition, null);
});
check('характеристика «Состояние» главнее текста', () => {
  assert.strictEqual(parseDetails('MacBook Air M3 новый', { Состояние: 'Б/у' }).condition, 'used');
  assert.strictEqual(parseDetails('MacBook Air M3', { Состояние: 'Новое' }).condition, 'new');
});
check('запечатанный по описанию — новый', () => {
  assert.strictEqual(parseDetails('MacBook Air M4', {}, 'Запечатан, не активирован').condition, 'new');
});

console.log('ключи группировки:');
check('экран входит в ключ: Pro M1 Pro 14" и 16" — разные группы', () => {
  const k14 = groupKeys(describe('MacBook Pro 14 M1 Pro 16/512', { screenIn: 14 })).map((k) => k.key);
  const k16 = groupKeys(describe('MacBook Pro 16 M1 Pro 16/512', { screenIn: 16 })).map((k) => k.key);
  assert.strictEqual(k14[0], 'pro|M1 Pro|14"|16/512');
  assert.strictEqual(k16[0], 'pro|M1 Pro|16"|16/512');
  assert.ok(k14.includes('pro|M1 Pro') && k16.includes('pro|M1 Pro'), 'общий уровень без экрана остаётся');
});
check('Intel с годом: год+экран; без года — только линейка+Intel', () => {
  assert.strictEqual(groupKeys(describe('MacBook Pro 15 2019 i7 16/512', null))[0].key, 'pro|y2019|15"|16/512');
  assert.strictEqual(groupKeys(describe('MacBook Pro Retina i7 16/512', null))[0].key, 'pro|intel');
  assert.deepStrictEqual(groupKeys(describe('MacBook Pro Retina i7', null)).map((k) => k.key), ['pro|intel']);
  assert.deepStrictEqual(groupKeys(describe('MacBook Pro 15 2019 i7 16/512', null)).map((k) => k.key),
    ['pro|y2019|15"|16/512', 'pro|y2019|15"', 'pro|intel|15"', 'pro|y2019', 'pro|intel']);
});
check('старые строки с 8192 ГБ читаются как 8', () => {
  const d = describe('MacBook Air M1', { ramGb: 8192, ssdGb: 1000, screenIn: 13.3 });
  assert.strictEqual(d.ramGb, 8);
  assert.strictEqual(d.ssdGb, 1024);
  assert.strictEqual(groupKeys(d)[0].label, 'MacBook Air M1 13" 8 ГБ/1 ТБ');
});
check('Apple Silicon без экрана: есть уровень чип+память', () => {
  const keys = groupKeys(describe('MacBook Air M1 8/256', null)).map((k) => k.key);
  assert.deepStrictEqual(keys, ['air|M1|8/256', 'air|M1', 'air|silicon-base']);
});
check('нет уровня «вся линейка»: M1 Max не сравнивается с Intel 2015', () => {
  const keys = groupKeys(describe('MacBook Pro 16 M1 Мах 32/1 tb', null)).map((k) => k.key);
  assert.ok(keys.every((k) => !k.endsWith('|*') && k !== '*'), keys.join(','));
  assert.strictEqual(keys[0], 'pro|M1 Max|16"|32/1024');
  assert.strictEqual(keys[keys.length - 1], 'pro|silicon-promax');
  assert.deepStrictEqual(groupKeys(describe('Ноутбук', null)), []);
});
check('M1 Max без слова Pro в заголовке — это Pro, и не сравнивается с базовым M1', () => {
  const d = describe('MacBook M1 Max 16 32/512gb', { chip: 'M1 Max', ramGb: 32, ssdGb: 512, screenIn: 16.2 });
  assert.strictEqual(d.line, 'pro');
  const keys = groupKeys(d).map((k) => k.key);
  assert.ok(!keys.some((k) => k.includes('unknown') || k.endsWith('silicon-base')), keys.join(','));
  assert.deepStrictEqual(keys, ['pro|M1 Max|16"|32/512', 'pro|M1 Max|16"', 'pro|M1 Max|32/512', 'pro|M1 Max', 'pro|silicon-max|16"', 'pro|silicon-max', 'pro|silicon-promax']);
  // базовый чип без линейки и с 13" остаётся без линейки, но в своём классе
  const base = groupKeys(describe('MacBook M1 8/256', { chip: 'M1', screenIn: 13.3 })).map((k) => k.key);
  assert.strictEqual(base[base.length - 1], 'unknown|silicon-base');
  // 14" и 16" — только Pro, 11" — только Air
  assert.strictEqual(describe('MacBook 14 M3', null).line, 'pro');
  assert.strictEqual(describe('MacBook 11 2015', null).line, 'air');
});
check('подписи групп', () => {
  assert.strictEqual(groupKeys(describe('MacBook Pro 16 2019 i9 16/1tb', null))[0].label, 'MacBook Pro 2019 16" 16 ГБ/1 ТБ');
});

console.log('батарея, год, корпус, флаги:');
const { batteryCyclesFrom, batteryHealthFrom, yearFrom, bodyConditionFrom, flagsFrom, formatDetailsLines } = require('./details');
check('циклы в разных формулировках', () => {
  assert.strictEqual(batteryCyclesFrom('батарея 530 циклов, ещё огонь'), 530);
  assert.strictEqual(batteryCyclesFrom('Состояние аккумулятора: емкость: 83%, количество циклов перезарядки: 335.'), 335);
  assert.strictEqual(batteryCyclesFrom('Количество циклов зарядки аккумулятора 53'), 53);
  assert.strictEqual(batteryCyclesFrom('всего 1 цикл'), 1);
  assert.strictEqual(batteryCyclesFrom('держит заряд долго'), null);
});
check('ёмкость батареи в процентах', () => {
  assert.strictEqual(batteryHealthFrom('Состояние аккумулятора: емкость: 83%, циклов 335'), 83);
  assert.strictEqual(batteryHealthFrom('здоровье аккумулятора 91 %'), 91);
  assert.strictEqual(batteryHealthFrom('батарея держит 8 часов, 100% рабочий'), null);
  assert.strictEqual(batteryHealthFrom('заряд держит 90% дня'), null);
});
check('год: заголовок, номер модели, описание', () => {
  assert.strictEqual(yearFrom('MacBook Pro 13 2019', ''), '2019');
  assert.strictEqual(yearFrom('MacBook Air A1466', ''), '2017');
  assert.strictEqual(yearFrom('MacBook Pro 13', 'Ноутбук 2018 года, обслужен'), '2018');
  assert.strictEqual(yearFrom('MacBook Pro 13', 'mid 2015, всё работает'), '2015');
  assert.strictEqual(yearFrom('MacBook Air M1', 'куплен за 2000 рублей'), null);
});
check('состояние корпуса', () => {
  assert.strictEqual(bodyConditionFrom('', 'Состояние идеальное, без царапин и сколов'), 'ideal');
  assert.strictEqual(bodyConditionFrom('', 'Есть потёртости на корпусе и небольшой скол'), 'marks');
  assert.strictEqual(bodyConditionFrom('', 'не включается после залития', ['дефект']), 'damaged');
  assert.strictEqual(bodyConditionFrom('', 'продаю, звоните'), null);
});
check('флаги комплекта, торга, раскладки', () => {
  const f = flagsFrom({}, 'MacBook Air M1', 'Зарядка и коробка в комплекте, чек есть. Торг уместен. Гравировка русская.');
  assert.deepStrictEqual(f, ['зарядка', 'коробка', 'чек/гарантия', 'гравировка RU', 'торг']);
  const g = flagsFrom({}, 'MacBook Air M1', 'Без зарядки, без коробки. Без торга.');
  assert.deepStrictEqual(g, []);
});
check('клавиатура-бабочка по линейке и году, не для Apple Silicon', () => {
  assert.ok(flagsFrom({}, 'MacBook Pro 13 2017', '').includes('клавиатура-бабочка'));
  assert.ok(flagsFrom({}, 'MacBook Air 2019 A1932', '').includes('клавиатура-бабочка'));
  assert.ok(!flagsFrom({}, 'MacBook Pro 13 2015', '').includes('клавиатура-бабочка'));
  assert.ok(!flagsFrom({}, 'MacBook Air M1 2020', '', { chip: 'M1' }).includes('клавиатура-бабочка'));
});
check('слабая батарея и экран без Retina из характеристик', () => {
  const f = flagsFrom({ 'Время автономной работы': '1-2 часа', 'Разрешение экрана': '1440 x 900' }, 'MacBook Air 13', '');
  assert.ok(f.includes('батарея слабая') && f.includes('без Retina'));
  assert.ok(flagsFrom({}, '', 'батарея 950 циклов').includes('батарея слабая'));
});
check('год из описания попадает в группу', () => {
  const d = describe('MacBook Pro 13', { chip: 'Intel', year: '2019', screenIn: 13.3 });
  assert.strictEqual(d.year, '2019');
  assert.ok(groupKeys(d).map((k) => k.key).includes('pro|y2019|13"'));
});
check('строки карточки', () => {
  const lines = formatDetailsLines(parseDetails('MacBook Pro 13 2017', { 'Состояние': 'Б/у', 'Процессор': 'Intel Core i5', 'Оперативная память': '16 ГБ', 'Ёмкость накопителя': '512 Гб' },
    'Состояние отличное, без сколов. Батарея около 200 циклов, 88%. В комплекте зарядка. Торг.'));
  assert.deepStrictEqual(lines, [
    '♻️ Б/у · корпус в идеале',
    '⚙️ Intel Core i5 · 16 ГБ · SSD 512 ГБ · 2017',
    '🔋 ~200 циклов · 88%',
    '⌨️ Клавиатура-бабочка (2016–2019): проверить залипание клавиш',
    '📦 зарядка',
    '💬 торг',
  ]);
});

console.log(`\nпроверок пройдено: ${passed}`);
