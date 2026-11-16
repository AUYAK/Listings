const { parseCoin, ussrVariety } = require('./coins/parse');

// «UNC», «aUNC», «анц», «штемпельный блеск», «люкс», «BU», «MS-64», «PL 63», слаб — но не «штемпель 1.2» (разновидность)
const USSR_UNC = /(?<!\p{L})[aа]?\s?unc(?!\p{L})|(?<!\p{L})[aа]?анц(?!\p{L})|штемпельн\p{L}*\s+блеск|штемп\.\s*блеск|(?<!\p{L})люкс|(?<!\p{L})bu(?!\p{L})|(?<!\p{L})(?:ms|pl)[-\s]?\d{2}(?!\d)|(?<!\p{L})(?:мини-?)?слаб(?:е|ы|а)?(?!\p{L})|(?<!\p{L})(?:ннр|ngc|pcgs)(?!\p{L})/iu;

// Список отслеживаемых ссылок на www.kufar.by.
// Каждая ссылка — это сохранённый поиск/категория Kufar.
//
// key     — уникальный, не менять после запуска: по нему в БД отличаются объявления разных ссылок.
// chatIds — кому слать уведомления по этой ссылке, если чат ни разу не открывал /settings в боте;
//           null = TELEGRAM_CHAT_IDS из .env. Чаты, открывавшие /settings, получают только то,
//           что отметили галочками.
// optIn   — true: без legacy-рассылки вообще, получают только те, кто отметил категорию в /settings.
//           Объявления при этом всё равно собираются в базу.
// trackSold — true: ушедшие с сайта объявления перепроверяются и помечаются проданными
//           (checkSoldListings в listings.js).
// ay.by (coins.js), дополнительно:
// sellers  — вместо разделов страницы «Аукционы продавца» (все страницы по 100 лотов); новые лоты этих продавцов
//            ещё и ловятся лентой новых лотов за минуты.
// feed     — true: брать подходящие лоты (металл из metals, страна из countries) и из ленты новых лотов всех монетных
//            разделов coins.ay.by/new/ (раз в COINS_FEED_INTERVAL_MS), а не только из своих разделов.
// notify   — false: только собирать лоты и итоги торгов в базу (своя история цен), без уведомлений;
//            такие мониторы не показываются в /settings.
// photos   — false: не сохранять фото проданных лотов на диск.
// pages    — сколько страниц раздела смотреть за цикл (по умолчанию COINS_PAGES).
// titleFilter — сохранять только карточки, заголовок которых подходит (остальные пропускаются целиком).
// cardMetals — true: из карточек списка брать только монеты из metals (металл — по строке карточки «Серебро, 1799»,
//            это поле «Металл» лота, иначе по заголовку), без копий; остальные карточки не сохраняются.
// deep     — true: кроме первых страниц за цикл, раз в сутки по кусочку пройти все страницы разделов (только
//            карточки, страницы лотов дочитываются потом) — чтобы не терять лоты, выставленные до запуска.

// Все монетные разделы ay.by, кроме «Копии, новоделы». Серебро и золото лежат везде: русско-финские и польские
// — у правителей Империи, талеры — в Европе, «серебро на вес» — в сборных лотах, брак — отдельным разделом.
const AYBY_ALL = [
  'rossiya', 'sssr', 'belarus-posle-1991', 'evropa', 'vkl-i-rech-pospolitaya-do-1795', 'antika-i-srednevekove',
  'amerika', 'aziya', 'afrika', 'avstraliya-i-okeaniya', 'sbornye-loty-kollekcii', 'defective', 'drugoe',
].map((s) => ({ url: `https://coins.ay.by/${s}/` }));

const MONITORS = [
  {
    key: 'iphone-minsk',
    name: 'iPhone (Минск)',
    emoji: '📱',
    url: 'https://www.kufar.by/l/r~minsk/mobilnye-telefony/mt~apple/bez-posrednikov?prc=r%3A0%2C100000000000&sort=lst.d',
    chatIds: null,
  },
  {
    key: 'kompyutery-minsk',
    name: 'Компьютеры (Минск)',
    emoji: '🖥️',
    url: 'https://www.kufar.by/l/r~minsk/kompyutery/bez-posrednikov?ar=v.or%3A22%2C23%2C24%2C25%2C26%2C27%2C28%2C29%2C30&sort=lst.d',
    chatIds: null,
  },
  {
    // Монеты на Kufar: обычный Kufar-монитор (listings.js). domain='coins' включает фильтр: уведомления
    // только по серебру и золоту без копий и подборок (разбор заголовка через coins/parse.js). Состояния
    // у Kufar нет, поэтому ориентир в основном — стоимость металла в монете.
    key: 'coins-kufar',
    name: 'Монеты (Kufar)',
    emoji: '🪙',
    domain: 'coins',
    url: 'https://www.kufar.by/l?cat=4170&clt=1&sort=lst.d',
    chatIds: null,
    optIn: true,
    trackSold: true, // исчезнувшие объявления помечаются проданными
  },
  {
    // Аукцион ay.by, ведёт отдельный процесс coins.js (source='ayby'); listings.js этот монитор пропускает.
    // Серебро всех стран и периодов из всех разделов (AYBY_ALL), копии не берутся; новые лоты — ещё и из ленты (feed).
    // У иностранных и памятных монет ориентир — в основном стоимость металла (coins/metal.js, текст лота).
    key: 'coins-silver',
    name: 'Монеты (серебро)',
    emoji: '🪙',
    source: 'ayby',
    domain: 'coins',
    url: 'https://coins.ay.by/',
    chatIds: null,
    optIn: true,
    metals: ['silver'],
    cardMetals: true,
    deep: true,
    feed: true,
    sections: AYBY_ALL,
  },
  {
    // Золото всех стран из всех разделов (сквозной раздел ay.by «Золото» — только лоты с этой пометкой, его мало).
    // Золото торгуется около металла, поэтому ориентир — содержание золота (coins/metal.js: таблицы и текст лота),
    // для Империи и СССР ещё и архив проходов.
    // countries (регулярки по пути раздела лота) — если понадобится снова ограничить страны.
    key: 'coins-gold',
    name: 'Монеты (золото)',
    emoji: '🥇',
    source: 'ayby',
    domain: 'coins',
    url: 'https://coins.ay.by/topic.phtml?f=1&ti1=6',
    chatIds: null,
    optIn: true,
    metals: ['gold'],
    cardMetals: true,
    deep: true,
    feed: true,
    sections: AYBY_ALL,
  },
  {
    // Продавцы, которые распродают коллекции «с рубля» / «с 20 копеек» и продают россыпь на вес: у них опытные
    // перекупщики берут товар одной ставкой. Их лоты лежат и в разделах, которые мы не сканируем (мир, Германия).
    // Если лот ведёт и монитор раздела, карточка всё равно приходит один раз. id — из ссылки whoiswho.phtml?id=N.
    key: 'coins-sellers',
    name: 'Монеты (распродажи продавцов)',
    emoji: '🧺',
    source: 'ayby',
    domain: 'coins',
    url: 'https://ay.by/',
    chatIds: null,
    optIn: true,
    metals: ['silver', 'gold'],
    sellers: [
      { id: '8530331', nick: 'Kukarzinio' },   // «С 20 копеек. Распродажа коллекции»
      { id: '8845195', nick: 'Дядя Гиляй' },   // старые монеты и медали «с рубля»
      { id: '8472074', nick: 'Oldboy' },       // «Продажа коллекции с 1 рубля!»
      { id: '741446', nick: 'Знаток' },        // россыпь на вес, «Империя 73 шт»
      { id: '6332437', nick: 'onos' },         // 1100+ лотов, «купить сейчас» около рынка разбирают за часы
      { id: '33853463', nick: 'DimaMinsk' },   // аукционы с рубля
    ],
  },
  {
    // Медь, бронза и мельхиор СССР 1921–1958: среди копеечных на вид монет есть дорогие годы (15 коп 1935 — ~6,5 тыс. ₽
    // в средней сохранности, лот за 12 р. без ставок). Ориентир — архив gdenashel (load-catalog.js --only sssr);
    // без ориентира лот только сохраняется. Серебро тех же разделов ведёт coins-silver.
    key: 'coins-ussr-base',
    name: 'СССР 1921–1958 (медь, мельхиор)',
    emoji: '🥉',
    source: 'ayby',
    domain: 'coins',
    url: 'https://coins.ay.by/sssr/',
    chatIds: null,
    optIn: true,
    metals: ['copper', 'base'],
    sections: [{ url: 'https://coins.ay.by/sssr/1921-1941/' }, { url: 'https://coins.ay.by/sssr/1942-1958/' }],
  },
  {
    // Сбор цен без уведомлений: серебряные марки Германии 1871–1945 (в том числе в слабах ННР/NGC) —
    // через 1–2 месяца хватит своих итогов торгов, чтобы включить уведомления (убрать notify: false).
    key: 'coins-germany',
    name: 'Монеты Германии 1871–1945 (сбор цен)',
    emoji: '🇩🇪',
    source: 'ayby',
    domain: 'coins',
    url: 'https://coins.ay.by/evropa/germaniya/',
    chatIds: null,
    optIn: true,
    notify: false,
    photos: false,
    pages: 2,
    sections: [{ url: 'https://coins.ay.by/evropa/germaniya/1871-1918/' }, { url: 'https://coins.ay.by/evropa/germaniya/1919-1945/' }],
  },
  {
    // Сбор цен без уведомлений: советские монеты 1961–1991 в UNC для погодовки (их отбирают и продают по 15–25 р.)
    // и монеты из таблицы разновидностей (parse.ussrVariety: 20 коп. 1991, 5 и 10 коп. 1990, перепутки, редкие годы) —
    // посмотреть, сколько их и по каким ценам, прежде чем проверять букву и цвет по фото автоматически.
    // Раздел огромный, поэтому сохраняются только такие лоты (titleFilter).
    key: 'coins-ussr-unc',
    name: 'СССР 1961–1991: UNC и разновидности (сбор цен)',
    emoji: '🎖',
    source: 'ayby',
    domain: 'coins',
    url: 'https://coins.ay.by/sssr/1961-1991/',
    chatIds: null,
    optIn: true,
    notify: false,
    photos: false,
    pages: 2,
    titleFilter: { test: (title) => USSR_UNC.test(title) || Boolean(ussrVariety(parseCoin({ title, sectionPath: null }))) },
    sections: [{ url: 'https://coins.ay.by/sssr/1961-1991/' }],
  },
];

module.exports = { MONITORS };
