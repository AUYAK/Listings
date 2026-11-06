# Listings — мониторинг Kufar и ay.by с уведомлениями в Telegram

Серебряные и золотые монеты (Российская империя, СССР) на ay.by и Kufar: новые лоты оцениваются по архиву
проходов gdenashel.ru, Numista, нашей базе и стоимости металла (НБРБ); выгодные уходят карточкой в Telegram,
добавляются в избранное аккаунта ay.by, а по ответу на карточку числом снайпер ставит максимальную ставку
за 30 с до конца торгов. Плюс простые мониторы Kufar (iPhone, компьютеры).

## Процессы (pm2)

| Процесс | Файл | Что делает |
|---|---|---|
| `listings-monitor` | `listings.js` | Kufar: новые объявления, оценка монет, проверка проданных |
| `coins-monitor` | `coins.js` | ay.by: разделы → лоты → оценка → уведомления → итоги торгов, избранное |
| `listings-poll` | `poll.js` | Telegram-бот: `/settings`, 👍, ответ числом на карточку = заявка на ставку, `/bids` |
| `coins-sniper` | `sniper.js` | ставит заявленный максимум за `SNIPE_SECONDS` до конца, отчитывается |

Что перезапускать после правки: `coins/*`, `telegram.js` → `coins-monitor` и `listings-monitor`
(`coins/bid.js`, `coins/store.js`, `coins/favorites.js` — ещё `listings-poll`, `coins-sniper`);
`listings.js`, `store.js` → `listings-monitor` (`store.js` — ещё `listings-poll`, `coins-sniper`);
`config.js` → все; `poll.js` → `listings-poll`; `sniper.js` → `coins-sniper`.

## Файлы

- `config.js` — мониторы (разделы, металлы, страны, получатели).
- `store.js` — общие таблицы (`listings.*`), `coins/store.js` — лоты, продажи, каталог, заявки на ставки.
- `coins/ayby.js` — скрапер ay.by; `coins/parse.js` — разбор монеты из заголовка; `coins/market.js` — оценка
  и текст карточки; `coins/metal.js` — содержание металла; `coins/rates.js` — курсы и цены металлов НБРБ;
  `coins/gdenashel.js`, `coins/numista.js` — внешние источники цен; `coins/photos.js` — фото на диске.
- `coins/favorites.js` — аккаунт ay.by (сессия, избранное); `coins/bid.js` — форма ставки, разбор ответа в Telegram.
- `load-catalog.js` — загрузка проходов gdenashel (`--only zoloto`, `--rebuild-only`).
- `coin-funnel.js` — почему лоты не попали в уведомления (`--days 7`).
- `ayby-login.js` — вход в ay.by без пароля в `.env`: `--cdp 9222` (через обычный Chrome), `--import cookies.txt`.
- `debug-list.js`, `debug-lot.js`, `debug-favorite.js`, `debug-bid.js` — проверка страниц ay.by на сервере.
- `test-coins.js` — `npm test`.
- `migrations/` — применять от `lo_admin` по порядку; все идемпотентны.

## Установка

```powershell
npm install
npx playwright install chromium
copy .env.example .env   # заполнить
psql -U lo_admin -d БАЗА -f migrations\001_listings_base.sql   # и далее 006, 011, 012, 013, 014
pm2 start listings.js --name listings-monitor
pm2 start coins.js --name coins-monitor
pm2 start poll.js --name listings-poll
pm2 start sniper.js --name coins-sniper
pm2 save
```

## Аккаунт ay.by (избранное и ставки)

Вход через Google, пароль нигде не хранится. На машине с рабочим столом:

```powershell
# 1. обычный Chrome с отладочным портом (из Win+R или PowerShell)
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\ayby-profile https://ay.by/personal/login.phtml
# 2. войти в этом окне, затем
node ayby-login.js --cdp 9222 --now
```

Получится `ayby-session.json` (cookies ay.by и ник) — его копируют на сервер. Когда сессия протухнет,
бот напишет «сессия ay.by не активна», процедуру повторить. Проверка: `node debug-favorite.js <url лота> --no-click`,
сухой прогон ставки: `node debug-bid.js <url лота> --amount <минимальная ставка>` (без `--confirm` не ставит).

## Ставки из Telegram

Ответ на карточку лота числом («150», «макс 150») — максимальная ставка; «отмена» снимает заявку; `/bids` —
активные заявки. ay.by работает по системе максимальных ставок без продления торгов, поэтому одна ставка на весь
максимум за 30 с до конца — оптимальная стратегия. Заказывать ставки могут только чаты из `SNIPE_CHAT_IDS`
(по умолчанию `TELEGRAM_CHAT_IDS`).
