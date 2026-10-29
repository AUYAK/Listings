// Список отслеживаемых ссылок на www.kufar.by.
// Каждая ссылка — это сохранённый поиск/категория Kufar.
//
// key     — уникальный, не менять после запуска: по нему в БД отличаются объявления разных ссылок.
// chatIds — кому слать уведомления по этой ссылке, если чат ни разу не открывал /settings в боте;
//           null = TELEGRAM_CHAT_IDS из .env. Чаты, открывавшие /settings, получают только то,
//           что отметили галочками.
// optIn   — true: без legacy-рассылки вообще, получают только те, кто отметил категорию в /settings.
//           Объявления при этом всё равно собираются в базу.
// market  — true: в уведомление добавляется рыночная сводка (медиана по похожим объявлениям,
//           выше/ниже рынка), а ушедшие с сайта объявления помечаются как проданные
//           (см. market.js и checkSoldListings в listings.js).

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
    key: 'macbook',
    name: 'MacBook',
    emoji: '💻',
    url: 'https://www.kufar.by/l/noutbuki/nb~apple/bez-posrednikov?sort=lst.d',
    chatIds: null,
    optIn: true,
    market: true,
  },
  {
    // Монеты на Kufar: обычный Kufar-монитор (listings.js). domain='coins' включает фильтр: уведомления
    // только по серебру без копий и подборок (разбор заголовка через coins/parse.js). Данных о состоянии
    // у Kufar нет, оценка рынка для этой категории пока не строится.
    key: 'coins-kufar',
    name: 'Монеты (Kufar)',
    emoji: '🪙',
    domain: 'coins',
    url: 'https://www.kufar.by/l?cat=4170&clt=1&sort=lst.d',
    chatIds: null,
    optIn: true,
    trackSold: true, // исчезнувшие объявления помечаются проданными (как у MacBook), без рыночной сводки MacBook
  },
  {
    // Аукцион ay.by, ведёт отдельный процесс coins.js (source='ayby'); listings.js этот монитор пропускает.
    // sections: корневые разделы; discover — регулярки по уровням вложенности, по которым
    // на лету находятся подразделы (правители → «Серебро (...)»). Нужные подразделы СССР перечислены явно.
    key: 'coins-silver',
    name: 'Монеты (серебро)',
    emoji: '🪙',
    source: 'ayby',
    domain: 'coins',
    url: 'https://coins.ay.by/',
    chatIds: null,
    optIn: true,
    silverOnly: true,
    sections: [
      { url: 'https://coins.ay.by/rossiya/rossijskaya-imperiya-do-1917/', discover: [/^\d{4}-\d{4}/, /^Серебро/] },
      { url: 'https://coins.ay.by/sssr/1921-1941/', discover: [/^(10 копеек|15 копеек|20 копеек|Полтинники|Рубли)$/] },
    ],
  },
];

module.exports = { MONITORS };
