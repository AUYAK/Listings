// Отправка карточек в Telegram и выбор получателей — общее для всех процессов-сборщиков.
// (listings.js пока держит свою копию этой логики; при следующем рефакторинге перевести на этот модуль.)
require('dotenv').config();
const store = require('./store');

const { TELEGRAM_BOT_TOKEN } = process.env;
const DEFAULT_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
  .split(',').map((id) => id.trim()).filter(Boolean);

async function telegramRequest(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (!data.ok) console.warn(`[Telegram] ${method} failed: ${data.description}`);
  return data;
}

// Кто получает уведомления монитора: отметившие категорию в /settings; чаты, не открывавшие
// настройки, — по config/.env, если монитор не optIn.
async function resolveRecipients(monitor) {
  const legacy = monitor.optIn ? [] : (monitor.chatIds && monitor.chatIds.length ? monitor.chatIds : DEFAULT_CHAT_IDS);
  try {
    const [subscribers, configured] = await Promise.all([store.getSubscribers(monitor.key), store.getConfiguredChats()]);
    const legacyOnly = legacy.filter((id) => !configured.has(String(id)));
    return [...new Set([...subscribers, ...legacyOnly].map(String))];
  } catch (err) {
    console.warn(`[Telegram] Could not load subscriptions (${err.message}), using config recipients`);
    return legacy;
  }
}

// Карточка с фото: альбом → одно фото → текст. Возвращает message_id или null.
async function sendCard(chatId, caption, photos = []) {
  let sentMsgId = null;
  if (photos.length >= 2) {
    const media = photos.slice(0, 10).map((url, i) => ({ type: 'photo', media: url, ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}) }));
    const res = await telegramRequest('sendMediaGroup', { chat_id: chatId, media });
    if (res.ok) sentMsgId = res.result?.[0]?.message_id;
  }
  if (!sentMsgId && photos.length >= 1) {
    const res = await telegramRequest('sendPhoto', { chat_id: chatId, photo: photos[0], caption, parse_mode: 'HTML' });
    if (res.ok) sentMsgId = res.result?.message_id;
  }
  if (!sentMsgId) {
    const res = await telegramRequest('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', disable_web_page_preview: false });
    if (res.ok) sentMsgId = res.result?.message_id;
  }
  return sentMsgId || null;
}

function isConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN);
}

module.exports = { telegramRequest, resolveRecipients, sendCard, isConfigured };
