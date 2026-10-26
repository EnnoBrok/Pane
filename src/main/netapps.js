// User-added network apps (e.g. http://tools.local) and local HTML files
// (file:///…), persisted in userData.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
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

// "file:///…", "/home/me/x.html", "~/x.html" or "C:\\x.html" name a local file.
function looksLikeFile(s) { return /^file:/i.test(s) || /^(~[\\/]|[\\/]|[a-zA-Z]:[\\/])/.test(s); }
function isFile(url) { return /^file:/i.test(url); }
function pathOf(url) { try { return fileURLToPath(url); } catch { return ''; } }
function dirOf(url) { const p = pathOf(url); return p ? path.dirname(p) : ''; }
// What a tile shows under a network app's name: its host, or the file name.
function hostOf(url) {
  if (isFile(url)) return path.basename(pathOf(url)) || url;
  try { return new URL(url).host; } catch { return url; }
}

// The file URL of an existing local file, or null.
function normalizeFile(s) {
  let p;
  if (/^file:/i.test(s)) p = pathOf(s);
  else p = /^~[\\/]/.test(s) ? path.join(os.homedir(), s.slice(2)) : s;
  if (!p) return null;
  p = path.resolve(p);
  try { if (!fs.statSync(p).isFile()) return null; } catch { return null; }
  return pathToFileURL(p).href;
}

// Accepts "tools.local", "tools.local:8080/path", "https://x.y" or a local file; returns a normalized URL or null.
function normalize(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (looksLikeFile(s)) return normalizeFile(s);
  if (!/^[a-z]+:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.href;
  } catch { return null; }
}

// On "Already in the list" the id of the existing entry is returned too, so the caller can open it.
function add(input) {
  const url = normalize(input);
  if (!url) return { ok: false, error: looksLikeFile(String(input || '').trim()) ? 'No such file' : 'Not a valid address' };
  const dup = [...apps.values()].find(a => a.url === url);
  if (dup) return { ok: false, error: 'Already in the list', id: dup.id };
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
  return [...apps.values()].map(({ id, url, title, kind, online, icon }) =>
    ({ id, url, title, kind, online, host: hostOf(url), icon, file: isFile(url) }));
}

function get(id) { return apps.get(id); }
function hostnames() {
  return [...apps.values()].filter(a => !isFile(a.url)).map(a => { try { return new URL(a.url).hostname; } catch { return ''; } });
}

module.exports = { load, add, remove, refresh, list, get, hostnames, normalize, looksLikeFile, isFile, pathOf, dirOf, hostOf };
