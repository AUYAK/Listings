// Вход в ay.by руками, без пароля в .env: node ayby-login.js
// Открывает окно браузера на странице входа (нужен рабочий стол сервера, RDP). Войдите, желательно с галочкой
// «Запомнить меня». Скрипт сам заметит вход, сохранит cookies в AYBY_SESSION_FILE (по умолчанию
// ./ayby-session.json) и закроется. Дальше избранное и снайпер работают по этому файлу.
// Когда сессия протухнет (бот напишет «сессия ay.by не активна»), повторить.
require('dotenv').config();
const path = require('path');
const { chromium } = require('playwright');
const fav = require('./coins/favorites');

const WAIT_MIN = parseInt(process.env.AYBY_LOGIN_WAIT_MIN || '10', 10);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--window-size=1100,900'] });
  const context = await browser.newContext({
    userAgent: fav.USER_AGENT, locale: 'ru-BY', viewport: null,
    storageState: fav.hasSession() ? fav.SESSION_FILE : undefined,
  });
  const page = await context.newPage();
  try {
    // уже вошли по старому файлу — просто обновим его
    if (fav.hasSession() && await fav.isLoggedIn(page)) {
      await context.storageState({ path: fav.SESSION_FILE });
      console.log(`сессия ещё жива, файл обновлён: ${fav.SESSION_FILE}`);
      return;
    }
    await page.goto(fav.LOGIN_URL, { waitUntil: 'domcontentloaded' });
    console.log(`Войдите в ay.by в открывшемся окне (жду до ${WAIT_MIN} мин). Галочка «Запомнить меня» продлит сессию.`);
    const deadline = Date.now() + WAIT_MIN * 60000;
    let ok = false;
    while (Date.now() < deadline) {
      await pause(2000);
      const signedIn = await page.evaluate(() => {
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        return /logout|Выйти/i.test(html) && !/login\.phtml\?act_login=register/.test(location.href) && !document.querySelector('input[type="password"]');
      }).catch(() => false);
      if (!signedIn) continue;
      // подтверждаем через страницу избранного в отдельной вкладке, чтобы не трогать окно пользователя
      const check = await context.newPage();
      ok = await fav.isLoggedIn(check).catch(() => false);
      await check.close();
      if (ok) break;
    }
    if (!ok) { console.error('вход не замечен, файл сессии не изменён'); process.exitCode = 1; return; }
    await context.storageState({ path: fav.SESSION_FILE });
    console.log(`вход замечен, сессия сохранена: ${path.resolve(fav.SESSION_FILE)}`);
    console.log('проверка: node debug-favorite.js "<url лота>" --no-click');
  } finally {
    await browser.close();
  }
})();
