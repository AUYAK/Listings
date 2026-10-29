// Воронка уведомлений по монетам за последние N дней: node coin-funnel.js [--days 7]
// Показывает, на каком шаге отсеиваются лоты (не серебро → нет ориентира → не прошли порог → ждут конца торгов),
// и состояние каталога (сколько типов/проходов загружено).
require('dotenv').config();
const { pool } = require('./store');
const { BARGAIN_PCT, BARGAIN_BYN, BARGAIN_MIN_BYN } = require('./coins/market');

const days = parseInt((process.argv.find((a, i, arr) => arr[i - 1] === '--days')) || '7', 10);

async function main() {
  const funnel = await pool.query(
    `SELECT l.monitor_key,
            count(*)::int AS total,
            count(*) FILTER (WHERE (a.parsed->>'isSilver')::boolean)::int AS silver,
            count(*) FILTER (WHERE (a.parsed->>'isSilver')::boolean AND NOT (a.parsed->'flags' ?| array['копия','несколько монет']))::int AS silver_ok,
            count(*) FILTER (WHERE (a.parsed->>'isSilver')::boolean AND a.est_reference IS NOT NULL)::int AS with_ref,
            count(*) FILTER (WHERE (a.parsed->>'isSilver')::boolean AND a.est_reference IS NOT NULL
                               AND (a.est_reference - a.current_price >= $2
                                    OR (a.deviation_pct <= -$3 AND a.est_reference - a.current_price >= $4)))::int AS bargain,
            count(a.notified_at)::int AS notified,
            count(*) FILTER (WHERE a.outcome IS NULL AND a.sale_type IN ('auction','auction_buynow'))::int AS auctions_open
     FROM listings.listings l JOIN listings.coin_lots a ON a.listing_id = l.id
     WHERE l.first_seen >= NOW() - ($1 || ' days')::interval
     GROUP BY l.monitor_key ORDER BY l.monitor_key`,
    [String(days), BARGAIN_BYN, BARGAIN_PCT, BARGAIN_MIN_BYN]
  );
  console.log(`Лоты за ${days} дн. (порог: выгода ≥ ${BARGAIN_BYN} р., либо ≤ −${BARGAIN_PCT}% и ≥ ${BARGAIN_MIN_BYN} р.):`);
  for (const r of funnel.rows) {
    console.log(`  ${r.monitor_key}: всего ${r.total} → серебро ${r.silver} → без копий/подборок ${r.silver_ok} → есть ориентир ${r.with_ref} → прошли порог ${r.bargain} → уведомлений ${r.notified}; аукционов идёт ${r.auctions_open}`);
  }

  const byDay = await pool.query(
    `SELECT date(l.first_seen) AS d, count(*)::int AS total,
            count(*) FILTER (WHERE (a.parsed->>'isSilver')::boolean)::int AS silver, count(a.notified_at)::int AS notified
     FROM listings.listings l JOIN listings.coin_lots a ON a.listing_id = l.id
     WHERE l.first_seen >= NOW() - ($1 || ' days')::interval AND l.monitor_key = 'coins-silver'
     GROUP BY 1 ORDER BY 1`, [String(days)]);
  console.log('\nПо дням (ay.by): дата · новых · серебро · уведомлений');
  for (const r of byDay.rows) console.log(`  ${r.d.toISOString().slice(0, 10)} · ${r.total} · ${r.silver} · ${r.notified}`);

  const grades = await pool.query(
    `SELECT coalesce(a.grade, '—') AS grade, count(*)::int AS n, count(a.est_reference)::int AS with_ref
     FROM listings.listings l JOIN listings.coin_lots a ON a.listing_id = l.id
     WHERE l.first_seen >= NOW() - ($1 || ' days')::interval AND l.monitor_key = 'coins-silver' AND (a.parsed->>'isSilver')::boolean
     GROUP BY 1 ORDER BY 2 DESC`, [String(days)]);
  console.log('\nСеребро по состоянию: состояние · лотов · с ориентиром');
  for (const r of grades.rows) console.log(`  ${r.grade} · ${r.n} · ${r.with_ref}`);

  const near = await pool.query(
    `SELECT l.url, a.current_price, a.est_reference, a.deviation_pct, a.grade, a.sale_type, a.ends_at, a.notified_at
     FROM listings.listings l JOIN listings.coin_lots a ON a.listing_id = l.id
     WHERE l.first_seen >= NOW() - ($1 || ' days')::interval AND a.outcome IS NULL AND (a.parsed->>'isSilver')::boolean
       AND a.est_reference IS NOT NULL AND a.deviation_pct < 0
     ORDER BY (a.est_reference - a.current_price) DESC LIMIT 15`, [String(days)]);
  console.log('\nИдущие лоты ниже ориентира (топ-15 по выгоде в р.): цена · ориентир · % · состояние · тип · конец · уведомлён');
  for (const r of near.rows) {
    const gain = Math.round(r.est_reference - r.current_price);
    console.log(`  ${r.url}\n     ${r.current_price} р. · ${Math.round(r.est_reference)} р. (+${gain}) · ${r.deviation_pct}% · ${r.grade || '—'} · ${r.sale_type} · ${r.ends_at ? r.ends_at.toISOString().slice(0, 16).replace('T', ' ') : '—'} · ${r.notified_at ? 'да' : 'нет'}`);
  }

  const cat = await pool.query(
    `SELECT source, count(*)::int AS types, max(fetched_at) AS updated FROM listings.coin_catalog GROUP BY source`);
  const sales = await pool.query(`SELECT count(*)::int AS n, count(price)::int AS priced, min(sold_on) AS from_d, max(sold_on) AS to_d FROM listings.coin_sales`);
  console.log('\nКаталог:');
  for (const r of cat.rows) console.log(`  ${r.source}: ${r.types} типов/вариантов, обновлён ${r.updated ? r.updated.toISOString().slice(0, 10) : '—'}`);
  const s = sales.rows[0];
  console.log(`  проходов gdenashel: ${s.n}, с ценой ${s.priced}${s.from_d ? `, ${s.from_d.toISOString().slice(0, 10)} … ${s.to_d.toISOString().slice(0, 10)}` : ''}`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
