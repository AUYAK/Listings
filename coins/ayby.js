// Скрапер ay.by: разделы, карточки списка, страница лота.
// Страницы ay.by подключают Prototype.js, который подменяет методы массивов (filter/map),
// поэтому внутри page.evaluate только обычные циклы.

const LIST_WAIT = '.item-type-card__card, .b-empty, h1';
const NAV_TIMEOUT = parseInt(process.env.COINS_NAV_TIMEOUT_MS || '30000', 10);

// ay.by иногда отдаёт вместо страницы JS-заглушку «Verification» (проверка на бота). Разбирать её нельзя:
// получится пустой лот с «истёкшим» таймером. Бросаем ошибку с «HTTP 403», чтобы циклы coins.js остановились.
// В обычном браузере заглушка сама переходит на запрошенную страницу за несколько секунд — ждём до 10 с.
async function assertNotVerification(page) {
  for (let i = 0; i < 10 && (await page.title().catch(() => '')) === 'Verification'; i++) await new Promise((r) => setTimeout(r, 1000));
  if ((await page.title().catch(() => '')) === 'Verification') throw new Error('HTTP 403: ay.by verification page (bot check)');
}

// Ошибки, после которых продолжать цикл бессмысленно: нас ограничивают или сайт не отвечает
function isBlocked(err) {
  return /HTTP 429|HTTP 403|Timeout \d+ms exceeded|interrupted by another navigation|net::ERR_/.test(err && err.message || '');
}

function parseTimeLeft(text) {
  // «6 д», «5 ч», «23 мин», «1 д 3 ч»
  const t = (text || '').toLowerCase();
  let ms = 0, any = false;
  const d = t.match(/(\d+)\s*д/); if (d) { ms += parseInt(d[1], 10) * 86400e3; any = true; }
  const h = t.match(/(\d+)\s*ч/); if (h) { ms += parseInt(h[1], 10) * 3600e3; any = true; }
  const m = t.match(/(\d+)\s*м(?:ин)?(?![\p{L}])/u); if (m) { ms += parseInt(m[1], 10) * 60e3; any = true; } // «24 м», «23 мин»
  const s = t.match(/(\d+)\s*с(?:ек)?(?![\p{L}])/u); if (s) { ms += parseInt(s[1], 10) * 1e3; any = true; }
  return any ? ms : null;
}

function parsePrice(text) {
  if (!text) return null;
  const m = String(text).replace(/\s| /g, '').match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

// Подразделы страницы раздела (например, «Серебро (копейки)» у Николая II)
async function discoverSubsections(page, sectionUrl, textRe) {
  await page.goto(sectionUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForSelector(LIST_WAIT, { timeout: 10000 }).catch(() => {});
  const links = await page.evaluate((base) => {
    const out = [];
    const as = document.querySelectorAll('a[href]');
    for (let i = 0; i < as.length; i++) {
      const a = as[i];
      const href = a.href;
      if (href.indexOf(base) === 0 && href.length > base.length && href.indexOf('#') < 0 && href.indexOf('?') < 0) {
        out.push({ text: (a.textContent || '').replace(/\s+/g, ' ').trim(), href });
      }
    }
    return out;
  }, sectionUrl);
  const seen = new Set();
  return links.filter((l) => textRe.test(l.text) && !seen.has(l.href) && seen.add(l.href));
}

// Карточки одной страницы списка
async function scanListPage(page, url) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  if (resp && resp.status() === 404) return [];
  await assertNotVerification(page);
  await page.waitForSelector(LIST_WAIT, { timeout: 10000 }).catch(() => {});
  const cards = await page.evaluate(() => {
    const out = [];
    const nodes = document.querySelectorAll('.item-type-card__card');
    for (let i = 0; i < nodes.length; i++) {
      const c = nodes[i];
      const fav = c.querySelector('.item-type-card__fav');
      const link = c.querySelector('a.item-type-card__link');
      const href = link ? link.href : '';
      const idm = href.match(/-(\d{6,})\.html/);
      const id = (fav && fav.getAttribute('data-element')) || (idm ? idm[1] : null);
      if (!id || !href) continue;
      const titleEl = c.querySelector('.item-type-card__title');
      const timeEl = c.querySelector('.item-type-card__time');
      const priceEl = c.querySelector('.item-type-card__info strong');
      const bidsEl = c.querySelector('.item-type-list__details__lots');
      const authorEl = c.querySelector('.item-type-card__author');
      const img = c.querySelector('img');
      out.push({
        id: String(id),
        url: href.split('?')[0],
        title: titleEl ? titleEl.textContent.trim() : null,
        timeLeftText: timeEl ? timeEl.textContent.trim() : null,
        priceText: priceEl ? priceEl.textContent.trim() : null,
        bidsText: bidsEl ? bidsEl.textContent.trim() : null,
        author: authorEl ? authorEl.textContent.replace(/\s+/g, ' ').trim() : null,
        thumb: img ? (img.getAttribute('data-src') || img.src) : null,
      });
    }
    return out;
  });
  const now = Date.now();
  return cards.map((c) => {
    const left = parseTimeLeft(c.timeLeftText);
    const bids = c.bidsText ? parseInt((c.bidsText.match(/\d+/) || ['0'])[0], 10) : 0;
    return { ...c, price: parsePrice(c.priceText), bids, endsAt: left != null ? new Date(now + left) : null };
  });
}

// Страница лота. Возвращает { gone } если лота нет, иначе подробности, включая признак окончания.
// Код ответа сам по себе не показатель: защита ay.by отдаёт 403/404 и на живые страницы, а завершённый лот
// с историей ставок может прийти с 404. Поэтому «нет лота» = нет заголовка лота на странице.
async function fetchLot(page, url) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  const code = resp ? resp.status() : 0;
  await assertNotVerification(page);
  await page.waitForSelector('.b-lot-title__title, .b-lot-control', { timeout: code === 200 ? 10000 : 4000 }).catch(() => {});
  const hasLot = await page.evaluate(() => Boolean(document.querySelector('.b-lot-title__title, .b-lot-control, #lot-timer')));
  if (!hasLot) {
    if (code === 404 || code === 410) return { gone: true, httpStatus: code };
    throw new Error(`HTTP ${code}: no lot content`);
  }

  const raw = await page.evaluate(() => {
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const out = {};
    out.title = text(document.querySelector('.b-lot-title__title, h1'));
    const timer = document.querySelector('#lot-timer');
    out.timerSeconds = timer && timer.getAttribute('data-time') ? parseInt(timer.getAttribute('data-time'), 10) : null;
    const parts = document.querySelectorAll('.b-lot-title__item-part, .b-lot-title__item');
    out.endsText = null; out.titleAreaText = text(document.querySelector('.b-lot-title')) || '';
    for (let i = 0; i < parts.length; i++) { const t = text(parts[i]); if (t && /Завершается|Завершен|завершен|Продан|продан/.test(t)) { out.endsText = t; break; } }
    const control = document.querySelector('.b-lot-control');
    out.controlText = text(control) || '';
    const mains = document.querySelectorAll('.b-lot-control__main');
    out.priceText = null;
    for (let i = 0; i < mains.length; i++) { const t = text(mains[i]); if (t && /\d/.test(t) && /руб/.test(t)) { out.priceText = t; break; } }
    const bidBtn = document.querySelector('.lot-rates-modal-btn');
    out.bidsText = text(bidBtn);
    out.hasBidButton = /Сделать ставку/.test(out.controlText);
    out.hasBuyNow = /Купить сейчас/.test(out.controlText);
    out.bargain = /Возможен торг/.test(out.controlText);
    out.specs = {};
    const rows = document.querySelectorAll('.b-description__item table tr');
    for (let i = 0; i < rows.length; i++) { const tds = rows[i].querySelectorAll('td'); if (tds.length === 2) out.specs[text(tds[0])] = text(tds[1]); }
    const items = document.querySelectorAll('.b-description__item');
    const descParts = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].querySelector('table')) continue;
      const t = (items[i].innerText || '').replace(/^Описание лота\s*/, '').trim();
      if (t) descParts.push(t);
    }
    out.description = descParts.join('\n').slice(0, 4000) || null;
    const viewsEl = document.querySelector('.b-lot-title__sub-item[title="Просмотров"] .sub-text');
    out.views = viewsEl ? parseInt(text(viewsEl).replace(/\s/g, ''), 10) : null;
    const photos = [];
    // галерея: <figure data-pswp-element><a href="…gallery…/650/…jpg">; запасной вариант — превью листинга
    const gal = document.querySelectorAll('figure[data-pswp-element] a[href], a[data-size][href], .b-gallery a[href*="aystatic"]');
    for (let i = 0; i < gal.length && photos.length < 10; i++) if (photos.indexOf(gal[i].href) < 0) photos.push(gal[i].href);
    if (!photos.length) {
      const imgs = document.querySelectorAll('.b-gallery img[src*="aystatic"], .b-lot-media img[src*="aystatic"]');
      for (let i = 0; i < imgs.length && photos.length < 10; i++) { const s = imgs[i].getAttribute('data-src') || imgs[i].src; if (s && photos.indexOf(s) < 0) photos.push(s); }
    }
    out.photos = photos;
    const body = (document.body.innerText || '').replace(/\s+/g, ' ');
    const cm = body.match(/Доставка из города ([^.]{2,60}?)(?: Отправка| Передача| Невозможн| Расчет|$)/);
    out.sellerCity = cm ? cm[1].trim() : null;
    const pm = body.match(/Выставить такой же лот (.{5,200}?)\s*(?=Осталось|Завершается|Завершён|Завершен|Торги завершены|Лот продан)/);
    out.categoryPath = pm ? pm[1].replace(/\s*(Монеты)\s*/, '$1 › ').trim() : null;
    const sm = body.match(/(?:Правила торгов|Предложить мою цену|Купить сейчас)\s+(.{2,40}?)\s+\d+\s+(?:Физическое лицо|Юридическое лицо|Магазин)/);
    out.seller = sm ? sm[1].trim() : null;
    // блок продавца: <a class="b-seller-info-summary" href="/whoiswho.phtml?id=N"> … __user-name, __rating-count
    const sellerA = document.querySelector('a.b-seller-info-summary[href*="whoiswho"]');
    out.sellerId = sellerA ? ((sellerA.getAttribute('href') || '').match(/id=(\d+)/) || [null, null])[1] : null;
    out.sellerNick = text(document.querySelector('.b-seller-info-summary__user-name'));
    const rc = text(document.querySelector('.b-seller-info-summary__rating-count'));
    out.sellerRating = rc && /\d/.test(rc) ? parseInt(rc.replace(/\D/g, ''), 10) : null;
    // «… победитель <a href="/whoiswho.phtml?id=N">ник</a>.» и «Минимальная цена не пройдена» — строки .b-lot-control__plain
    out.winner = null; out.winnerId = null; out.reserveText = null;
    const plains = document.querySelectorAll('.b-lot-control__plain');
    for (let i = 0; i < plains.length; i++) {
      const t = text(plains[i]) || '';
      if (/победитель/.test(t)) {
        const a = plains[i].querySelector('a[href*="whoiswho"]');
        if (a) { out.winner = text(a); out.winnerId = ((a.getAttribute('href') || '').match(/id=(\d+)/) || [null, null])[1]; }
      }
      if (/Минимальная цена/.test(t)) out.reserveText = t;
    }
    out.statusHint = (body.match(/Торги завершены[^.]{0,80}|Лот продан[^.]{0,80}|Лот снят[^.]{0,60}|Торги завершились[^.]{0,80}/) || [null])[0];
    // завершённый лот: «Завершён 26 октября в 16:09:04» в шапке и «Лот продан за 3,50 бел. руб. 26 октября в 16:09:04,
    // победитель Wolf71. 1 сделка» / «16 ставок» в блоке цены
    out.endedAtText = (body.match(/Заверш[её]н\s*(\d{1,2}\s+[а-яё]+(?:\s+\d{4})?\s+в\s+\d{1,2}:\d{2}(?::\d{2})?)/i) || [null, null])[1];
    out.soldText = (body.match(/Лот продан за\s*[\d\s.,]+\s*бел\.?\s*руб\.?[^.]{0,80}/) || [null])[0];
    out.unsoldText = (body.match(/(?:Лот не продан|Торги завершены без ставок|Лот снят с торгов|Лот отменён|Лот отменен)[^.]{0,60}/) || [null])[0];
    return out;
  });
  return interpretLot(raw, code);
}

const MONTHS_RU = { января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5, июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11 };
const MINSK_OFFSET_H = 3;

// «26 октября в 16:09:04» (год не указан → ближайший прошедший) → Date; время сайта — минское (UTC+3)
function parseEndedAt(text, now = new Date()) {
  const m = (text || '').toLowerCase().match(/(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?\s+в\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m || MONTHS_RU[m[2]] == null) return null;
  let year = m[3] ? parseInt(m[3], 10) : now.getUTCFullYear();
  let d = new Date(Date.UTC(year, MONTHS_RU[m[2]], +m[1], +m[4] - MINSK_OFFSET_H, +m[5], +(m[6] || 0)));
  if (!m[3] && d.getTime() > now.getTime() + 86400e3) d = new Date(Date.UTC(year - 1, MONTHS_RU[m[2]], +m[1], +m[4] - MINSK_OFFSET_H, +m[5], +(m[6] || 0)));
  return d;
}

// Сырые данные страницы → лот. Вынесено из fetchLot, чтобы проверять офлайн.
function interpretLot(raw, code = 200) {
  const sold = Boolean(raw.soldText);
  const endedAt = parseEndedAt(raw.endedAtText);
  const ended = sold || Boolean(raw.unsoldText) || Boolean(endedAt) || raw.timerSeconds == null || raw.timerSeconds <= 0;
  // путь категории заканчивается заголовком лота — убираем его
  let categoryPath = raw.categoryPath;
  if (categoryPath && raw.title && categoryPath.endsWith(raw.title)) categoryPath = categoryPath.slice(0, -raw.title.length).trim();
  const bids = raw.bidsText ? parseInt((raw.bidsText.match(/\d+/) || ['0'])[0], 10) : 0;
  let saleType = null;
  if (raw.hasBidButton && raw.hasBuyNow) saleType = 'auction_buynow';
  else if (raw.hasBidButton) saleType = 'auction';
  else if (raw.hasBuyNow) saleType = 'buy_now';
  else if (bids > 0) saleType = 'auction';
  const soldPrice = sold ? parsePrice(raw.soldText.match(/за\s*([\d\s.,]+)/)[1]) : null;
  const price = soldPrice ?? parsePrice(raw.priceText);
  // победитель: ссылка в строке «Лот продан…», запасной вариант — текст «победитель ник»
  const winner = raw.winner || (sold ? ((raw.soldText.match(/победитель\s+([^,]+?)\.?$/) || [null, null])[1] || null) : null);
  const reserve = !raw.reserveText ? null : /не\s+пройдена/.test(raw.reserveText) ? 'not_met' : /пройдена/.test(raw.reserveText) ? 'met' : null;

  return {
    gone: false,
    httpStatus: code,
    title: raw.title,
    price,
    bids,
    saleType,
    bargain: raw.bargain,
    endsAt: !ended && raw.timerSeconds != null ? new Date(Date.now() + raw.timerSeconds * 1000) : null,
    endsText: raw.endsText,
    ended,
    endedAt,
    sold,                 // true: на странице «Лот продан за …» (аукцион со ставками или «купить сейчас»)
    finalPrice: soldPrice,
    statusText: raw.soldText || raw.unsoldText || raw.statusHint || (ended ? raw.titleAreaText.slice(0, 200) : null),
    specs: raw.specs,
    conditionText: raw.specs['Состояние'] || null,
    description: raw.description,
    views: raw.views,
    photos: raw.photos,
    seller: raw.sellerNick || raw.seller,
    sellerId: raw.sellerId || null,
    sellerRating: Number.isFinite(raw.sellerRating) ? raw.sellerRating : null,
    sellerCity: raw.sellerCity,
    winner,
    winnerId: raw.winnerId || null,
    reserve,              // 'not_met' — «Минимальная цена не пройдена»: дёшево продавец не отдаст
    categoryPath,
  };
}

// Активные лоты продавца, страница pageNo по 100 (ближайшие к окончанию сверху):
// whoiswho.phtml?id=N&show=auction_active&auctions_limit=100&page=K → таблица tr#lot_ID: td.txt (ссылка),
// td.cost (<big> текущая цена, <small> цена «купить сейчас»), td.total-rates (ставки), td.lost-time («15 ч», «4 дня»).
// Карточки в том же виде, что scanListPage. Меньше SELLER_PAGE_SIZE строк — последняя страница.
const SELLER_PAGE_SIZE = 100;
function sellerPageUrl(sellerId, pageNo = 1) {
  return `https://ay.by/whoiswho.phtml?id=${encodeURIComponent(sellerId)}&show=auction_active&auctions_limit=${SELLER_PAGE_SIZE}${pageNo > 1 ? `&page=${pageNo}` : ''}`;
}

async function scanSellerPage(page, sellerId, pageNo = 1) {
  const url = sellerPageUrl(sellerId, pageNo);
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  if (resp && resp.status() === 404) return [];
  await assertNotVerification(page);
  await page.waitForSelector('tr[id^="lot_"], h1', { timeout: 10000 }).catch(() => {});
  const rows = await page.evaluate(() => {
    const out = [];
    const trs = document.querySelectorAll('tr[id^="lot_"]');
    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i];
      const a = tr.querySelector('td.txt a[href*="/lot/"]');
      if (!a) continue;
      const big = tr.querySelector('td.cost big');
      const small = tr.querySelector('td.cost small');
      const rates = tr.querySelector('td.total-rates');
      const left = tr.querySelector('td.lost-time');
      const img = tr.querySelector('td.ph img');
      out.push({
        id: tr.id.replace('lot_', ''),
        url: a.href.split('?')[0],
        title: a.textContent.replace(/\s+/g, ' ').trim(),
        priceText: big ? big.textContent : null,
        buyNowText: small ? small.textContent : null,
        bidsText: rates ? rates.textContent.trim() : '',
        timeLeftText: left ? left.textContent.trim() : null,
        thumb: img ? (img.getAttribute('data-src') || img.src) : null,
      });
    }
    return out;
  });
  const now = Date.now();
  return rows.map((c) => {
    const left = parseTimeLeft(c.timeLeftText);
    return { ...c, author: null, price: parsePrice(c.priceText), buyNowPrice: parsePrice(c.buyNowText), bids: parseInt((c.bidsText.match(/\d+/) || ['0'])[0], 10), endsAt: left != null ? new Date(now + left) : null };
  });
}

// Профиль пользователя: <h1>ник <sup title="Рейтинг пользователя">348</sup></h1>, отзывы dt.resp-good / resp-neut / resp-false
async function fetchUser(page, userId) {
  const resp = await page.goto(`https://ay.by/whoiswho.phtml?id=${encodeURIComponent(userId)}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  if (resp && resp.status() === 404) return null;
  await assertNotVerification(page);
  await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});
  const u = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    if (!h1) return null;
    let nick = null;
    for (let i = 0; i < h1.childNodes.length && !nick; i++) {
      const n = h1.childNodes[i];
      if (n.nodeType === 3 && n.textContent.trim()) nick = n.textContent.trim();
    }
    const int = (el) => (el && /\d/.test(el.textContent) ? parseInt(el.textContent.replace(/\D/g, ''), 10) : null);
    return { nick, rating: int(h1.querySelector('sup')), positive: int(document.querySelector('dt.resp-good')), negative: int(document.querySelector('dt.resp-false')) };
  });
  return u && u.nick ? { id: String(userId), ...u } : null;
}

// Ник продавца из карточки списка: «maybach - 888 99.8%» → «maybach - 888» (процент положительных отзывов в конце)
function authorNick(author) {
  return (author || '').replace(/\s+\d+(?:[.,]\d+)?\s*%\s*$/, '').trim() || null;
}

module.exports = { discoverSubsections, scanListPage, scanSellerPage, sellerPageUrl, authorNick, fetchLot, fetchUser, interpretLot, parseEndedAt, parseTimeLeft, parsePrice, isBlocked, NAV_TIMEOUT, SELLER_PAGE_SIZE };
