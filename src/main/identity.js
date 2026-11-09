// Who is behind a local origin. http://127.0.0.1:8770 is whoever listens on
// 8770 right now, so anything saved for an origin (logins, later cookies and
// grants) is tied to the process it was saved with, not to the port.
// See docs/app-identity.md for the levels and the rules they follow.
//
// Evidence about the processes listening on a port, { key, exe, cwd, launchedKey },
// is compared with a record { key, exe, cwd } of one seen earlier. Linux gives
// exe and cwd through /proc; elsewhere there is no evidence yet and callers keep
// the plain per-origin behavior (supported = false).
// No Electron in here, so `node --test` can load it.
const fs = require('node:fs');

const supported = process.platform === 'linux';
const LAUNCHED = 'launched';       // Pane started it for this pane.sh app (or it descends from that process)
const RECOGNIZED = 'recognized';   // same executable and working folder as recorded
const UNKNOWN = 'unknown';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_OWNERS = 4;
const MAX_USES = 8;

// /proc/<pid>/stat: "pid (comm) state ppid ... starttime" (starttime is field 22).
// comm may hold spaces and parentheses, so the fields are split after the last ")".
function parseStat(text) {
  const i = String(text || '').lastIndexOf(')');
  if (i < 0) return null;
  const f = text.slice(i + 2).trim().split(/\s+/);
  const ppid = Number(f[1]);
  const start = f[19];
  return Number.isInteger(ppid) && start ? { ppid, start } : null;
}
const realProc = {
  stat(pid) { try { return parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return null; } },
};

// The servers Pane started: pid plus start time, so a pid the system reused
// for something else does not count. A pane.sh that execs its server keeps the
// pid; one that runs it as a child is found by walking up the parents.
function createLaunches(proc = realProc) {
  const byPid = new Map();   // pid -> { key, start }
  return {
    note(key, pid) {
      const st = pid && proc.stat(pid);
      if (st) byPid.set(pid, { key, start: st.start });
    },
    forget(pid) { byPid.delete(pid); },
    // The app key Pane started this process (or one of its ancestors) for, or ''.
    keyOf(pid) {
      for (let p = pid, n = 0; p > 1 && n < 64; n++) {
        const st = proc.stat(p);
        if (!st) return '';
        const l = byPid.get(p);
        if (l && l.start === st.start) return l.key;
        p = st.ppid;
      }
      return '';
    },
  };
}

// listener: a row of scanner.listListeners(); key: the app key Pane knows it by.
function evidenceOf(listener, key, launches = null) {
  return {
    key: String(key || ''), exe: listener.exe || '', cwd: listener.cwd || '',
    launchedKey: listener.pid && launches ? launches.keyOf(listener.pid) : '',
  };
}
function hasFingerprint(x) { return !!(x && x.exe && x.cwd); }
function same(a, b) { return a.key === b.key && a.exe === b.exe && a.cwd === b.cwd; }

// One answer for everything listening on a port: null when nothing listens,
// { conflict: true } when the listeners are not all the same program.
function combine(list) {
  if (!list.length) return null;
  const [first, ...rest] = list;
  if (rest.some(e => !same(e, first) || e.launchedKey !== first.launchedKey)) return { conflict: true };
  return first;
}

function level(ev, rec) {
  if (!ev || ev.conflict || !rec) return UNKNOWN;
  // Only a pane.sh launch counts: a pin's start command is copied from whichever
  // server held its "name:port" key, so it could have been planted.
  if (ev.launchedKey && ev.launchedKey === rec.key && rec.key.startsWith('pane:')) return LAUNCHED;
  if (hasFingerprint(rec) && ev.exe === rec.exe && ev.cwd === rec.cwd) return RECOGNIZED;
  return UNKNOWN;
}

// May a login saved with these owners be filled into what listens now?
// owners undefined: saved before owners were recorded; linked at the next typed login.
// Neither side readable (another user's process, typically root): nothing to
// compare, so it may, but never across from or to a readable process.
function mayFill(owners, ev) {
  if (!Array.isArray(owners) || !ev || ev.conflict) return false;
  if (!hasFingerprint(ev)) return owners.some(o => !hasFingerprint(o));
  return owners.some(o => level(ev, o) !== UNKNOWN);
}

function recordOf(ev) { return { key: ev.key, exe: ev.exe, cwd: ev.cwd }; }

// The list with this identity first; the same array when it was already first.
function addTo(list, ev, max, extra = {}) {
  const prev = Array.isArray(list) ? list : [];
  const rec = recordOf(ev);
  if (prev[0] && same(prev[0], rec)) return prev;
  const old = prev.find(o => same(o, rec));
  return [{ ...rec, ...extra, ...(old || {}) }, ...prev.filter(o => !same(o, rec))].slice(0, max);
}
function addOwner(owners, ev) { return addTo(owners, ev, MAX_OWNERS); }
// Partition use keeps when each identity was first seen; order is most recent first.
function addUse(uses, ev, now = Date.now()) { return addTo(uses, ev, MAX_USES, { since: now }); }

// Whether a URL is served from this machine: a loopback host, or the address a
// local listener on that port was found on.
function isLocal(url, listeners = []) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (LOOPBACK.has(u.hostname)) return true;
  const port = portOf(u);
  return listeners.some(l => l.port === port && l.reachHost === u.host.replace(/:\d+$/, ''));
}
function portOf(u) { return Number(u.port) || (u.protocol === 'https:' ? 443 : 80); }

module.exports = {
  supported, LAUNCHED, RECOGNIZED, UNKNOWN,
  parseStat, createLaunches, evidenceOf, hasFingerprint, combine, level, mayFill,
  addOwner, addUse, isLocal, portOf,
};
