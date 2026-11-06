// Избранное ay.by: выгодный лот добавляется в избранное аккаунта.
// Вход в аккаунт — один из двух способов:
//   1) node ayby-login.js на сервере: открывается окно браузера, пользователь входит сам, cookies сохраняются
//      в AYBY_SESSION_FILE (пароль нигде не хранится; при протухании сессии — повторить);
//   2) AYBY_LOGIN / AYBY_PASSWORD в .env: вход выполняется автоматически, когда сессия протухла.
// Аккаунт живёт в отдельном контексте браузера, чтобы сканирование сотен страниц шло анонимно и не
// связывалось с учётной записью.
// Проверка результата — не по кнопке, а по странице «Избранное»: там должен появиться id лота.
// Отладка на сервере: node debug-favorite.js <url лота>

const fs = require('fs');
const path = require('path');

const LOGIN = process.env.AYBY_LOGIN || '';
const PASSWORD = process.env.AYBY_PASSWORD || '';
const SESSION_FILE = process.env.AYBY_SESSION_FILE || path.join(__dirname, '..', 'ayby-session.json');
const LOGIN_URL = 'https://ay.by/personal/login.phtml';
const FAVORITES_URL = 'https://ay.by/personal/favorite_lists.phtml';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const NAV_TIMEOUT = parseInt(process.env.COINS_NAV_TIMEOUT_MS || '30000', 10);
const FAV_BUTTON = /^\s*(?:добавить\s+)?в\s+избранное\s*$/i;

const hasCredentials = () => Boolean(LOGIN && PASSWORD);
const hasSession = () => fs.existsSync(SESSION_FILE);
const enabled = () => hasCredentials() || hasSession();
const RELOGIN_HINT = `сессия ay.by не активна — выполните на сервере: node ayby-login.js`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`  [Favorites] ${msg}`);

let context = null; // контекст аккаунта на время цикла
let loggedIn = false;

async function assertNotVerification(page) {
  if ((await page.title().catch(() => '')) === 'Verification') throw new Error('HTTP 403: ay.by verification page (bot check)');
}

async function open(browser) {
  if (!enabled() || context) return;
  const storageState = fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined;
  context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ru-BY', storageState });
  loggedIn = false;
}

async function close() {
  if (!context) return;
  await context.close().catch(() => {});
  context = null;
  loggedIn = false;
}

async function saveSession() {
  if (context) await context.storageState({ path: SESSION_FILE }).catch((err) => log(`сессия не сохранена: ${err.message}`));
}

// Пользователь вошёл, если страница избранного открывается без редиректа на вход
async function isLoggedIn(page) {
  await page.goto(FAVORITES_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await assertNotVerification(page);
  return !/login\.phtml/.test(page.url());
}

// Форма входа: ищем поле пароля, логин — первое текстовое поле той же формы
async function login(page) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await assertNotVerification(page);
  const pw = page.locator('input[type="password"]').first();
  await pw.waitFor({ timeout: 10000 });
  const form = pw.locator('xpath=ancestor::form[1]');
  const user = form.locator('input[type="text"], input[type="email"], input[type="tel"], input:not([type])').first();
  await user.fill(LOGIN);
  await pw.fill(PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {}),
    pw.press('Enter'),
  ]);
  await pause(1500);
  await assertNotVerification(page);
  if (!(await isLoggedIn(page))) {
    const hint = (await page.locator('form').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`вход не удался (${page.url()}): ${hint}`);
  }
  await saveSession();
  log(`вход выполнен как ${LOGIN}, сессия сохранена в ${path.basename(SESSION_FILE)}`);
}

async function ensureLoggedIn(page) {
  if (loggedIn) return;
  if (await isLoggedIn(page)) { loggedIn = true; return; }
  if (!hasCredentials()) throw new Error(RELOGIN_HINT);
  await login(page);
  loggedIn = true;
}

// Лот в избранном? Ищем id лота на странице избранного (ссылка на лот, element_id в ссылке удаления)
// и на страницах списков, на которые она ссылается.
const idInHtml = (html, lotId) => html.includes(`-${lotId}.html`) || new RegExp(`(?:element_id|lot_id|lot|id)[=/:-]${lotId}(?!\\d)`).test(html);
async function hasFavorite(page, lotId) {
  await page.goto(FAVORITES_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await assertNotVerification(page);
  const html = await page.content();
  if (idInHtml(html, lotId)) return true;
  // списки избранного: favorite_lists.phtml?list_id=… / ?id=… — первые несколько
  const lists = [...new Set((html.match(/https?:\/\/ay\.by\/personal\/favorite_lists\.phtml\?[^"'\s<>]+/g) || [])
    .filter((u) => !/action=/.test(u)).map((u) => u.replace(/&amp;/g, '&')))].slice(0, 5);
  for (const url of lists) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    if (idInHtml(await page.content(), lotId)) return true;
  }
  return false;
}

// Добавление через запрос, который шлёт сама кнопка «В избранное» (подсмотрен в debug-favorite.js):
// GET favorite_lists.phtml?action=element_insert&ajax=1&element_id=<id>&type=auction — с cookies аккаунта
async function insertFavorite(page, lotId, lotUrl) {
  const url = `${FAVORITES_URL}?action=element_insert&ajax=1&element_id=${lotId}&type=auction`;
  const resp = await page.request.get(url, { headers: { Referer: lotUrl || 'https://ay.by/', 'X-Requested-With': 'XMLHttpRequest' }, timeout: NAV_TIMEOUT });
  const body = (await resp.text().catch(() => '')).replace(/\s+/g, ' ').trim();
  return { status: resp.status(), url: resp.url(), body: body.slice(0, 300) };
}

// Кнопка «В избранное» на странице лота: нажать и вернуть её текст после нажатия
async function clickFavorite(page, lotUrl) {
  await page.goto(lotUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await assertNotVerification(page);
  await page.waitForSelector('.b-lot-title__title, .b-lot-control', { timeout: 10000 }).catch(() => {});
  const btn = page.getByText(FAV_BUTTON).first();
  if (!(await btn.count())) {
    const already = await page.getByText(/в избранном|удалить из избранного|убрать из избранного/i).first().count();
    return { clicked: false, already: already > 0 };
  }
  const before = (await btn.innerText().catch(() => '')).trim();
  await btn.click({ timeout: 10000 });
  await pause(2000);
  const after = (await btn.innerText().catch(() => '')).trim();
  return { clicked: true, before, after, url: page.url() };
}

// Добавить лот в избранное. Возвращает { ok, note }; никогда не бросает — уведомление важнее избранного.
async function add(lotUrl, lotId) {
  if (!enabled()) return { ok: false, note: 'выключено (нет AYBY_LOGIN/AYBY_PASSWORD)' };
  if (!context) return { ok: false, note: 'контекст аккаунта не открыт' };
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page);
    if (await hasFavorite(page, lotId)) return { ok: true, note: 'уже в избранном' };
    const ins = await insertFavorite(page, lotId, lotUrl);
    if (/login\.phtml/.test(ins.url)) { loggedIn = false; return { ok: false, note: 'сессия слетела, перенаправило на вход' }; }
    if (ins.status >= 400) return { ok: false, note: `запрос добавления вернул HTTP ${ins.status}` };
    if (await hasFavorite(page, lotId)) { await saveSession(); return { ok: true, note: 'добавлено' }; }
    // запрос прошёл, но в списке не видим: пробуем через кнопку на странице лота
    const r = await clickFavorite(page, lotUrl);
    if (r.clicked && await hasFavorite(page, lotId)) { await saveSession(); return { ok: true, note: 'добавлено (через кнопку)' }; }
    if (ins.status === 200 && !/ошибк|error|войти|login/i.test(ins.body)) return { ok: true, note: `запрос принят (HTTP 200), в списке не нашли: ${ins.body.slice(0, 80) || 'пустой ответ'}` };
    return { ok: false, note: `HTTP ${ins.status}: ${ins.body.slice(0, 120) || 'пустой ответ'}` };
  } catch (err) {
    if (/вход не удался|verification/i.test(err.message)) loggedIn = false;
    return { ok: false, note: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

// Страница в контексте аккаунта (для снайп-ставок: sniper.js, debug-bid.js); вход выполняется при необходимости
async function newPage() {
  if (!context) throw new Error('контекст аккаунта не открыт (favorites.open(browser))');
  const page = await context.newPage();
  try { await ensureLoggedIn(page); } catch (err) { await page.close().catch(() => {}); throw err; }
  return page;
}

module.exports = {
  enabled, hasCredentials, hasSession, open, close, add, login, isLoggedIn, hasFavorite, insertFavorite, clickFavorite, ensureLoggedIn, newPage, saveSession,
  assertNotVerification, FAV_BUTTON, SESSION_FILE, LOGIN_URL, FAVORITES_URL, LOGIN, USER_AGENT, RELOGIN_HINT,
};
