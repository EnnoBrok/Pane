// Web apps that say how to start them: a folder with an executable pane.sh at
// its root. Run from that folder, pane.sh starts the app's server in the
// foreground; its leading comment lines name the app and its port:
//
//   #!/usr/bin/env bash
//   # pane.name: Photo Sorter
//   # pane.port: 8770
//   # pane.icon: ui/favicon.svg
//   # pane.description: Sorts photos by date
//   exec ./venv/bin/python -u server.py
//
// So an app that never ran on this machine still shows on home and starts with
// a click. The files are looked for at most two folders below a few roots
// (root/*/pane.sh, root/*/*/pane.sh): only readdir and stat, cheap enough to
// repeat every minute. No Electron in here, so `node --test` can load it.
// Windows has no pane.sh convention (and no bash to run one): nothing is found there.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const FILE_NAME = 'pane.sh';
const DEPTH = 2;
// Never descended into; folders starting with a dot (.git, .venv, .cache) neither.
const SKIP = new Set(['node_modules', 'venv', 'dist', 'out', '__pycache__']);
const DEFAULT_FOLDERS = ['Dokumente', 'Documents', 'Projects', 'src'];
const HEAD_BYTES = 8192;   // the header sits at the top; never read a whole big script
const supported = process.platform !== 'win32';

// "# pane.<key>: <value>" lines from the leading comment block (the shebang
// counts as a comment, blank lines are skipped); the first code line ends it.
function parseHeader(text) {
  const meta = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('#')) break;
    const m = /^#\s*pane\.([a-z][\w-]*)\s*:\s*(.*)$/i.exec(line);
    const key = m && m[1].toLowerCase();
    if (key && !(key in meta)) meta[key] = m[2].trim();
  }
  return meta;
}

function inside(file, dir) {
  if (!file || !dir) return false;
  const rel = path.relative(dir, file);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// The app a pane.sh describes, or { error } when name or port is missing.
// The key is what prefs, tabs and pins know the app by, also while it runs.
function appFrom(file, meta) {
  const name = String(meta.name || '').slice(0, 80);
  const port = /^\d{1,5}$/.test(meta.port || '') ? Number(meta.port) : 0;
  if (!name) return { error: 'no "# pane.name:" line' };
  if (!port || port > 65535) return { error: meta.port ? `"${meta.port}" is not a port` : 'no "# pane.port:" line' };
  const dir = path.dirname(file);
  // Only a file inside the app's own folder: the icon ends up in Pane's chrome.
  const icon = meta.icon ? path.resolve(dir, meta.icon) : '';
  return {
    app: {
      key: `pane:${dir}`, dir, file, name, port,
      iconFile: icon && icon !== dir && inside(icon, dir) ? icon : '',
      description: String(meta.description || '').slice(0, 300),
    },
  };
}

// Child folders worth looking into; symlinked folders count.
async function subdirs(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(p);
    else if (e.isSymbolicLink()) { try { if ((await fsp.stat(p)).isDirectory()) out.push(p); } catch { /* dangling */ } }
  }
  return out;
}

// Every root/*/pane.sh and root/*/*/pane.sh (not root/pane.sh), sorted, without duplicates.
async function findFiles(roots, depth = DEPTH) {
  const found = new Set();
  const walk = async (dir, level) => {
    for (const d of await subdirs(dir)) {
      const f = path.join(d, FILE_NAME);
      try { if ((await fsp.stat(f)).isFile()) found.add(f); } catch { /* none here */ }
      if (level < depth) await walk(d, level + 1);
    }
  };
  for (const r of new Set(roots.filter(Boolean).map(r => path.resolve(r)))) await walk(r, 1);
  return [...found].sort();
}

// The folder to search for a server's siblings: the parent of its working
// folder, only inside the home folder (a daemon in / must not make Pane walk /proc).
function parentRoot(cwd, home) {
  if (!cwd || !home || !path.isAbsolute(cwd)) return null;
  const parent = path.dirname(cwd);
  return inside(parent, home) ? parent : null;
}

// folders: the configured roots, or null for the defaults below home.
// cwds: working folders of local servers; their parents are searched too.
// parents: such parents remembered from earlier (prefs serverFolders).
function rootsFor({ home, folders = null, cwds = [], parents = [] }) {
  const base = Array.isArray(folders) ? folders.map(f => String(f).replace(/^~(?=$|\/)/, home)) : DEFAULT_FOLDERS.map(n => path.join(home, n));
  const seen = [...parents.filter(p => p && inside(p, home)), ...cwds.map(c => parentRoot(c, home))];
  const list = [...base, ...seen].filter(Boolean).map(p => path.resolve(p));
  return [...new Set(list)].filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

// Which discovered app a listening server is. The port must be the app's; a
// known working folder must lie in the app's folder (another app may happen to
// use that port), unless Pane started the server itself (launched: key -> pid).
function matchApp(list, server, launched = new Map()) {
  const same = list.filter(a => a.port === server.port);
  if (!same.length) return null;
  const mine = server.pid && same.find(a => launched.get(a.key) === server.pid);
  if (mine) return mine;
  if (!server.cwd) return same[0];
  return same.find(a => inside(server.cwd, a.dir) || inside(server.cwd, a.realDir)) || null;
}

// ---------- the discovered apps ----------

let apps = new Map();      // key -> app
const read = new Map();    // file -> { version, result }: a pane.sh is parsed again only when it changed

async function load(file) {
  let st;
  try { st = await fsp.stat(file); } catch { return { error: 'gone' }; }
  const version = `${st.mtimeMs}:${st.mode}`;   // the mode too: chmod +x after the log said so
  const prev = read.get(file);
  if (prev && prev.version === version) return { ...prev.result, fresh: false };
  let result;
  try {
    await fsp.access(file, fs.constants.X_OK);
    const fh = await fsp.open(file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      text = buf.toString('utf8', 0, bytesRead);
    } finally { await fh.close(); }
    result = appFrom(file, parseHeader(text));
    if (result.app) { try { result.app.realDir = fs.realpathSync(result.app.dir); } catch { result.app.realDir = result.app.dir; } }
  } catch (err) {
    result = { error: err.code === 'EACCES' ? 'not executable (chmod +x pane.sh)' : String(err.message || err) };
  }
  read.set(file, { version, result });
  return { ...result, fresh: true };
}

// Looks again; resolves to true when the list changed. Files that cannot be
// used are logged once per version of the file.
async function refresh(roots, log = (msg) => console.warn(msg)) {
  if (!supported) return false;
  const next = new Map();
  for (const file of await findFiles(roots)) {
    const r = await load(file);
    if (r.app) { if (!next.has(r.app.key)) next.set(r.app.key, r.app); } else if (r.fresh) log(`Pane: ignoring ${file}: ${r.error}`);
  }
  const changed = JSON.stringify([...apps]) !== JSON.stringify([...next]);
  apps = next;
  return changed;
}

function list() { return [...apps.values()]; }
function get(key) { return apps.get(key) || null; }
function match(server, launched) { return matchApp(list(), server, launched); }

module.exports = {
  supported, FILE_NAME, inside, parseHeader, appFrom, findFiles, parentRoot, rootsFor, matchApp,
  refresh, list, get, match,
};
