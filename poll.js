require('dotenv').config();
const store = require('./store');
const { MONITORS } = require('./config');
const stats = require('./stats');

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
  } else if (/^\/stats(@\w+)?(\s|$)/.test(text)) {
    console.log(`[Stats] /stats from chat=${chatId}`);
    await sendStats(chatId);
  }
}

// Market summary for the first monitor with market=true; period buttons switch the view in place
async function sendStats(chatId) {
  const monitor = MONITORS.find((m) => m.market);
  if (!monitor) {
    await tg('sendMessage', { chat_id: chatId, text: 'Статистика пока не ведётся ни по одной категории.' });
    return;
  }
  try {
    const { text, keyboard } = await stats.buildStats(monitor, stats.PERIODS[0].days);
    await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    console.error('[Stats] failed:', err.message);
    await tg('sendMessage', { chat_id: chatId, text: 'Не удалось посчитать статистику, попробуйте позже.' });
  }
}

async function handleCallback(cb) {
  const data = cb.data || '';
  const chatId = String(cb.message?.chat?.id ?? cb.from.id);
  const msgId = cb.message?.message_id;

  if (data.startsWith('stats:')) {
    const [, key, daysStr] = data.split(':');
    const monitor = MONITORS.find((m) => m.key === key && m.market);
    if (!monitor) {
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Категория больше не отслеживается' });
      return;
    }
    const days = parseInt(daysStr, 10) || 0;
    try {
      const { text, keyboard } = await stats.buildStats(monitor, days);
      if (msgId) await tg('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: keyboard });
      await tg('answerCallbackQuery', { callback_query_id: cb.id });
    } catch (err) {
      console.error('[Stats] failed:', err.message);
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Не удалось посчитать статистику' });
    }
    return;
  }

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
      { command: 'stats', description: 'Статистика рынка: что ушло, цены, тренд' },
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
