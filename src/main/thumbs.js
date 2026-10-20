// Screenshots for the Previews layout. Taken while an app is on screen, or once
// in a hidden window for apps that were never opened. Kept as small JPEGs in
// userData/thumbs so they survive restarts.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow } = require('electron');

const cache = new Map();   // key -> data url ('' when there is none)
const tried = new Set();   // keys a background capture was attempted for this session
const queue = [];
let busy = false;
let onChange = () => {};

function file(key) {
  const dir = path.join(app.getPath('userData'), 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '.jpg');
}

function get(key) {
  if (!cache.has(key)) {
    let url = '';
    try { url = 'data:image/jpeg;base64,' + fs.readFileSync(file(key)).toString('base64'); } catch { /* none yet */ }
    cache.set(key, url);
  }
  return cache.get(key);
}

function set(key, image) {
  if (!image || image.isEmpty()) return;
  const jpg = image.resize({ width: 560, quality: 'good' }).toJPEG(80);
  try { fs.writeFileSync(file(key), jpg); } catch { /* ignore */ }
  cache.set(key, 'data:image/jpeg;base64,' + jpg.toString('base64'));
  onChange();
}

// target: { key, url, partition }. Loads the page off screen, without the login
// autofill preload, muted, and keeps the last painted frame.
function capture(target) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      show: false, width: 1280, height: 800,
      webPreferences: { offscreen: true, partition: target.partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const wc = w.webContents;
    let last = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!w.isDestroyed()) w.destroy();
      resolve(last);
    };
    const timer = setTimeout(finish, 12000);
    wc.setAudioMuted(true);
    wc.setFrameRate(4);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('paint', (_e, _dirty, image) => { last = image; });
    wc.on('did-finish-load', () => setTimeout(finish, 2500));   // let SPAs render
    wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => { if (isMainFrame && code !== -3) { last = null; finish(); } });
    wc.loadURL(target.url);
  });
}

async function pump() {
  if (busy) return;
  const target = queue.shift();
  if (!target) return;
  busy = true;
  try { set(target.key, await capture(target)); } catch { /* ignore */ }
  busy = false;
  pump();
}

// One capture at a time, at most once per app and session.
function request(targets) {
  for (const t of targets) {
    if (!t || get(t.key) || tried.has(t.key)) continue;
    tried.add(t.key);
    queue.push(t);
  }
  pump();
}

module.exports = { get, set, request, onUpdate: (cb) => { onChange = cb; } };
