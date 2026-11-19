// Снайп-ставки ay.by: разбор ответа в Telegram («150», «макс 150», «отмена»), чтение состояния лота
// (таймер, цена, минимальная ставка) и сама ставка через форму лота.
// ay.by работает по системе максимальных ставок без продления торгов: мы вводим свой максимум, площадка
// сама держит цену на шаг выше чужой. Поэтому ставка один раз, за SNIPE_SECONDS до конца, на весь максимум.
// Форма лота: поле суммы (предзаполнено минимальной ценой) → «Сделать ставку» → «Я согласен с правилами…
// Это моя максимальная ставка.» → «Да, сделать ставку». Проверка на сервере: node debug-ayby.js <url лота> --bid <мин. ставка>

const { assertNotVerification } = require('./favorites');
const { parsePrice } = require('./ayby');

const SNIPE_SECONDS = parseInt(process.env.SNIPE_SECONDS || '30', 10);
const NAV_TIMEOUT = parseInt(process.env.COINS_NAV_TIMEOUT_MS || '30000', 10);
const BID_BUTTON = /^\s*Сделать ставку\s*$/;
const CONFIRM_BUTTON = /Да,\s*сделать ставку/;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => `${Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} р.`;

// «150», «150 р», «150,50 руб.», «макс 150», «мц 150», «до 150» → { max }; «отмена», «стоп», «0» → { cancel }; иначе null
function parseBidReply(text) {
  const t = (text || '').trim().toLowerCase().replace(/ё/g, 'е');
  if (!t) return null;
  if (/^(?:отмена|отменить|отмени|стоп|нет|0)[.!]*$/.test(t)) return { cancel: true };
  const m = t.match(/^(?:макс(?:имум)?\.?|мц|до|ставка|снайп|max)?\s*(\d{1,3}(?:[  ]\d{3})+|\d{1,6}(?:[.,]\d{1,2})?)\s*(?:р\.?|руб\.?|рубл\p{L}*|byn|бел\.?\s*руб\.?)?[.!]*$/u);
  if (!m) return null;
  const max = Math.round(parseFloat(m[1].replace(/[  ]/g, '').replace(',', '.')) * 100) / 100;
  return max > 0 ? { max } : null;
}

// Некруглый довесок к максимуму. На ay.by побеждает больший максимум с любым перевесом, а цена — не выше своего
// максимума: 13,03 р. обходит 13 р. (ay.by 5041986585, 18.11.2026). По 810 раскрытым максимумам 150 торгов: 85% —
// целые рубли, 7% — «,50»; от 50 р. половина ставок кратна 5, ещё 15–22% — «круглое + 1» (81, 86, 151). Довесок
// ставит нас выше и тех, и других: до 10 р. — 0,07; до 50 р. — 0,57 (выше «,50»); от 50 р. — 1,07 (выше «+1»).
// Только к круглому максимуму (целые рубли или «,50»): 81,58 от человека — уже его выбор. SNIPE_ODD=0 — выключить.
// Предохранитель: довесок не больше ODD_MAX_ADD рублей и ODD_MAX_SHARE от максимума, иначе ставится сам максимум.
const ODD = process.env.SNIPE_ODD !== '0';
const ODD_MAX_ADD = 1.07;
const ODD_MAX_SHARE = 0.06;
function oddAmount(max) {
  const m = Math.round(Number(max) * 100) / 100;
  if (!ODD || !(m > 0)) return m;
  const kop = Math.round((m - Math.floor(m)) * 100);
  if (kop !== 0 && kop !== 50) return m;
  const add = m < 10 ? 0.07 : m < 50 ? 0.57 : 1.07;
  const out = Math.round((m + add) * 100) / 100;
  return out > m && out - m <= ODD_MAX_ADD + 1e-9 && out - m <= m * ODD_MAX_SHARE + 1e-9 ? out : m;
}

// Состояние лота для снайпа. Внутри evaluate — только циклы (Prototype.js на ay.by подменяет методы массивов).
async function readLotState(page) {
  const raw = await page.evaluate(() => {
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const out = {};
    const timer = document.querySelector('#lot-timer');
    out.timerSeconds = timer && timer.getAttribute('data-time') ? parseInt(timer.getAttribute('data-time'), 10) : null;
    const control = document.querySelector('.b-lot-control');
    out.controlText = text(control);
    const mains = document.querySelectorAll('.b-lot-control__main');
    out.priceText = null;
    for (let i = 0; i < mains.length; i++) { const t = text(mains[i]); if (t && /\d/.test(t) && /руб/.test(t)) { out.priceText = t; break; } }
    const body = (document.body.innerText || '').replace(/\s+/g, ' ');
    // минимальная ставка: data-min поля суммы (#lot-input), запасной вариант — текст «Минимальная цена N бел. руб.»
    const lotInput = document.querySelector('#lot-input, .b-lot-control input[name="cost"]');
    out.minText = (lotInput && lotInput.getAttribute('data-min')) || (body.match(/Минимальная цена\s*([\d\s.,]+)\s*бел/) || [null, null])[1];
    out.reserveNotMet = /Минимальная цена не пройдена/.test(body); // резерв продавца не достигнут
    out.hasBidButton = /Сделать ставку/.test(out.controlText);
    out.soldText = (body.match(/Лот продан за\s*[\d\s.,]+\s*бел\.?\s*руб\.?[^.]{0,120}/) || [null])[0];
    out.unsoldText = (body.match(/(?:Лот не продан|Торги завершены без ставок|Лот снят с торгов|Лот отменён|Лот отменен)[^.]{0,60}/) || [null])[0];
    out.winner = (body.match(/победитель\s+([^\s.,]+)/i) || [null, null])[1];
    const bidBtn = document.querySelector('.lot-rates-modal-btn');
    out.bidsText = text(bidBtn);
    out.yours = /Ваша ставка|Вы лидируете|Ваша максимальная ставка|Вы — лидер|Вы лидер/i.test(body);
    out.inputs = [];
    const inputs = control ? control.querySelectorAll('input') : [];
    for (let i = 0; i < inputs.length; i++) {
      const el = inputs[i];
      if (/hidden|checkbox|radio|submit|button/.test(el.type)) continue;
      out.inputs.push({ name: el.name || '', id: el.id || '', type: el.type, value: el.value || '', placeholder: el.placeholder || '' });
    }
    // только ошибки ставки: «Войдите с помощью своего профиля Вконтакте…» — текст окна входа, которое есть на каждой
    // странице и у вошедшего пользователя (2026-11-14: ставка прошла, а бот сообщил «не поставлена»)
    out.errorText = (body.match(/(?:Ставка должна быть|Недостаточно|необходимо войти|Ошибка при|Ошибка:|Вы не можете)[^.]{0,100}/i) || [null])[0];
    return out;
  });
  const ended = Boolean(raw.soldText || raw.unsoldText) || raw.timerSeconds == null || raw.timerSeconds <= 0;
  return {
    ...raw,
    ended,
    remaining: ended ? 0 : raw.timerSeconds,
    price: parsePrice(raw.soldText ? raw.soldText.match(/за\s*([\d\s.,]+)/)[1] : raw.priceText),
    minBid: parsePrice(raw.minText),
    bids: raw.bidsText ? parseInt((raw.bidsText.match(/\d+/) || ['0'])[0], 10) : 0,
  };
}

async function openLot(page, url) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await assertNotVerification(page);
  await page.waitForSelector('.b-lot-title__title, .b-lot-control', { timeout: 10000 }).catch(() => {});
  const state = await readLotState(page);
  state.httpStatus = resp ? resp.status() : 0;
  state.hasLot = await page.evaluate(() => Boolean(document.querySelector('.b-lot-title__title, .b-lot-control, #lot-timer')));
  return state;
}

// Ставка: заполнить сумму, «Сделать ставку», (пауза beforeConfirm — ждём момента), «Да, сделать ставку».
// confirm=false — только открыть подтверждение и вернуть его текст (отладка).
async function placeBid(page, amount, { confirm = true, beforeConfirm = null } = {}) {
  // Разметка ay.by (проверено 2026-11-06): form#lot-rate-form → input#lot-input[name=cost] (data-min — минимальная
  // ставка), кнопка «Сделать ставку» button.show-popup, подтверждение «Да, сделать ставку» button[data-form="#lot-rate-form"]
  const control = page.locator('.b-lot-control');
  let input = page.locator('#lot-input, .b-lot-control input[name="cost"]').first();
  if (!(await input.count())) input = control.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])').first();
  if (!(await input.count())) throw new Error('поле суммы ставки не найдено в .b-lot-control');
  const min = parseFloat(await input.getAttribute('data-min').catch(() => '') || '0') || 0;
  if (min && amount < min) throw new Error(`сумма ${amount} ниже минимальной ставки ${min}`);
  const value = Number.isInteger(Number(amount)) ? String(amount) : Number(amount).toFixed(2).replace('.', ',');
  await input.fill(value);
  await input.dispatchEvent('change').catch(() => {});
  let btn = control.locator('button.show-popup').first();
  if (!(await btn.count())) btn = control.getByText(BID_BUTTON).first();
  if (!(await btn.count())) btn = page.getByText(BID_BUTTON).first();
  if (!(await btn.count())) throw new Error('кнопка «Сделать ставку» не найдена');
  await btn.click({ timeout: 10000 });
  let yes = page.locator('button[data-form="#lot-rate-form"]').first();
  if (!(await yes.count())) yes = page.getByText(CONFIRM_BUTTON).first();
  // подтверждение не появилось — понятная причина вместо «locator.waitFor: Timeout…»: ошибка ставки на странице
  // или текст открытого окна (ay.by мог показать другое окно: ограничения продавца, вход и т. п.)
  await yes.waitFor({ timeout: 10000 }).catch(async () => {
    const st = await readLotState(page).catch(() => null);
    const popup = await page.evaluate(() => {
      const els = document.querySelectorAll('[class*="popup"], [class*="modal"], [role="dialog"]');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const r = el.getBoundingClientRect();
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (r.width > 0 && r.height > 0 && t && !/Войдите с помощью/.test(t)) return t.slice(0, 160);
      }
      return '';
    }).catch(() => '');
    const why = (st && st.errorText) || popup;
    throw new Error(`после «Сделать ставку» не появилось подтверждение «Да, сделать ставку»${why ? ` — на странице: «${why}»` : ''}`);
  });
  const consent = (await page.getByText(/Я согласен с правилами/).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  // если в подтверждении есть чекбокс согласия — отметить
  const boxes = page.locator('input[type="checkbox"]');
  for (let i = 0; i < await boxes.count(); i++) {
    const b = boxes.nth(i);
    if (await b.isVisible().catch(() => false) && !(await b.isChecked().catch(() => true))) await b.check().catch(() => {});
  }
  if (!confirm) return { confirmed: false, value, consent };
  if (beforeConfirm) await beforeConfirm();
  const clickedAt = new Date();
  await yes.click({ timeout: 10000 });
  await pause(2500);
  const state = await readLotState(page);
  return { confirmed: true, value, consent, clickedAt, state, ok: !state.errorText && !/login\.phtml/.test(page.url()) };
}

module.exports = { parseBidReply, oddAmount, readLotState, openLot, placeBid, fmt, pause, SNIPE_SECONDS, BID_BUTTON, CONFIRM_BUTTON };
