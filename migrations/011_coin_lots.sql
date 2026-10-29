-- Применять от lo_admin (владелец схемы listings), как и предыдущие миграции.

-- Монеты со всех площадок: строка на каждое объявление/лот из listings.listings (мониторы с domain='coins').
-- Kufar (source='kufar'): фиксированная цена, итог = исчезло с сайта. ay.by (source='ayby'): аукцион или
-- «купить сейчас», ставки, срок, состояние по шкале площадки, итог торгов. Цены — BYN.
CREATE TABLE IF NOT EXISTS listings.coin_lots (
  listing_id        INT PRIMARY KEY REFERENCES listings.listings(id) ON DELETE CASCADE,
  source            TEXT NOT NULL,            -- 'ayby' | 'kufar'
  section           TEXT,                     -- url раздела ay.by, где лот найден
  category_path     TEXT,                     -- «Монеты › Россия › Российская Империя › Николай II › Серебро (рубли)»
  sale_type         TEXT,                     -- 'auction' | 'buy_now' | 'auction_buynow' | 'fixed' (Kufar)
  condition_code    TEXT,                     -- шкала ay.by: '0', 'I', 'II+', 'II', 'III', 'IV'
  grade             TEXT,                     -- нормализованно: PF, UNC, AU, XF, VF, F, VG
  start_price       NUMERIC,                  -- цена при первом обнаружении
  current_price     NUMERIC,                  -- последняя увиденная цена / ставка
  bids              INT,
  bargain           BOOLEAN,                  -- «Возможен торг»
  ends_at           TIMESTAMPTZ,              -- аукцион: по таймеру лота
  ended_at          TIMESTAMPTZ,
  outcome           TEXT,                     -- 'sold' | 'unsold' | 'removed' | NULL (идёт)
  final_price       NUMERIC,
  final_bids        INT,
  end_status_text   TEXT,                     -- сырой текст статуса завершённого лота (для калибровки)
  seller            TEXT,
  seller_city       TEXT,
  views             INT,
  specs             JSONB,                    -- характеристики лота как есть
  description       TEXT,
  parsed            JSONB,                    -- разбор монеты: номинал, год, знак, правитель, металл, состояние, флаги
  photos            JSONB,
  -- оценка на момент обнаружения (и повторно перед уведомлением об окончании торгов)
  est_catalog       NUMERIC,                  -- каталожная цена для состояния лота, BYN
  est_catalog_src   TEXT,                     -- 'numista' | ...
  est_market        NUMERIC,                  -- наша медиана по похожим лотам того же состояния, BYN
  est_market_n      INT,
  est_reference     NUMERIC,                  -- с чем сравнивали (каталог, иначе рынок)
  deviation_pct     INT,                      -- (price − reference) / reference
  assessed_at       TIMESTAMPTZ,
  detail_fetched_at TIMESTAMPTZ,              -- NULL = известна только карточка списка
  notified_at       TIMESTAMPTZ,              -- когда ушло уведомление (аукционы — только за ≤12 ч до конца)
  checked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coin_lots_open   ON listings.coin_lots (ends_at) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_coin_lots_detail ON listings.coin_lots (detail_fetched_at) WHERE detail_fetched_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_coin_lots_grade  ON listings.coin_lots (grade);
CREATE INDEX IF NOT EXISTS idx_coin_lots_source ON listings.coin_lots (source);

-- Кэш каталожных цен по типу монеты (номинал|год|знак → цены по состояниям).
CREATE TABLE IF NOT EXISTS listings.coin_catalog (
  type_key    TEXT PRIMARY KEY,               -- например '100|1898|АГ' или '100|1898'
  source      TEXT NOT NULL,                  -- 'numista'
  external_id TEXT,                           -- id типа в каталоге
  title       TEXT,
  currency    TEXT,                           -- валюта цен в prices
  prices      JSONB,                          -- {"VG": 10.5, "F": 14, "VF": 20, "XF": 45, "AU": 90, "UNC": 150}
  raw         JSONB,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
