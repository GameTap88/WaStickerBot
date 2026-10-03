// WhatsApp sticker pack bot - runs on YOUR account.
//   .pack <query> [count]      -> static sticker pack (default 30)
//   .animpack <query> [count]  -> animated sticker pack
// Sends the native "View sticker pack" card. If that fails, falls back to a .wastickers file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);
const pino = require('pino');
const AdmZip = require('adm-zip');
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, generateWAMessageFromContent, proto } = baileys;

// teach this Baileys version the sticker-pack upload paths
try {
  const D = require('@whiskeysockets/baileys/lib/Defaults');
  D.MEDIA_PATH_MAP['sticker-pack'] = '/mms/sticker-pack';
  D.MEDIA_PATH_MAP['thumbnail-sticker-pack'] = '/mms/thumbnail-sticker-pack';
} catch (e) { console.log('[warn] could not patch upload paths:', e.message); }

const PREFIX = '.';
const DEFAULT_COUNT = 30;
const CARD_MODE = true; // false = always send the .wastickers file
const PUBLISHER = 'My Bot';
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const ask = (q) =>
  new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(a.trim()); });
  });

// ---------- 1. search the web for images ----------
async function searchImages(query, want, gifOnly) {
  const h = { 'User-Agent': UA };
  const page = await (await fetch('https://duckduckgo.com/?q=' + encodeURIComponent(query) + '&iax=images&ia=images', { headers: h })).text();
  const m = page.match(/vqd=["']?([\d-]+)["']?/);
  if (!m) throw new Error('Search was blocked (no token). Try again in a minute.');
  const vqd = m[1];
  let url = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,,,&p=1`;
  const out = [];
  for (let i = 0; i < 8 && out.length < want * 4; i++) {
    const r = await fetch(url, { headers: { ...h, Referer: 'https://duckduckgo.com/' } });
    if (!r.ok) break;
    const j = await r.json();
    for (const x of j.results || []) {
      if (gifOnly && !/\.gif(\?|$)/i.test(x.image)) continue;
      out.push(x.image);
    }
    if (!j.next) break;
    url = 'https://duckduckgo.com/' + j.next + '&vqd=' + vqd;
  }
  return [...new Set(out)];
}

// ---------- 2. download ----------
async function download(u, file, min = 3000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!r.ok) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < min || buf.length > 8e6) return false;
    fs.writeFileSync(file, buf);
    return true;
  } catch { return false; } finally { clearTimeout(t); }
}

// ---------- 3. convert to 512x512 webp (needs ffmpeg) ----------
const FIT = 'format=rgba,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';
async function toWebp(inp, out, animated) {
  const limit = animated ? 500 * 1024 : 100 * 1024;
  const qualities = animated ? [45, 30, 18] : [75, 55, 35];
  for (const q of qualities) {
    const args = animated
      ? ['-y', '-i', inp, '-t', '6', '-vf', `fps=${q > 30 ? 12 : 8},${FIT}`, '-loop', '0', '-an', '-c:v', 'libwebp', '-q:v', String(q), '-compression_level', '6', out]
      : ['-y', '-i', inp, '-frames:v', '1', '-vf', FIT, '-c:v', 'libwebp', '-q:v', String(q), out];
    await run('ffmpeg', args, { timeout: 25000 });
    if (fs.statSync(out).size <= limit) return;
  }
  throw new Error('too big');
}
async function makeTray(inp, out) {
  await run('ffmpeg', ['-y', '-i', inp, '-frames:v', '1', '-vf', 'format=rgba,scale=96:96:force_original_aspect_ratio=decrease,pad=96:96:(ow-iw)/2:(oh-ih)/2:color=0x00000000', out], { timeout: 30000 });
}
async function makeThumb(inp, out) {
  await run('ffmpeg', ['-y', '-i', inp, '-frames:v', '1', '-vf', 'scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:(ow-iw)/2:(oh-ih)/2:color=white', '-q:v', '4', out], { timeout: 30000 });
}

// ---------- 4. collect the stickers (Sticker.ly first, web images as backup) ----------
const SL_UA = 'androidapp.stickerly/3.17.0 (Redmi 7; U; Android 29; en-US; us;)';

async function packUrls(p) {
  if (p.resourceUrlPrefix && Array.isArray(p.resourceFiles) && p.resourceFiles.length > 1) {
    return p.resourceFiles.map((f) => p.resourceUrlPrefix + f);
  }
  const ids = [String(p.shareUrl || '').split('/').pop(), p.packId, p.stickerPackId, p.id].filter(Boolean);
  for (const id of ids) {
    for (const base of ['https', 'http']) {
      try {
        const r = await fetch(`${base}://api.sticker.ly/v3.1/stickerPack/${encodeURIComponent(id)}`, { headers: { 'User-Agent': SL_UA } });
        if (!r.ok) continue;
        const j = await r.json();
        const res = j.result;
        if (res && res.stickers && res.resourceUrlPrefix) return res.stickers.map((x) => res.resourceUrlPrefix + x.fileName);
      } catch {}
    }
  }
  return [];
}

function findPacks(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return [];
  if (Array.isArray(o)) {
    const f = o[0];
    if (f && typeof f === 'object' && ['resourceUrlPrefix', 'resourceFiles', 'packId', 'shareUrl', 'stickerPackId'].some((k) => k in f)) return o;
    for (const x of o) { const r = findPacks(x, depth + 1); if (r.length) return r; }
    return [];
  }
  for (const k of Object.keys(o)) { const r = findPacks(o[k], depth + 1); if (r.length) return r; }
  return [];
}

let SL_OK = null; // remembers the filter values the server accepted
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'from', 'in', 'on', 'to', 'for', 'with']);
const normText = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
const sigWords = (t) => {
  const all = normText(t).split(/\s+/).filter((w) => w.length > 1);
  const sig = all.filter((w) => !STOPWORDS.has(w));
  return sig.length ? sig : all;
};

async function stickerlyUrls(kw, animated, want, forceType, qWords) {
  const types = forceType ? [forceType] : animated ? ['ANIMATED', 'ALL'] : ['ALL'];
  let rest = [];
  if (SL_OK) rest = [SL_OK];
  else for (const languages of [['ALL'], ['en']]) for (const sortBy of ['RECOMMENDED', 'RELEVANT', 'POPULAR']) for (const searchBy of ['ALL', 'KEYWORD', 'NAME']) rest.push({ languages, sortBy, searchBy });
  const combos = types.flatMap((t) => rest.map((x) => ({ stickerType: t, ...x })));
  let j = null;
  for (const c of combos) {
    const r = await fetch('https://api.sticker.ly/v4/stickerPack/smartSearch', {
      method: 'POST',
      headers: { 'User-Agent': SL_UA, 'Content-Type': 'application/json', 'x-duid': crypto.randomBytes(8).toString('hex') },
      body: JSON.stringify({ keyword: kw, enabledKeywordSearch: true, filter: { extendSearchResult: false, minStickerCount: 3, ...c } }),
    });
    const body = await r.json().catch(() => ({}));
    if (body && body.error) {
      console.log('[sl err]', JSON.stringify(c), String(body.error.internalErrorMessage || body.error.errorMessage || '').slice(0, 150));
      SL_OK = null;
      continue;
    }
    SL_OK = { languages: c.languages, sortBy: c.sortBy, searchBy: c.searchBy }; j = body;
    console.log('[sl ok]', JSON.stringify(c));
    break;
  }
  if (!j) return [];
  const packs = findPacks(j);
  if (!packs.length) console.log('[sticker.ly raw]', JSON.stringify(j).slice(0, 400));
  console.log(`[sticker.ly] "${kw}" -> ${packs.length} packs`);
  const words = qWords && qWords.length ? qWords : sigWords(kw);
  const rel = (p) => {
    const t = normText(p.name);
    const m = words.filter((w) => t.includes(w)).length;
    return !words.length ? 0 : m === words.length ? 4 : m ? 1 + m / words.length : 0;
  };
  let cand = packs.filter((p) => !BLOCKED.test(String(p.name || '')));
  const matched = cand.filter((p) => rel(p) > 0);
  // long names (2+ real words): the pack title must contain ALL of them, no random fallback
  cand = words.length >= 2 ? cand.filter((p) => rel(p) === 4) : matched.length ? matched : cand;
  const list = await Promise.all(cand.slice(0, 20).map(async (p) => ({
    id: String(p.resourceUrlPrefix || p.shareUrl || p.packId || p.name),
    name: String(p.name || ''),
    rel: rel(p),
    score: (!!p.isAnimated === animated ? 2 : 0) + rel(p) * 3,
    urls: await packUrls(p).catch(() => []),
  })));
  return list.filter((p) => p.urls.length >= 3);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [a[i], a[k]] = [a[k], a[i]]; }
  return a;
}

// best pack first: relevant name, right type, enough stickers; unused ones before used ones
function pickPacks(packs, used, count) {
  const unused = packs.filter((p) => !used.has(p.id));
  const pool = unused.length ? unused : packs; // all used -> start the rotation again
  const size = (p) => (p.urls.length >= count ? 2 : p.urls.length >= 10 ? 1 : 0);
  return shuffle([...pool]).sort((x, y) => (y.score * 3 + size(y)) - (x.score * 3 + size(x)));
}

const USED_FILE = path.join(__dirname, 'used.json');
const HISTORY_HOURS = 24; // the "don't repeat a pack" memory forgets entries after this long
const loadUsed = () => {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(USED_FILE, 'utf8')); } catch {}
  const now = Date.now(), out = {};
  for (const [k, v] of Object.entries(d)) {
    const h = Array.isArray(v) ? Object.fromEntries(v.map((id) => [id, now])) : v || {};
    for (const id of Object.keys(h)) if (now - h[id] > HISTORY_HOURS * 36e5) delete h[id];
    if (Object.keys(h).length) out[k] = h;
  }
  return out;
};
const saveUsed = (o) => { try { fs.writeFileSync(USED_FILE, JSON.stringify(o)); } catch {} };

// turn a downloaded file into a WhatsApp-ready webp buffer (or null to skip it)
async function normalize(raw, out, animated) {
  const buf = fs.readFileSync(raw);
  const isWebp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  const isGif = buf.subarray(0, 3).toString() === 'GIF';
  const limit = animated ? 500 * 1024 : 100 * 1024;
  if (isWebp) {
    const anim = buf.includes('ANIM');
    if (animated !== anim) throw new Error('mismatch'); // keep the pack all-static or all-animated
    if (buf.length <= limit) return buf;
    if (anim) throw new Error('big'); // can't shrink animated webp here
  } else if (animated && !isGif) {
    throw new Error('mismatch');
  }
  await toWebp(raw, out, animated && isGif);
  return fs.readFileSync(out);
}

async function solid(out, size, color) {
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}x${size}`, '-frames:v', '1', out], { timeout: 30000 });
}

async function buildPack(query, count, animated) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  try {
    let n = 0;
    const stats = { ok: 0, dl: 0, mismatch: 0, big: 0, other: 0 };
    const key = query.toLowerCase() + '|' + (animated ? 'a' : 's');
    const usedAll = loadUsed();
    const hist = usedAll[key] || {};
    const used = new Set(Object.keys(hist));
    const handle = async (u) => {
      const id = ++n;
      const raw = path.join(dir, 'r' + id), out = path.join(dir, 'o' + id + '.webp');
      if (!(await download(u, raw, 300))) { stats.dl++; return null; }
      try { const buf = await normalize(raw, out, animated); stats.ok++; return { buf, raw }; }
      catch (e) { stats[e.message === 'mismatch' || e.message === 'big' ? e.message : 'other']++; return null; }
    };
    const deadline = Date.now() + 100000;
    // download + convert ONE pack's stickers (never mixes packs)
    const collect = async (urls) => {
      const got = [], hashes = new Set();
      let firstRaw = null;
      for (let i = 0; i < urls.length && got.length < count && Date.now() < deadline; i += 8) {
        const res = await Promise.all(urls.slice(i, i + 8).map(handle));
        for (const r of res) {
          if (!r || got.length >= count) continue;
          const h = sha256(r.buf).toString('hex');
          if (hashes.has(h)) continue;
          hashes.add(h); got.push(r.buf);
          if (!firstRaw) firstRaw = r.raw;
        }
      }
      return { got, firstRaw };
    };

    let stickers = [], firstRaw = null, packName = '';
    const qWords = sigWords(query);
    const kws = [...new Set([query, qWords.join(' '), ...[...qWords].sort((x, y) => y.length - x.length).slice(0, 2)])];
    const attempts = [
      ...kws.map((k) => [k, null]),
      ...(animated ? [[kws[0] + ' animated', 'ANIMATED'], [kws[0], 'ALL']] : [[kws[0] + ' stickers', 'ALL']]),
    ];
    outer:
    for (const [kw, type] of attempts) {
      let packs = [];
      try { packs = await stickerlyUrls(kw, animated, count, type, qWords); } catch (e) { console.log('[sticker.ly]', e.message); }
      for (const p of pickPacks(packs, used, count).slice(0, 6)) {
        if (Date.now() > deadline) break outer;
        const { got, firstRaw: fr } = await collect(p.urls);
        console.log(`[pack] "${p.name}": ${got.length} usable`);
        if (got.length >= 3) { stickers = got; firstRaw = fr; packName = p.name; used.add(p.id); hist[p.id] = Date.now(); break outer; }
      }
    }
    console.log('[pack] stats', JSON.stringify(stats));
    if (stickers.length < 3) throw new Error(`Couldn't find a pack named "${query}". Try the exact name or fewer words.`);
    usedAll[key] = hist;
    saveUsed(usedAll);

    const trayP = path.join(dir, 'tray.png'), thumbP = path.join(dir, 'thumb.jpg');
    try { await makeTray(firstRaw, trayP); } catch { await solid(trayP, 96, 'white'); }
    try { await makeThumb(firstRaw, thumbP); } catch { await solid(thumbP, 256, 'white'); }
    const title = (packName || query).slice(0, 30);
    return { stickers, tray: fs.readFileSync(trayP), thumb: fs.readFileSync(thumbP), title, n: stickers.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 5a. fallback: .wastickers file ----------
function toWastickers(pack) {
  const zip = new AdmZip();
  zip.addFile('title.txt', Buffer.from(pack.title));
  zip.addFile('author.txt', Buffer.from(PUBLISHER));
  zip.addFile('tray.png', pack.tray);
  pack.stickers.forEach((b, i) => zip.addFile(`${i + 1}.webp`, b));
  return zip.toBuffer();
}

// ---------- 5b. native sticker pack card ----------
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function zipStore(files) { // store-only zip (no compression)
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, f.data); centrals.push(ch, name);
    offset += 30 + name.length + size;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function encryptMedia(plain, mediaKey, info) {
  const x = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), info, 112));
  const iv = x.subarray(0, 16), key = x.subarray(16, 48), macKey = x.subarray(48, 80);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(Buffer.concat([iv, enc])).digest().subarray(0, 10);
  const out = Buffer.concat([enc, mac]);
  return { out, fileSha256: sha256(plain), fileEncSha256: sha256(out) };
}

async function uploadEnc(sock, enc, mediaType) {
  const file = path.join(os.tmpdir(), 'up-' + crypto.randomBytes(6).toString('hex'));
  fs.writeFileSync(file, enc.out);
  try {
    const b64 = encodeURIComponent(enc.fileEncSha256.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    const usesPath = /createReadStream|filePath/.test(String(sock.waUploadToServer));
    const src = usesPath ? file : fs.createReadStream(file);
    const res = await sock.waUploadToServer(src, { fileEncSha256B64: b64, mediaType, timeoutMs: 60000 });
    if (!res || !res.directPath) throw new Error('upload returned no path');
    return res;
  } finally { fs.rmSync(file, { force: true }); }
}

async function sendCard(sock, jid, pack) {
  if (!proto || !proto.Message || !proto.Message.StickerPackMessage) {
    throw new Error('this Baileys version has no sticker pack support');
  }
  const mediaKey = crypto.randomBytes(32);
  const packId = 'pk' + crypto.randomBytes(8).toString('hex');
  const files = [{ name: `${packId}.webp`, data: pack.stickers[0] }];
  const seen = new Set();
  const meta = pack.stickers.map((buf) => {
    const name = sha256(buf).toString('base64url') + '.webp';
    if (!seen.has(name)) { seen.add(name); files.push({ name, data: buf }); }
    return { fileName: name, isAnimated: buf.includes('ANIM'), emojis: ['🙂'], accessibilityLabel: '', isLottie: false, mimetype: 'image/webp' };
  });
  const zipBuf = zipStore(files);
  const z = encryptMedia(zipBuf, mediaKey, 'WhatsApp Sticker Pack Keys');
  const t = encryptMedia(pack.thumb, mediaKey, 'WhatsApp Sticker Pack Thumbnail Keys');
  const zu = await uploadEnc(sock, z, 'sticker-pack');
  const tu = await uploadEnc(sock, t, 'thumbnail-sticker-pack');
  const content = proto.Message.fromObject({
    stickerPackMessage: {
      stickerPackId: packId, name: pack.title, publisher: PUBLISHER, stickers: meta,
      fileLength: zipBuf.length, fileSha256: z.fileSha256, fileEncSha256: z.fileEncSha256,
      mediaKey, directPath: zu.directPath,
      thumbnailSha256: t.fileSha256, thumbnailEncSha256: t.fileEncSha256, thumbnailDirectPath: tu.directPath,
      stickerPackSize: zipBuf.length, trayIconFileName: `${packId}.webp`,
    },
  });
  const full = generateWAMessageFromContent(jid, content, { userJid: sock.user.id });
  await sock.relayMessage(jid, full.message, { messageId: full.key.id });
}

// ---------- WhatsApp connection ----------
const seen = new Set();
const ALLOWED_FILE = path.join(__dirname, 'allowed.json');
const numOf = (jid) => String(jid || '').split('@')[0].split(':')[0];
const allowedChats = new Set(), allowedUsers = new Set();
try {
  const d = JSON.parse(fs.readFileSync(ALLOWED_FILE, 'utf8'));
  if (Array.isArray(d)) d.forEach((x) => allowedChats.add(x)); // old format
  else { (d.chats || []).forEach((x) => allowedChats.add(x)); (d.users || []).forEach((x) => allowedUser
