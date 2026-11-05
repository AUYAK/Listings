require('dotenv').config();
const store = require('./store');
const cstore = require('./coins/store');
const bid = require('./coins/bid');
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

function buildKeyboard(subs) {
  return {
    inline_keyboard: MONITORS.map((m) => [{
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
  return MONITORS
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
  if (/^\/(start|settings)(@\w+)?(\s|$)/.test(text)) {
    console.log(`[Settings] ${text.split(' ')[0]} from chat=${chatId}`);
    await sendSettings(chatId);
    return;
  }
  if (/^\/bids(@\w+)?(\s|$)/.test(text)) { await sendBids(chatId); return; }
  if (msg.reply_to_message) await handleBidReply(msg, chatId, text);
}

// ---- Снайп-ставки: ответ на карточку лота ay.by числом ----

const SNIPE_CHAT_IDS = (process.env.SNIPE_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const snipeAllowed = (chatId) => (SNIPE_CHAT_IDS.length ? SNIPE_CHAT_IDS : DEFAULT_CHAT_IDS).includes(String(chatId));
const fmtDate = (d) => new Date(d).toLocaleString('ru-BY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Minsk' });

async function reply(msg, text) {
  await tg('sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', reply_to_message_id: msg.message_id, disable_web_page_preview: true });
}

async function handleBidReply(msg, chatId, text) {
  const order = bid.parseBidReply(text);
  if (!order) return; // ответ не про ставку
  if (!snipeAllowed(chatId)) { await reply(msg, 'Ставки из этого чата не разрешены (SNIPE_CHAT_IDS / TELEGRAM_CHAT_IDS в .env).'); return; }
  const lot = await cstore.lotByMessage(chatId, msg.reply_to_message.message_id);
  if (!lot) { await reply(msg, 'Не нашёл лот по этому сообщению. Ответьте на карточку лота ay.by.'); return; }
  if (lot.source !== 'ayby' || !/auction/.test(lot.sale_type || '')) { await reply(msg, 'Это не аукцион ay.by, ставку поставить нельзя.'); return; }
  if (lot.outcome || (lot.ends_at && new Date(lot.ends_at) < Date.now())) { await reply(msg, 'Торги по этому лоту уже закончились.'); return; }
  if (order.cancel) {
    const c = await cstore.cancelBid(lot.id);
    await reply(msg, c ? `Заявка до ${bid.fmt(c.max_byn)} отменена.` : 'Активной заявки по этому лоту нет.');
    console.log(`[Bids] chat=${chatId} cancel lot ${lot.external_id}: ${c ? 'ok' : 'none'}`);
    return;
  }
  if (lot.current_price != null && order.max <= Number(lot.current_price)) {
    await reply(msg, `Максимум ${bid.fmt(order.max)} не выше текущей цены ${bid.fmt(lot.current_price)}. Нужно больше.`);
    return;
  }
  await cstore.setBid(lot.id, chatId, order.max);
  console.log(`[Bids] chat=${chatId} lot ${lot.external_id}: max ${order.max}`);
  await reply(msg, `🎯 Снайп: до <b>${bid.fmt(order.max)}</b> на «${lot.title}».\nСейчас ${bid.fmt(lot.current_price)} · ${lot.bids || 0} ставок · до ${lot.ends_at ? fmtDate(lot.ends_at) : '?'}.\nБот поставит максимум за ${bid.SNIPE_SECONDS} с до конца и отчитается. Изменить: ответьте другим числом, отменить: «отмена».`);
}

async function sendBids(chatId) {
  const rows = await cstore.openBids(chatId);
  if (!rows.length) { await tg('sendMessage', { chat_id: chatId, text: 'Активных заявок нет. Ответьте на карточку лота ay.by числом — это максимальная ставка.' }); return; }
  const st = { pending: '⏳ ждёт', running: '🎯 в работе', placed: '✅ поставлена' };
  const lines = rows.map((r) => `${st[r.status] || r.status} до ${bid.fmt(r.max_byn)} — <a href="${r.url}">${r.title}</a>, сейчас ${bid.fmt(r.current_price)}, конец ${r.ends_at ? fmtDate(r.ends_at) : '?'}`);
  await tg('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true });
}

async function handleCallback(cb) {
  const data = cb.data || '';
  const chatId = String(cb.message?.chat?.id ?? cb.from.id);
  const msgId = cb.message?.message_id;

  if (data.startsWith('sub:')) {
    const key = data.slice(4);
    const monitor = MONITORS.find((m) => m.key === key);
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

main();
