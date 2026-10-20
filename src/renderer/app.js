const api = window.pane;
const $ = (s) => document.querySelector(s);

let servers = [];
let loaded = false;           // first scan arrived; until then "no apps" would be a lie
let netApps = [];
let logins = { entries: [], backend: '' };
let tabState = { active: 'home', tabs: [], open: [] };
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

function apps() {
  const local = servers.filter(s => s.kind === 'html' && !s.hidden).map(s => ({
    id: s.id, key: s.key, icon: s.icon, thumb: s.thumb,
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
  return { local, network };
}

function renderHome() {
  const layout = view.layout;
  const q = query.trim().toLowerCase();
  const hit = (a) => !q || `${a.name} ${a.sub} ${a.tip}`.toLowerCase().includes(q);
  const { local, network } = apps();
  const l = local.filter(hit);
  const n = network.filter(hit);
  const first = l[0] || n[0];
  const open = new Set(tabState.open);

  const name = (a) => rename && rename.id === a.id
    ? `<input class="rename" value="${esc(rename.value)}" spellcheck="false">`
    : `<span class="name">${esc(a.name)}</span>`;
  const tile = (a) => {
    const cls = `tile${a.offline ? ' offline' : ''}${open.has(a.key) ? ' open' : ''}${q && a === first ? ' selected' : ''}${hit(a) ? '' : ' dim'}`;
    const body = layout === 'previews'
      ? `<span class="shot">${a.thumb ? `<img src="${esc(a.thumb)}" alt="" draggable="false">` : iconHtml(a.icon, a.name, a.key, 'icon')}</span>
         <span class="cap">${iconHtml(a.icon, a.name, a.key, 'ticon')}${name(a)}${a.offline ? '<span class="sub">offline</span>' : ''}</span>`
      : `${iconHtml(a.icon, a.name, a.key, 'icon')}${name(a)}${a.offline ? '<span class="sub">offline</span>' : ''}`;
    const tip = `${a.tip}\nCtrl+click: open in ${view.windowsByDefault ? 'a tab' : 'its own window'}`;
    return `<div class="${cls}" data-id="${esc(a.id)}" title="${esc(tip)}" tabindex="0" role="button">${body}</div>`;
  };

  $('#home').dataset.layout = layout;
  rendering = true;
  $('#local').innerHTML = l.map(a => tile(a)).join('');
  $('#net').innerHTML = n.map(a => tile(a)).join('');
  rendering = false;
  $('#local-sec').hidden = !l.length;
  $('#net-sec').hidden = !n.length;
  for (const h of document.querySelectorAll('.section-label')) h.hidden = !(l.length && n.length);

  const hint = $('#hint');
  hint.hidden = !notice && !(q && !first);
  hint.classList.toggle('error', !!notice);
  if (notice) hint.textContent = notice;
  else if (looksLikeAddress(query.trim())) hint.innerHTML = `Press <kbd>Enter</kbd> to add <b>${esc(query.trim())}</b>`;
  else hint.textContent = 'No matching apps';
  $('#empty').hidden = !loaded || !!q || local.length + network.length > 0;

  const input = document.querySelector('.rename');
  if (input) {
    input.focus();
    if (rename.fresh) { input.select(); rename.fresh = false; }
  }
  if (layout === 'previews' && tabState.active === 'home') {
    const missing = [...l, ...n].filter(a => !a.thumb && !a.offline).map(a => a.id);
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
  $('[data-sec="services"]').hidden = !services.length;
  $('[data-sec="hidden"]').hidden = !hiddenList.length;
  $('[data-sec="logins"]').hidden = !logins.entries.length;
  if (!services.length && !hiddenList.length && !logins.entries.length) $('#manage').close();
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
});

// ---------- tabs ----------

function renderTabs() {
  const { active, tabs } = tabState;
  $('#tabs').innerHTML = tabs.map(t => `
    <div class="tab${t.id === active ? ' active' : ''}" data-tab="${esc(t.id)}" title="${esc(t.title)}">
      ${t.loading ? '<span class="spin"></span>' : iconHtml(t.icon, t.title, t.key, 'ticon')}
      <span class="label">${esc(t.title || t.url)}</span>
      <button class="close" data-close="${esc(t.id)}" title="Close (Ctrl+W)">${CLOSE_ICON}</button>
    </div>`).join('');
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
api.onPasswords((st) => { logins = st; renderHome(); });
api.listPasswords().then((st) => { logins = st; renderHome(); });
api.onTabs((state) => { tabState = state; renderTabs(); renderHome(); });
api.onRename((id) => {
  const a = [...apps().local, ...apps().network].find(x => x.id === id);
  rename = { id, value: a ? a.name : '', fresh: true };
  renderHome();
});
api.onFocusSearch(() => { search.focus(); search.select(); });
api.getView().then((v) => { view = v; renderHome(); });
api.onView((v) => { view = v; renderHome(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderTabs);
renderTabs();
