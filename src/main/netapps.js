// User-added network apps (e.g. http://tools.local), persisted in userData.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { probeUrl } = require('./probe');
const icons = require('./icons');

const FILE = () => path.join(app.getPath('userData'), 'network-apps.json');
const apps = new Map();   // id -> { id, url, title, kind, online, probedAt, icon }
let nextId = 1;

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    for (const a of list) {
      const id = `net:${nextId++}`;
      apps.set(id, { id, url: a.url, title: a.title || '', kind: null, online: null, probedAt: 0, icon: '' });
    }
  } catch { /* first run */ }
}

function save() {
  const list = [...apps.values()].map(({ url, title }) => ({ url, title }));
  try { fs.writeFileSync(FILE(), JSON.stringify(list, null, 2)); } catch { /* ignore */ }
}

// Accepts "tools.local", "tools.local:8080/path", "https://x.y"; returns a normalized URL or null.
function normalize(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.href;
  } catch { return null; }
}

function add(input) {
  const url = normalize(input);
  if (!url) return { ok: false, error: 'Not a valid address' };
  if ([...apps.values()].some(a => a.url === url)) return { ok: false, error: 'Already in the list' };
  const id = `net:${nextId++}`;
  apps.set(id, { id, url, title: '', kind: null, online: null, probedAt: 0, icon: '' });
  save();
  return { ok: true, id };
}

function remove(id) {
  const had = apps.delete(id);
  if (had) save();
  return had;
}

// Re-probes entries whose last check is older than maxAge; returns true if anything changed.
async function refresh(maxAge) {
  const now = Date.now();
  let changed = false;
  await Promise.all([...apps.values()].map(async (a) => {
    if (now - a.probedAt < maxAge) return;
    a.probedAt = now;
    const p = await probeUrl(a.url);
    const online = !!p;
    const kind = p ? p.kind : a.kind;
    const title = p && p.title ? p.title : a.title;
    if (online !== a.online || kind !== a.kind || title !== a.title) changed = true;
    a.online = online; a.kind = kind;
    if (p && !a.icon) {
      const icon = await icons.forPage(p.finalUrl, p.body);
      if (icon) { a.icon = icon; changed = true; }
    }
    if (title !== a.title) { a.title = title; save(); }
  }));
  return changed;
}

function list() {
  return [...apps.values()].map(({ id, url, title, kind, online, icon }) => {
    let host = url;
    try { host = new URL(url).host; } catch { /* keep */ }
    return { id, url, title, kind, online, host, icon };
  });
}

function get(id) { return apps.get(id); }
function hostnames() {
  return [...apps.values()].map(a => { try { return new URL(a.url).hostname; } catch { return ''; } });
}

module.exports = { load, add, remove, refresh, list, get, hostnames };
