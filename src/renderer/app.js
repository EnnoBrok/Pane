const api = window.pane;
const $ = (s) => document.querySelector(s);

let servers = [];
let loaded = false;           // first scan arrived; until then "no apps" would be a lie
let netApps = [];
let pins = [];
let logins = { entries: [], backend: '' };
let perms = [];
let tabState = { active: 'home', tabs: [], open: [], counts: {} };
let query = '';
let notice = '';              // error from adding an address
let rename = null;            // { id, value, fresh } while a tile's name is edited
let rendering = false;

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const looksLikeAddress = (s) => /^(https?:\/\/)?[\w.-]+(:\d+)?(\/\S*)?$/i.test(s) && /[.:]|^localhost/i.test(s);
const CLOSE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 2l6 6M8 2l-6 6"/></svg>';

// ---------- home ----------

let view = { layout: 'grid' };   // home layout: 'grid' (small tiles) or 'previews' (prefs.js)

// Pinned apps ("my apps") first, in pin order and also while their server is
// down; then the rest of what runs on this computer and on the network.
function apps() {
  const local = servers.filter(s => s.kind === 'html').map(s => ({
    id: s.id, key: s.key, icon: s.icon, thumb: s.thumb, hidden: s.hidden,
    name: s.label || s.title || baseName(s.cwd) || s.name || `:${s.port}`,
    sub: `:${s.port}`,
    tip: [s.url, s.cwd, s.name && `${s.name} · pid ${s.pid}`].filter(Boolean).join('\n'),
  }));
  const network = netApps.map(a => ({
    id: a.id, key: a.key, icon: a.icon, thumb: a.thumb, offline: a.online === false,
    name: a.label || a.title || a.host,
    sub: a.host,
    tip: a.url,
  }));
  const pinnedKeys = new Set(pins.map(p => p.key));
  const live = new Map([...local, ...network].map(a => [a.key, a]));
  const pinned = pins.map(p => live.get(p.key) || {
    id: `pin:${p.key}`, key: p.key, icon: p.icon, thumb: p.thumb, stopped: true, starting: p.starting,
    name: p.label || p.title || p.key,
    sub: p.starting ? 'Starting…' : p.local ? 'Not running' : 'offline',
    tip: [p.url, p.local && (p.canStart ? 'Click to start it' : 'Opens once its server runs')].filter(Boolean).join('\n'),
  });
  return {
    pinned,
    local: local.filter(a => !a.hidden && !pinnedKeys.has(a.key)),
    network: network.filter(a => !pinnedKeys.has(a.key)),
  };
}

function renderHome() {
  const q = query.trim().toLowerCase();
  const hit = (a) => !q || `${a.name} ${a.sub} ${a.tip}`.toLowerCase().includes(q);
  const { pinned, local, network } = apps();
  const p = pinned.filter(hit);
  const l = local.filter(hit);
  const n = network.filter(hit);
  const first = p[0] || l[0] || n[0];
  const open = new Set(tabState.open);
  const counts = tabState.counts || {};
  const hasPins = pinned.length > 0;

  const name = (a) => rename && rename.id === a.id
    ? `<input class="rename" value="${esc(rename.value)}" spellcheck="false">`
    : `<span class="name">${esc(a.name)}</span>`;
  const status = (a) => (a.offline || a.stopped ? `<span class="sub">${esc(a.stopped ? a.sub : 'offline')}</span>` : '');
  const badge = (a) => (counts[a.key] ? `<span class="badge">${counts[a.key] > 99 ? '99+' : counts[a.key]}</span>` : '');
  const tile = (a, layout) => {
    const cls = `tile${a.offline || a.stopped ? ' offline' : ''}${a.starting ? ' starting' : ''}${open.has(a.key) ? ' open' : ''}${q && a === first ? ' selected' : ''}`;
    const body = layout === 'previews'
      ? `<span class="shot">${a.thumb ? `<img src="${esc(a.thumb)}" alt="" draggable="false">` : iconHtml(a.icon, a.name, a.key, 'icon')}${badge(a)}</span>
         <span class="cap">${iconHtml(a.icon, a.name, a.key, 'ticon')}${name(a)}${status(a)}</span>`
      : `<span class="icon-wrap">${iconHtml(a.icon, a.name, a.key, 'icon')}${badge(a)}</span>${name(a)}${status(a)}`;
    const tip = `${a.tip}\nCtrl+click: open in ${view.windowsByDefault ? 'a tab' : 'its own window'}`;
    return `<div class="${cls}" data-id="${esc(a.id)}" title="${esc(tip)}" tabindex="0" role="button">${body}</div>`;
  };
  // With pinned apps, the rest is a compact list below them.
  const restLayout = hasPins ? 'compact' : view.layout;

  $('#home').dataset.layout = view.layout;
  $('.apps').classList.toggle('has-pins', hasPins);
  rendering = true;
  $('#pinned').innerHTML = p.map(a => tile(a, view.layout)).join('');
  $('#local').innerHTML = l.map(a => tile(a, restLayout)).join('');
  $('#net').innerHTML = n.map(a => tile(a, restLayout)).join('');
  rendering = false;
  $('#pinned').className = `grid ${view.layout}`;
  $('#local').className = $('#net').className = `grid ${restLayout}`;
  $('#pin-sec').hidden = !p.length;
  $('#local-sec').hidden = !l.length;
  $('#net-sec').hidden = !n.length;
  for (const h of document.querySelectorAll('#rest .section-label')) h.hidden = !hasPins && !(l.length && n.length);
  $('#pin-hint').hidden = hasPins || !!q || !(l.length + n.length);

  const hint = $('#hint');
  hint.hidden = !notice && !(q && !first);
  hint.classList.toggle('error', !!notice);
  if (notice) hint.textContent = notice;
  else if (looksLikeAddress(query.trim())) hint.innerHTML = `Press <kbd>Enter</kbd> to add <b>${esc(query.trim())}</b>`;
  else hint.textContent = 'No matching apps';
  $('#empty').hidden = !loaded || !!q || pinned.length + local.length + network.length > 0;

  const input = document.querySelector('.rename');
  if (input) {
    input.focus();
    if (rename.fresh) { input.select(); rename.fresh = false; }
  }
  if (view.layout === 'previews' && tabState.active === 'home') {
    const shown = hasPins ? p : [...l, ...n];
    const missing = shown.filter(a => !a.thumb && !a.offline && !a.stopped).map(a => a.id);
    if (missing.length) api.wantThumbs(missing);
  }
  renderFooter();
  if ($('#manage').open) renderManage();
}

function renderFooter() {
  const services = servers.filter(s => s.kind !== 'html' && !s.hidden).length;
  const hiddenCount = servers.filter(s => s.hidden).length;
  const parts = [];
  if (services) parts.push(`<button data-manage="services">${plural(services, 'background service')}</button>`);
  if (hiddenCount) parts.push(`<button data-manage="hidden">${hiddenCount} hidden</button>`);
  if (logins.entries.length) parts.push(`<button data-manage="logins">${plural(logins.entries.length, 'saved login')}</button>`);
  if (perms.length) parts.push(`<button data-manage="permissions">${plural(perms.length, 'permission')}</button>`);
  parts.push('<button data-discover>Find network apps</button>');
  $('#links').innerHTML = parts.join('<span>·</span>');
  for (const b of document.querySelectorAll('#views button')) b.classList.toggle('on', b.dataset.layout === view.layout);
}

$('#views').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layout]');
  if (b) api.setLayout(b.dataset.layout);
});

// ---------- find network apps ----------

let discovered = null;        // last search result, kept until "Search again"
let discovering = false;

async function runDiscover() {
  discovering = true;
  discovered = null;
  $('#d-bar').style.width = '0%';
  renderDiscover();
  try { discovered = await api.discover(); } finally { discovering = false; }
  renderDiscover();
}

function openDiscover() {
  const d = $('#discover');
  if (!d.open) d.showModal();
  if (!discovered && !discovering) runDiscover(); else renderDiscover();
}

function renderDiscover() {
  const list = discovered || [];
  const added = new Set(netApps.map(a => a.url));
  $('#d-busy').hidden = !discovering;
  $('#d-again').disabled = discovering;
  $('#d-empty').hidden = discovering || list.length > 0;
  $('#d-list').innerHTML = list.map(f => `
    <div class="row" data-url="${esc(f.url)}">
      ${iconHtml('', f.title, f.url, 'ricon')}
      <span class="r-main" title="${esc(f.title)}">${esc(f.title)}</span>
      <span class="r-sub" title="${esc(f.url)}">${esc(f.url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</span>
      ${added.has(f.url) ? '<button class="act" disabled>Added</button>' : '<button class="act" data-act="add">Add</button>'}
    </div>`).join('');
}

api.onDiscoverProgress(({ f, text }) => {
  $('#d-bar').style.width = `${Math.round(f * 100)}%`;
  $('#d-status').textContent = `${text}…`;
});
api.onDiscoverOpen(openDiscover);
$('#d-again').addEventListener('click', runDiscover);
$('#discover').addEventListener('click', async (e) => {
  const d = $('#discover');
  if (e.target === d || e.target.closest('[data-close]')) return d.close();
  const row = e.target.closest('.row');
  if (row && e.target.closest('[data-act="add"]')) {
    e.target.disabled = true;
    await api.addNet(row.dataset.url);   // the list re-renders when the network apps update
  }
});

// ---------- manage dialog ----------

function renderManage() {
  const services = servers.filter(s => s.kind !== 'html' && !s.hidden);
  const hiddenList = servers.filter(s => s.hidden);
  const row = (s, act, label) => `
    <div class="row" data-id="${esc(s.id)}">
      ${iconHtml(s.icon, s.label || s.title || s.name, s.key, 'ricon')}
      <span class="r-main">${esc(s.label || s.title || s.name || 'Unnamed')}</span>
      <span class="r-sub">:${esc(s.port)}${s.kind === 'api' ? ' · API' : ''}</span>
      <button class="act" data-act="${act}">${label}</button>
    </div>`;
  $('#m-services').innerHTML = services.map(s => row(s, 'open', 'Open')).join('');
  $('#m-hidden').innerHTML = hiddenList.map(s => row(s, 'show', 'Show')).join('');
  $('#m-logins').innerHTML = logins.entries.map(e => `
    <div class="row" data-login="${esc(e.id)}">
      <span class="r-main">${esc(e.username || '(no username)')}</span>
      <span class="r-sub">${esc(e.origin)}</span>
      <button class="act" data-act="forget">Forget</button>
    </div>`).join('');
  $('#m-backend').textContent = `Passwords are stored ${logins.backend}.`;
  const PERM_NAMES = { camera: 'Camera', microphone: 'Microphone', geolocation: 'Location', 'display-capture': 'Screen recording',
                       'clipboard-read': 'Clipboard', midi: 'MIDI', midiSysex: 'MIDI', 'idle-detection': 'Idle detection', openExternal: 'Other programs' };
  $('#m-perms').innerHTML = perms.map(x => `
    <div class="row" data-origin="${esc(x.origin)}" data-perm="${esc(x.permission)}">
      <span class="r-main">${esc(PERM_NAMES[x.permission] || x.permission)} · ${x.allowed ? 'allowed' : 'blocked'}</span>
      <span class="r-sub">${esc(x.origin.replace(/^https?:\/\//, ''))}</span>
      <button class="act" data-act="unperm">Forget</button>
    </div>`).join('');
  $('[data-sec="services"]').hidden = !services.length;
  $('[data-sec="hidden"]').hidden = !hiddenList.length;
  $('[data-sec="logins"]').hidden = !logins.entries.length;
  $('[data-sec="permissions"]').hidden = !perms.length;
  if (!services.length && !hiddenList.length && !logins.entries.length && !perms.length) $('#manage').close();
}

function openManage(section) {
  const d = $('#manage');
  renderManage();
  if (!d.open) d.showModal();
  d.querySelector(`[data-sec="${section}"]`)?.scrollIntoView({ block: 'start' });
}

$('#manage').addEventListener('click', (e) => {
  const d = $('#manage');
  if (e.target === d || e.target.closest('[data-close]')) return d.close();   // backdrop or ×
  const act = e.target.closest('[data-act]')?.dataset.act;
  const row = e.target.closest('.row');
  if (!act || !row) return;
  if (act === 'open') { d.close(); api.openTab(row.dataset.id); }
  if (act === 'show') api.unhideServer(row.dataset.id);
  if (act === 'forget') api.removePassword(row.dataset.login);
  if (act === 'unperm') api.forgetPermission(row.dataset.origin, row.dataset.perm);
});

// ---------- tabs ----------

let shownTab = 'home';
function renderTabs() {
  const { active, tabs } = tabState;
  if (active !== shownTab) { shownTab = active; finder.close(); }   // find belongs to the page it was opened on
  $('#tabs').innerHTML = tabs.map(t => `
    <div class="tab${t.id === active ? ' active' : ''}" data-tab="${esc(t.id)}" title="${esc(t.title)}">
      ${t.loading ? '<span class="spin"></span>' : iconHtml(t.icon, t.title, t.key, 'ticon')}
      <span class="label">${esc(t.title || t.url)}</span>
      ${t.count ? `<span class="count">${t.count > 99 ? '99+' : t.count}</span>` : ''}
      <button class="close" data-close="${esc(t.id)}" title="Close (Ctrl+W)">${CLOSE_ICON}</button>
    </div>`).join('');
  setBadge(tabs.reduce((sum, t) => sum + (t.count || 0), 0));
  $('.tab.home').classList.toggle('active', active === 'home');
  $('.tab.home').hidden = !tabs.length;   // nothing open: the bar is a title bar with the name
  $('#brand').hidden = tabs.length > 0;
  const t = tabs.find(x => x.id === active);
  $('#home').hidden = !!t;
  showStatus(t);
  applyTheme(t ? t.theme : null);
}

// Tabs switch on press, like desktop tab strips; closing waits for the click.
$('#tabbar').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('[data-close]')) return;
  const tab = e.target.closest('[data-tab]');
  if (tab) api.activateTab(tab.dataset.tab);
});
$('#tabbar').addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) api.closeTab(close.dataset.close);
});
$('#tabbar').addEventListener('auxclick', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (e.button === 1 && tab && tab.dataset.tab !== 'home') api.closeTab(tab.dataset.tab);
});

// ---------- input ----------

const search = $('#q');
function clearSearch() { search.value = ''; query = ''; notice = ''; renderHome(); }

search.addEventListener('input', () => { query = search.value; notice = ''; renderHome(); });
search.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { if (search.value) clearSearch(); else search.blur(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); document.querySelector('.tile')?.focus(); }
  if (e.key !== 'Enter') return;
  const first = document.querySelector('.tile.selected');
  if (first) { api.openTab(first.dataset.id, e.ctrlKey || e.metaKey); clearSearch(); return; }
  const value = search.value.trim();
  if (!value || !looksLikeAddress(value)) return;
  const r = await api.addNet(value);
  if (r.ok) { clearSearch(); api.openTab(r.id); } else { notice = r.error; renderHome(); }
});

$('#home').addEventListener('click', (e) => {
  const m = e.target.closest('[data-manage]');
  if (m) return openManage(m.dataset.manage);
  if (e.target.closest('[data-discover]')) return openDiscover();
  const tile = e.target.closest('.tile');
  if (tile && !e.target.closest('.rename')) api.openTab(tile.dataset.id, e.ctrlKey || e.metaKey);
});
// Middle click, like Ctrl+click: open the other way (window instead of tab, or the reverse).
$('#home').addEventListener('auxclick', (e) => {
  const tile = e.target.closest('.tile');
  if (e.button === 1 && tile) api.openTab(tile.dataset.id, true);
});

document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input')) return;
  const item = e.target.closest('.tile, .row[data-id]');
  if (item) { e.preventDefault(); api.tileMenu(item.dataset.id); return; }
  const tab = e.target.closest('.tab[data-tab]:not(.home)');
  if (tab) { e.preventDefault(); api.tabMenu(tab.dataset.tab); return; }
  if (e.target.closest('#home') && !e.target.closest('button, dialog')) { e.preventDefault(); api.homeMenu(); }
});

function commitRename() {
  if (!rename) return;
  const { id, value } = rename;
  rename = null;
  api.rename(id, value);   // empty resets to the app's own name
  renderHome();
}
document.addEventListener('input', (e) => { if (rename && e.target.classList.contains('rename')) rename.value = e.target.value; });
document.addEventListener('focusout', (e) => { if (!rendering && e.target.classList?.contains('rename')) commitRename(); });

document.addEventListener('keydown', (e) => {
  if (e.target.classList?.contains('rename')) {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') { rename = null; renderHome(); }
    return;
  }
  const tile = e.target.closest?.('.tile');
  if (tile && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); api.openTab(tile.dataset.id, e.ctrlKey || e.metaKey); return; }
  if (tile && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    const all = [...document.querySelectorAll('.tile')];
    all[all.indexOf(tile) + (e.key === 'ArrowRight' ? 1 : -1)]?.focus();
    return;
  }
  // Type anywhere on the home page to search.
  if (tabState.active !== 'home' || document.querySelector('dialog[open]') || e.target instanceof HTMLInputElement) return;
  if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.altKey && !e.metaKey) search.focus();
});

// ---------- wiring ----------

api.onServers((list) => { servers = list; loaded = true; renderHome(); });
api.listServers().then((list) => { if (list.length) { servers = list; loaded = true; renderHome(); } });
api.onNet((list) => { netApps = list; renderHome(); if ($('#discover').open) renderDiscover(); });
api.listNet().then((list) => { netApps = list; renderHome(); });
api.onPins((list) => { pins = list; renderHome(); });
api.listPins().then((list) => { pins = list; renderHome(); });
api.onPermissions((list) => { perms = list; renderHome(); });
api.listPermissions().then((list) => { perms = list; renderHome(); });
api.onPasswords((st) => { logins = st; renderHome(); });
api.listPasswords().then((st) => { logins = st; renderHome(); });
api.onTabs((state) => { tabState = state; renderTabs(); renderHome(); });
api.onRename((id) => {
  const { pinned, local, network } = apps();
  const a = [...pinned, ...local, ...network].find(x => x.id === id);
  rename = { id, value: a ? a.name : '', fresh: true };
  renderHome();
});
api.onFocusSearch(() => { search.focus(); search.select(); });
api.getView().then((v) => { view = v; renderHome(); });
api.onView((v) => { view = v; renderHome(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderTabs);
renderTabs();
