const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu, clipboard, screen, nativeTheme, nativeImage, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile, spawn } = require('node:child_process');
const treeKill = require('tree-kill');
const { listListeners } = require('./scanner');
const { probe } = require('./probe');
const icons = require('./icons');
const netapps = require('./netapps');
const passwords = require('./passwords');
const hidden = require('./hidden');
const prefs = require('./prefs');
const standalone = require('./standalone');
const thumbs = require('./thumbs');
const { discover } = require('./discover');
const { selfInstall } = require('./install');
const launch = require('./launch');

const TAB_BAR_HEIGHT = 40;
const FRAME_HEIGHT = 34;          // title strip of an app opened in its own window
const SCAN_INTERVAL_MS = 2000;
const REPROBE_MS = 30000;         // confirmed web apps
const REPROBE_PENDING_MS = 5000;  // everything else, which may still be starting up
const START_TIMEOUT_MS = 90000;   // a started server that never answers is given up on
const NET_REPROBE_MS = 15000;     // user-added network apps
const HOME_BG = { dark: '#16171b', light: '#f5f5f6' };   // --page in style.css

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const LAYOUTS = ['grid', 'previews'];

let win = null;              // main window: tab bar + launcher
const servers = new Map();   // id -> server record
// tabId -> { id, serverId, key, label, partition, view, title, url, icon, theme, loading, failed, host }
// host is null for a tab in the main window, or the BrowserWindow of an app opened on its own.
const tabs = new Map();
let activeTab = 'home';
let nextTabId = 1;
let nextLinkId = 1;
let scanning = null;         // the scan in flight
const starting = new Map();  // app key -> time its server was started from Pane, until it answers

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// ---------- discovery ----------

function serverId(l) { return `${l.pid || 0}:${l.port}`; }
// Stable across restarts (pids change); the same key hidden.js uses.
function serverKey(s) { return `${s.name || ''}:${s.port}`; }

// Full scan while the main window exists. With only app windows open nobody sees
// the launcher, so then the failed tabs are just retried, without listing ports.
function scan() {
  if (!scanning) {   // a slow probe must not stack up scans
    const full = win && !win.isDestroyed();
    scanning = (full ? scanOnce() : Promise.resolve().then(retryFailed))
      .catch(() => {})
      .finally(() => { scanning = null; });
  }
  return scanning;
}
function retryFailed() { for (const t of tabs.values()) if (t.failed) recover(t.key); }

async function scanOnce() {
  const listeners = await listListeners();
  const seen = new Set();
  let changed = false;
  const now = Date.now();
  await Promise.all(listeners.map(async (l) => {
    if (l.pid === process.pid) return;
    const id = serverId(l);
    seen.add(id);
    let s = servers.get(id);
    if (!s) {
      s = { id, port: l.port, pid: l.pid, name: l.name, cmdline: l.cmdline, argv: l.argv, cwd: l.cwd, exe: l.exe,
            host: l.reachHost, kind: null, title: '', url: '', proto: '', icon: '', probedAt: 0 };
      servers.set(id, s);
      changed = true;
    }
    if (now - s.probedAt > (s.kind === 'html' ? REPROBE_MS : REPROBE_PENDING_MS)) {
      s.probedAt = now;
      const p = await probe(s.host, s.port);
      const kind = p ? p.kind : 'none';
      if (kind !== s.kind || (p && p.title !== s.title)) changed = true;
      s.kind = kind;
      if (p) { s.title = p.title; s.url = p.url; s.proto = p.proto; }
      if (kind === 'html') {
        if (!s.iconTried) {
          s.iconTried = true;
          icons.forPage(p.url, p.body).then((icon) => { if (icon && servers.get(id) === s) { s.icon = icon; refreshPin(s); pushServers(); } });
        }
        refreshPin(s);
        if (starting.delete(serverKey(s))) { pushPins(); notifyKey(serverKey(s)); recover(serverKey(s), true); }
      }
    }
    if (s.kind === 'html') recover(serverKey(s));   // its tabs that failed while it was down
  }));
  for (const id of servers.keys()) {
    if (!seen.has(id)) { servers.delete(id); changed = true; }
  }
  if (changed) pushServers();
}

function publicServers() {
  return [...servers.values()]
    .filter(s => s.kind && s.kind !== 'none')
    .map((s) => {
      const { id, port, pid, name, cmdline, cwd, exe, host, kind, title, url, proto, icon } = s;
      const key = serverKey(s);
      return { id, key, port, pid, name, cmdline, cwd, exe, host, kind, title, url, proto, icon,
               label: prefs.getName(key), hidden: hidden.isHidden(s), thumb: thumbFor(key) };
    });
}
function pushServers() { send('servers:update', publicServers()); }

async function scanNet(force = false) {
  if (!win || win.isDestroyed()) return;   // nobody sees the list; failed tabs are retried by scan()
  if (await netapps.refresh(force ? 0 : NET_REPROBE_MS)) pushNet();
  for (const a of netapps.list()) if (a.online) recover(a.url);
}
function publicNet() { return netapps.list().map(a => ({ ...a, key: a.url, label: prefs.getName(a.url), thumb: thumbFor(a.url) })); }
function thumbFor(key) { return prefs.getLayout() === 'previews' ? thumbs.get(key) : ''; }
function pushNet() { send('net:update', publicNet()); }

// ---------- pinned apps ----------
// Pinned apps sit at the top of home and stay there while their server is down
// (tile id "pin:<key>"). A local one remembers how its server was started.

function publicPins() {
  return prefs.listPins().map(p => ({
    key: p.key, local: p.local, title: p.title, label: prefs.getName(p.key), icon: p.icon, url: p.url,
    thumb: thumbFor(p.key), canStart: p.local && launch.canStart(p.start), starting: starting.has(p.key),
  }));
}
function pushPins() { send('pins:update', publicPins()); }

function pin(target) {
  const s = target.id && servers.get(target.id);
  prefs.setPinned(target.key, { ...target, start: s ? launch.commandOf(s) : null });
  pushPins();
}
function unpin(key) { prefs.setPinned(key, null); pushPins(); }

// Keeps a pin's title, icon and start command current while its app runs.
function refreshPin(s) {
  const key = serverKey(s);
  if (prefs.isPinned(key)) prefs.updatePin(key, { title: s.title, url: s.url, icon: s.icon, start: launch.commandOf(s) });
}

// Resolves when something answers on the URL's port.
function listening(url) {
  let host, port;
  try { const u = new URL(url); host = u.hostname.replace(/^\[|\]$/g, ''); port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80); }
  catch { return Promise.resolve(false); }
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Starts an app's server with { start, url, title }: a pin, or what a running
// server was seen with. Returns false when there is nothing to start.
async function startServer(key, info) {
  if (starting.has(key) || !launch.canStart(info.start)) return false;
  if (await listening(info.url)) return false;   // already up
  const name = prefs.getName(key) || info.title || key;
  const fail = (detail) => {
    if (!starting.delete(key)) return;
    pushPins(); notifyKey(key);
    startFailed(key, name, detail);
  };
  let child;
  starting.set(key, Date.now());
  try { child = launch.start(key, info.start); } catch (err) { fail(String(err.message || err)); return false; }
  child.once('error', (err) => fail(String(err.message || err)));
  // Exit code 0 can be a server that forked itself into the background.
  child.once('exit', (code, signal) => { if (code !== 0) fail(signal ? `It was ended by ${signal}.` : `It exited with code ${code}.`); });
  setTimeout(() => { if (starting.delete(key)) { pushPins(); notifyKey(key); } }, START_TIMEOUT_MS);
  pushPins();
  notifyKey(key);
  return true;
}
function startPinned(key) {
  const p = prefs.getPin(key);
  return p && p.local ? startServer(key, p) : Promise.resolve(false);
}

async function startFailed(key, name, detail) {
  const log = launch.hasLog(key);
  const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'error', message: `${name} did not start`, detail, noLink: true,
    buttons: log ? ['Show output', 'Close'] : ['Close'], defaultId: 0, cancelId: log ? 1 : 0,
  });
  if (log && response === 0) shell.openPath(launch.logFile(key));
}

// Stops a local server and starts it again with the same command.
function restartServer(s) {
  const key = serverKey(s);
  const info = { start: launch.commandOf(s), url: s.url, title: s.title || s.name };
  treeKill(s.pid, 'SIGTERM', async (err) => {
    if (err) { dialog.showMessageBox(win, { type: 'error', message: `Could not stop ${info.title}`, detail: String(err.message || err) }); return; }
    for (let i = 0; i < 40 && await listening(info.url); i++) await new Promise(r => setTimeout(r, 250));
    startServer(key, info);
  });
}

// Resolves a server id (local "pid:port", "net:n" or "pin:<key>") to what a tab needs.
function resolveTarget(sid) {
  if (String(sid).startsWith('pin:')) {
    const key = sid.slice(4);
    const live = [...servers.values()].find(x => x.kind === 'html' && serverKey(x) === key)
      || netapps.list().find(a => a.url === key);
    if (live) return resolveTarget(live.id);
    const p = prefs.getPin(key);
    return p && { id: null, key, url: p.url, icon: p.icon, label: prefs.getName(key), title: p.title || key, partition: p.partition };
  }
  const s = servers.get(sid);
  if (s) {
    const key = serverKey(s);
    return { id: s.id, key, url: s.url, icon: s.icon, label: prefs.getName(key),
             title: s.title || s.name || `:${s.port}`, partition: `persist:app-${s.port}` };
  }
  const n = netapps.get(sid);
  if (n) {
    let host = n.url; try { host = new URL(n.url).host; } catch { /* keep */ }
    return { id: n.id, key: n.url, url: n.url, icon: n.icon, label: prefs.getName(n.url),
             title: n.title || host, partition: `persist:net-${host}` };
  }
  return null;
}

// ---------- tabs and app windows ----------

function windowOf(t) { return t.host || win; }
function mainTabs() { return [...tabs.values()].filter(t => !t.host); }

function contentBounds(t) {
  const bar = t.host ? FRAME_HEIGHT : TAB_BAR_HEIGHT;
  const [w, h] = windowOf(t).getContentSize();
  return { x: 0, y: bar, width: w, height: Math.max(0, h - bar) };
}

// Sizes the main window's views; with focus, also hands the keyboard to the active app.
function layout(focus = false) {
  if (!win || win.isDestroyed()) return;
  for (const t of mainTabs()) {
    const show = t.id === activeTab && !t.failed;
    t.view.setVisible(show);
    if (show) t.view.setBounds(contentBounds(t));
  }
  if (!focus) return;
  const active = tabs.get(activeTab);
  if (active && !active.failed) active.view.webContents.focus();
  else win.webContents.focus();
}

// On Linux the size read during 'resize' can still be the old one (always on
// maximize), and no second event follows. So lay out on every size event and
// again once the window has settled; the chrome page also reports its resizes.
function onResize(w, fn) {
  let timers = [];
  const run = () => {
    fn();
    timers.forEach(clearTimeout);
    timers = [80, 300].map(ms => setTimeout(fn, ms));
  };
  for (const ev of ['resize', 'resized', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) w.on(ev, run);
  return run;
}
function layoutWindow(t) {
  if (!t.host || t.host.isDestroyed()) return;
  t.view.setVisible(!t.failed);
  t.view.setBounds(contentBounds(t));
}
function relayout(t) { if (t.host) layoutWindow(t); else layout(); }

// "(3) Inbox": the count becomes a badge, the title is shown without it.
function unread(title) {
  const m = /^\s*[([](\d{1,5})\+?[)\]]\s*/.exec(title || '');
  return m ? { count: Number(m[1]), title: title.slice(m[0].length) } : { count: 0, title };
}
function windowTitle(t) {
  const name = t.label || t.title || 'Pane';
  return t.count ? `(${t.count}) ${name}` : name;
}

function publicTab(t) {
  const p = prefs.getPin(t.key);
  return { id: t.id, key: t.key, title: t.label || t.title, url: t.url, icon: t.icon, theme: t.theme, count: t.count || 0,
           loading: t.loading, failed: t.failed ? t.failed.desc : null,
           starting: starting.has(t.key), canStart: !!(p && p.local && launch.canStart(p.start)) };
}
function pushTabs() {
  const counts = {};
  for (const t of tabs.values()) if (t.count) counts[t.key] = (counts[t.key] || 0) + t.count;
  send('tabs:update', { active: activeTab, tabs: mainTabs().map(publicTab), open: [...tabs.values()].map(t => t.key), counts });
  if (win && !win.isDestroyed()) {
    const t = tabs.get(activeTab);
    win.setTitle(t ? windowTitle(t) : 'Pane');   // the taskbar shows the app, not the browser
  }
  updateBadgeCount();
  saveSession();
}
function pushFrame(t) {
  if (!t.host || t.host.isDestroyed()) return;
  t.host.webContents.send('frame:update', publicTab(t));
  t.host.setTitle(windowTitle(t));
}
// App windows are not in the tab list, but home shows their unread counts too.
function notify(t) { if (t.host) { pushFrame(t); pushTabs(); } else pushTabs(); }
function notifyKey(key) { for (const t of tabs.values()) if (t.key === key) notify(t); }

// Linux launchers that support it (KDE, Unity) show the total unread count on Pane's icon.
let badgeCount = 0;
function updateBadgeCount() {
  if (process.platform !== 'linux') return;
  const n = [...tabs.values()].reduce((sum, t) => sum + (t.count || 0), 0);
  if (n !== badgeCount) { badgeCount = n; app.setBadgeCount(n); }
}

// ---------- reopening apps ----------
// The apps open when Pane closes are reopened on the next start. Closing a
// single window takes its app off the list; closing the last one keeps it.
let mainOpened = false;     // started from a standalone launcher only: leave the list alone
let restored = false;       // saving waits until the saved list was read back
let sessionTimer = null;
let sessionFrozen = false;

function sessionSnapshot() {
  return [...tabs.values()].filter(t => !t.key.startsWith('link:')).map(t => ({
    key: t.key, url: t.url, title: t.title, icon: t.icon, partition: t.partition,
    window: !!t.host, active: !t.host && t.id === activeTab,
  }));
}
function saveSession() {
  if (sessionFrozen || !mainOpened || !restored) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => { sessionTimer = null; prefs.setSession(sessionSnapshot()); }, 1000);
}
function freezeSession() {
  if (sessionFrozen) return;
  clearTimeout(sessionTimer);
  if (mainOpened && restored) prefs.setSession(sessionSnapshot());
  sessionFrozen = true;
}
// Called from a window's 'close': the last one going means Pane is quitting.
function windowClosing() {
  const open = (win && !win.isDestroyed() ? 1 : 0) + [...tabs.values()].filter(t => t.host && !t.host.isDestroyed()).length;
  if (open <= 1) freezeSession();
}

// Local apps come back only if their server runs (or they are pinned); a dev server that is gone stays closed.
function restoreSession() {
  restored = true;
  const live = new Set([...servers.values()].filter(x => x.kind === 'html').map(serverKey));
  let active = null;
  for (const e of prefs.getSession()) {
    if (!/^https?:\/\//.test(e.key) && !live.has(e.key) && !prefs.isPinned(e.key)) continue;
    if ([...tabs.values()].some(t => t.key === e.key)) continue;
    const id = openTab({ id: null, key: e.key, url: e.url, title: e.title, label: prefs.getName(e.key), icon: e.icon, partition: e.partition },
      { window: !!e.window });
    if (e.active) active = id;
  }
  if (win && !win.isDestroyed()) activateTab(active || 'home');
}

// Samples the top strip of the page and reports its average color, so the
// bar above it can blend in.
async function sampleTheme(t) {
  const w = t && windowOf(t);
  if (!w || w.isDestroyed() || w.isMinimized() || !w.isVisible()) return;
  if ((!t.host && t.id !== activeTab) || t.failed || t.view.webContents.isDestroyed()) return;
  const { width } = contentBounds(t);
  if (width < 8) return;
  let img;
  try { img = await t.view.webContents.capturePage({ x: 0, y: 0, width: Math.min(width, 600), height: 6 }); }
  catch { return; }
  const { width: iw, height: ih } = img.getSize();
  if (!iw || !ih) return;
  const px = img.toBitmap();           // BGRA
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < px.length; i += 4 * 3) { b += px[i]; g += px[i + 1]; r += px[i + 2]; n++; }
  r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const theme = { color: `rgb(${r},${g},${b})`, dark: lum < 0.5 };
  if (!t.theme || t.theme.color !== theme.color) { t.theme = theme; notify(t); }
}
let ticks = 0;
setInterval(() => {
  const thumbTime = ++ticks % 40 === 0;   // every minute
  for (const t of tabs.values()) {
    if (!t.host && t.id !== activeTab) continue;
    sampleTheme(t);
    if (thumbTime) captureThumb(t);
  }
}, 1500);

async function captureThumb(t) {
  const w = windowOf(t);
  if (!w || w.isDestroyed() || w.isMinimized() || t.failed || t.key.startsWith('link:') || t.view.webContents.isDestroyed()) return;
  if (!t.host && t.id !== activeTab) return;
  try { thumbs.set(t.key, await t.view.webContents.capturePage()); } catch { /* ignore */ }
}

// Where an app opens unless asked otherwise: its own window if it is marked so, or if that is the default.
function opensInWindow(key) { return prefs.windowsByDefault() || prefs.isWindowed(key); }

// opts.window forces a tab (false) or a window (true); an app already open is moved there.
function openTab(target, opts = {}) {
  const explicit = 'window' in opts;
  const inWindow = explicit ? opts.window : opensInWindow(target.key);
  const existing = [...tabs.values()].find(t => t.key === target.key);
  if (existing) {
    if (inWindow && !existing.host) moveToWindow(existing);
    else if (explicit && !inWindow && existing.host) moveToTabs(existing);
    else reveal(existing);
    return existing.id;
  }
  const view = new WebContentsView({
    webPreferences: {
      partition: target.partition,   // own cookies per app
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, 'content-preload.js'),
    },
  });
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? HOME_BG.dark : HOME_BG.light);
  const id = String(nextTabId++);
  const t = { id, serverId: target.id, key: target.key, label: target.label || '', partition: target.partition, view,
              title: target.title, url: target.url, icon: target.icon || '', theme: null, loading: true, failed: null, host: null, count: 0 };
  tabs.set(id, t);
  wire(t);
  view.webContents.loadURL(target.url);
  if (inWindow) attachWindow(t);
  else {
    if (!win || win.isDestroyed()) createWindow();
    win.contentView.addChildView(view);
    activeTab = id;
    layout(true);
  }
  pushTabs();
  return id;
}

// A link from inside an app, opened next to it with the same cookies.
function openLink(from, url) {
  let host = url; try { host = new URL(url).host; } catch { /* keep */ }
  openTab({ id: null, key: `link:${nextLinkId++}`, url, title: host, icon: from.icon, partition: from.partition }, { window: false });
}

function reveal(t) {
  if (t.host) { t.host.show(); t.host.focus(); return; }
  if (!win || win.isDestroyed()) return;
  activeTab = t.id;
  layout(true);
  pushTabs();
  win.show();
  win.focus();
}

function wire(t) {
  const wc = t.view.webContents;
  wc.on('page-title-updated', (_e, title) => {
    if (t.failed) return;
    const u = unread(title);
    t.title = u.title;
    t.count = u.count;
    notify(t);
  });
  wc.on('page-favicon-updated', async (_e, favicons) => {
    const icon = await icons.fetchIcon(favicons[0]);
    if (icon && icon !== t.icon) { t.icon = icon; notify(t); }
  });
  wc.on('did-start-loading', () => { t.loading = true; notify(t); });
  wc.on('did-stop-loading', () => {
    t.loading = false;
    notify(t);
    setTimeout(() => sampleTheme(t), 150);
    setTimeout(() => captureThumb(t), 2500);
  });
  wc.on('did-navigate', (_e, url) => {
    t.url = url;
    if (t.failed) { t.failed = null; relayout(t); }
    const z = prefs.getZoom(t.key);   // zoom is remembered per app
    if (z !== wc.getZoomLevel()) wc.setZoomLevel(z);
    notify(t);
  });
  wc.on('did-finish-load', () => { if (!t.failed && starting.delete(t.key)) { pushPins(); notifyKey(t.key); } });
  wc.on('found-in-page', (_e, r) => {
    const w = windowOf(t);
    if (w && !w.isDestroyed()) w.webContents.send('find:result', { active: r.activeMatchOrdinal, matches: r.matches });
  });
  wc.on('did-navigate-in-page', (_e, url) => { t.url = url; notify(t); });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;   // -3: aborted by a newer navigation
    t.failed = { url: url || t.url, desc: desc.replace(/^ERR_/, '').toLowerCase().replace(/_/g, ' '), at: Date.now() };
    t.loading = false;
    relayout(t);
    notify(t);
  });
  wc.on('before-input-event', (e, input) => { if (handleKey(input, t)) e.preventDefault(); });
  wc.on('context-menu', (_e, params) => pageMenu(t, params));
  wc.setWindowOpenHandler(({ url }) => {
    let u;
    try { u = new URL(url); } catch { return { action: 'deny' }; }
    if (!/^https?:$/.test(u.protocol)) return { action: 'deny' };
    let own = '';
    try { own = new URL(t.url).host; } catch { /* keep */ }
    if (isLocalHost(u.hostname) || u.host === own) openLink(t, url);
    else shell.openExternal(url);
    return { action: 'deny' };
  });
}

// A failed tab reloads by itself once its server answers again (now, with force).
function recover(key, force = false) {
  for (const t of tabs.values()) {
    if (!t.failed || t.key !== key || t.view.webContents.isDestroyed()) continue;
    if (!force && Date.now() - t.failed.at < 3000) continue;
    t.failed.at = Date.now();
    t.view.webContents.loadURL(t.failed.url);
  }
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.host && !t.host.isDestroyed()) { t.host.close(); return; }   // 'closed' destroys the tab
  destroyTab(t);
}

function destroyTab(t) {
  const list = mainTabs();
  const i = list.indexOf(t);
  if (!t.host && win && !win.isDestroyed()) win.contentView.removeChildView(t.view);
  for (const [id, n] of notes) if (n.tab === t) { n.note.close(); notes.delete(id); }
  if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
  tabs.delete(t.id);
  if (activeTab === t.id) {
    const next = list[i + 1] || list[i - 1];   // like a browser: the neighbour, not home
    activeTab = next && next !== t ? next.id : 'home';
  }
  layout(true);
  pushTabs();
}

function moveToWindow(t) {
  if (t.host) return reveal(t);
  if (win && !win.isDestroyed()) win.contentView.removeChildView(t.view);
  if (activeTab === t.id) activeTab = 'home';
  attachWindow(t);
  layout();
  pushTabs();
}

function moveToTabs(t) {
  const w = t.host;
  if (!w) return;
  if (!win || win.isDestroyed()) createWindow();
  t.host = null;           // tells the window's 'closed' handler to leave the tab alive
  w.contentView.removeChildView(t.view);
  w.close();
  win.contentView.addChildView(t.view);
  activeTab = t.id;
  layout(true);
  pushTabs();
  win.show();
  win.focus();
}

// Restores saved bounds only if they still land on a connected display; .maximized rides along.
function savedBounds(key, fallback) {
  const b = prefs.getBounds(key);
  const visible = b && screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
  return visible ? b : fallback;
}

// An app on its own: a slim, app-colored title strip above the page, its own taskbar entry.
function attachWindow(t) {
  const dark = t.theme ? t.theme.dark : nativeTheme.shouldUseDarkColors;
  const bounds = savedBounds(`window:${t.key}`, { width: 1100, height: 760 });
  const w = new BrowserWindow({
    ...bounds, minWidth: 420, minHeight: 300,
    title: t.label || t.title, backgroundColor: dark ? HOME_BG.dark : HOME_BG.light, icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? HOME_BG.dark : HOME_BG.light, symbolColor: dark ? '#e9eaee' : '#1c1d21', height: FRAME_HEIGHT },
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  t.host = w;
  if (bounds.maximized) w.maximize();
  applyStandaloneIdentity(t);
  guardChrome(w.webContents);
  w.contentView.addChildView(t.view);
  w.loadFile(path.join(RENDERER, 'frame.html'), { query: { tab: t.id } });
  layoutWindow(t);
  onResize(w, () => layoutWindow(t));
  w.on('close', () => {
    prefs.setBounds(`window:${t.key}`, { ...w.getNormalBounds(), maximized: w.isMaximized() });
    if (t.host === w) windowClosing();   // not when the app only moves back into a tab
  });
  w.on('closed', () => { if (t.host === w) { t.host = null; destroyTab(t); } });
  w.on('focus', () => w.flashFrame(false));
  w.on('app-command', (_e, cmd) => appCommand(t.view.webContents, cmd));
  w.webContents.on('before-input-event', (e, input) => { if (handleKey(input, t)) e.preventDefault(); });
  w.webContents.on('did-finish-load', () => pushFrame(t));
  t.view.webContents.focus();
}

// ---------- standalone apps ----------

// A detached app's window shows its own icon and, on Windows, groups as its own taskbar entry.
function applyStandaloneIdentity(t) {
  const id = prefs.standaloneFor(t.key);
  const e = id && prefs.getStandalone(id);
  if (!e || !t.host) return;
  if (e.png) { try { t.host.setIcon(nativeImage.createFromDataURL(e.png)); } catch { /* ignore */ } }
  if (process.platform === 'win32') {
    try { t.host.setAppDetails({ appId: standalone.appUserModelId(id), appIconPath: standalone.iconPath(id, 'ico'), relaunchDisplayName: e.name }); } catch { /* ignore */ }
  }
}

// The launcher icon is drawn by a chrome page (common.js rasterIcon), which can render SVG favicons.
async function launcherIcon(chrome, target, name) {
  const wc = chrome && !chrome.isDestroyed() ? chrome : win && !win.isDestroyed() ? win.webContents : null;
  if (!wc) return null;
  try {
    const url = await wc.executeJavaScript(`rasterIcon(${JSON.stringify(target.icon || '')}, ${JSON.stringify(name)}, ${JSON.stringify(target.key)})`);
    return nativeImage.createFromDataURL(url).toPNG();
  } catch { return null; }
}

async function detach(target, chrome) {
  if (!target || target.key.startsWith('link:')) return;
  const id = standalone.idFor(target.key);
  const name = target.label || target.title;
  const png = await launcherIcon(chrome, target, name);
  const where = png && standalone.install(id, name, png);
  if (!where) {
    dialog.showMessageBox(win, { type: 'error', message: `Could not create a launcher entry for ${name}.`, noLink: true });
    return;
  }
  prefs.setStandalone(id, { key: target.key, name, url: target.url, partition: target.partition, icon: target.icon || '',
                            png: 'data:image/png;base64,' + png.toString('base64'), file: where });
  prefs.setWindowed(target.key, true);
  if (!prefs.isPinned(target.key)) pin(target);   // a detached app is one of "my apps"
  openTab(target, { window: true });
  const t = [...tabs.values()].find(x => x.key === target.key);
  if (t) applyStandaloneIdentity(t);
  dialog.showMessageBox(t?.host || win, {
    type: 'info', message: `${name} is now a standalone app.`,
    detail: `Start it from your ${process.platform === 'win32' ? 'Start menu' : 'app menu'}; it opens in its own window. Pin it to the taskbar from there.`,
    noLink: true,
  });
}

function undetach(key) {
  const id = prefs.standaloneFor(key);
  const e = id && prefs.getStandalone(id);
  if (!e) return;
  standalone.uninstall(id, e.file);
  prefs.setStandalone(id, null);
}

// Rewrites a launcher entry (new name, or Pane moved). Returns false when it could not.
function reinstall(id, e, name = e.name) {
  const png = e.png ? nativeImage.createFromDataURL(e.png).toPNG() : null;
  const file = png && standalone.install(id, name, png, e.file);
  if (file) prefs.setStandalone(id, { ...e, name, file });
  return !!file;
}

// On start: entries the user deleted from the menu are forgotten; the others are
// rewritten if they point elsewhere, so they keep working after the AppImage or
// portable exe was moved, or once Pane installed itself on Windows.
function refreshStandalone() {
  for (const [id, e] of prefs.listStandalone()) {
    if (!e.file) continue;
    if (!standalone.exists(e.file)) prefs.setStandalone(id, null);
    else if (!standalone.isCurrent(id, e.file)) reinstall(id, e);
  }
}

// Opens a detached app by its launcher id; works with or without the main window.
function openStandalone(id) {
  const e = id && prefs.getStandalone(id);
  if (!e) return false;
  openTab({ id: null, key: e.key, url: e.url, title: e.name, label: prefs.getName(e.key), icon: e.icon, partition: e.partition }, { window: true });
  startPinned(e.key);   // its server, if it is pinned, local and down
  return true;
}

// ---------- keyboard ----------

function cycleTabs(dir) {
  const order = ['home', ...mainTabs().map(t => t.id)];
  const i = order.indexOf(activeTab);
  activateTab(order[(i + dir + order.length) % order.length]);
}
function activateTab(id) {
  activeTab = tabs.has(id) && !tabs.get(id).host ? id : 'home';
  layout(true);
  pushTabs();
  setTimeout(() => sampleTheme(tabs.get(activeTab)), 100);
}
function showHome(focusSearch) {
  if (!win || win.isDestroyed()) createWindow();
  activateTab('home');
  win.show();
  win.focus();
  if (focusSearch) send('home:focus');
}
function zoom(t, step) {
  const wc = t.view.webContents;
  const level = step ? Math.max(-3, Math.min(5, wc.getZoomLevel() + step)) : 0;
  wc.setZoomLevel(level);
  prefs.setZoom(t.key, level);
}
function appCommand(wc, cmd) {
  if (!wc || wc.isDestroyed()) return;
  if (cmd === 'browser-backward' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  if (cmd === 'browser-forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
}

// Shared by the chrome, every tab and every app window. t is the tab the keys
// apply to (null on the home page). Returns true when the key was handled.
function handleKey(input, t) {
  if (input.type !== 'keyDown') return false;
  const ctrl = input.control || input.meta;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const inMain = !t || !t.host;

  if (ctrl && key === 'w') { if (t) closeTab(t.id); return true; }
  if (ctrl && key === 't') { showHome(true); return true; }
  if (inMain && ctrl && (key === 'Tab' || key === 'PageDown' || key === 'PageUp')) {
    cycleTabs(key === 'PageUp' || input.shift ? -1 : 1);
    return true;
  }
  if (inMain && ctrl && /^[1-9]$/.test(key)) {
    const list = mainTabs();
    const pick = key === '9' ? list[list.length - 1] : list[Number(key) - 1];
    if (pick) activateTab(pick.id);
    return true;
  }
  const wc = t && t.view.webContents;
  if (!wc || wc.isDestroyed()) return false;
  const h = wc.navigationHistory;
  if (input.alt && key === 'ArrowLeft') { if (h.canGoBack()) h.goBack(); return true; }
  if (input.alt && key === 'ArrowRight') { if (h.canGoForward()) h.goForward(); return true; }
  if (ctrl && (key === '+' || key === '=')) { zoom(t, 0.5); return true; }
  if (ctrl && key === '-') { zoom(t, -0.5); return true; }
  if (ctrl && key === '0') { zoom(t, 0); return true; }
  if (ctrl && key === 'f') { openFind(t); return true; }
  if ((ctrl && key === 'F5') || (ctrl && input.shift && key === 'r')) { hardReload(wc); return true; }
  if (key === 'F5' || (ctrl && key === 'r')) { wc.reload(); return true; }
  if (key === 'F12') { wc.toggleDevTools(); return true; }
  return false;
}

// Hard reload: drop the tab's HTTP cache (cookies and storage stay), then reload bypassing cache.
async function hardReload(wc) {
  if (!wc || wc.isDestroyed()) return;
  try { await wc.session.clearCache(); } catch { /* ignore */ }
  wc.reloadIgnoringCache();
}

// ---------- menus ----------

const SEP = { type: 'separator' };
function popup(items, w) {
  Menu.buildFromTemplate(items.map(i => ({ registerAccelerator: false, ...i }))).popup({ window: w });
}
function detachItem(target, chrome) {
  if (!standalone.supported) return { label: 'Detach as standalone app (Linux and Windows)', enabled: false };
  if (target.key.startsWith('link:')) return { label: 'Detach as standalone app', enabled: false };
  return prefs.standaloneFor(target.key)
    ? { label: 'Remove standalone app', click: () => undetach(target.key) }
    : { label: 'Detach as standalone app…', click: () => detach(target, chrome) };
}

// Right-click on an empty spot of the home page.
function homeMenu(sender) {
  const layout = prefs.getLayout();
  const item = (id, label) => ({ label, type: 'radio', checked: layout === id, click: () => setLayout(id) });
  const items = [
    item('grid', 'Grid'), item('previews', 'Previews'),
    SEP,
    { label: 'Open apps in their own window', type: 'checkbox', checked: prefs.windowsByDefault(),
      click: (mi) => { prefs.setWindowsByDefault(mi.checked); pushView(); } },
    SEP,
    { label: 'Find network apps…', click: () => sender.send('home:discover') },
  ];
  popup(items, BrowserWindow.fromWebContents(sender));
}

function setLayout(layout) {
  if (!LAYOUTS.includes(layout)) return;
  prefs.setLayout(layout);
  pushView();
  pushServers();   // thumbnails come and go with the Previews layout
  pushNet();
  pushPins();
}
function publicView() { return { layout: prefs.getLayout(), windowsByDefault: prefs.windowsByDefault() }; }
function pushView() { send('view:update', publicView()); }

function openExternal(url) { if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); }

function navItems(wc) {
  const h = wc.navigationHistory;
  return [
    { label: 'Back', accelerator: 'Alt+Left', enabled: h.canGoBack(), click: () => h.goBack() },
    { label: 'Forward', accelerator: 'Alt+Right', enabled: h.canGoForward(), click: () => h.goForward() },
    { label: 'Reload', accelerator: 'F5', click: () => wc.reload() },
  ];
}

// Right-click on a tab, or on the title strip of an app window.
function tabMenu(t) {
  const wc = t.view.webContents;
  popup([
    ...navItems(wc),
    { label: 'Hard reload', accelerator: 'Ctrl+Shift+R', click: () => hardReload(wc) },
    SEP,
    t.host ? { label: 'Move to tabs', click: () => moveToTabs(t) } : { label: 'Open in own window', click: () => moveToWindow(t) },
    pinItem({ id: t.serverId, key: t.key, url: t.url, title: t.title, icon: t.icon, partition: t.partition }),
    { label: 'Find in page…', accelerator: 'Ctrl+F', click: () => openFind(t) },
    detachItem({ key: t.key, url: t.url, title: t.title, label: t.label, icon: t.icon, partition: t.partition }, windowOf(t)?.webContents),
    { label: 'Copy address', click: () => clipboard.writeText(t.url) },
    { label: 'Open in system browser', click: () => openExternal(t.url) },
    { label: 'Developer tools', accelerator: 'F12', click: () => wc.toggleDevTools() },
    SEP,
    { label: t.host ? 'Close window' : 'Close tab', accelerator: 'Ctrl+W', click: () => closeTab(t.id) },
  ], windowOf(t));
}

// Right-click inside a page. Electron has no context menu of its own.
function pageMenu(t, p) {
  const wc = t.view.webContents;
  const items = [];
  if (/^https?:/.test(p.linkURL)) {
    items.push(
      { label: 'Open link in new tab', click: () => openLink(t, p.linkURL) },
      { label: 'Open link in system browser', click: () => openExternal(p.linkURL) },
      { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
      SEP);
  }
  if (p.mediaType === 'image') items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) }, SEP);
  if (p.isEditable) {
    const f = p.editFlags;
    items.push(
      { label: 'Undo', accelerator: 'Ctrl+Z', enabled: f.canUndo, click: () => wc.undo() },
      { label: 'Redo', accelerator: 'Ctrl+Shift+Z', enabled: f.canRedo, click: () => wc.redo() },
      SEP,
      { label: 'Cut', accelerator: 'Ctrl+X', enabled: f.canCut, click: () => wc.cut() },
      { label: 'Copy', accelerator: 'Ctrl+C', enabled: f.canCopy, click: () => wc.copy() },
      { label: 'Paste', accelerator: 'Ctrl+V', enabled: f.canPaste, click: () => wc.paste() },
      { label: 'Select all', accelerator: 'Ctrl+A', click: () => wc.selectAll() },
      SEP);
  } else if (p.selectionText.trim()) {
    items.push({ label: 'Copy', accelerator: 'Ctrl+C', click: () => wc.copy() }, SEP);
  }
  items.push(...navItems(wc), SEP, { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
  popup(items, windowOf(t));
}

function pinItem(target) {
  if (target.key.startsWith('link:')) return { label: 'Pin to top', enabled: false };
  return prefs.isPinned(target.key)
    ? { label: 'Unpin from top', click: () => unpin(target.key) }
    : { label: 'Pin to top', click: () => pin(target) };
}

// Right-click on a launcher tile (or a row in Manage). sid "pin:<key>" is a pinned app whose server is down.
function tileMenu(sender, sid) {
  const target = resolveTarget(sid);
  if (!target) return;
  const s = servers.get(target.id);
  const n = netapps.get(target.id);
  const p = prefs.getPin(target.key);
  const open = [...tabs.values()].find(t => t.key === target.key);
  const items = [
    opensInWindow(target.key)
      ? { label: 'Open in tab', accelerator: 'Ctrl+Enter', click: () => openTab(target, { window: false }) }
      : { label: open && open.host ? 'Show window' : 'Open in own window', accelerator: 'Ctrl+Enter', click: () => openTab(target, { window: true }) },
    { label: 'Always open in own window', type: 'checkbox', checked: prefs.isWindowed(target.key),
      click: (mi) => prefs.setWindowed(target.key, mi.checked) },
    pinItem(target),
    detachItem(target, sender),
    SEP,
    { label: 'Rename…', click: () => sender.send('tile:rename', sid) },
    { label: 'Copy address', click: () => clipboard.writeText(target.url) },
    { label: 'Open in system browser', click: () => openExternal(target.url) },
  ];
  const cwd = (s && s.cwd) || (p && p.start && p.start.cwd);
  if (cwd) items.push({ label: editorCmd ? 'Open folder in VS Code' : 'Open folder', click: () => openFolder(cwd) });
  items.push(SEP);
  if (s) {
    if (!p) {
      const isHidden = hidden.isHidden(s);
      items.push({ label: isHidden ? 'Show on home' : 'Hide', click: () => { if (isHidden) hidden.unhide(s); else hidden.hide(s); pushServers(); } });
    }
    if (s.pid && launch.commandOf(s)) items.push({ label: 'Restart server', click: () => restartServer(s) });
    if (s.pid) items.push({ label: 'Stop…', click: () => confirmStop(s) });
  } else if (n) {
    items.push({ label: 'Remove', click: () => removeNet(n.id) });
  } else if (p && p.local) {
    items.push({ label: starting.has(p.key) ? 'Starting…' : 'Start server', enabled: launch.canStart(p.start) && !starting.has(p.key),
                 click: () => startPinned(p.key) });
  }
  if (launch.hasLog(target.key)) items.push({ label: 'Show server output', click: () => shell.openPath(launch.logFile(target.key)) });
  if (items[items.length - 1] === SEP) items.pop();
  popup(items, BrowserWindow.fromWebContents(sender));
}

// ---------- processes, folders, network apps ----------

async function confirmStop(s) {
  const name = prefs.getName(serverKey(s)) || s.title || s.name;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', message: `Stop ${name}?`,
    detail: `Ends ${s.name || 'the process'} (pid ${s.pid}) and its child processes.`,
    buttons: ['Stop', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
  });
  if (response !== 0) return;
  treeKill(s.pid, 'SIGTERM', (err) => {
    if (err) { dialog.showMessageBox(win, { type: 'error', message: `Could not stop ${name}`, detail: String(err.message || err) }); return; }
    for (const t of [...tabs.values()]) if (t.key === serverKey(s)) closeTab(t.id);
    setTimeout(scan, 500);
  });
}

function removeNet(id) {
  const n = netapps.get(id);
  if (n) for (const t of [...tabs.values()]) if (t.key === n.url) closeTab(t.id);
  if (n && prefs.isPinned(n.url)) unpin(n.url);
  netapps.remove(id);
  pushNet();
}

let editorCmd = null;   // 'code' when VS Code is on the PATH
function detectEditor() {
  execFile('code', ['--version'], { shell: process.platform === 'win32', windowsHide: true }, (err) => {
    if (!err) editorCmd = 'code';
  });
}

function openFolder(dir) {
  if (!editorCmd) { shell.openPath(dir); return; }
  // cmd.exe needs the quotes: with shell: true, Node joins the arguments unquoted.
  const arg = process.platform === 'win32' ? `"${dir.replace(/"/g, '')}"` : dir;
  const child = spawn(editorCmd, [arg], { shell: process.platform === 'win32', detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => shell.openPath(dir));
  child.unref();
}

// ---------- ipc ----------

ipcMain.handle('servers:list', () => publicServers());
ipcMain.handle('servers:unhide', (_e, sid) => { const s = servers.get(sid); if (s) { hidden.unhide(s); pushServers(); } });
ipcMain.handle('net:list', () => publicNet());
ipcMain.handle('pins:list', () => publicPins());
// One search of the local network at a time; a second request joins the running one.
let discovering = null;
ipcMain.handle('net:discover', (e) => {
  if (!discovering) {
    const report = (f, text) => { if (!e.sender.isDestroyed()) e.sender.send('net:discover-progress', { f, text }); };
    discovering = discover({ known: netapps.list().map(a => a.url), onProgress: report })
      .catch(() => [])
      .finally(() => { discovering = null; });
  }
  return discovering;
});
ipcMain.handle('net:add', async (_e, input) => { const r = netapps.add(input); if (r.ok) { pushNet(); scanNet(); } return r; });
ipcMain.handle('app:rename', (_e, sid, name) => {
  const target = resolveTarget(sid);
  if (!target) return;
  prefs.setName(target.key, name);
  for (const t of tabs.values()) if (t.key === target.key) { t.label = prefs.getName(target.key); notify(t); }
  const id = prefs.standaloneFor(target.key);   // the launcher entry follows the new name
  if (id) reinstall(id, prefs.getStandalone(id), prefs.getName(target.key) || target.title);
  pushServers();
  pushNet();
  pushPins();
});
ipcMain.handle('tile:menu', (e, sid) => tileMenu(e.sender, sid));
ipcMain.handle('home:menu', (e) => homeMenu(e.sender));
ipcMain.handle('view:get', () => publicView());
ipcMain.handle('view:layout', (_e, layout) => setLayout(layout));
ipcMain.handle('thumbs:want', (_e, sids) => {
  if (!Array.isArray(sids)) return;
  thumbs.request(sids.slice(0, 50).map(resolveTarget).filter(Boolean));
});
// other: Ctrl/middle click, which opens the app the other way than it normally would.
ipcMain.handle('tab:open', (_e, sid, other) => {
  const t = resolveTarget(sid);
  if (!t) return null;
  if (!t.id) startPinned(t.key);   // a pinned app whose server is down
  return openTab(t, other ? { window: !opensInWindow(t.key) } : {});
});
ipcMain.handle('tab:start', (_e, id) => { const t = tabs.get(id); if (t) startPinned(t.key); });
ipcMain.handle('tab:activate', (_e, id) => activateTab(id));
ipcMain.handle('tab:close', (_e, id) => closeTab(id));
ipcMain.handle('tab:menu', (_e, id) => { const t = tabs.get(id); if (t) tabMenu(t); });
ipcMain.handle('tab:retry', (_e, id) => { const t = tabs.get(id); if (t && t.failed) t.view.webContents.loadURL(t.failed.url); });
ipcMain.handle('chrome:resized', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && w === win) layout();
  else for (const t of tabs.values()) if (t.host === w) layoutWindow(t);
});
ipcMain.handle('frame:get', (_e, id) => { const t = tabs.get(id); return t ? publicTab(t) : null; });
// Windows shows the unread count drawn by the chrome page (common.js badgeIcon) on the taskbar button.
ipcMain.handle('chrome:badge', (e, count, png) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed() || process.platform !== 'win32') return;
  const img = count && /^data:image\/png;base64,/.test(String(png)) ? nativeImage.createFromDataURL(png) : null;
  w.setOverlayIcon(img, count ? `${count} unread` : '');
});

// ---------- find in page ----------
// The find field lives in the bar of the window the app is in (common.js).
function openFind(t) {
  const w = windowOf(t);
  if (!w || w.isDestroyed()) return;
  w.webContents.focus();
  w.webContents.send('find:open');
}
function findTarget(sender) {
  const w = BrowserWindow.fromWebContents(sender);
  const t = w === win ? tabs.get(activeTab) : [...tabs.values()].find(x => x.host === w);
  return t && !t.view.webContents.isDestroyed() ? t : null;
}
ipcMain.handle('find:query', (e, text, { forward = true, again = false } = {}) => {
  const t = findTarget(e.sender);
  if (!t) return;
  if (!text) { t.view.webContents.stopFindInPage('clearSelection'); e.sender.send('find:result', { active: 0, matches: 0 }); return; }
  t.view.webContents.findInPage(String(text), { forward, findNext: !again });
});
ipcMain.handle('find:close', (e) => {
  const t = findTarget(e.sender);
  if (!t) return;
  t.view.webContents.stopFindInPage('keepSelection');
  t.view.webContents.focus();
});
ipcMain.handle('chrome:color', (e, { color, symbolColor } = {}) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed() || typeof w.setTitleBarOverlay !== 'function') return;
  if (!/^(#[0-9a-f]{6}|rgb\(\d+,\d+,\d+\))$/i.test(String(color))) return;
  const height = w === win ? TAB_BAR_HEIGHT : FRAME_HEIGHT;
  try { w.setTitleBarOverlay({ color: toHex(color), symbolColor: symbolColor === 'dark' ? '#1c1d21' : '#e9eaee', height }); } catch { /* unsupported */ }
});
function toHex(c) {
  if (c.startsWith('#')) return c;
  return '#' + c.match(/\d+/g).map(n => Number(n).toString(16).padStart(2, '0')).join('');
}

// ---------- passwords ----------
// The origin always comes from the sender's real URL, never from the page.
function senderOrigin(e) {
  try { const u = new URL(e.sender.getURL()); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; }
}
function pushPasswords() { send('pw:update', { entries: passwords.list(), backend: passwords.backend() }); }
ipcMain.handle('pw:get', (e) => {
  const origin = senderOrigin(e);
  if (!origin) return null;
  const list = passwords.forOrigin(origin);
  return list.length ? list[0] : null;
});
ipcMain.on('pw:captured', async (e, { username, password } = {}) => {
  const origin = senderOrigin(e);
  if (!origin || typeof password !== 'string' || !password || typeof username !== 'string') return;
  if (passwords.isNever(origin) || passwords.matches(origin, username, password)) return;
  const update = passwords.forOrigin(origin).some(c => c.username === username);
  const host = new URL(origin).host;
  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender) || win, {
    type: 'question',
    message: update ? `Update the saved password for ${username || 'this account'} at ${host}?` : `Save the password for ${username || 'this account'} at ${host}?`,
    detail: `Stored ${passwords.backend()}.`,
    buttons: ['Save', 'Not now', 'Never for this site'], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (response === 0) { passwords.set(origin, username, password); pushPasswords(); }
  if (response === 2) passwords.addNever(origin);
});
ipcMain.handle('pw:list', () => ({ entries: passwords.list(), backend: passwords.backend() }));
ipcMain.handle('pw:remove', (_e, id) => { passwords.remove(Number(id)); pushPasswords(); });

function tabFor(wc) { return [...tabs.values()].find(t => t.view.webContents === wc) || null; }

// ---------- notifications ----------
// content-preload.js routes a page's `new Notification()` here, so it shows
// the app's name and icon and a click brings the app's tab or window forward.
const notes = new Map();   // "<webContents id>:<id>" -> { note, tab }; kept so click handlers survive

function appIcon(t) {
  const id = prefs.standaloneFor(t.key);
  const src = (id && prefs.getStandalone(id)?.png) || t.icon;
  if (!src || !src.startsWith('data:')) return undefined;
  try { const img = nativeImage.createFromDataURL(src); return img.isEmpty() ? undefined : img; } catch { return undefined; }
}

ipcMain.on('note:show', (e, n = {}) => {
  const t = tabFor(e.sender);
  if (!t || !Notification.isSupported()) return;
  const name = t.label || t.title;
  let title = String(n.title || '').slice(0, 200);
  if (!title.toLowerCase().includes(String(name).toLowerCase())) title = title ? `${name}: ${title}` : name;
  const ref = `${e.sender.id}:${n.id}`;
  if (n.tag) {   // same tag: the new one replaces the old
    for (const [k, v] of notes) if (v.tab === t && v.tag === n.tag) { v.note.close(); notes.delete(k); }
  }
  const note = new Notification({ title, body: String(n.body || '').slice(0, 1000), silent: !!n.silent, icon: appIcon(t) });
  const event = (type) => { if (!e.sender.isDestroyed()) e.sender.send('note:event', { id: n.id, type }); };
  notes.set(ref, { note, tab: t, tag: n.tag || '' });
  note.on('show', () => event('show'));
  note.on('click', () => { event('click'); if (tabs.has(t.id)) reveal(t); });
  note.on('close', () => { event('close'); notes.delete(ref); });
  note.show();
  const w = windowOf(t);
  if (w && !w.isDestroyed() && !w.isFocused()) w.flashFrame(true);
});
ipcMain.on('note:close', (e, id) => {
  const ref = `${e.sender.id}:${id}`;
  notes.get(ref)?.note.close();
  notes.delete(ref);
});

// ---------- permissions ----------
// Notifications, fullscreen and the like are granted; camera, microphone,
// location, screen capture and clipboard reading are asked for once per app.
// Anything requested outside an app tab (e.g. a hidden thumbnail window) is refused.
const ASK = {
  camera: 'use your camera', microphone: 'use your microphone', geolocation: 'see your location',
  'display-capture': 'record your screen', 'clipboard-read': 'read your clipboard',
  midi: 'use MIDI devices', midiSysex: 'use MIDI devices', 'idle-detection': 'see when you are away',
  openExternal: 'open another program',
};
function permKeys(permission, details) {
  if (permission !== 'media') return [permission];
  const types = details.mediaTypes && details.mediaTypes.length ? details.mediaTypes : ['audio', 'video'];
  return [...new Set(types.map(x => (x === 'video' ? 'camera' : 'microphone')))];
}
function originOf(url) { try { return new URL(url).origin; } catch { return ''; } }

const asking = new Map();   // one dialog per origin+request at a time
async function requestPermission(wc, permission, details) {
  const t = tabFor(wc);
  if (!t) return false;
  if (permission === 'openExternal' && /^(mailto|tel):/i.test(details.externalURL || '')) return true;
  const keys = permKeys(permission, details);
  if (!keys.some(k => ASK[k])) return true;
  const origin = originOf(details.requestingUrl || wc.getURL());
  const saved = keys.map(k => prefs.getPermission(origin, k));
  if (saved.includes(false)) return false;
  if (saved.every(v => v === true)) return true;
  const ref = `${origin} ${keys.join('+')}`;
  if (!asking.has(ref)) asking.set(ref, ask(t, origin, keys, details).finally(() => asking.delete(ref)));
  return asking.get(ref);
}
async function ask(t, origin, keys, details) {
  const what = keys.length === 2 && keys.includes('camera') ? 'use your camera and microphone' : ASK[keys[0]];
  const { response, checkboxChecked } = await dialog.showMessageBox(windowOf(t), {
    type: 'question', message: `Allow ${t.label || t.title} to ${what}?`,
    detail: keys[0] === 'openExternal' ? String(details.externalURL || origin) : origin,
    buttons: ['Allow', 'Block'], defaultId: 0, cancelId: 1, noLink: true,
    checkboxLabel: 'Remember for this app', checkboxChecked: true,
  });
  const allowed = response === 0;
  if (checkboxChecked) { for (const k of keys) prefs.setPermission(origin, k, allowed); pushPermissions(); }
  return allowed;
}
// Checks (navigator.permissions, Notification.permission) say "granted" unless the user blocked it,
// so apps go ahead and request, which is where Pane asks.
function checkPermission(permission, origin, details) {
  const keys = permission === 'media' ? [details.mediaType === 'video' ? 'camera' : 'microphone'] : [permission];
  const o = originOf(origin);   // Electron passes "http://host:port/", stored ones have no slash
  return !keys.some(k => prefs.getPermission(o, k) === false);
}
app.on('session-created', (ses) => {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    requestPermission(wc, permission, details).then(callback, () => callback(false));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => checkPermission(permission, origin, details || {}));
});

function pushPermissions() { send('perm:update', prefs.listPermissions()); }
ipcMain.handle('perm:list', () => prefs.listPermissions());
ipcMain.handle('perm:forget', (_e, origin, permission) => { prefs.setPermission(String(origin), String(permission), null); pushPermissions(); });

// ---------- windows ----------

// The chrome pages hold the privileged API: never let them navigate or open windows.
function guardChrome(wc) {
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const bg = dark ? HOME_BG.dark : HOME_BG.light;
  const bounds = savedBounds('main', { width: 1280, height: 800 });
  const w = new BrowserWindow({
    ...bounds, minWidth: 560, minHeight: 360,
    title: 'Pane', backgroundColor: bg, icon: ICON,
    // The tab bar doubles as the title bar; the OS only draws the window buttons on top of it.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: bg, symbolColor: dark ? '#e9eaee' : '#1c1d21', height: TAB_BAR_HEIGHT },
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win = w;
  mainOpened = true;
  if (bounds.maximized) w.maximize();
  guardChrome(w.webContents);
  w.loadFile(path.join(RENDERER, 'index.html'));
  onResize(w, () => layout());
  w.on('close', () => {
    prefs.setBounds('main', { ...w.getNormalBounds(), maximized: w.isMaximized() });
    windowClosing();
  });
  w.on('focus', () => w.flashFrame(false));
  w.on('closed', () => {
    const own = mainTabs();
    win = null;
    activeTab = 'home';
    for (const t of own) destroyTab(t);
  });
  w.on('app-command', (_e, cmd) => appCommand(tabs.get(activeTab)?.view.webContents, cmd));
  w.webContents.on('before-input-event', (e, input) => { if (handleKey(input, tabs.get(activeTab) || null)) e.preventDefault(); });
  w.webContents.on('did-finish-load', () => { pushServers(); pushNet(); pushPins(); pushPasswords(); pushPermissions(); pushTabs(); });
  scan();   // the list may be stale after running with app windows only
  scanNet();
}

// Dev aids: PANE_AUTOOPEN=<port>[,<port>…] opens those servers once discovered.
// PANE_SCREENSHOT=/path/out.png captures every window (and the pages in them) and exits.
function devAids() {
  const auto = String(process.env.PANE_AUTOOPEN || '').split(',').map(Number).filter(Boolean);
  if (auto.length) setTimeout(() => {
    for (const port of auto) { const s = [...servers.values()].find(x => x.port === port); if (s) openTab(resolveTarget(s.id)); }
  }, 3000);
  const shot = process.env.PANE_SCREENSHOT;
  if (shot) setTimeout(async () => {
    const fs = require('node:fs');
    const save = async (wc, suffix) => fs.writeFileSync(shot.replace(/\.png$/, `${suffix}.png`), (await wc.capturePage()).toPNG());
    if (win) await save(win.webContents, '');
    const active = tabs.get(activeTab);
    if (active && !active.host) await save(active.view.webContents, '.tab');
    for (const t of tabs.values()) {
      if (t.host) { await save(t.host.webContents, `.win${t.id}`); await save(t.view.webContents, `.win${t.id}.tab`); }
    }
    app.quit();
  }, Number(process.env.PANE_SCREENSHOT_DELAY || 5000));
}

function isLocalHost(h) {
  h = h.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  if (!net.isIPv4(h)) return false;
  const [a, b] = h.split('.').map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

// Local dev servers and LAN boxes often use self-signed certificates; user-added hosts are trusted too.
app.on('certificate-error', (event, _wc, url, _err, _cert, callback) => {
  const h = new URL(url).hostname;
  if (isLocalHost(h) || netapps.hostnames().includes(h)) { event.preventDefault(); callback(true); } else callback(false);
});

// Settings lived under the old name (AppBrowser) before; copy them over once.
function migrateSettings() {
  const dir = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'appbrowser');
  if (old === dir || !fs.existsSync(old) || fs.existsSync(path.join(dir, 'prefs.json')) || fs.existsSync(path.join(dir, 'network-apps.json'))) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['network-apps.json', 'hidden.json', 'credentials.json', 'prefs.json']) {
    try { fs.copyFileSync(path.join(old, f), path.join(dir, f)); } catch { /* not there */ }
  }
  try { fs.cpSync(path.join(old, 'Partitions'), path.join(dir, 'Partitions'), { recursive: true }); } catch { /* cookies of the apps */ }
}

// Dev aid: a separate profile (and with it a separate single-instance lock) to test next to a running copy.
if (process.env.PANE_USER_DATA) app.setPath('userData', process.env.PANE_USER_DATA);
else migrateSettings();

// Windows groups taskbar buttons by this id; detached apps get their own (standalone.appUserModelId).
if (process.platform === 'win32') app.setAppUserModelId('io.github.ennobrok.pane');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => { if (!openStandalone(standalone.fromArgv(argv))) showHome(false); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);   // no hidden menu bar; shortcuts live in handleKey
    netapps.load();
    passwords.load();
    hidden.load();
    prefs.load();
    thumbs.onUpdate(() => { if (prefs.getLayout() === 'previews') { pushServers(); pushNet(); pushPins(); } });
    // Started from a detached app's launcher entry: just that app, no home screen.
    refreshStandalone();
    const solo = openStandalone(standalone.fromArgv(process.argv));
    if (!solo) createWindow();
    devAids();
    detectEditor();
    scan().then(() => { if (solo) restored = true; else restoreSession(); });
    scanNet();
    setInterval(scan, SCAN_INTERVAL_MS);
    setInterval(scanNet, SCAN_INTERVAL_MS);
    // Started as the portable exe: install a copy that starts without unpacking, once the window is up.
    setTimeout(() => selfInstall().then((ok) => { if (ok) refreshStandalone(); }), 5000);
  });
}

app.on('before-quit', freezeSession);
app.on('window-all-closed', () => app.quit());
