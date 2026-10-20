// Runs inside every app tab (sandboxed, isolated world). Autofills saved logins
// and reports new ones to the main process, which asks the user before saving.
// Also routes the page's notifications through Pane (main.js, "notifications").
const { ipcRenderer, contextBridge } = require('electron');

// ---- notifications: the page's Notification class is replaced by one that main.js shows ----
const noteCallbacks = new Map();
let nextNote = 1;
ipcRenderer.on('note:event', (_e, { id, type }) => {
  const cb = noteCallbacks.get(id);
  if (cb) cb(type);
  if (type === 'close') noteCallbacks.delete(id);
});
try {
  contextBridge.exposeInMainWorld('__paneNotify', {
    show(title, opts, onEvent) {
      const id = nextNote++;
      if (typeof onEvent === 'function') noteCallbacks.set(id, onEvent);
      const o = opts || {};
      ipcRenderer.send('note:show', { id, title: String(title ?? ''), body: String(o.body ?? ''), tag: String(o.tag ?? ''), silent: !!o.silent });
      return id;
    },
    close(id) { ipcRenderer.send('note:close', id); },
  });
  contextBridge.executeInMainWorld({
    func: () => {
      const bridge = window.__paneNotify;
      const Native = window.Notification;
      if (!bridge || !Native) return;
      class Notification extends EventTarget {
        constructor(title, options = {}) {
          super();
          if (title === undefined) throw new TypeError("Failed to construct 'Notification': 1 argument required.");
          this.title = String(title);
          this.body = String(options.body ?? '');
          this.tag = String(options.tag ?? '');
          this.icon = String(options.icon ?? '');
          this.data = options.data ?? null;
          this.silent = !!options.silent;
          this.onclick = this.onshow = this.onclose = this.onerror = null;
          if (Native.permission !== 'granted') { setTimeout(() => this._fire('error')); return; }
          this._id = bridge.show(this.title, { body: this.body, tag: this.tag, silent: this.silent }, (type) => this._fire(type));
        }
        _fire(type) {
          const e = new Event(type, { cancelable: type === 'click' });
          this.dispatchEvent(e);
          const h = this['on' + type];
          if (typeof h === 'function') h.call(this, e);
        }
        close() { if (this._id) bridge.close(this._id); }
        static get permission() { return Native.permission; }
        static requestPermission(cb) { return Native.requestPermission(cb); }
        static get maxActions() { return 0; }
      }
      window.Notification = Notification;
    },
  });
} catch { /* the page keeps the plain notifications */ }

function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
function passwordField() { return [...document.querySelectorAll('input[type=password]')].find(visible); }

function usernameField(pw) {
  const scope = pw.form || pw.closest('form, [class*=login], [class*=auth], main, body') || document;
  const inputs = [...scope.querySelectorAll('input')].filter(i =>
    visible(i) && ['text', 'email', 'tel', ''].includes(i.type));
  const before = inputs.filter(i => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
  return before[before.length - 1]
    || inputs.find(i => /user|mail|login|name/i.test(i.name + i.id + i.autocomplete + i.placeholder))
    || null;
}

// Set a value the way frameworks notice (React/Vue listen to native input events).
function setValue(el, v) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

let filledFor = null;
async function autofill() {
  const pw = passwordField();
  if (!pw || pw.value || filledFor === pw) return;
  const creds = await ipcRenderer.invoke('pw:get');
  if (!creds) return;
  filledFor = pw;
  const user = usernameField(pw);
  if (user && !user.value) setValue(user, creds.username);
  setValue(pw, creds.password);
}

// ---- capture: remember what was typed, report it once the login seems to have gone through ----
let pending = null;
let checks = 0;

function capture(pw) {
  if (!pw || !pw.value) return;
  const user = usernameField(pw);
  pending = { username: user ? user.value : '', password: pw.value, href: location.href };
  checks = 0;
  setTimeout(check, 1500);
}
function flush() {
  if (!pending) return;
  ipcRenderer.send('pw:captured', { username: pending.username, password: pending.password });
  pending = null;
}
function check() {
  if (!pending) return;
  const pw = passwordField();
  // Password field gone or URL changed: the app accepted the login.
  if (!pw || location.href !== pending.href) return flush();
  if (++checks < 6) setTimeout(check, 1500); else pending = null;   // still on the form: probably rejected
}

function nearestPassword(el) {
  const scope = (el && el.closest && el.closest('form')) || document;
  return [...scope.querySelectorAll('input[type=password]')].find(visible);
}

document.addEventListener('submit', (e) => capture(nearestPassword(e.target)), true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target instanceof HTMLInputElement) capture(nearestPassword(e.target));
}, true);
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('button, input[type=submit]');
  if (b) capture(nearestPassword(b));
}, true);
window.addEventListener('pagehide', flush);

// SPAs render login forms late; watch for password fields appearing.
let debounce = null;
const observer = new MutationObserver(() => {
  if (!debounce) debounce = setTimeout(() => { debounce = null; autofill(); }, 300);
});
function start() { autofill(); observer.observe(document.documentElement, { childList: true, subtree: true }); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
