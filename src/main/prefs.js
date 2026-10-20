// UI preferences: custom app names, apps that open in their own window, window
// positions, the home layout, and detached apps. Written to a temp file and renamed, so a crash never
// leaves half a file behind.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'prefs.json');
let data = { names: {}, windowed: [], windowsByDefault: false, bounds: {}, layout: 'grid', standalone: {} };

function load() {
  try { data = { ...data, ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) }; } catch { /* first run */ }
  // The free-arrangement "desktop" layout was removed; fall back to the grid.
  if (!['grid', 'previews'].includes(data.layout)) data.layout = 'grid';
  delete data.positions;
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

module.exports = {
  load, getName, setName, isWindowed, setWindowed, windowsByDefault, setWindowsByDefault, getBounds, setBounds,
  getLayout, setLayout, getStandalone, standaloneFor, setStandalone, listStandalone,
};
