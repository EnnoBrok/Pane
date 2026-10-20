// Shared by the main window (app.js) and app-window title strips (frame.js).
const HOME_BG = { dark: '#16171b', light: '#f5f5f6' };   // keep in sync with main.js
const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hue(s) {
  let h = 0;
  for (const c of String(s || '')) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h % 360;
}

// The app's icon, or its first letter on a color derived from its key.
function iconHtml(src, name, key, cls) {
  if (src) return `<span class="${cls}"><img src="${esc(src)}" alt="" draggable="false"></span>`;
  const letter = (String(name || '').match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
  return `<span class="${cls} mono" style="--h:${hue(key || name)}">${esc(letter)}</span>`;
}

// A 256 px launcher icon for a detached app, as a PNG data URL (called from main.js).
// Favicons sit on a plate that contrasts with them; no favicon gets the letter tile.
async function rasterIcon(src, name, key) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const plate = (fill) => { g.fillStyle = fill; g.beginPath(); g.roundRect(8, 8, S - 16, S - 16, 50); g.fill(); };
  const letterTile = () => {
    plate(`hsl(${hue(key || name)} 34% 46%)`);
    g.fillStyle = '#fff';
    g.font = '600 124px Inter, "Segoe UI", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText((String(name || '').match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase(), S / 2, S / 2 + 8);
  };
  if (!src) { letterTile(); return c.toDataURL('image/png'); }
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    // Average brightness of the icon's visible pixels decides a light or dark plate.
    const probe = document.createElement('canvas');
    probe.width = probe.height = 32;
    const pg = probe.getContext('2d');
    pg.drawImage(img, 0, 0, 32, 32);
    const px = pg.getImageData(0, 0, 32, 32).data;
    let lum = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 128) { lum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; n++; }
    plate(n && lum / n > 170 ? '#2a2c32' : '#f2f2f4');
    const s = 152;
    g.drawImage(img, (S - s) / 2, (S - s) / 2, s, s);
    return c.toDataURL('image/png');
  } catch {
    g.clearRect(0, 0, S, S);
    letterTile();
    return c.toDataURL('image/png');
  }
}

// The bar sits just off the page color so the app seems to own the whole window.
function shade(color, dark) {
  const [r, g, b] = color.match(/\d+/g).map(Number);
  const f = (v) => Math.round(dark ? Math.min(255, v + 8) : v * 0.955);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

let lastChrome = '';
function applyTheme(theme) {
  const dark = theme ? theme.dark : systemDark();
  const page = theme ? theme.color : HOME_BG[dark ? 'dark' : 'light'];
  const bar = theme ? shade(theme.color, dark) : page;
  const root = document.documentElement;
  root.style.setProperty('--page', page);
  root.style.setProperty('--bar', bar);
  root.dataset.theme = dark ? 'dark' : 'light';
  if (bar + dark !== lastChrome) {
    lastChrome = bar + dark;
    window.pane.setChromeColor(bar, dark ? 'light' : 'dark');   // window buttons follow the bar
  }
}

// Shown in place of a page whose server stopped answering, or is being started.
function showStatus(t) {
  const el = document.getElementById('status');
  el.hidden = !(t && t.failed);
  if (el.hidden) return;
  const name = t.title || 'This app';
  const [h, p, button] = ['h3', 'p', 'button'].map(s => el.querySelector(s));
  el.classList.toggle('starting', !!t.starting);
  button.hidden = !!t.starting;
  if (t.starting) {
    h.textContent = `Starting ${name}…`;
    p.textContent = 'It opens as soon as its server answers.';
  } else if (t.canStart) {
    h.textContent = `${name} isn’t running`;
    p.textContent = 'Start it from here; it also reloads by itself once it is back.';
    button.textContent = 'Start';
    button.onclick = () => window.pane.startTab(t.id);
  } else {
    h.textContent = `${name} isn’t responding`;
    p.textContent = `${t.failed[0].toUpperCase()}${t.failed.slice(1)}. It reloads by itself once the app is back.`;
    button.textContent = 'Retry now';
    button.onclick = () => window.pane.retryTab(t.id);
  }
}

// Unread count for the taskbar button (Windows draws it over the icon).
let lastBadge = -1;
function setBadge(count) {
  if (count === lastBadge) return;
  lastBadge = count;
  if (!count) { window.pane.setBadge(0, ''); return; }
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#e5484d';
  g.beginPath(); g.arc(16, 16, 16, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.font = `600 ${count > 9 ? 16 : 20}px "Segoe UI", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(count > 99 ? '99+' : String(count), 16, 17);
  window.pane.setBadge(count, c.toDataURL('image/png'));
}

// ---------- find in page ----------
// Ctrl+F opens a field in the bar; the page itself is searched by main.js.
const finder = {
  el: document.getElementById('find'),
  input: document.getElementById('find-q'),
  count: document.getElementById('find-n'),
  open() {
    this.el.hidden = false;
    this.input.focus();
    this.input.select();
    if (this.input.value) window.pane.find(this.input.value, {});
  },
  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.count.textContent = '';
    window.pane.findClose();
  },
  step(forward) { if (this.input.value) window.pane.find(this.input.value, { forward, again: true }); },
};
if (finder.el) {
  window.pane.onFindOpen(() => finder.open());
  window.pane.onFindResult(({ active, matches }) => {
    finder.count.textContent = finder.input.value ? `${matches ? active : 0}/${matches}` : '';
    finder.el.classList.toggle('none', !!finder.input.value && !matches);
  });
  finder.input.addEventListener('input', () => window.pane.find(finder.input.value, {}));
  finder.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finder.step(!e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); finder.close(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); finder.input.select(); }
  });
  finder.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-find]');
    if (!b) return;
    if (b.dataset.find === 'close') finder.close(); else finder.step(b.dataset.find === 'next');
  });
}

// The page views sit on top of this chrome page and are sized by main.js; the
// chrome's own resize is the one signal that is never late.
let resizeFrame = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => window.pane.resized());
});
