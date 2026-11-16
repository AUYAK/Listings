// Оценка монеты по всем источникам — общая для ay.by (coins.js), Kufar (listings.js) и оценки по фото (poll.js):
// архивы проходов и Numista (coin_catalog), наша база (медиана похожих, кэш на 5 минут), стоимость металла по НБРБ.
// Возвращает результат cmarket.assess; сохранение оценки в базу — на вызывающем.
const cstore = require('./store');
const cmarket = require('./market');
const numista = require('./numista');
const { metalValueLive } = require('./metal');
const { resolveContent, needsLookup } = require('./content');

const ROWS_TTL_MS = 5 * 60e3;
let rowsCache = { at: 0, rows: [] };

async function coinRows() {
  if (Date.now() - rowsCache.at > ROWS_TTL_MS) rowsCache = { at: Date.now(), rows: await cstore.getCoinRows(null).catch(() => rowsCache.rows) };
  return rowsCache.rows;
}

// parsed — разбор coins/parse.js (состояние в parsed.grade); price — цена лота или null;
// excludeId — id самого лота, чтобы он не попал в свою же медиану; fixedPrice — фиксированная цена, а не ставка;
// title/description — текст лота: по нему ищется вес драгметалла, если таблиц и веса в тексте нет (coins/content.js)
async function assessCoin({ parsed, price = null, excludeId = null, fixedPrice = false, title = null, description = null }) {
  if (title && needsLookup(parsed)) {
    const c = await resolveContent(parsed, title, description || '').catch((err) => { console.warn(`[Вес] ${err.message}`); return null; });
    if (c) parsed = { ...parsed, content: c };
  }
  const rows = await coinRows();
  // источники показываются раздельно; ориентир — свежие продажи нашей базы, иначе самый низкий из источников
  // с точным состоянием; стоимость металла — нижняя планка при любом состоянии
  const { catalogs, type } = await cstore.getCatalogs(parsed).catch((err) => { console.warn(`[Catalog] ${err.message}`); return { catalogs: [], type: null }; });
  if (parsed.isPrecious && !parsed.slab && !catalogs.some((c) => c.source === 'numista')) {
    const n = await numista.lookup(parsed).catch((err) => { console.warn(`[Numista] ${err.message}`); return null; });
    if (n) catalogs.push(n);
  }
  const metal = await metalValueLive(parsed).catch((err) => { console.warn(`[Metal] ${err.message}`); return null; });
  return cmarket.assess({ parsed, price, rows, excludeId, catalogs, coinType: type, metal, fixedPrice });
}

module.exports = { assessCoin };
