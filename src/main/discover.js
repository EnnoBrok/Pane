// Finds web apps on the local network, once, when asked: services announced over
// mDNS (DNS-SD), plus a sweep of common web ports on this machine's /24 networks
// and on the /24 networks of apps already added. Nothing runs in the background.
// Plain Node (no Electron), so it can be tested on its own.
const dgram = require('node:dgram');
const net = require('node:net');
const os = require('node:os');
const dns = require('node:dns').promises;
const { probeUrl } = require('./probe');

const PORTS = [80, 443, 3000, 5000, 8000, 8080, 8443, 8888];
const TLS_PORTS = new Set([443, 8443]);
// Stock pages of a freshly installed web server are not apps.
const DEFAULT_PAGE = /^(welcome to nginx!?|iis windows( server)?|apache2? .*default page.*|it works!?|test page for .*|default web site page)$/i;

// ---------- mDNS browse (RFC 6762/6763), via a legacy unicast query ----------
// Asking from a random port instead of 5353 makes responders answer us directly,
// so we neither need to share port 5353 with the OS responder nor join the group.

function encodeName(name) {
  const parts = name.split('.').filter(Boolean).map(l => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function ptrQuery(names) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(Math.floor(Math.random() * 0xffff) + 1, 0);
  head.writeUInt16BE(names.length, 4);
  const qs = names.map(n => Buffer.concat([encodeName(n), Buffer.from([0, 12, 0, 1])]));   // PTR, IN
  return Buffer.concat([head, ...qs]);
}

function readName(buf, off) {
  const labels = [];
  let end = -1;
  for (let jumps = 0; off < buf.length && jumps < 32;) {
    const len = buf[off];
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) {             // compression pointer
      if (end < 0) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      jumps++;
      continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return [labels.join('.'), end < 0 ? off : end];
}

// Returns the resource records of a DNS message: { name, type, data }.
function parse(buf) {
  const records = [];
  if (buf.length < 12) return records;
  const qd = buf.readUInt16BE(4);
  const rr = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off)[1] + 4;
  for (let i = 0; i < rr && off + 10 <= buf.length; i++) {
    const [name, o] = readName(buf, off);
    const type = buf.readUInt16BE(o);
    const len = buf.readUInt16BE(o + 8);
    const at = o + 10;
    if (at + len > buf.length) break;
    if (type === 12) records.push({ name, type: 'PTR', data: readName(buf, at)[0] });
    else if (type === 33) records.push({ name, type: 'SRV', data: { port: buf.readUInt16BE(at + 4), target: readName(buf, at + 6)[0] } });
    else if (type === 1 && len === 4) records.push({ name, type: 'A', data: [...buf.subarray(at, at + 4)].join('.') });
    off = at + len;
  }
  return records;
}

function mdnsBrowse(timeout = 2500) {
  const types = ['_http._tcp.local', '_https._tcp.local'];
  return new Promise((resolve) => {
    const records = [];
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try { sock.close(); } catch { /* closed */ }
      const ptr = records.filter(r => r.type === 'PTR' && types.includes(r.name.toLowerCase()));
      const srv = new Map(records.filter(r => r.type === 'SRV').map(r => [r.name.toLowerCase(), r.data]));
      const a = new Map(records.filter(r => r.type === 'A').map(r => [r.name.toLowerCase(), r.data]));
      const found = [];
      for (const p of ptr) {
        const s = srv.get(p.data.toLowerCase());
        if (!s) continue;
        found.push({
          label: p.data.slice(0, p.data.length - p.name.length - 1).replace(/\\032/g, ' '),
          host: s.target, ip: a.get(s.target.toLowerCase()) || null, port: s.port,
          proto: p.name.toLowerCase().startsWith('_https') ? 'https' : 'http',
        });
      }
      resolve(found);
    };
    sock.on('message', (msg) => { try { records.push(...parse(msg)); } catch { /* malformed */ } });
    sock.on('error', () => done());
    sock.bind(0, () => {
      try { sock.setMulticastTTL(255); } catch { /* ignore */ }
      const q = ptrQuery(types);
      const send = () => sock.send(q, 5353, '224.0.0.251', () => {});
      send();
      setTimeout(send, 900);   // a second try for slow or sleepy responders
      setTimeout(done, timeout);
    });
  });
}

// ---------- port sweep ----------

function isPrivate(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
function ownAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
}

function tcpOpen(ip, port, timeout = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    const finish = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  }));
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise(r => setTimeout(() => r(fallback), ms))]);
}

// ---------- all together ----------

// known: URLs of apps already added (skipped, and their networks are swept too).
// onProgress(fraction 0..1, text) reports what is happening.
async function discover({ known = [], onProgress = () => {} } = {}) {
  const own = ownAddresses();
  const knownHosts = known.map(u => { try { return new URL(u); } catch { return null; } }).filter(Boolean);
  const knownIps = new Map();   // "ip:port" of added apps
  await Promise.all(knownHosts.map(async (u) => {
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const ip = net.isIPv4(u.hostname) ? u.hostname : await withTimeout(dns.lookup(u.hostname, { family: 4 }).then(r => r.address).catch(() => null), 2000, null);
    if (ip) knownIps.set(`${ip}:${port}`, u.hostname);
  }));

  onProgress(0.02, 'Looking around the network');
  const announcing = mdnsBrowse();   // runs alongside the sweep

  const prefixes = [...new Set([...own, ...[...knownIps.keys()].map(k => k.split(':')[0])]
    .filter(isPrivate).map(ip => ip.split('.').slice(0, 3).join('.')))].slice(0, 4);
  const targets = [];
  for (const p of prefixes) for (let h = 1; h < 255; h++) for (const port of PORTS) targets.push([`${p}.${h}`, port]);
  const open = [];
  let checked = 0;
  await pool(targets, 192, async ([ip, port]) => {
    if (own.includes(ip)) return;
    if (await tcpOpen(ip, port)) open.push({ ip, port });
    if (++checked % 200 === 0) onProgress(0.05 + 0.75 * checked / targets.length, `Checking ${prefixes.map(p => `${p}.x`).join(', ')}`);
  });

  const announced = await announcing;
  // One candidate per ip:port; announced services bring their name and host name.
  const cands = new Map();
  for (const o of open) cands.set(`${o.ip}:${o.port}`, { ip: o.ip, port: o.port, proto: TLS_PORTS.has(o.port) ? 'https' : 'http' });
  for (const s of announced) {
    const key = `${s.ip}:${s.port}`;
    cands.set(key, { ...(cands.get(key) || {}), ...s, ip: s.ip || cands.get(key)?.ip });
  }

  onProgress(0.82, 'Asking the web servers what they are');
  const found = [];
  const list = [...cands.values()].filter(c => !own.includes(c.ip) && !knownIps.has(`${c.ip}:${c.port}`));
  await pool(list, 24, async (c) => {
    const host = c.host || c.ip;
    const port = c.port === (c.proto === 'https' ? 443 : 80) ? '' : `:${c.port}`;
    let p = await probeUrl(`${c.proto}://${c.ip || host}${port}/`, 2500);
    if (!p && c.proto === 'http') { p = await probeUrl(`https://${c.ip || host}${port}/`, 2500); if (p) c.proto = 'https'; }
    if (!p || p.kind !== 'html' || DEFAULT_PAGE.test(p.title.trim())) return;
    const name = c.host ? c.host.replace(/\.$/, '')
      : await withTimeout(dns.reverse(c.ip).then(n => n[0]).catch(() => null), 1500, null);
    found.push({
      title: p.title || c.label || name || c.ip,
      host: name || c.ip,
      url: `${c.proto}://${name || c.ip}${port}/`,
      ip: c.ip,
    });
  });

  // The same server on several ports (http and https) shows up once.
  const seen = new Set();
  const unique = found.filter(f => { const k = `${f.ip}|${f.title}`; if (seen.has(k)) return false; seen.add(k); return true; });
  unique.sort((a, b) => a.title.localeCompare(b.title));
  onProgress(1, `${unique.length} found`);
  return unique;
}

module.exports = { discover, mdnsBrowse };
