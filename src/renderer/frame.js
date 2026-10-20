// Title strip of an app opened in its own window: icon, title, the app's color.
const api = window.pane;
const tabId = new URLSearchParams(location.search).get('tab');
let current = null;

function render(t) {
  if (!t) return;
  current = t;
  document.getElementById('ficon').innerHTML = t.loading ? '<span class="spin"></span>' : iconHtml(t.icon, t.title, t.key, 'ticon');
  document.getElementById('ftitle').textContent = t.title || t.url;
  document.title = t.title || 'Pane';
  showStatus(t);
  applyTheme(t.theme);
}

api.getFrame(tabId).then(render);
api.onFrame(render);
document.getElementById('tabbar').addEventListener('contextmenu', (e) => { e.preventDefault(); api.tabMenu(tabId); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render(current));
