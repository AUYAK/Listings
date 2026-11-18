// Аккаунт ay.by для снайп-ставок (sniper.js): сессия, вход, страница в контексте аккаунта. В избранное лоты
// больше не добавляются (2026-11-18): ставки заказываются ответом на карточку.
// Вход в аккаунт — один из двух способов:
//   1) node ayby-login.js на сервере: открывается окно браузера, пользователь входит сам, cookies сохраняются
//      в AYBY_SESSION_FILE (пароль нигде не хранится; при протухании сессии — повторить);
//   2) AYBY_LOGIN / AYBY_PASSWORD в .env: вход выполняется автоматически, когда сессия протухла.
// Аккаунт живёт в отдельном контексте браузера, чтобы сканирование сотен страниц шло анонимно и не
// связывалось с учётной записью.
// Проверка сессии на сервере: node ayby-login.js --check

const fs = require('fs');
const path = require('path');

const LOGIN = process.env.AYBY_LOGIN || '';
const PASSWORD = process.env.AYBY_PASSWORD || '';
const SESSION_FILE = process.env.AYBY_SESSION_FILE || path.join(__dirname, '..', 'ayby-session.json');
const LOGIN_URL = 'https://ay.by/personal/login.phtml';
const FAVORITES_URL = 'https://ay.by/personal/favorite_lists.phtml';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const NAV_TIMEOUT = parseInt(process.env.COINS_NAV_TIMEOUT_MS || '30000', 10);

const hasCredentials = () => Boolean(LOGIN && PASSWORD);
const hasSession = () => fs.existsSync(SESSION_FILE);
const enabled = () => hasCredentials() || hasSession();
const RELOGIN_HINT = `сессия ay.by не активна — выполните на сервере: node ayby-login.js`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`  [Favorites] ${msg}`);

let context = null; // контекст аккаунта на время цикла
let loggedIn = false;

// Страница «Verification» (проверка на бота) в обычном браузере сама переходит на запрошенную страницу
// за несколько секунд — ждём до 10 с, и только потом считаем, что нас не пускают
async function assertNotVerification(page) {
  for (let i = 0; i < 10 && (await page.title().catch(() => '')) === 'Verification'; i++) await pause(1000);
  if ((await page.title().catch(() => '')) === 'Verification') throw new Error('HTTP 403: ay.by verification page (bot check)');
}

// AYBY_CDP=9222 — вместо своего контекста подключиться к обычному Chrome/Edge, запущенному с
// --remote-debugging-port (локальная отладка: такой браузер проходит проверку ay.by на бота)
let cdpBrowser = null;

async function open(browser) {
  if (!enabled() || context) return;
  if (process.env.AYBY_CDP) {
    const { chromium } = require('playwright');
    cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.AYBY_CDP}`, { timeout: 5000 });
    context = cdpBrowser.contexts()[0];
    if (!context) throw new Error('в браузере на порту AYBY_CDP нет окон');
    log(`работаем через браузер на порту ${process.env.AYBY_CDP}`);
  } else {
    const storageState = fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined;
    context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ru-BY', storageState });
  }
  loggedIn = false;
}

async function close() {
  if (!context) return;
  if (cdpBrowser) { await cdpBrowser.close().catch(() => {}); cdpBrowser = null; } // отключаемся, окно остаётся
  else await context.close().catch(() => {});
  context = null;
  loggedIn = false;
}

// В файл сессии — только cookies ay.by
async function saveSession() {
  if (!context) return;
  try {
    const state = await context.storageState();
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      nick: savedNick(),
      cookies: (state.cookies || []).filter((c) => /(^|\.)ay\.by$/.test(c.domain)),
      origins: (state.origins || []).filter((o) => /ay\.by/.test(o.origin)),
    }, null, 2));
  } catch (err) {
    log(`сессия не сохранена: ${err.message}`);
  }
}

// Пользователь вошёл, если страница избранного открывается без отдельной страницы входа. Без входа ay.by
// не перенаправляет на login.phtml, а отдаёт страницу входа (#auth-layout, заголовок «Беларусь. Минск») по тому же
// адресу. Скрытый попап входа (#loginPopup, cl_psw) встроен во все страницы — на него смотреть нельзя.
async function isLoggedIn(page) {
  await page.goto(FAVORITES_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await assertNotVerification(page);
  if (/login\.phtml/.test(page.url())) return false;
  return !(await page.evaluate(() => Boolean(document.querySelector('#auth-layout'))));
}

// Ник аккаунта: заголовок личного кабинета https://ay.by/personal/ — это ник (например, «Wolf71»)
async function accountNick(page) {
  await page.goto('https://ay.by/personal/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await assertNotVerification(page);
  if (/login\.phtml/.test(page.url())) return null;
  const title = (await page.title().catch(() => '')).trim();
  return title && title.length <= 40 && !/ay\.by|Минск|Беларусь/i.test(title) ? title : null;
}

// Ник из файла сессии (записывает ayby-login.js / saveSession), если AYBY_NICK не задан
function savedNick() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).nick || null; } catch { return null; }
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

// Страница в контексте аккаунта без проверки входа (отладка)
async function rawPage() {
  if (!context) throw new Error('контекст аккаунта не открыт (favorites.open(browser))');
  return context.newPage();
}

// Страница в контексте аккаунта (для снайп-ставок: sniper.js, debug-ayby.js); вход выполняется при необходимости
async function newPage() {
  const page = await rawPage();
  try { await ensureLoggedIn(page); } catch (err) { await page.close().catch(() => {}); throw err; }
  return page;
}

module.exports = {
  enabled, hasCredentials, hasSession, open, close, login, isLoggedIn, accountNick, savedNick, ensureLoggedIn, newPage, rawPage, saveSession,
  assertNotVerification, SESSION_FILE, LOGIN_URL, FAVORITES_URL, LOGIN, USER_AGENT, RELOGIN_HINT,
};
