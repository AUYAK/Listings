// Пересчитывает разобранные поля listing_details (чип, память, год, батарея, состояние корпуса,
// флаги) по уже сохранённым характеристикам и описаниям. Сеть не нужна.
// Запускать после миграции 010 и после правок разбора в details.js: node reparse-details.js
require('dotenv').config();
const { Pool } = require('pg');
const store = require('./store');
const { parseDetails } = require('./details');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const dryRun = process.argv.includes('--dry-run');

(async () => {
  const { rows } = await pool.query(
    `SELECT d.listing_id, d.specs, d.description, COALESCE(s.title, l.title) AS title
     FROM listings.listing_details d
     JOIN listings.listings l ON l.id = d.listing_id
     LEFT JOIN LATERAL (
       SELECT title FROM listings.listing_snapshots WHERE listing_id = l.id ORDER BY scraped_at DESC LIMIT 1
     ) s ON true`
  );
  console.log(`${rows.length} rows${dryRun ? ' (dry run, nothing written)' : ''}`);

  const stat = { chip: 0, ramGb: 0, ssdGb: 0, screenIn: 0, year: 0, batteryCycles: 0, batteryHealthPct: 0, bodyCondition: 0, flags: 0 };
  const flagCount = {};
  let done = 0;
  for (const r of rows) {
    const d = parseDetails(r.title, r.specs || {}, r.description);
    for (const k of Object.keys(stat)) if (k === 'flags' ? d.flags.length : d[k] != null) stat[k]++;
    for (const f of d.flags) flagCount[f] = (flagCount[f] || 0) + 1;
    if (!dryRun) await store.saveListingDetails(r.listing_id, d);
    done++;
    if (done % 200 === 0) console.log(`  ${done}/${rows.length}`);
  }

  const pct = (n) => `${Math.round((n / rows.length) * 100)}%`;
  console.log('\ncoverage:');
  for (const [k, n] of Object.entries(stat)) console.log(`  ${k.padEnd(18)} ${pct(n)}`);
  console.log('flags:');
  for (const [f, n] of Object.entries(flagCount).sort((a, b) => b[1] - a[1])) console.log(`  ${f.padEnd(22)} ${n}`);

  await pool.end();
  await store.closePool();
})().catch((err) => { console.error(err); process.exit(1); });
