require('dotenv').config();
const store = require('./store');
const cstore = require('./coins/store');
const bid = require('./coins/bid');
const vision = require('./coins/vision');
const photos = require('./coins/photos');
const { ussrVariety } = require('./coins/parse');
const { assessCoin } = require('./coins/assess');
const { MONITORS } = require('./config');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LIKE_EMOJI = '👍';
const DEFAULT_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
  .split(',').map((id) => id.trim()).filter(Boolean);

async function tg(method, body, timeoutMs = 15000) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json();
  if (!data.ok) console.error(`[Poll] ${method} error:`, data.description);
  return data;
}

async function getUpdates(offset) {
  const data = await tg('getUpdates', {
    offset,
    timeout: 30,
    allowed_updates: ['message', 'callback_query', 'message_reaction'],
  }, 35000);
  return data.result || [];
}

// ---- Settings (checkbox list of monitors) ----

// Мониторы, которые только собирают цены (notify: false в config.js), в настройках не показываются
const SETTINGS_MONITORS = MONITORS.filter((m) => m.notify !== false);

function buildKeyboard(subs) {
  return {
    inline_keyboard: SETTINGS_MONITORS.map((m) => [{
      text: `${subs.has(m.key) ? '✅' : '☐'} ${m.emoji || ''} ${m.name}`.trim(),
      callback_data: `sub:${m.key}`,
    }]),
  };
}

const SETTINGS_TEXT =
  '⚙️ <b>Настройки уведомлений</b>\n' +
  'Отметьте категории, по которым хотите получать объявления. ' +
  'Нажатие на строку включает или выключает её.';

// Monitors this chat received under the legacy config (chatIds / TELEGRAM_CHAT_IDS)
function legacyMonitorKeys(chatId) {
  return SETTINGS_MONITORS
    .filter((m) => !m.optIn)
    .filter((m) => (m.chatIds && m.chatIds.length ? m.chatIds : DEFAULT_CHAT_IDS).includes(chatId))
    .map((m) => m.key);
}

async function sendSettings(chatId) {
  const isNew = await store.registerChat(chatId);
  if (isNew) {
    // Keep whatever the chat was already receiving so nothing silently stops
    await store.setSubscriptions(chatId, legacyMonitorKeys(chatId));
  }
  const subs = await store.getSubscriptions(chatId);
  await tg('sendMessage', {
    chat_id: chatId,
    text: SETTINGS_TEXT,
    parse_mode: 'HTML',
    reply_markup: buildKeyboard(subs),
  });
}

async function handleMessage(msg) {
  const text = msg.text || '';
  const chatId = String(msg.chat.id);
  if (isImageMessage(msg)) { await collectPhoto(msg, chatId); return; }
  if (/^\/(start|settings)(@\w+)?(\s|$)/.test(text)) {
    console.log(`[Settings] ${text.split(' ')[0]} from chat=${chatId}`);
    await sendSettings(chatId);
    return;
  }
  if (/^\/bids(@\w+)?(\s|$)/.test(text)) { await sendBids(chatId); return; }
  if (/^\/photo(@\w+)?(\s|$)/.test(text)) { await reply(msg, PHOTO_HELP); return; }
  const link = text.match(LOT_LINK);
  if (!link && !msg.reply_to_message) return;
  // ответ на карточку или ссылка на лот: любая ошибка (база не ответила и т. п.) — сообщением, а не молчанием
  try {
    if (link) await handleLinkBid(msg, chatId, text, link);
    else if (GRADE_REPLY.test(text)) await handleGradeReply(msg, chatId);
    else if (LETTER_REPLY.test(text)) await handleLetterReply(msg, chatId);
    else await handleBidReply(msg, chatId, text);
  } catch (err) {
    console.error(`[Poll] ответ «${text.slice(0, 40)}» chat=${chatId}: ${err.message}`);
    await reply(msg, `⚠️ Не получилось обработать ответ: ${escHtml(err.message)}. Попробуйте ещё раз через минуту.`).catch(() => {});
  }
}

// ---- Оценка по фото (coins/vision.js): фото или альбом с подписью → что за монета, состояние, сколько предложить ----

const PHOTO_HELP = '📷 Пришлите фото монеты (лучше альбомом: аверс, реверс, гурт) и подпишите, что известно и сколько просят, '
  + 'например «50 копеек 1925, просят 60». Бот определит монету и состояние по фото, сравнит с нашей базой и архивами '
  + 'и подскажет, сколько предложить.\n\nНа карточку лота ay.by или Kufar можно ответить «фото» — бот возьмёт все фото лота, '
  + 'оценит состояние сам (продавцу не верит) и пересчитает ориентир и разумный максимум.\n\n'
  + 'Ответ «буква» на карточку монеты СССР 1961–1991 — буква монетного двора (М, Л или её нет) и цвет металла по фото: '
  + 'так ищут дорогие разновидности (20 коп. 1991 без буквы, 5 и 10 коп. 1990 М) и перепутки (белые 2–3 коп., жёлтые 20 коп.).\n\n'
  + 'Точность по фото — ±1 ступень состояния; вес и размеры проверяйте сами.';
const VISION_OFF = 'Оценка по фото выключена: в .env нет ключа модели (ANTHROPIC_API_KEY — свой или шлюза вместе с ANTHROPIC_API_URL, либо OPENAI_API_KEY).';
// ответ на карточку лота: «фото», «оцени», «оценка», «состояние», «📷»
const GRADE_REPLY = /^\s*(?:📷|фото|оцени(?:ть)?|оценка|состояние)(?!\p{L})/iu;
// «буква» / «двор» — СССР 1961–1991: буква монетного двора и цвет металла по фото лота (разновидности, перепутки)
const LETTER_REPLY = /^\s*(?:🔤|буква|двор)(?!\p{L})/iu;
const ALBUM_WAIT_MS = 2500;
const albums = new Map(); // chat:media_group_id → { msgs, timer }
let photoQueue = Promise.resolve();

const isImageMessage = (msg) => Boolean((msg.photo && msg.photo.length) || (msg.document && /^image\//.test(msg.document.mime_type || '')));

async function collectPhoto(msg, chatId) {
  if (!snipeAllowed(chatId)) return; // чужие чаты не тратят ключ API
  if (!vision.enabled()) { await reply(msg, VISION_OFF); return; }
  const key =`${chatId}:${msg.media_group_id || `m${msg.message_id}`}`;
  const album = albums.get(key) || { msgs: [], timer: null };
  album.msgs.push(msg);
  clearTimeout(album.timer);
  // части альбома приходят отдельными сообщениями — ждём, пока придут все
  album.timer = setTimeout(() => {
    albums.delete(key);
    photoQueue = photoQueue.then(() => gradeAlbum(album.msgs)).catch((err) => console.error('[Photo]', err.message || err));
  }, ALBUM_WAIT_MS);
  albums.set(key, album);
}

async function downloadImage(msg) {
  const fileId = msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id; // самое крупное
  const f = await tg('getFile', { file_id: fileId });
  if (!f.ok) throw new Error('не удалось получить файл из Telegram');
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Telegram file ${res.status}`);
  const ext = (f.result.file_path.match(/\.(\w+)$/) || [])[1] || 'jpg';
  const mediaType = msg.document ? msg.document.mime_type : { png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext.toLowerCase()] || 'image/jpeg';
  return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mediaType };
}

async function gradeAlbum(msgs) {
  msgs.sort((a, b) => a.message_id - b.message_id);
  const first = msgs[0];
  const caption = msgs.map((m) => m.caption).filter(Boolean).join(' ').trim();
  const chatId = String(first.chat.id);
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try {
    const images = [];
    for (const m of msgs.slice(0, vision.MAX_PHOTOS)) images.push(await downloadImage(m));
    const graded = await vision.gradePhotos(images, caption);
    const price = vision.captionPrice(caption);
    const coins = (graded.result.coins || []).slice(0, 8);
    const items = [];
    for (const coin of coins) {
      const parsed = vision.parsedFromVision(coin);
      const known = parsed.denomination || parsed.isPrecious;
      const est = known ? await assessCoin({ parsed, price: coins.length === 1 ? price : null, fixedPrice: true, title: coin.title }).catch(() => null) : null;
      items.push({ coin, est });
    }
    console.log(`[Photo] chat=${chatId} ${images.length} фото: ${coins.map((c) => `${c.title} ${c.grade}`).join('; ') || 'монет нет'} · ${graded.model} ≈ $${graded.costUsd != null ? graded.costUsd.toFixed(3) : '?'}`);
    for (const text of vision.formatReport(graded, items, price)) await reply(first, text);
  } catch (err) {
    console.error(`[Photo] chat=${chatId}: ${err.message || err}`);
    await reply(first, `Не получилось оценить фото: ${String(err.message || err).replace(/[<>&]/g, '')}`);
  }
}

// «фото» в ответ на карточку лота: все фото лота → состояние по фото → ориентир и максимум по нему.
// Слабам верим — их не дооцениваем (и не тратим ключ API).
async function handleLetterReply(msg, chatId) {
  if (!snipeAllowed(chatId)) return;
  if (!vision.enabled()) { await reply(msg, VISION_OFF); return; }
  const lot = await cstore.lotByMessage(chatId, msg.reply_to_message.message_id);
  if (!lot) { await reply(msg, 'Не нашёл лот по этому сообщению. Ответьте «буква» на карточку монеты ay.by или Kufar.'); return; }
  const parsed = (typeof lot.parsed === 'string' ? JSON.parse(lot.parsed) : lot.parsed) || {};
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  photoQueue = photoQueue.then(async () => {
    try {
      const images = await photos.lotImages(lot, 4);
      if (!images.length) { await reply(msg, 'Фото лота не скачались (лот снят или площадка ограничила доступ).'); return; }
      const checked = await vision.checkMintLetter(images, lot.title);
      const r = checked.result;
      console.log(`[Letter] chat=${chatId} лот ${lot.source} ${lot.external_id} «${lot.title}»: буква ${r.letter} (${r.letter_confidence}), цвет ${r.color_ok ? 'ок' : 'НЕ ТОТ'} · ${checked.model} ≈ $${checked.costUsd != null ? checked.costUsd.toFixed(3) : '?'}`);
      await reply(msg, vision.formatLetterCheck(checked, ussrVariety(parsed)));
    } catch (err) {
      console.error(`[Letter] chat=${chatId} лот ${lot.external_id}: ${err.message || err}`);
      await reply(msg, `Не получилось проверить фото: ${String(err.message || err).replace(/[<>&]/g, '')}`);
    }
  }).catch((err) => console.error('[Letter]', err.message || err));
}

async function handleGradeReply(msg, chatId) {
  if (!snipeAllowed(chatId)) return;
  if (!vision.enabled()) { await reply(msg, VISION_OFF); return; }
  const lot = await cstore.lotByMessage(chatId, msg.reply_to_message.message_id);
  if (!lot) { await reply(msg, 'Не нашёл лот по этому сообщению. Ответьте «фото» на карточку монеты ay.by или Kufar.'); return; }
  const parsed = typeof lot.parsed === 'string' ? JSON.parse(lot.parsed) : lot.parsed;
  if (!parsed) { await reply(msg, 'Лот ещё не разобран (карточка без деталей лота) — оценить не с чем.'); return; }
  if (parsed.slab && parsed.slab.bucket) { await reply(msg, `Слаб ${parsed.slab.bucket}: состоянию слаба верим, по фото не дооцениваю.`); return; }
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  photoQueue = photoQueue.then(() => regradeLot(msg, chatId, lot, parsed)).catch((err) => console.error('[Photo]', err.message || err));
}

async function regradeLot(msg, chatId, lot, parsed) {
  try {
    const images = await photos.lotImages(lot, vision.MAX_PHOTOS);
    if (!images.length) { await reply(msg, 'Фото лота не скачались (лот снят или площадка ограничила доступ). Попробуйте позже или пришлите фото сами.'); return; }
    const graded = await vision.gradePhotos(images, vision.lotHint(lot.title));
    const coin = (graded.result.coins || [])[0];
    const price = lot.current_price != null ? Number(lot.current_price) : null;
    const auction = /auction/.test(lot.sale_type || '');
    const declared = parsed.grade || null;
    const opts = { price, excludeId: lot.id, fixedPrice: !auction, title: lot.title };
    const before = declared ? await assessCoin({ parsed, ...opts }).catch(() => null) : null;
    // металл, которого нет в лоте (Kufar без поля «Металл»), — по фото: иначе не посчитать стоимость металла
    const metal = parsed.metal || (coin && ['silver', 'gold'].includes(coin.metal) ? coin.metal : null);
    const after = coin && coin.grade !== 'unknown'
      ? await assessCoin({ parsed: { ...parsed, metal, isPrecious: parsed.isPrecious || Boolean(metal), grade: coin.grade, gradeSource: 'photo' }, ...opts }).catch(() => null) : null;
    console.log(`[Photo] chat=${chatId} лот ${lot.source} ${lot.external_id} «${lot.title}»: ${images.length} фото, продавец ${declared || '—'} → фото ${coin ? coin.grade : 'нет монеты'}`
      + `, ориентир ${before && before.reference != null ? Math.round(before.reference) : '—'} → ${after && after.reference != null ? Math.round(after.reference) : '—'} · ${graded.model} ≈ $${graded.costUsd != null ? graded.costUsd.toFixed(3) : '?'}`);
    for (const text of vision.formatLotRegrade(graded, { lot, declared, before, after, auction })) await reply(msg, text);
  } catch (err) {
    console.error(`[Photo] chat=${chatId} лот ${lot.external_id}: ${err.message || err}`);
    await reply(msg, `Не получилось оценить фото лота: ${String(err.message || err).replace(/[<>&]/g, '')}`);
  }
}

// ---- Снайп-ставки: ответ на карточку лота ay.by числом ----

const SNIPE_CHAT_IDS = (process.env.SNIPE_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const snipeAllowed = (chatId) => (SNIPE_CHAT_IDS.length ? SNIPE_CHAT_IDS : DEFAULT_CHAT_IDS).includes(String(chatId));
const fmtDate = (d) => new Date(d).toLocaleString('ru-BY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Minsk' });

// Ответ на сообщение. Telegram не принял HTML (символы < > & в заголовке лота) — тот же текст без разметки:
// раньше такой ответ просто терялся, и пользователь не получал ничего
async function reply(msg, text) {
  const r = await tg('sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', reply_to_message_id: msg.message_id, disable_web_page_preview: true });
  if (r && !r.ok) {
    const plain = text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    await tg('sendMessage', { chat_id: msg.chat.id, text: plain, reply_to_message_id: msg.message_id, disable_web_page_preview: true });
  }
}
const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Состояние лота прямо со страницы: в базе цена с последнего прохода бота и могла отстать (под конец торгов ставки
// идут часто). Минимальная ставка — data-min поля суммы #lot-input (цена + шаг); поле есть только у аукциона.
// Таймер #lot-timer data-time — секунд до конца. Страница не открылась — null, тогда сверка по базе.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
async function liveBidState(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const html = await res.text();
    const text = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    const input = (html.match(/<input[^>]*id="lot-input"[^>]*>/) || [''])[0];
    const min = parseFloat((input.match(/data-min="([\d.]+)"/) || [])[1]);
    const main = (html.match(/b-lot-control__main[^>]*>([\s\S]{0,200}?)<\/(?:div|span|p)>/) || [])[1];
    const price = main ? parseFloat(main.replace(/<[^>]+>|&nbsp;|\s/g, '').replace(',', '.')) : NaN;
    const timerTag = (html.match(/<[^>]*id="lot-timer"[^>]*>/) || [''])[0];
    const seconds = parseInt((timerTag.match(/data-time="(\d+)"/) || [])[1], 10);
    const bids = parseInt((text((html.match(/lot-rates-modal-btn[^>]*>([\s\S]{0,120}?)<\/(?:a|button|span|div)>/) || [])[1]).match(/\d+/) || ['0'])[0], 10);
    const title = text((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]) || null;
    if (!(min > 0) && !(price > 0) && !title) return null;
    return {
      min: min > 0 ? min : null,
      price: price > 0 ? price : null,
      title,
      auction: Boolean(input),
      endsAt: seconds > 0 ? new Date(Date.now() + seconds * 1000) : null,
      // таймер не нашёлся (другая разметка) — не считать законченным, иначе ставки бы не принимались вовсе
      ended: (Boolean(timerTag) && !(seconds > 0)) || /Лот продан за|Торги завершены|Лот не продан/.test(html),
      bids,
    };
  } catch { return null; }
}

async function handleBidReply(msg, chatId, text) {
  const order = bid.parseBidReply(text);
  if (!order) return; // ответ не про ставку
  if (!snipeAllowed(chatId)) { await reply(msg, 'Ставки из этого чата не разрешены (SNIPE_CHAT_IDS / TELEGRAM_CHAT_IDS в .env).'); return; }
  const lot = await cstore.lotByMessage(chatId, msg.reply_to_message.message_id);
  if (!lot) { await reply(msg, 'Не нашёл лот по этому сообщению. Ответьте на карточку лота ay.by или пришлите ссылку на лот и максимум.'); return; }
  await applyBidOrder(msg, chatId, lot, order, null);
}

// «https://ay.by/lot/…-5041929853.html 120» — ставка без карточки: лот, которого бот не присылал (или не видел вовсе).
// «ссылка отмена» — отменить заявку. Только ссылка — текущее состояние лота и подсказка.
const LOT_LINK = /https?:\/\/(?:www\.)?ay\.by\/lot\/[^\s?#]*?-(\d{6,})\.html[^\s]*/i;
async function handleLinkBid(msg, chatId, text, link) {
  if (!snipeAllowed(chatId)) { await reply(msg, 'Ставки из этого чата не разрешены (SNIPE_CHAT_IDS / TELEGRAM_CHAT_IDS в .env).'); return; }
  const url = link[0].replace(/[?#].*$/, '');
  const externalId = link[1];
  const rest = text.replace(link[0], ' ').trim();
  const order = rest ? bid.parseBidReply(rest) : null;
  const live = await liveBidState(url);
  let lot = await cstore.lotByExternalId(externalId);
  if (!lot) {
    if (!live || !live.title) { await reply(msg, 'Страница лота не открылась (лот снят или ay.by не ответил). Попробуйте ещё раз через минуту.'); return; }
    if (!order || order.cancel) { await reply(msg, linkHelp(live)); return; }
    lot = await cstore.saveManualLot({ externalId, url, title: live.title, saleType: live.auction ? 'auction' : 'buy_now', endsAt: live.endsAt, price: live.price, bids: live.bids });
    console.log(`[Bids] chat=${chatId} лот ${externalId} заведён по ссылке: «${live.title}»`);
  }
  if (!order) { await reply(msg, live ? linkHelp(live) : 'Пришлите ссылку и максимум одним сообщением, например: «ссылка 120».'); return; }
  await applyBidOrder(msg, chatId, lot, order, live);
}

function linkHelp(live) {
  if (!live.auction) return `«${escHtml(live.title)}» — не аукцион (только «купить сейчас»), снайп-ставку поставить нельзя.`;
  return `«${escHtml(live.title)}»: сейчас ${live.price != null ? bid.fmt(live.price) : '?'}${live.min != null ? `, мин. ставка ${bid.fmt(live.min)}` : ''}`
    + ` · ${live.bids} ставок · до ${live.endsAt ? fmtDate(live.endsAt) : '?'}.\nЧтобы поставить, пришлите ссылку и максимум одним сообщением, например: «ссылка ${live.min != null ? Math.ceil(live.min) : 100}».`;
}

// Общая часть ответа на карточку и ставки по ссылке: проверки, отмена, сверка с минимальной ставкой, заявка
// Закончились ли торги — по странице лота, если она открылась: в базе бывает ложное «снят» (404 при дочитке, в том числе
// от проверки на бота — 2026-11-16 «Торги по этому лоту уже закончились» на идущем лоте) и устаревшее время конца.
async function applyBidOrder(msg, chatId, lot, order, liveState) {
  if (lot.source !== 'ayby') { await reply(msg, 'Это не аукцион ay.by, ставку поставить нельзя.'); return; }
  if (order.cancel) {
    const c = await cstore.cancelBid(lot.id);
    await reply(msg, c ? `Заявка до ${bid.fmt(c.max_byn)} отменена.` : 'Активной заявки по этому лоту нет.');
    console.log(`[Bids] chat=${chatId} cancel lot ${lot.external_id}: ${c ? 'ok' : 'none'}`);
    return;
  }
  const live = liveState || await liveBidState(lot.url);
  const pageOk = Boolean(live && live.title);
  const dbEnded = Boolean(lot.outcome || (lot.ends_at && new Date(lot.ends_at) < Date.now()));
  const auction = pageOk ? live.auction : /auction/.test(lot.sale_type || '');
  console.log(`[Bids] chat=${chatId} lot ${lot.external_id}: страница ${pageOk ? `${live.ended ? 'торги окончены' : 'торги идут'}, до ${live.endsAt ? fmtDate(live.endsAt) : '?'}` : 'не открылась'}; база: ${lot.outcome || 'идёт'}, до ${lot.ends_at ? fmtDate(lot.ends_at) : '?'}`);
  if (!auction) { await reply(msg, 'Это не аукцион ay.by (только «купить сейчас»), ставку поставить нельзя.'); return; }
  if (pageOk ? live.ended : dbEnded) {
    await reply(msg, `Торги по этому лоту уже закончились${pageOk ? '' : ' (по базе; страница лота сейчас не открылась — если торги идут, пришлите ещё раз через минуту)'}.`);
    return;
  }
  if (pageOk && lot.outcome === 'removed') {
    await cstore.reviveLot(lot.id).catch(() => {});
    console.log(`[Bids] лот ${lot.external_id}: в базе был «снят», страница показывает торги — пометка снята`);
  }
  if (pageOk && live.endsAt) await cstore.touchEndsAt(lot.id, live.endsAt, live.price, live.bids).catch(() => {});
  if (pageOk && live.endsAt) lot.ends_at = live.endsAt;
  const price = live && live.price != null ? live.price : (lot.current_price != null ? Number(lot.current_price) : null);
  const min = live ? live.min : null;
  const tooLow = min != null ? order.max < min : price != null && order.max <= price;
  console.log(`[Bids] chat=${chatId} lot ${lot.external_id}: ответ ${order.max}, сейчас ${price ?? '?'}, мин. ставка ${min ?? '?'}${live ? '' : ' (страница не открылась — цена из базы)'}${tooLow ? ' — мало' : ''}`);
  if (tooLow) {
    await reply(msg, `Максимум ${bid.fmt(order.max)} меньше ${min != null ? `минимальной ставки <b>${bid.fmt(min)}</b>` : 'нужного'} — сейчас цена ${price != null ? bid.fmt(price) : '?'}${live ? '' : ' (по базе, могла вырасти)'}.\nПришлите число не меньше ${min != null ? bid.fmt(min) : 'цены + шаг'}.`);
    return;
  }
  await cstore.setBid(lot.id, chatId, order.max);
  const bidsNow = live && live.bids != null ? live.bids : (lot.bids || 0);
  await reply(msg, `🎯 Снайп: до <b>${bid.fmt(order.max)}</b> на «${escHtml(lot.title)}».\nСейчас ${price != null ? bid.fmt(price) : '?'}${min != null ? ` (мин. ставка ${bid.fmt(min)})` : ''} · ${bidsNow} ставок · до ${lot.ends_at ? fmtDate(lot.ends_at) : '?'}.\nБот поставит максимум за ${bid.SNIPE_SECONDS} с до конца и отчитается. Изменить или отменить: то же сообщение с другим числом или «отмена» (ответом на карточку или вместе со ссылкой).`);
}

// /bids: активные заявки со свежим состоянием каждой страницы лота (цена, мин. ставка, конец — и в базу), плюс итоги
// за неделю. «Перебита» — минимальная ставка уже выше вашего максимума: снайпер ставить не будет, поднимите максимум.
async function sendBids(chatId) {
  const send = async (lines) => {
    // лимит сообщения Telegram 4096 символов — режем по строкам
    let chunk = '';
    for (const l of lines) {
      if (chunk && chunk.length + l.length + 1 > 3800) { await tg('sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'HTML', disable_web_page_preview: true }); chunk = ''; }
      chunk += (chunk ? '\n' : '') + l;
    }
    if (chunk) await tg('sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'HTML', disable_web_page_preview: true });
  };
  const open = await cstore.openBids(chatId);
  const done = await cstore.recentBids(chatId, 7).catch(() => []);
  if (!open.length && !done.length) {
    await tg('sendMessage', { chat_id: chatId, text: 'Заявок нет. Ответьте на карточку лота ay.by числом — это максимальная ставка. Или пришлите ссылку на лот и максимум: «https://ay.by/lot/… 120».' });
    return;
  }
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const lines = [];
  if (open.length) lines.push(`<b>🎯 Активные заявки (${open.length})</b>`);
  for (const r of open) {
    const live = await liveBidState(r.url);
    // закончился раньше срока (выкупили «купить сейчас», сняли) — срок в базе = сейчас: снайпер заберёт заявку
    // в ближайший опрос и пришлёт итог, а не ждёт плановый конец
    const endedEarly = live && live.title && live.ended && r.ends_at && new Date(r.ends_at) > Date.now();
    if (live && live.title) await cstore.touchEndsAt(r.listing_id, endedEarly ? new Date() : live.endsAt, live.price, live.bids).catch(() => {});
    const price = live && live.price != null ? live.price : Number(r.current_price);
    const ends = live && live.endsAt ? live.endsAt : r.ends_at;
    const max = Number(r.max_byn);
    const ended = live && live.title && live.ended;
    const outbid = !ended && live && live.min != null && live.min > max;
    // не поставлена, а торги идут и максимума хватает — перезапустить: снайпер возьмёт её снова под конец
    let restarted = false;
    if (r.status === 'failed' && live && live.title && !ended && !outbid) {
      await cstore.setBid(r.listing_id, chatId, max);
      console.log(`[Bids] chat=${chatId} lot ${r.external_id}: заявка до ${max} перезапущена из /bids (была ошибка: ${String(r.note || '').split('\n')[0].slice(0, 100)})`);
      restarted = true;
    }
    const icon = ended ? '🏁' : restarted ? '🔄' : r.status === 'failed' ? '⚠️' : outbid ? '❗' : { pending: '⏳', running: '🎯', placed: '✅' }[r.status] || '•';
    // причина — первая строка, без технического хвоста Playwright («Call log: …»)
    const why = String(r.note || '').split(/\n|Call log/)[0].replace(/^locator\.waitFor: Timeout \d+ms exceeded\.?/, 'не дождались окна подтверждения ставки').trim().slice(0, 120);
    const state = ended ? (endedEarly ? 'закончился досрочно (выкупили или сняли) — итог от снайпера в течение минуты' : 'торги закончились, итог придёт от снайпера')
      : restarted ? `перезапущена — в прошлый раз не поставилась${why ? ` (${escHtml(why)})` : ''}, снайпер попробует снова под конец`
      : r.status === 'failed' ? `не поставлена${why ? ` (${escHtml(why)})` : ''} — пришлите ссылку и число ещё раз, бот перезапустит`
        : outbid ? `перебита: мин. ставка ${bid.fmt(live.min)} выше вашего максимума — поднимите или «отмена»`
          : { pending: 'ждёт', running: 'в работе', placed: 'поставлена' }[r.status] || r.status;
    lines.push(`${icon} до <b>${bid.fmt(max)}</b> · сейчас ${bid.fmt(price)}${live && live.bids != null ? ` (${live.bids} ст.)` : ''} · конец ${ends ? fmtDate(ends) : '?'}${live ? '' : ' · страница не открылась, цена из базы'}\n   <a href="${r.url}">${escHtml(r.title)}</a> — ${state}`);
  }
  if (done.length) {
    lines.push('', `<b>🏁 Итоги за неделю (${done.length})</b>`);
    const st = { won: '🏆 выиграна', lost: '❌ проиграна', failed: '⚠️ не поставлена', cancelled: '🚫 отменена' };
    for (const r of done) {
      const result = r.final_price != null ? `, ушёл за ${bid.fmt(r.final_price)}${r.winner ? ` (${escHtml(r.winner)})` : ''}` : '';
      lines.push(`${st[r.status] || r.status} · до ${bid.fmt(r.max_byn)}${result} · ${r.ends_at ? fmtDate(r.ends_at) : ''}\n   <a href="${r.url}">${escHtml(r.title)}</a>`);
    }
  }
  await send(lines);
}

async function handleCallback(cb) {
  const data = cb.data || '';
  const chatId = String(cb.message?.chat?.id ?? cb.from.id);
  const msgId = cb.message?.message_id;

  if (data.startsWith('sub:')) {
    const key = data.slice(4);
    const monitor = SETTINGS_MONITORS.find((m) => m.key === key);
    if (!monitor) {
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Категория больше не отслеживается' });
      return;
    }
    await store.registerChat(chatId);
    const on = await store.toggleSubscription(chatId, key);
    console.log(`[Settings] chat=${chatId} ${on ? 'ON ' : 'OFF'} ${key}`);

    const subs = await store.getSubscriptions(chatId);
    if (msgId) {
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: buildKeyboard(subs) });
    }
    await tg('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: `${monitor.name}: ${on ? 'включено' : 'выключено'}`,
    });
    return;
  }

  await tg('answerCallbackQuery', { callback_query_id: cb.id });
}

// ---- 👍 reaction → follow a listing ----

async function handleReaction(reaction) {
  const hasLikeIn = (list) => (list || []).some((r) => r.type === 'emoji' && r.emoji === LIKE_EMOJI);
  const hadLike = hasLikeIn(reaction.old_reaction);
  const hasLike = hasLikeIn(reaction.new_reaction);
  if (hadLike === hasLike) return; // some other emoji changed

  const chatId = String(reaction.chat.id);
  const msgId = reaction.message_id;

  if (hasLike) {
    console.log(`[Poll] 👍 chat=${chatId} msg=${msgId}`);
    const listingId = await store.addFollower(chatId, msgId);
    if (listingId) {
      console.log(`[Follow] chat=${chatId} liked listing #${listingId} (msg ${msgId})`);
    } else {
      console.log(`[Follow] no listing found for chat=${chatId} msg=${msgId} (notification not saved yet)`);
    }
  } else {
    console.log(`[Poll] 👍 removed chat=${chatId} msg=${msgId}`);
    const listingId = await store.removeFollower(chatId, msgId);
    if (listingId) console.log(`[Follow] chat=${chatId} unfollowed listing #${listingId}`);
  }
}

async function main() {
  if (!TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
  }

  await tg('setMyCommands', {
    commands: [
      { command: 'settings', description: 'Выбрать категории уведомлений' },
      { command: 'bids', description: 'Мои снайп-ставки' },
      { command: 'photo', description: 'Как оценить монету по фото' },
    ],
  });

  console.log('Polling for messages, button presses and reactions...');
  let offset = 0;

  while (true) {
    try {
      const updates = await getUpdates(offset);

      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          if (update.message) await handleMessage(update.message);
          else if (update.callback_query) await handleCallback(update.callback_query);
          else if (update.message_reaction) await handleReaction(update.message_reaction);
        } catch (err) {
          console.error(`[Poll] failed to handle update ${update.update_id}:`, err.message || err);
        }
      }
    } catch (err) {
      console.error('[Poll] error:', err.message || err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

if (require.main === module) main();
module.exports = { liveBidState, LOT_LINK };
