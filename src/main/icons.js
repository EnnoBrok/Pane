// Finds an app's icon and returns it as a data: URL, so the chrome
// (CSP img-src 'self' data:) can show it without loading remote content.
const http = require('node:http');
const https = require('node:https');
const { nativeTheme } = require('electron');

const MAX_BYTES = 256 * 1024;
const cache = new Map();   // icon url -> Promise<data url or ''>

function get(url, hops = 3) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    if (!/^https?:$/.test(u.protocol)) return resolve(null);
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(deadline); req.destroy(); resolve(v); } };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { timeout: 3000, rejectUnauthorized: false, headers: { 'User-Agent': 'Pane' } }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && hops > 0) {
        let next = null;
        try { next = new URL(loc, u).href; } catch { /* bad redirect */ }
        return finish(next ? get(next, hops - 1) : null);
      }
      if (res.statusCode !== 200) return finish(null);
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) finish(null); else chunks.push(c); });
      res.on('end', () => finish({ type: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), buf: Buffer.concat(chunks) }));
      res.on('error', () => finish(null));
    });
    const deadline = setTimeout(() => finish(null), 5000);
    req.on('timeout', () => finish(null));
    req.on('error', () => finish(null));
  });
}

// Trust the bytes, not the header: SPA dev servers answer /favicon.ico with index.html.
function imageType(type, buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.readUInt32BE(0) === 0x00000100) return 'image/x-icon';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if ((type.includes('svg') || type.includes('xml')) && /<svg[\s>]/i.test(buf.toString('utf8', 0, 2048))) return 'image/svg+xml';
  return null;
}

function fetchIcon(url) {
  if (!url) return Promise.resolve('');
  if (!cache.has(url)) {
    cache.set(url, get(url).then((r) => {
      const type = r && imageType(r.type, r.buf);
      if (!type) { cache.delete(url); return ''; }   // try again next time, the server may still be starting
      return `data:${type};base64,${r.buf.toString('base64')}`;
    }));
  }
  return cache.get(url);
}

// <link rel=icon> candidates from a page, best first: SVG, then large PNGs, then /favicon.ico.
function candidates(pageUrl, body) {
  const dark = nativeTheme.shouldUseDarkColors;
  const found = [];
  for (const tag of String(body || '').match(/<link\b[^>]*>/gi) || []) {
    const attr = (n) => {
      const m = tag.match(new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
      return m ? (m[1] ?? m[2] ?? m[3]) : '';
    };
    const rel = attr('rel').toLowerCase().split(/\s+/);
    if (!rel.includes('icon') && !rel.includes('apple-touch-icon')) continue;
    const href = attr('href').replace(/&amp;/g, '&');
    if (!href) continue;
    const media = attr('media').toLowerCase();
    if ((media.includes('dark') && !dark) || (media.includes('light') && dark)) continue;
    const size = Math.max(0, ...attr('sizes').split(/\s+/).map(s => parseInt(s, 10) || 0));
    const svg = /\.svg(\?|$)/i.test(href) || attr('type').includes('svg');
    const score = svg ? 1000 : rel.includes('apple-touch-icon') ? 500 : size || 16;
    try { found.push({ url: new URL(href, pageUrl).href, score }); } catch { /* bad href */ }
  }
  found.sort((a, b) => b.score - a.score);
  const list = found.map(f => f.url);
  try { list.push(new URL('/favicon.ico', pageUrl).href); } catch { /* bad page url */ }
  return [...new Set(list)];
}

async function forPage(pageUrl, body) {
  for (const url of candidates(pageUrl, body)) {
    const icon = await fetchIcon(url);
    if (icon) return icon;
  }
  return '';
}

module.exports = { forPage, fetchIcon };
