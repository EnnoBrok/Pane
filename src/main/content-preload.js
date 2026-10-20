// Runs inside every app tab (sandboxed, isolated world). Autofills saved logins
// and reports new ones to the main process, which asks the user before saving.
const { ipcRenderer } = require('electron');

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
