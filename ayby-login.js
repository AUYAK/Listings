// Вход в ay.by без пароля в .env: сессия (cookies) сохраняется в AYBY_SESSION_FILE (./ayby-session.json),
// дальше избранное и снайпер работают по ней. Когда сессия протухнет (бот напишет «сессия ay.by не активна»),
// повторить. В файл попадают только cookies домена ay.by.
//
// Три способа (нужен рабочий стол сервера, RDP):
//   node ayby-login.js --cdp 9222
//       Вход через Google: Google не пускает в браузер под управлением Playwright, поэтому входим в обычном
//       Edge/Chrome, запущенном с отладочным портом, а скрипт забирает cookies оттуда. Сначала запустить браузер:
//         Start-Process msedge.exe -ArgumentList '--remote-debugging-port=9222','--user-data-dir=C:\ayby-profile','https://ay.by/personal/login.phtml'
//       (или chrome.exe), войти в ay.by в этом окне, затем запустить скрипт. После — окно можно закрыть.
//   node ayby-login.js
//       Открывает своё окно браузера на странице входа; подходит для входа по логину/паролю (не Google).
//   node ayby-login.js --import cookies.txt
//       Импорт cookies ay.by, выгруженных расширением вроде «Get cookies.txt LOCALLY» (формат Netscape),
//       либо строкой из DevTools: --import "PHPSESSID=…; other=…"
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const fav = require('./coins/favorites');

const args = process.argv.slice(2);
const argAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const WAIT_MIN = parseInt(process.env.AYBY_LOGIN_WAIT_MIN || '10', 10);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// В файл сессии — только ay.by
function onlyAyby(state) {
  return {
    cookies: (state.cookies || []).filter((c) => /(^|\.)ay\.by$/.test(c.domain)),
    origins: (state.origins || []).filter((o) => /ay\.by/.test(o.origin)),
  };
}

async function saveState(context) {
  const state = onlyAyby(await context.storageState());
  if (!state.cookies.length) throw new Error('cookies ay.by не найдены — вход не выполнен?');
  fs.writeFileSync(fav.SESSION_FILE, JSON.stringify(state, null, 2));
  console.log(`сессия сохранена: ${path.resolve(fav.SESSION_FILE)} (${state.cookies.length} cookies)`);
}

// Проверка файла сессии отдельным headless-браузером
async function verifySaved() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: fav.USER_AGENT, locale: 'ru-BY', storageState: fav.SESSION_FILE });
    const page = await context.newPage();
    const ok = await fav.isLoggedIn(page);
    console.log(ok ? 'проверка: вход по сохранённой сессии работает ✅' : 'проверка: по сохранённой сессии ay.by НЕ считает нас вошедшими ❌');
    return ok;
  } finally {
    await browser.close();
  }
}

// Ждём, пока в контексте появится вход (страница избранного открывается без редиректа), проверяя в отдельной вкладке
async function waitForLogin(context) {
  const deadline = Date.now() + WAIT_MIN * 60000;
  console.log(`Войдите в ay.by в окне браузера (жду до ${WAIT_MIN} мин). Галочка «Запомнить меня» продлит сессию.`);
  while (Date.now() < deadline) {
    await pause(3000);
    const check = await context.newPage();
    try {
      if (await fav.isLoggedIn(check)) return true;
    } catch (err) {
      console.log(`  ${err.message}`);
    } finally {
      await check.close().catch(() => {});
    }
  }
  return false;
}

// --cdp: обычный Edge/Chrome с отладочным портом
async function viaCdp(port) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (err) {
    console.error(`не удалось подключиться к браузеру на порту ${port}: ${err.message}`);
    console.error(`сначала запустите: Start-Process msedge.exe -ArgumentList '--remote-debugging-port=${port}','--user-data-dir=C:\\ayby-profile','${fav.LOGIN_URL}'`);
    process.exitCode = 1;
    return;
  }
  const context = browser.contexts()[0];
  if (!context) { console.error('в браузере нет открытых окон'); process.exitCode = 1; return; }
  try {
    const ok = await waitForLogin(context);
    if (!ok) { console.error('вход не замечен, файл сессии не изменён'); process.exitCode = 1; return; }
    await saveState(context);
  } finally {
    await browser.close().catch(() => {}); // отключаемся; само окно браузера остаётся, его можно закрыть
  }
  await verifySaved();
}

// --import: Netscape cookies.txt или строка «name=value; name2=value2»
function parseCookies(arg) {
  const text = fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg;
  const cookies = [];
  if (/\t/.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const [domain, , cpath, secure, expires, name, value] = line.split('\t');
      if (!name || !/ay\.by$/.test(domain)) continue;
      cookies.push({ name, value: (value || '').trim(), domain, path: cpath || '/', expires: expires ? parseInt(expires, 10) : -1, httpOnly: false, secure: secure === 'TRUE', sameSite: 'Lax' });
    }
  } else {
    for (const part of text.split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i <= 0) continue;
      cookies.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), domain: '.ay.by', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' });
    }
  }
  return cookies;
}

async function viaImport(arg) {
  const cookies = parseCookies(arg);
  if (!cookies.length) { console.error('cookies ay.by в импорте не найдены'); process.exitCode = 1; return; }
  fs.writeFileSync(fav.SESSION_FILE, JSON.stringify({ cookies, origins: [] }, null, 2));
  console.log(`импортировано ${cookies.length} cookies → ${path.resolve(fav.SESSION_FILE)}`);
  if (!(await verifySaved())) process.exitCode = 1;
}

// по умолчанию: своё окно браузера (вход по логину/паролю)
async function viaWindow() {
  const browser = await chromium.launch({ headless: false, args: ['--window-size=1100,900'] });
  const context = await browser.newContext({
    userAgent: fav.USER_AGENT, locale: 'ru-BY', viewport: null,
    storageState: fav.hasSession() ? fav.SESSION_FILE : undefined,
  });
  try {
    const page = await context.newPage();
    if (fav.hasSession() && await fav.isLoggedIn(page)) { await saveState(context); console.log('сессия ещё жива, файл обновлён'); return; }
    await page.goto(fav.LOGIN_URL, { waitUntil: 'domcontentloaded' });
    console.log('Если входите через Google и видите «недоверенный браузер» — используйте способ --cdp (см. шапку файла).');
    const ok = await waitForLogin(context);
    if (!ok) { console.error('вход не замечен, файл сессии не изменён'); process.exitCode = 1; return; }
    await saveState(context);
  } finally {
    await browser.close();
  }
  await verifySaved();
}

(async () => {
  if (argAfter('--cdp')) await viaCdp(parseInt(argAfter('--cdp'), 10));
  else if (argAfter('--import')) await viaImport(argAfter('--import'));
  else await viaWindow();
})().catch((err) => { console.error(`ошибка: ${err.message}`); process.exit(1); });
