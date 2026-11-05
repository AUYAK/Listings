// Избранное ay.by: выгодный лот добавляется в избранное аккаунта (AYBY_LOGIN / AYBY_PASSWORD в .env).
// Аккаунт живёт в отдельном контексте браузера, чтобы сканирование сотен страниц шло анонимно и не
// связывалось с учётной записью. Сессия (cookies) сохраняется в AYBY_SESSION_FILE и переживает перезапуски,
// вход выполняется только когда сессия протухла.
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

const enabled = () => Boolean(LOGIN && PASSWORD);
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
  await login(page);
  loggedIn = true;
}

// Лот в избранном? Страница избранного содержит ссылки на лоты с их числовым id
async function hasFavorite(page, lotId) {
  await page.goto(FAVORITES_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await assertNotVerification(page);
  const html = await page.content();
  return html.includes(`-${lotId}.html`) || new RegExp(`lot[_/=-]?id\\D{0,5}${lotId}(?!\\d)`).test(html);
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
    const r = await clickFavorite(page, lotUrl);
    if (!r.clicked && !r.already) return { ok: false, note: 'кнопка «В избранное» не найдена' };
    if (/login\.phtml/.test(r.url || '')) { loggedIn = false; return { ok: false, note: 'сессия слетела, перенаправило на вход' }; }
    if (await hasFavorite(page, lotId)) { await saveSession(); return { ok: true, note: r.after && r.after !== r.before ? `кнопка: «${r.after}»` : 'добавлено' }; }
    return { ok: false, note: `нажали «${r.before}», но в списке избранного лота нет (после нажатия: «${r.after}»)` };
  } catch (err) {
    if (/вход не удался|verification/i.test(err.message)) loggedIn = false;
    return { ok: false, note: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { enabled, open, close, add, login, isLoggedIn, hasFavorite, clickFavorite, ensureLoggedIn, FAV_BUTTON, SESSION_FILE, LOGIN_URL, FAVORITES_URL };
