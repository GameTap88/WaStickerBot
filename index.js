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
const makeWASocket = typeof baileys.default === 'function' ? baileys.default : (baileys.default && baileys.default.default) || baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, generateWAMessageFromContent, proto } = baileys;

// teach this Baileys version the sticker-pack upload paths
try {
  const D = require('@whiskeysockets/baileys/lib/Defaults');
  D.MEDIA_PATH_MAP['sticker-pack'] = '/mms/sticker-pack';
  D.MEDIA_PATH_MAP['thumbnail-sticker-pack'] = '/mms/thumbnail-sticker-pack';
} catch (e) { console.log('[warn] could not patch upload paths:', e.message); }

// ---------- self-heal for "Bad MAC" / "Failed to decrypt" (message keys out of sync) ----------
const AUTH_DIR = 'auth';
let healNow = async () => {};
const macHits = [];
let lastHeal = 0, lastNote = 0;
const rawErr = console.error.bind(console), rawInfo = console.info.bind(console);
// the encryption library dumps huge session objects (with keys!) to the screen: hide those
console.info = (...a) => { if (typeof a[0] === 'string' && /Closing session|Removing old closed session|Opening session/.test(a[0])) return; rawInfo(...a); };
console.error = (...a) => {
  const t = a.map((x) => (typeof x === 'string' ? x : x && x.message ? x.message : '')).join(' ');
  if (/Bad MAC|Failed to decrypt message with any known session|MessageCounterError|No session found|Key used already/.test(t)) {
    const now = Date.now();
    macHits.push(now);
    while (macHits.length && now - macHits[0] > 60000) macHits.shift();
    if (now - lastNote > 10000) { lastNote = now; rawErr('[session] some messages could not be decrypted (keys out of sync)'); }
    if (macHits.length >= 4 && now - lastHeal > 5 * 60000) { lastHeal = now; healNow('too many decrypt errors').catch(() => {}); }
    return;
  }
  rawErr(...a);
};

let chess = null;
try { chess = require('./chessgame.js').createChessBot({ numOf: (j) => String(j || '').split('@')[0].split(':')[0], prefix: '.' }); }
catch (e) { console.log('[chess] not loaded (is chessgame.js in the bot folder?):', e.message); }

const PREFIX = '.';
const DEFAULT_COUNT = 30;
const TEXT_PACK_LAST_RESORT = false; // true = make a simple text pack instead of an error when nothing is found
const USE_GIPHY = false; // Giphy stickers are often unrelated, so it is off. true = use it as the very last fallback (needs giphy.key)
const SHOW_SOURCE = true; // send a short "From: ..." line after each pack (owner only)
const MAX_PACKS = 20; // most packs one command can make (owner only)
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
  let cand = packs.slice();
  // pack title must contain at least half of the words (1 of 1, 1 of 2, 2 of 3...). no match = go to the fallbacks
  const need = Math.max(1, Math.ceil(words.length / 2));
  cand = cand.filter((p) => { const t = normText(p.name); return words.filter((w) => t.includes(w)).length >= need; });
  console.log(`[sticker.ly] ${cand.length} of ${packs.length} packs match the name`);
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
async function normalize(raw, out, animated, mixed = false, animGif = animated) {
  const buf = fs.readFileSync(raw);
  const isWebp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  const isGif = buf.subarray(0, 3).toString() === 'GIF';
  if (isWebp) {
    const anim = buf.includes('ANIM');
    if (!mixed && animated !== anim) throw new Error('mismatch'); // normally keep the pack all-static or all-animated
    const limit = anim ? 500 * 1024 : 100 * 1024;
    if (buf.length <= limit) return buf;
    if (anim) throw new Error('big'); // can't shrink animated webp here
  } else if (animated && !isGif && !mixed) {
    throw new Error('mismatch');
  }
  await toWebp(raw, out, isGif && animGif);
  return fs.readFileSync(out);
}

async function solid(out, size, color) {
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}x${size}`, '-frames:v', '1', out], { timeout: 30000 });
}

// ---------- fallback sources (only used when Sticker.ly finds nothing) ----------
// order: Sticko -> Sticked -> Telegram -> Giphy
const readKey = (envName, file) => process.env[envName] || (fs.existsSync(path.join(__dirname, file)) ? fs.readFileSync(path.join(__dirname, file), 'utf8').trim() : '');
const giphyKey = () => readKey('GIPHY_KEY', 'giphy.key');
const tgToken = () => readKey('TELEGRAM_TOKEN', 'telegram.token');

async function getText(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json' }, signal: ctl.signal });
    return r.ok ? await r.text() : '';
  } catch { return ''; } finally { clearTimeout(t); }
}

// every sticker-looking image URL on a page (skips logos, icons, banners)
function pageImages(html, base) {
  const out = new Set();
  const add = (u) => {
    try {
      u = new URL(String(u).replace(/&amp;/g, '&'), base);
      if (u.pathname.includes('/_next/image') && u.searchParams.get('url')) u = new URL(u.searchParams.get('url'), base);
      const h = u.href;
      if (/\.(webp|png|gif|jpe?g)(\?|$)/i.test(h) && !/\/static\/|logo|\/og\/|avatar|icon|sprite|favicon|banner|badge/i.test(h)) out.add(h);
    } catch {}
  };
  const flat = html.replace(/\\\//g, '/');
  for (const m of flat.matchAll(/(?:src|data-src|content)=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of flat.matchAll(/srcset=["']([^"']+)["']/gi)) for (const part of m[1].split(',')) add(part.trim().split(/\s+/)[0]);
  for (const m of flat.matchAll(/https?:\/\/[^"'\s\\<>)]+?\.(?:webp|png|gif)(?:\?[^"'\s\\<>)]*)?/gi)) add(m[0]);
  return [...out];
}

const CATALOGS = {
  Sticko: {
    base: 'https://sticko.app',
    pages: (tag, q) => [{ p: `/hashtag/${tag}`, tagPage: true }, { p: `/search?q=${q}`, tagPage: false }],
    link: /\/sticker-pack\/([A-Za-z0-9-]+-[A-Za-z0-9]{10})(?=["'?#\s)\\])/g,
    idLen: 10,
  },
  Sticked: {
    base: 'https://sticked.app',
    pages: (tag) => [{ p: `/tag/${tag}`, tagPage: true }],
    link: /\/(?:packs?|sticker-pack|stickers?)\/([A-Za-z0-9_-]+)(?=["'?#\s)\\])/g,
    idLen: 0,
  },
};

async function catalogPacks(name, query, qWords, animated) {
  const c = CATALOGS[name];
  const words = qWords.length ? qWords : sigWords(query);
  const tags = [...new Set([words.join(''), ...words])].filter(Boolean).slice(0, 3);
  const trustedTag = words.join('');
  const pages = new Map(); // url -> is it the tag page for the exact name?
  for (const tag of tags) for (const pg of c.pages(encodeURIComponent(tag), encodeURIComponent(query))) pages.set(c.base + pg.p, pg.tagPage && tag === trustedTag);
  const entries = [...pages];
  const htmls = await Promise.all(entries.map(([u]) => getText(u)));
  const found = new Map();
  htmls.forEach((html, k) => {
    for (const m of html.replace(/\\\//g, '/').matchAll(c.link)) {
      const prev = found.get(m[1]);
      if (!prev || (entries[k][1] && !prev.trusted)) found.set(m[1], { url: c.base + m[0], trusted: entries[k][1] });
    }
  });
  console.log(`[${name}] ${found.size} pack links`);
  const rel = (title) => { const t = normText(title); const m = words.filter((w) => t.includes(w)).length; return m === words.length ? 4 : m ? 1 + m / words.length : 0; };
  let cand = [...found].map(([slug, v]) => {
    const title = (c.idLen ? slug.slice(0, -(c.idLen + 1)) : slug).replace(/[-_]+/g, ' ');
    return { url: v.url, title, rel: rel(title), trusted: v.trusted };
  });
  const need = Math.max(1, Math.ceil(words.length / 2));
  cand = cand.filter((p) => p.trusted || (() => { const t = normText(p.title); return words.filter((w) => t.includes(w)).length >= need; })());
  console.log(`[${name}] ${cand.length} packs match the name`);
  cand = shuffle(cand).slice(0, 8);
  const list = await Promise.all(cand.map(async (p) => ({
    id: p.url, name: p.title, score: p.rel * 3,
    urls: pageImages(await getText(p.url), p.url),
  })));
  return list.filter((p) => p.urls.length >= 3);
}

async function telegramPack(query) {
  const token = tgToken();
  if (!token) { console.log('[Telegram] skipped (no telegram.token)'); return []; }
  const link = query.match(/addstickers\/([A-Za-z0-9_]+)/);
  const q = query.trim();
  const names = link ? [link[1]] : [...new Set([q.replace(/\s+/g, '_'), q.replace(/\s+/g, '')])];
  for (const nm of names) {
    const r = await fetch(`https://api.telegram.org/bot${token}/getStickerSet?name=${encodeURIComponent(nm)}`).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (!j || !j.ok) continue;
    const st = (j.result.stickers || []).filter((x) => !x.is_animated && !x.is_video).slice(0, 40);
    const urls = (await Promise.all(st.map(async (x) => {
      try {
        const f = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${x.file_id}`)).json();
        return f.ok ? `https://api.telegram.org/file/bot${token}/${f.result.file_path}` : null;
      } catch { return null; }
    }))).filter(Boolean);
    if (urls.length >= 3) return [{ id: 'tg:' + nm, name: j.result.title || nm, score: 9, urls }];
  }
  return [];
}

async function giphyUrls(query, animated) {
  const key = giphyKey();
  if (!key) { console.log('[Giphy] skipped (no giphy.key)'); return []; }
  const ask = async (offset) => {
    const r = await fetch(`https://api.giphy.com/v1/stickers/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&limit=40&offset=${offset}&lang=en`);
    if (!r.ok) throw new Error('Giphy error ' + r.status);
    const j = await r.json();
    return (j.data || []).map((g) => (animated ? g.images?.original?.url : g.images?.original_still?.url)).filter(Boolean);
  };
  let urls = await ask(Math.floor(Math.random() * 30)); // random start = different stickers each time
  if (urls.length < 3) urls = await ask(0);
  return urls;
}

// last resort so a pack is ALWAYS made: simple text stickers from the query
async function generateTextPack(query, dir, n) {
  const text = query.replace(/['":\\%{}\[\],;]/g, '').trim().slice(0, 24) || 'Sticker';
  const size = Math.max(48, Math.min(150, Math.floor(1000 / Math.max(5, text.length))));
  const colors = ['0x2D3047', '0xE0475B', '0x1B998B', '0xF4A259', '0x5B5F97', '0x8E6C8A', '0x3E7CB1', '0xC84B31', '0x2E7D32', '0x6D4C41'];
  const fonts = ['/system/fonts/Roboto-Regular.ttf', '/system/fonts/DroidSans.ttf', '/system/fonts/NotoSans-Regular.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', ''];
  const textFile = path.join(dir, 'gtext.txt');
  fs.writeFileSync(textFile, text);
  const stickers = [];
  let first = null;
  for (let i = 0; i < Math.min(n, 10); i++) {
    const f = path.join(dir, `g${i}.webp`);
    const src = `color=c=${colors[i % colors.length]}:s=512x512:d=1`;
    let ok = false;
    for (const font of fonts) {
      const dt = `drawtext=${font ? `fontfile=${font}:` : ''}textfile=${textFile}:fontsize=${size}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`;
      try { await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', src, '-vf', dt, '-frames:v', '1', '-c:v', 'libwebp', '-q:v', '70', f], { timeout: 20000 }); ok = true; break; } catch {}
    }
    if (!ok) { try { await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', src, '-frames:v', '1', '-c:v', 'libwebp', '-q:v', '70', f], { timeout: 20000 }); ok = true; } catch {} }
    if (!ok) continue;
    stickers.push(fs.readFileSync(f));
    if (!first) first = f;
  }
  if (stickers.length < 3) throw new Error('could not generate stickers');
  return { stickers, firstRaw: first };
}

// Pinterest image search (what the other bot uses). Last fallback: plain images, not made-for-WhatsApp stickers
async function pinterestUrls(query) {
  const base = 'https://www.pinterest.com';
  const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' };
  const home = await fetch(base + '/', { headers: H });
  const sc = home.headers && typeof home.headers.getSetCookie === 'function' ? home.headers.getSetCookie() : [];
  const cookies = sc.map((c) => c.split(';')[0]).join('; ');
  const csrf = (cookies.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const q = `${query} sticker`;
  const src = `/search/pins/?q=${encodeURIComponent(q)}`;
  const out = [];
  let bookmark = null;
  for (let page = 0; page < 3 && out.length < 60; page++) {
    const data = { options: { query: q, scope: 'pins', page_size: 25, gated: false, bookmarks: bookmark ? [bookmark] : [] }, context: {} };
    const url = `${base}/resource/BaseSearchResource/get/?source_url=${encodeURIComponent(src)}&data=${encodeURIComponent(JSON.stringify(data))}`;
    const r = await fetch(url, { headers: { ...H, Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', 'X-Pinterest-AppState': 'active', 'X-Pinterest-Source-Url': src, 'X-CSRFToken': csrf, Cookie: cookies } });
    if (!r.ok) throw new Error('Pinterest error ' + r.status);
    const j = await r.json();
    const res = j.resource_response || {};
    const items = Array.isArray(res.data) ? res.data : (res.data && res.data.results) || [];
    for (const p of items) {
      const im = p && p.images && (p.images.orig || p.images['736x']);
      if (im && im.url && !p.videos) out.push(im.url);
    }
    bookmark = res.bookmark;
    if (!bookmark || bookmark === '-end-') break;
  }
  return shuffle([...new Set(out)]);
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
    const hash = (b) => sha256(b).toString('hex');
    const job = currentJob;          // .abandon stops this
    const GOOD = count;              // only a FULL pack ends the search; smaller ones keep the fallbacks going
    let mixed = false;               // true = also accept the other sticker type (animated <-> static)
    let animGif = animated;          // should GIF files become animated stickers?
    let fillAnimated = false;        // top-up search for animated packs
    let deadline = Date.now() + 100000;

    const handle = async (u) => {
      const id = ++n;
      const raw = path.join(dir, 'r' + id), out = path.join(dir, 'o' + id + '.webp');
      if (!(await download(u, raw, 300))) { stats.dl++; return null; }
      try { const buf = await normalize(raw, out, animated, mixed, animGif); stats.ok++; return { buf, raw }; }
      catch (e) { stats[e.message === 'mismatch' || e.message === 'big' ? e.message : 'other']++; return null; }
    };
    // download + convert ONE pack's stickers; pred = optional filter, limit = how many to keep
    const collect = async (urls, limit = count, pred = null) => {
      const got = [], hashes = new Set();
      let firstRaw = null;
      for (let i = 0; i < urls.length && got.length < limit && Date.now() < deadline && !job.cancel; i += 8) {
        const res = await Promise.all(urls.slice(i, i + 8).map(handle));
        for (const r of res) {
          if (!r || got.length >= limit) continue;
          if (pred && !pred(r.buf)) continue;
          const h = hash(r.buf);
          if (hashes.has(h)) continue;
          hashes.add(h); got.push(r.buf);
          if (!firstRaw) firstRaw = r.raw;
        }
      }
      return { got, firstRaw };
    };

    const qWords = sigWords(query);
    const kws = [...new Set([query, qWords.join(' '), ...[...qWords].sort((x, y) => y.length - x.length).slice(0, 2)])];
    const attempts = [
      ...kws.map((k) => [k, null]),
      ...(animated ? [[kws[0] + ' animated', 'ANIMATED'], [kws[0], 'ALL']] : [[kws[0] + ' stickers', 'ALL']]),
    ];
    const tgLink = /addstickers\/[A-Za-z0-9_]+/.test(query);
    if (tgLink && animated) throw new Error('Telegram links only work for static packs (.pack).');
    if (tgLink && !tgToken()) throw new Error('Telegram links need a bot token. Save it with: echo TOKEN > telegram.token');

    let best = null;          // biggest usable pack found so far
    const leftover = [];      // static stickers from tiny packs, mixed in later if needed
    const tried = new Set();
    const consider = (got, fr, p, source) => {
      if (!mixed && got.length > 0 && got.length < 3) leftover.push(...got.filter((b) => !b.includes('ANIM')));
      if (got.length >= 3 && (!best || got.length > best.stickers.length)) best = { stickers: got, firstRaw: fr, name: p.name, id: p.id, source };
      return got.length >= GOOD;
    };
    const tryList = async (packs, label, limit = 4) => {
      const fresh = pickPacks(packs, used, count).filter((p) => !tried.has(p.id)).slice(0, limit);
      for (const p of fresh) {
        if (job.cancel || Date.now() > deadline) return false;
        tried.add(p.id);
        const { got, firstRaw: fr } = await collect(p.urls);
        console.log(`[${label}] "${p.name}": ${got.length} usable${mixed ? ' (any type)' : ''}`);
        if (consider(got, fr, p, label)) return true;
      }
      return false;
    };
    const chain = () => [
      ['Sticko', () => catalogPacks('Sticko', query, qWords, animated)],
      ['Sticked', () => catalogPacks('Sticked', query, qWords, animated)],
      ...(animated ? [] : [['Telegram', () => telegramPack(query)]]),
      ...((!animated || mixed) && !fillAnimated ? [['Pinterest', async () => { const u = await pinterestUrls(query); return u.length ? [{ id: 'pin:' + query, name: query, score: 0, urls: u }] : []; }]] : []),
      ...(USE_GIPHY ? [['Giphy', async () => { const u = await giphyUrls(query, animGif); return u.length ? [{ id: 'giphy:' + query, name: query, score: 0, urls: u }] : []; }]] : []),
    ];
    // one full sweep: Sticker.ly first, then every fallback from best to worst. visit(packs,label,limit) true = stop
    const sweep = async (visit) => {
      tried.clear();
      if (tgLink) { try { return await visit(await telegramPack(query), 'Telegram', 4); } catch (e) { console.log('[Telegram]', e.message); return false; } }
      deadline = Date.now() + 100000;
      for (const [kw, type] of attempts) {
        let packs = [];
        try { packs = await stickerlyUrls(kw, animated, count, type || (fillAnimated ? 'ANIMATED' : null), qWords); } catch (e) { console.log('[sticker.ly]', e.message); }
        if (await visit(packs, 'Sticker.ly', 6)) return true;
        if (Date.now() > deadline) break;
      }
      for (const [label, get] of chain()) {
        if (job.cancel) return false;
        deadline = Date.now() + 60000;
        try { if (await visit(await get(), label, 4)) return true; } catch (e) { console.log(`[${label}]`, e.message); }
      }
      return false;
    };

    // 1) the asked type only
    await sweep(tryList);
    if (job.cancel) throw new Error('abandoned');
    // 2) nothing at all of that type: accept the other type too
    if (!best && !tgLink) {
      mixed = true; animGif = true;
      console.log('[pack] nothing found, allowing the other sticker type');
      await sweep(tryList);
    }
    if (job.cancel) throw new Error('abandoned');
    if (best && mixed && leftover.length) { // mix in the few stickers found earlier
      const seen = new Set(best.stickers.map(hash));
      const extra = leftover.filter((b) => { const h = hash(b); if (seen.has(h)) return false; seen.add(h); return true; });
      best.stickers = [...extra, ...best.stickers].slice(0, count);
    }
    // 3) pack not full: top it up with the OTHER type (animated for .pack, static for .animpack)
    let filled = 0;
    if (best && !tgLink && best.stickers.length < count) {
      const other = (b) => b.includes('ANIM') !== animated;
      const need = count - best.stickers.length;
      mixed = true; animGif = !animated; fillAnimated = !animated;
      console.log(`[pack] only ${best.stickers.length}/${count}, filling ${need} with ${animated ? 'static' : 'animated'} stickers`);
      const have = new Set(best.stickers.map(hash));
      const extra = [];
      const fillList = async (packs, label, limit = 4) => {
        const fresh = pickPacks(packs, used, count).filter((p) => !tried.has(p.id)).slice(0, limit);
        for (const p of fresh) {
          if (extra.length >= need || Date.now() > deadline) break;
          tried.add(p.id);
          const { got } = await collect(p.urls, need - extra.length, other);
          for (const b of got) { const h = hash(b); if (!have.has(h)) { have.add(h); extra.push(b); } }
          console.log(`[${label}] filler "${p.name}": ${got.length}`);
        }
        return extra.length >= need;
      };
      try { await sweep(fillList); } catch (e) { console.log('[fill]', e.message); }
      if (job.cancel) throw new Error('abandoned');
      filled = extra.length;
      if (filled) best.stickers = [...best.stickers, ...extra].slice(0, count);
    }
    // 4) optional last resort
    if (!best && !tgLink && TEXT_PACK_LAST_RESORT) {
      try {
        const g = await generateTextPack(query, dir, Math.min(count, 8));
        best = { stickers: g.stickers, firstRaw: g.firstRaw, name: query, id: 'gen:' + query, source: 'Generated' };
        console.log('[pack] nothing found online, made a text pack');
      } catch (e) { console.log('[Generated]', e.message); }
    }
    console.log('[pack] stats', JSON.stringify(stats));
    if (!best) throw new Error(tgLink ? "Couldn't load that Telegram pack." : `Couldn't find any stickers for "${query}". Try another name.`);

    used.add(best.id); hist[best.id] = Date.now();
    usedAll[key] = hist;
    saveUsed(usedAll);

    const trayP = path.join(dir, 'tray.png'), thumbP = path.join(dir, 'thumb.jpg');
    try { await makeTray(best.firstRaw, trayP); } catch { await solid(trayP, 96, 'white'); }
    try { await makeThumb(best.firstRaw, thumbP); } catch { await solid(thumbP, 256, 'white'); }
    const animCount = best.stickers.filter((b) => b.includes('ANIM')).length;
    return {
      stickers: best.stickers, tray: fs.readFileSync(trayP), thumb: fs.readFileSync(thumbP),
      title: (best.name || query).slice(0, 30), n: best.stickers.length, id: best.id, source: best.source, animCount,
    };
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
  const meta = pack.stickers.map((buf, i) => {
    const name = `${String(i + 1).padStart(2, '0')}_${sha256(buf).toString('base64url')}.webp`;
    files.push({ name, data: buf });
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
      thumbnailSha256: t.fileSha256, thumbnailEncSha256: t.fileEncSha256, thumbnailDirectPath: tu.directPath, thumbnailHeight: 256, thumbnailWidth: 256,
      stickerPackSize: zipBuf.length, trayIconFileName: `${packId}.webp`,
    },
  });
  const full = generateWAMessageFromContent(jid, content, { userJid: sock.user.id });
  await sock.relayMessage(jid, full.message, { messageId: full.key.id });
  remember(full);
}

// ---------- WhatsApp connection ----------
// keep recent sent messages: if the phone fails to open one it asks for a resend, and this lets us answer
const sentCache = new Map();
const remember = (m) => {
  if (m && m.key && m.key.id && m.message) {
    sentCache.set(m.key.id, m.message);
    if (sentCache.size > 300) sentCache.delete(sentCache.keys().next().value);
  }
};
const seen = new Set();
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const settings = { card: true }; // card = try the native "View sticker pack" card (experimental); false = send the pack file
try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch {}
const saveSettings = () => { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch {} };
const ALLOWED_FILE = path.join(__dirname, 'allowed.json');
const numOf = (jid) => String(jid || '').split('@')[0].split(':')[0];
const allowedChats = new Set(), allowedUsers = new Set();
try {
  const d = JSON.parse(fs.readFileSync(ALLOWED_FILE, 'utf8'));
  if (Array.isArray(d)) d.forEach((x) => allowedChats.add(x)); // old format
  else { (d.chats || []).forEach((x) => allowedChats.add(x)); (d.users || []).forEach((x) => allowedUsers.add(x)); }
} catch {}
const saveAllowed = () => { try { fs.writeFileSync(ALLOWED_FILE, JSON.stringify({ chats: [...allowedChats], users: [...allowedUsers] })); } catch {} };
const lastUse = new Map();
let busy = false;
let consoleOn = false;
let DEBUG = true;      // print one line for every incoming message (type  debug  in Termux to toggle)
let curSock = null;
const last4 = (j) => String(j || '').split('@')[0].split(':')[0].slice(-4) || '-';
let currentJob = { cancel: false }; // .abandon sets cancel = true

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }),
    printQRInTerminal: false, browser: ['Ubuntu', 'Chrome', '22.04.4'],
    getMessage: async (key) => sentCache.get(key.id),
  });
  const rawSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...a) => { const m = await rawSend(...a); remember(m); return m; };

  if (!sock.authState.creds.registered) {
    const num = (await ask('Your WhatsApp number with country code, digits only (no +): ')).replace(/\D/g, '');
    await sleep(2500);
    const code = await sock.requestPairingCode(num);
    console.log('\nPAIRING CODE:', code, '\nWhatsApp > Settings > Linked devices > Link with phone number\n');
  }

  curSock = sock;
  healNow = async (why) => {
    console.log(`[heal] ${why}: resetting message sessions (no relink needed)`);
    try { for (const f of fs.readdirSync(AUTH_DIR)) if (/^session-/.test(f)) fs.unlinkSync(path.join(AUTH_DIR, f)); } catch (e) { console.log('[heal] error', e.message); }
    try { sock.end(new Error('session reset')); } catch {}
  };
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log(`[me] logged in as ...${last4(sock.user && sock.user.id)}, lid ...${last4(sock.user && sock.user.lid)}`);
      console.log('Connected ✅  Try  .pack <name>  in any chat.   (Termux commands: heal, ping, debug)');
      if (!consoleOn) {
        consoleOn = true;
        readline.createInterface({ input: process.stdin }).on('line', (l) => {
          const c = l.trim().toLowerCase();
          if (c === 'heal') healNow('manual');
          else if (c === 'debug') { DEBUG = !DEBUG; console.log('[debug]', DEBUG ? 'on' : 'off'); }
          else if (c === 'ping') {
            const me = curSock && curSock.user ? numOf(curSock.user.id) + '@s.whatsapp.net' : null;
            if (!me) return console.log('[ping] not connected yet');
            curSock.sendMessage(me, { text: 'pong from the bot' }).then(() => console.log('[ping] sent to your own number - check WhatsApp')).catch((e) => console.log('[ping] failed:', e.message));
          }
        });
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('[conn] closed (status ' + code + ') - reconnecting');
      if (code === DisconnectReason.loggedOut) {
        console.log('Logged out. Delete the "auth" folder and start again.');
        process.exit(1);
      }
      start();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        if (DEBUG) console.log(`[evt] ${type} fromMe=${msg.key.fromMe ? 1 : 0} chat=...${last4(msg.key.remoteJid)} sender=...${last4(msg.key.participant)} ${msg.message ? Object.keys(msg.message)[0] : 'NO CONTENT stub=' + msg.messageStubType}`);
        const chat = msg.key.remoteJid;
        if (!chat || chat === 'status@broadcast') continue;
        // you = messages flagged fromMe, OR sent by your own number/LID (some WhatsApp versions don't set fromMe)
        const mine = new Set([numOf(sock.user && sock.user.id), numOf(sock.user && sock.user.lid)].filter(Boolean));
        const fromMe = !!msg.key.fromMe || [msg.key.participant, msg.key.participantAlt, chat, msg.key.remoteJidAlt].filter(Boolean).some((j) => mine.has(numOf(j)));
        if (fromMe) console.log('[recv] from you,', msg.message ? Object.keys(msg.message)[0] : 'COULD NOT DECRYPT (keys out of sync - self-heal will reset them)');
        else if (!msg.message) console.log('[recv] a message from ...' + chat.split('@')[0].slice(-4) + ' could not be opened');
        if (!msg.message) continue;
        const chatIds = [chat, msg.key.remoteJidAlt].filter(Boolean);
        const senderNums = [msg.key.participant, msg.key.participantAlt, msg.key.remoteJidAlt, chat].filter(Boolean).map(numOf);
        const allowedHere = fromMe || chatIds.some((c) => allowedChats.has(c)) || senderNums.some((n) => allowedUsers.has(n));
        if (!allowedHere && !(chess && chess.has(chat))) { if (DEBUG) console.log('[evt]   ignored: not from you, and this chat/person is not allowed'); continue; } // others need .allow (or a chess game in this chat)
        let m = msg.message;
        m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.documentWithCaptionMessage?.message || m;
        const text = String(m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || '').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/^\s*[．。۔]/, '.').trim();
        if (chess && text) {
          try {
            const mentions = (m.extendedTextMessage && m.extendedTextMessage.contextInfo && m.extendedTextMessage.contextInfo.mentionedJid) || [];
            if (await chess.handle({ sock, msg, chat, text, fromMe, allowedHere, mine, mentions })) continue;
          } catch (e) { console.log('[chess error]', e); }
        }
        if (!allowedHere) continue; // people who only joined a chess game can't use the other commands
        if (!text.startsWith(PREFIX)) continue;
        if (seen.has(msg.key.id)) continue;
        seen.add(msg.key.id);
        const parts = text.slice(PREFIX.length).trim().split(/\s+/);
        const cmd = parts.shift().toLowerCase();
        if (!fromMe && !['pack', 'animpack'].includes(cmd)) continue; // others can only make packs
        if (cmd === 'allow' || cmd === 'deny') {
          const men = ((m.extendedTextMessage && m.extendedTextMessage.contextInfo && m.extendedTextMessage.contextInfo.mentionedJid) || []).map(numOf);
          if (men.length) men.forEach((n) => (cmd === 'allow' ? allowedUsers.add(n) : allowedUsers.delete(n))); // .allow @Friend
          else if (cmd === 'allow') { allowedChats.add(chat); if (msg.key.remoteJidAlt) allowedChats.add(msg.key.remoteJidAlt); } // .allow  -> whole chat/group
          else { allowedChats.delete(chat); if (msg.key.remoteJidAlt) allowedChats.delete(msg.key.remoteJidAlt); }
          saveAllowed();
          await sock.sendMessage(chat, { react: { text: cmd === 'allow' ? '✅' : '🚫', key: msg.key } });
          continue;
        }
        if (cmd === 'abandon') { // stop the pack(s) being made right now (owner only)
          if (busy) { currentJob.cancel = true; await sock.sendMessage(chat, { react: { text: '🛑', key: msg.key } }); }
          else await sock.sendMessage(chat, { text: 'Nothing to abandon.' });
          continue;
        }
        if (cmd === 'card') { // .card on / .card off -> native pack card (experimental) or the pack file
          const v = (parts[0] || '').toLowerCase();
          if (v === 'on' || v === 'off') { settings.card = v === 'on'; saveSettings(); }
          await sock.sendMessage(chat, { text: `Pack format: ${settings.card ? 'native card (experimental)' : 'pack file (open with Sticker Maker)'}\nChange it with ${PREFIX}card on / ${PREFIX}card off` });
          continue;
        }
        if (cmd === 'sources') { // .sources Query -> checks every source without sending a pack (owner only)
          const q = parts.join(' ');
          if (!q) { await sock.sendMessage(chat, { text: `Usage: ${PREFIX}sources Query` }); continue; }
          const words = sigWords(q), out = [];
          const step = async (label, fn) => { try { out.push(`${label}: ${await fn()}`); } catch (e) { out.push(`${label}: error (${e.message})`); } };
          await step('Sticker.ly', async () => `${(await stickerlyUrls(q, false, 30, null, words)).length} matching packs`);
          await step('Sticko', async () => `${(await catalogPacks('Sticko', q, words, false)).length} packs with images`);
          await step('Sticked', async () => `${(await catalogPacks('Sticked', q, words, false)).length} packs with images`);
          await step('Telegram', async () => (tgToken() ? ((await telegramPack(q)).length ? 'found a pack with that name' : 'no pack with that exact name') : 'no telegram.token'));
          if (USE_GIPHY) await step('Giphy', async () => (giphyKey() ? `${(await giphyUrls(q, false)).length} stickers` : 'no giphy.key'));
          await step('Pinterest', async () => `${(await pinterestUrls(q)).length} images`);
          if (TEXT_PACK_LAST_RESORT) out.push('Last resort: text pack (always works)');
          await sock.sendMessage(chat, { text: out.join('\n') });
          continue;
        }
        if (!['pack', 'animpack'].includes(cmd)) continue;
        console.log('[cmd]', text.slice(0, 60));
        const jid = msg.key.remoteJid;
        const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: msg });
        // .pack Query [stickers] [packs]   e.g. .pack Query 30 5 = 5 packs of 30
        const nums = [];
        while (parts.length > 1 && nums.length < 2 && /^\d+$/.test(parts[parts.length - 1])) nums.unshift(parseInt(parts.pop(), 10));
        let count = DEFAULT_COUNT, packs = 1;
        if (nums.length >= 1) count = Math.min(30, Math.max(3, nums[0]));
        if (nums.length === 2) packs = Math.min(MAX_PACKS, Math.max(1, nums[1]));
        if (!fromMe) packs = 1; // friends get one pack at a time
        const query = parts.join(' ');
        if (!fromMe) {
          const who = msg.key.participant || chat;
          if (Date.now() - (lastUse.get(who) || 0) < 30000) continue; // 30s cooldown for others
          lastUse.set(who, Date.now());
        }
        if (!query) { await reply(`Usage: ${PREFIX}${cmd} Query [stickers] [packs]`); continue; }
        if (busy) { await reply('⏳ Already making a pack, wait for it to finish.'); continue; }
        busy = true;
        try {
          const animated = cmd === 'animpack';
          await sock.sendMessage(jid, { react: { text: '❄️', key: msg.key } });
          currentJob = { cancel: false };
          const sentIds = new Set();
          for (let i = 0; i < packs; i++) {
            if (currentJob.cancel) throw new Error('abandoned');
            const pack = await buildPack(query, count, animated);
            if (pack.id && !/^(giphy|gen|pin):/.test(pack.id) && sentIds.has(pack.id)) { // ran out of different packs for this name
              await reply(`That's all the different packs I could find (${sentIds.size}).`);
              break;
            }
            if (pack.id) sentIds.add(pack.id);
            let sent = false;
            if (settings.card) {
              try { await sendCard(sock, jid, pack); sent = true; }
              catch (e) { console.log('[card failed]', e); }
            }
            if (!sent) {
              await sock.sendMessage(jid, { document: toWastickers(pack), mimetype: 'application/octet-stream', fileName: `${pack.title}.wastickers` });
            }
            const staticCount = pack.n - pack.animCount;
            if (pack.source === 'Generated') await sock.sendMessage(jid, { text: `ℹ️ Couldn't find stickers for "${query}" anywhere, so I made a simple text pack.` });
            else if (!animated && pack.animCount > 0) await sock.sendMessage(jid, { text: `ℹ️ ${pack.animCount === pack.n ? 'No static stickers found, so this pack is all animated' : `Not enough static stickers found, so ${pack.animCount} of ${pack.n} are animated`}.` });
            else if (animated && staticCount > 0) await sock.sendMessage(jid, { text: `ℹ️ ${staticCount === pack.n ? 'No animated stickers found, so this pack is all static' : `Not enough animated stickers found, so ${staticCount} of ${pack.n} are static`}.` });
            if (SHOW_SOURCE && fromMe) {
              const extra = pack.source === 'Giphy' ? ' (mixed stickers)' : ` (${pack.title})`;
              await sock.sendMessage(jid, { text: `From: ${pack.source || 'unknown'}${extra}${packs > 1 ? `  ${i + 1}/${packs}` : ''}` });
            }
            if (i < packs - 1) await sleep(2000);
          }
        } catch (e) {
          if (e.message === 'abandoned') await reply('🛑 Stopped.');
          else { console.log('[error]', e); await reply('❌ ' + e.message); }
        } finally { busy = false; }
      } catch (e) { console.log('handler error:', e.message); busy = false; }
    }
  });
}

start();
