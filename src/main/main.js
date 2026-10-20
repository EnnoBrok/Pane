const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu, clipboard, screen, nativeTheme, nativeImage } = require('electron');
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

const TAB_BAR_HEIGHT = 40;
const FRAME_HEIGHT = 34;          // title strip of an app opened in its own window
const SCAN_INTERVAL_MS = 2000;
const REPROBE_MS = 30000;         // confirmed web apps
const REPROBE_PENDING_MS = 5000;  // everything else, which may still be starting up
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
let scanning = false;

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// ---------- discovery ----------

function serverId(l) { return `${l.pid || 0}:${l.port}`; }
// Stable across restarts (pids change); the same key hidden.js uses.
function serverKey(s) { return `${s.name || ''}:${s.port}`; }

async function scan() {
  if (scanning) return;   // a slow probe must not stack up scans
  scanning = true;
  try { await scanOnce(); } finally { scanning = false; }
}

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
      s = { id, port: l.port, pid: l.pid, name: l.name, cmdline: l.cmdline, cwd: l.cwd, exe: l.exe,
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
          icons.forPage(p.url, p.body).then((icon) => { if (icon && servers.get(id) === s) { s.icon = icon; pushServers(); } });
        }
        recover(serverKey(s));
      }
    }
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
  if (await netapps.refresh(force ? 0 : NET_REPROBE_MS)) pushNet();
  for (const a of netapps.list()) if (a.online) recover(a.url);
}
function publicNet() { return netapps.list().map(a => ({ ...a, key: a.url, label: prefs.getName(a.url), thumb: thumbFor(a.url) })); }
function thumbFor(key) { return prefs.getLayout() === 'previews' ? thumbs.get(key) : ''; }
function pushNet() { send('net:update', publicNet()); }

// Resolves a server id (local "pid:port" or "net:n") to what a tab needs.
function resolveTarget(sid) {
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

function publicTab(t) {
  return { id: t.id, key: t.key, title: t.label || t.title, url: t.url, icon: t.icon, theme: t.theme,
           loading: t.loading, failed: t.failed ? t.failed.desc : null };
}
function pushTabs() {
  send('tabs:update', { active: activeTab, tabs: mainTabs().map(publicTab), open: [...tabs.values()].map(t => t.key) });
  if (win && !win.isDestroyed()) {
    const t = tabs.get(activeTab);
    win.setTitle(t ? (t.label || t.title) : 'Pane');   // the taskbar shows the app, not the browser
  }
}
function pushFrame(t) {
  if (!t.host || t.host.isDestroyed()) return;
  t.host.webContents.send('frame:update', publicTab(t));
  t.host.setTitle(t.label || t.title || 'Pane');
}
function notify(t) { if (t.host) pushFrame(t); else pushTabs(); }

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
              title: target.title, url: target.url, icon: target.icon || '', theme: null, loading: true, failed: null, host: null };
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
  wc.on('page-title-updated', (_e, title) => { if (!t.failed) { t.title = title; notify(t); } });
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
    notify(t);
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

// A failed tab reloads by itself once its server answers again.
function recover(key) {
  for (const t of tabs.values()) {
    if (!t.failed || t.key !== key || t.view.webContents.isDestroyed()) continue;
    if (Date.now() - t.failed.at < 3000) continue;
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

// Restores saved bounds only if they still land on a connected display.
function savedBounds(key, fallback) {
  const b = prefs.getBounds(key);
  const visible = b && screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
  return visible ? b : fallback;
}

// An app on its own: a slim, app-colored title strip above the page, its own taskbar entry.
function attachWindow(t) {
  const dark = t.theme ? t.theme.dark : nativeTheme.shouldUseDarkColors;
  const w = new BrowserWindow({
    ...savedBounds(`window:${t.key}`, { width: 1100, height: 760 }), minWidth: 420, minHeight: 300,
    title: t.label || t.title, backgroundColor: dark ? HOME_BG.dark : HOME_BG.light, icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? HOME_BG.dark : HOME_BG.light, symbolColor: dark ? '#e9eaee' : '#1c1d21', height: FRAME_HEIGHT },
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  t.host = w;
  applyStandaloneIdentity(t);
  guardChrome(w.webContents);
  w.contentView.addChildView(t.view);
  w.loadFile(path.join(RENDERER, 'frame.html'), { query: { tab: t.id } });
  layoutWindow(t);
  onResize(w, () => layoutWindow(t));
  w.on('close', () => prefs.setBounds(`window:${t.key}`, w.getNormalBounds()));
  w.on('closed', () => { if (t.host === w) { t.host = null; destroyTab(t); } });
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
function zoom(wc, step) {
  wc.setZoomLevel(step ? Math.max(-3, Math.min(5, wc.getZoomLevel() + step)) : 0);
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
  if (ctrl && (key === '+' || key === '=')) { zoom(wc, 0.5); return true; }
  if (ctrl && key === '-') { zoom(wc, -0.5); return true; }
  if (ctrl && key === '0') { zoom(wc, 0); return true; }
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

// Right-click on a launcher tile (or a row in Manage).
function tileMenu(sender, sid) {
  const target = resolveTarget(sid);
  if (!target) return;
  const s = servers.get(sid);
  const open = [...tabs.values()].find(t => t.key === target.key);
  const items = [
    opensInWindow(target.key)
      ? { label: 'Open in tab', accelerator: 'Ctrl+Enter', click: () => openTab(target, { window: false }) }
      : { label: open && open.host ? 'Show window' : 'Open in own window', accelerator: 'Ctrl+Enter', click: () => openTab(target, { window: true }) },
    { label: 'Always open in own window', type: 'checkbox', checked: prefs.isWindowed(target.key),
      click: (mi) => prefs.setWindowed(target.key, mi.checked) },
    detachItem(target, sender),
    SEP,
    { label: 'Rename…', click: () => sender.send('tile:rename', sid) },
    { label: 'Copy address', click: () => clipboard.writeText(target.url) },
    { label: 'Open in system browser', click: () => openExternal(target.url) },
  ];
  if (s && s.cwd) items.push({ label: editorCmd ? 'Open folder in VS Code' : 'Open folder', click: () => openFolder(s.cwd) });
  items.push(SEP);
  if (s) {
    const isHidden = hidden.isHidden(s);
    items.push({ label: isHidden ? 'Show on home' : 'Hide', click: () => { if (isHidden) hidden.unhide(s); else hidden.hide(s); pushServers(); } });
    if (s.pid) items.push({ label: 'Stop…', click: () => confirmStop(s) });
  } else {
    items.push({ label: 'Remove', click: () => removeNet(sid) });
  }
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
  return openTab(t, other ? { window: !opensInWindow(t.key) } : {});
});
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

// ---------- windows ----------

// The chrome pages hold the privileged API: never let them navigate or open windows.
function guardChrome(wc) {
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const bg = dark ? HOME_BG.dark : HOME_BG.light;
  const w = new BrowserWindow({
    ...savedBounds('main', { width: 1280, height: 800 }), minWidth: 560, minHeight: 360,
    title: 'Pane', backgroundColor: bg, icon: ICON,
    // The tab bar doubles as the title bar; the OS only draws the window buttons on top of it.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: bg, symbolColor: dark ? '#e9eaee' : '#1c1d21', height: TAB_BAR_HEIGHT },
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win = w;
  guardChrome(w.webContents);
  w.loadFile(path.join(RENDERER, 'index.html'));
  onResize(w, () => layout());
  w.on('close', () => prefs.setBounds('main', w.getNormalBounds()));
  w.on('closed', () => {
    const own = mainTabs();
    win = null;
    activeTab = 'home';
    for (const t of own) destroyTab(t);
  });
  w.on('app-command', (_e, cmd) => appCommand(tabs.get(activeTab)?.view.webContents, cmd));
  w.webContents.on('before-input-event', (e, input) => { if (handleKey(input, tabs.get(activeTab) || null)) e.preventDefault(); });
  w.webContents.on('did-finish-load', () => { pushServers(); pushNet(); pushPasswords(); pushTabs(); });
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
    thumbs.onUpdate(() => { if (prefs.getLayout() === 'previews') { pushServers(); pushNet(); } });
    // Started from a detached app's launcher entry: just that app, no home screen.
    refreshStandalone();
    if (!openStandalone(standalone.fromArgv(process.argv))) createWindow();
    devAids();
    detectEditor();
    scan();
    scanNet();
    setInterval(scan, SCAN_INTERVAL_MS);
    setInterval(scanNet, SCAN_INTERVAL_MS);
    // Started as the portable exe: install a copy that starts without unpacking, once the window is up.
    setTimeout(() => selfInstall().then((ok) => { if (ok) refreshStandalone(); }), 5000);
  });
}

app.on('window-all-closed', () => app.quit());
