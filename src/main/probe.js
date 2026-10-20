// Asks a port whether it speaks HTTP and what it serves.
const http = require('node:http');
const https = require('node:https');

const MAX_BODY = 64 * 1024;

// Resolves with the status, headers and the start of the body. Stops reading
// after </head> or 64 KB, and gives up after a hard deadline, so a server that
// streams at "/" (camera feed, SSE) cannot keep the probe open forever.
function request(proto, host, port, timeout, urlPath = '/') {
  return new Promise((resolve) => {
    let done = false;
    let res = null;
    let body = '';
    const result = () => (res ? { status: res.statusCode, headers: res.headers, body } : null);
    const finish = (v) => { if (!done) { done = true; clearTimeout(deadline); req.destroy(); resolve(v); } };
    const mod = proto === 'https' ? https : http;
    const req = mod.request({
      host: host.replace(/^\[|\]$/g, ''), port, path: urlPath, method: 'GET', timeout,
      headers: { Accept: 'text/html,*/*;q=0.5', 'User-Agent': 'Pane-probe' },
      rejectUnauthorized: false,
    }, (r) => {
      res = r;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length >= MAX_BODY || /<\/head>/i.test(c)) finish(result());
      });
      res.on('end', () => finish(result()));
      res.on('error', () => finish(result()));
    });
    const deadline = setTimeout(() => finish(result()), timeout + 1000);
    req.on('timeout', () => finish(result()));
    req.on('error', () => finish(result()));
    req.end();
  });
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function classify(res) {
  const ct = String(res.headers['content-type'] || '').toLowerCase();
  let kind = 'other';
  if (res.status >= 400) kind = ct.includes('json') ? 'api' : 'other';
  else if (ct.includes('text/html')) kind = 'html';
  else if (ct.includes('json')) kind = 'api';
  else if (res.status >= 300 && res.status < 400) kind = 'html';
  const m = res.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = m ? decodeEntities(m[1].trim().replace(/\s+/g, ' ')) : '';
  if (res.status >= 400) title = '';
  return { kind, title, status: res.status };
}

// Probes a full URL (for user-added network apps). Returns null when unreachable.
async function probeUrl(url, timeout = 3000) {
  let u;
  try { u = new URL(url); } catch { return null; }
  let res = null;
  // Follow a few same-host redirects (e.g. "/" -> "/login") so the title is useful.
  for (let hop = 0; hop < 3; hop++) {
    const proto = u.protocol.replace(':', '');
    const port = u.port || (proto === 'https' ? 443 : 80);
    res = await request(proto, u.hostname, port, timeout, u.pathname + u.search);
    if (!res) return null;
    const loc = res.headers.location;
    if (!(res.status >= 300 && res.status < 400 && loc)) break;
    let next;
    try { next = new URL(loc, u); } catch { break; }
    if (next.host !== u.host) break;
    u = next;
  }
  return { ...classify(res), url, finalUrl: u.href, body: res.body };
}

async function probe(host, port, timeout = 1500) {
  let proto = 'http';
  let res = await request('http', host, port, timeout);
  if (!res) {
    res = await request('https', host, port, timeout);
    proto = 'https';
  }
  if (!res) return null;
  // A 404 at "/" with an HTML error page is an API backend, not a frontend.
  return { proto, ...classify(res), url: `${proto}://${host}:${port}/`, body: res.body };
}

module.exports = { probe, probeUrl };
