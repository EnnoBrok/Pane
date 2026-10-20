// UI preferences: custom app names, apps that open in their own window, window
// positions, the home layout, detached and pinned apps, per-app zoom, the apps
// open at quit, and site permissions. Written to a temp file and renamed, so a
// crash never leaves half a file behind.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'prefs.json');
let data = { names: {}, windowed: [], windowsByDefault: false, bounds: {}, layout: 'grid', standalone: {},
             pins: [], zoom: {}, session: [], permissions: {} };

function load() {
  try { data = { ...data, ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) }; } catch { /* first run */ }
  // The free-arrangement "desktop" layout was removed; fall back to the grid.
  if (!['grid', 'previews'].includes(data.layout)) data.layout = 'grid';
  delete data.positions;
  // Detached apps count as pinned; done once, so unpinning one later sticks.
  if (!data.pinsMigrated) {
    for (const e of Object.values(data.standalone)) {
      if (!data.pins.some(p => p.key === e.key)) data.pins.push(pinFrom({ ...e, title: e.name }));
    }
    data.pinsMigrated = true;
  }
}
function save() {
  const tmp = FILE() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, FILE()); } catch { /* ignore */ }
}

function getName(key) { return data.names[key] || ''; }
function setName(key, name) {
  name = String(name || '').trim().slice(0, 80);
  if (name) data.names[key] = name; else delete data.names[key];
  save();
}
function isWindowed(key) { return data.windowed.includes(key); }
function setWindowed(key, on) {
  data.windowed = data.windowed.filter(k => k !== key);
  if (on) data.windowed.push(key);
  save();
}
function windowsByDefault() { return !!data.windowsByDefault; }
function setWindowsByDefault(on) { data.windowsByDefault = !!on; save(); }
function getBounds(key) { return data.bounds[key] || null; }
function setBounds(key, b) { data.bounds[key] = b; save(); }

function getLayout() { return data.layout; }
function setLayout(layout) { data.layout = layout; save(); }

// id -> { key, name, url, partition, icon, png }; png is the launcher icon as a data URL
function getStandalone(id) { return data.standalone[id] || null; }
function standaloneFor(key) { return Object.entries(data.standalone).find(([, e]) => e.key === key)?.[0] || null; }
function listStandalone() { return Object.entries(data.standalone); }
function setStandalone(id, entry) {
  if (entry) data.standalone[id] = entry; else delete data.standalone[id];
  save();
}

// Pinned apps, in pin order: what home needs to show and reopen them while
// their server is down. start: { exe, argv, cwd } of a local server (launch.js).
function pinFrom(t) {
  return { key: t.key, local: !/^https?:\/\//.test(t.key), title: t.title || '', icon: t.icon || '',
           url: t.url, partition: t.partition, start: t.start || null };
}
function listPins() { return data.pins; }
function getPin(key) { return data.pins.find(p => p.key === key) || null; }
function isPinned(key) { return data.pins.some(p => p.key === key); }
function setPinned(key, target) {
  data.pins = data.pins.filter(p => p.key !== key);
  if (target) data.pins.push(pinFrom(target));
  save();
}
// Refreshes what a pin remembers from the running app; writes only on change.
function updatePin(key, patch) {
  const p = getPin(key);
  if (!p) return;
  const next = { ...p };
  for (const [k, v] of Object.entries(patch)) if (v) next[k] = v;
  if (JSON.stringify(next) === JSON.stringify(p)) return;
  Object.assign(p, next);
  save();
}

function getZoom(key) { return data.zoom[key] || 0; }
function setZoom(key, level) {
  if (level) data.zoom[key] = level; else delete data.zoom[key];
  save();
}

// [{ key, url, title, icon, partition, window, active }]
function getSession() { return Array.isArray(data.session) ? data.session : []; }
function setSession(list) {
  if (JSON.stringify(list) === JSON.stringify(data.session)) return;
  data.session = list;
  save();
}

// origin -> { permission: true | false }
function getPermission(origin, permission) { return data.permissions[origin]?.[permission]; }
function setPermission(origin, permission, allowed) {
  const o = data.permissions[origin] || (data.permissions[origin] = {});
  if (allowed === null) delete o[permission]; else o[permission] = allowed;
  if (!Object.keys(o).length) delete data.permissions[origin];
  save();
}
function listPermissions() {
  return Object.entries(data.permissions).flatMap(([origin, o]) => Object.entries(o).map(([permission, allowed]) => ({ origin, permission, allowed })));
}

module.exports = {
  load, getName, setName, isWindowed, setWindowed, windowsByDefault, setWindowsByDefault, getBounds, setBounds,
  getLayout, setLayout, getStandalone, standaloneFor, setStandalone, listStandalone,
  listPins, getPin, isPinned, setPinned, updatePin, getZoom, setZoom, getSession, setSession,
  getPermission, setPermission, listPermissions,
};
