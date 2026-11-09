// Minimal credential store: one JSON file in userData, passwords encrypted with
// the OS keyring via safeStorage (DPAPI on Windows, libsecret/kwallet on Linux).
const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const identity = require('./identity');

const FILE = () => path.join(app.getPath('userData'), 'credentials.json');
// { id, origin, username, password: 'enc:<base64>' | 'plain:<text>', owners }
// owners (local origins only): the processes it was saved with or typed into,
// [{ key, exe, cwd }] (identity.js); undefined for logins saved before Pane kept them.
let entries = [];
let never = [];     // origins the user said never to ask for
let nextId = 1;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    entries = (data.entries || []).map(e => ({ ...e, id: nextId++ }));
    never = data.never || [];
  } catch { /* first run */ }
}
function save() {
  const data = { entries: entries.map(({ origin, username, password, owners }) => ({ origin, username, password, owners })), never };
  try { fs.writeFileSync(FILE(), JSON.stringify(data, null, 2), { mode: 0o600 }); } catch { /* ignore */ }
}

function encrypted() { return safeStorage.isEncryptionAvailable(); }
function enc(s) { return encrypted() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : 'plain:' + s; }
function dec(s) {
  if (s.startsWith('enc:')) { try { return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); } catch { return ''; } }
  return s.replace(/^plain:/, '');
}

function backend() {
  if (!encrypted()) return 'unencrypted (no OS keyring available)';
  return process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'OS keyring';
}

// Entries that no longer decrypt (keyring changed) are skipped rather than filled in empty.
function forOrigin(origin) {
  return entries.filter(e => e.origin === origin)
    .map(e => ({ username: e.username, password: dec(e.password), owners: e.owners })).filter(c => c.password);
}
function find(origin, username) { return entries.find(e => e.origin === origin && e.username === username); }
function matches(origin, username, password) {
  const e = find(origin, username);
  return !!e && dec(e.password) === password;
}
// owner: evidence of the process it was typed into (identity.js), or null for a network origin.
function set(origin, username, password, owner = null) {
  let e = find(origin, username);
  if (e) e.password = enc(password);
  else entries.push(e = { id: nextId++, origin, username, password: enc(password) });
  if (owner) e.owners = identity.addOwner(e.owners, owner);
  save();
}
// The user typed this saved login into another process (or one saved before owners were kept) and it worked.
function addOwner(origin, username, owner) {
  const e = find(origin, username);
  if (!e || !owner) return;
  const next = identity.addOwner(e.owners, owner);
  if (next !== e.owners) { e.owners = next; save(); }
}
function remove(id) { entries = entries.filter(e => e.id !== id); save(); }
function isNever(origin) { return never.includes(origin); }
function addNever(origin) { if (!never.includes(origin)) { never.push(origin); save(); } }
function list() { return entries.map(({ id, origin, username }) => ({ id, origin, username })); }

module.exports = { load, forOrigin, matches, set, addOwner, remove, isNever, addNever, list, backend };
