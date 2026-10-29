// Фото лотов на диске: до PER_LOT снимков на лот (аверс/реверс), папка по месяцам, общий лимит по объёму.
// Снимки с ay.by существуют только в одном размере (650 px, ~100–200 КБ), поэтому лимит — главный предохранитель:
// при превышении COINS_PHOTO_MAX_MB сначала удаляются фото лотов, которые не были проданы, потом самые старые.
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(process.env.COINS_PHOTO_DIR || path.join(__dirname, '..', 'coin-photos'));
const MAX_MB = parseFloat(process.env.COINS_PHOTO_MAX_MB || '1024');
const PER_LOT = parseInt(process.env.COINS_PHOTO_PER_LOT || '2', 10);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const WIDTH = parseInt(process.env.COINS_PHOTO_WIDTH || '450', 10);   // сжатие, если установлен sharp (npm i sharp)
const QUALITY = parseInt(process.env.COINS_PHOTO_QUALITY || '75', 10);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let sharp = null;
try { sharp = require('sharp'); } catch { /* без sharp фото пишутся как есть (650 px, ~150 КБ) */ }

const monthDir = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

async function shrink(buf) {
  if (!sharp || !(WIDTH > 0)) return buf;
  try { return await sharp(buf).rotate().resize({ width: WIDTH, withoutEnlargement: true }).jpeg({ quality: QUALITY }).toBuffer(); }
  catch { return buf; }
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_FILE_BYTES) throw new Error(`size ${buf.length}`);
  buf = await shrink(buf);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

// Сохраняет фото лота; возвращает относительные пути (уже сохранённые — не перекачивает)
async function saveLotPhotos(externalId, urls, existing = []) {
  const files = [...(existing || [])];
  const want = (urls || []).slice(0, PER_LOT);
  for (let i = 0; i < want.length; i++) {
    const rel = `${monthDir()}/${externalId}_${i + 1}${path.extname(new URL(want[i]).pathname) || '.jpg'}`;
    if (files.some((f) => path.basename(f) === path.basename(rel))) continue;
    try {
      await download(want[i], path.join(DIR, rel));
      files.push(rel);
    } catch (err) {
      console.warn(`  [Photos] ${externalId} #${i + 1}: ${err.message}`);
    }
  }
  return files;
}

function removeLotPhotos(files) {
  for (const rel of files || []) {
    try { fs.unlinkSync(path.join(DIR, rel)); } catch { /* уже нет */ }
  }
}

// Общий объём папки и список файлов (путь относительно DIR, размер, mtime)
function inventory() {
  const out = [];
  if (!fs.existsSync(DIR)) return { bytes: 0, files: out };
  for (const month of fs.readdirSync(DIR)) {
    const mp = path.join(DIR, month);
    if (!fs.statSync(mp).isDirectory()) continue;
    for (const f of fs.readdirSync(mp)) {
      const st = fs.statSync(path.join(mp, f));
      if (st.isFile()) out.push({ rel: `${month}/${f}`, bytes: st.size, mtime: st.mtimeMs, externalId: f.split('_')[0] });
    }
  }
  return { bytes: out.reduce((s, f) => s + f.bytes, 0), files: out };
}

// Удерживает папку в лимите. keepIds — лоты, чьи фото ценны (проданные): удаляются последними.
// Возвращает { bytes, removed, removedIds }.
function enforceLimit(keepIds = new Set()) {
  const inv = inventory();
  const limit = MAX_MB * 1024 * 1024;
  const removedIds = new Set();
  let bytes = inv.bytes, removed = 0;
  if (bytes <= limit) return { bytes, removed, removedIds };
  const order = [...inv.files].sort((a, b) => (keepIds.has(a.externalId) - keepIds.has(b.externalId)) || (a.mtime - b.mtime));
  for (const f of order) {
    if (bytes <= limit * 0.9) break; // освобождаем с запасом, чтобы не чистить каждый цикл
    try { fs.unlinkSync(path.join(DIR, f.rel)); bytes -= f.bytes; removed++; removedIds.add(f.externalId); } catch { /* ignore */ }
  }
  for (const month of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
    const mp = path.join(DIR, month);
    try { if (fs.statSync(mp).isDirectory() && !fs.readdirSync(mp).length) fs.rmdirSync(mp); } catch { /* ignore */ }
  }
  return { bytes, removed, removedIds };
}

module.exports = { DIR, MAX_MB, PER_LOT, compression: sharp ? `${WIDTH}px q${QUALITY}` : null, saveLotPhotos, removeLotPhotos, inventory, enforceLimit };
