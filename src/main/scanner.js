// Lists TCP ports in LISTEN state together with the owning process.
// Linux: `ss -tlnpH` plus /proc for cmdline and cwd.
// Windows: `netstat -ano` plus `tasklist` for the process name.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

// "0.0.0.0:80", "[::]:80", "*:80", "127.0.0.1:8000", "[::ffff:127.0.0.1]:3000"
function splitAddr(s) {
  const i = s.lastIndexOf(':');
  if (i < 0) return null;
  let host = s.slice(0, i);
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  host = host.replace(/^\[|\]$/g, '');
  return { host, port };
}

// Address a local client should use to reach this listener.
function reachableHost(host) {
  if (host === '' || host === '*' || host === '0.0.0.0' || host === '::' || host === '127.0.0.1') return '127.0.0.1';
  if (host === '::1') return '[::1]';
  if (host.startsWith('::ffff:')) return host.slice(7);
  return host.includes(':') ? `[${host}]` : host;
}

function readProc(pid, file) {
  try { return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8'); } catch { return ''; }
}
function readLink(pid, file) {
  try { return fs.readlinkSync(`/proc/${pid}/${file}`); } catch { return ''; }
}

async function listLinux() {
  const out = await run('ss', ['-tlnpH']);
  const result = [];
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const addr = splitAddr(cols[3]);
    if (!addr) continue;
    const m = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    const pid = m ? Number(m[2]) : null;
    const name = m ? m[1] : null;
    const entry = { host: addr.host, port: addr.port, pid, name, cmdline: '', argv: [], cwd: '', exe: '' };
    if (pid) {
      entry.argv = readProc(pid, 'cmdline').split('\0').filter(Boolean);
      entry.cmdline = entry.argv.join(' ');
      entry.cwd = readLink(pid, 'cwd');
      entry.exe = readLink(pid, 'exe');
    }
    result.push(entry);
  }
  return result;
}

const winNameCache = new Map();
async function listWindows() {
  const [out, out6] = await Promise.all([run('netstat', ['-ano', '-p', 'TCP']), run('netstat', ['-ano', '-p', 'TCPv6'])]);
  const rows = [];
  for (const line of (out + '\n' + out6).split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
    const addr = splitAddr(cols[1]);
    if (!addr) continue;
    rows.push({ host: addr.host, port: addr.port, pid: Number(cols[4]), name: null, cmdline: '', argv: [], cwd: '', exe: '' });
  }
  const unknown = [...new Set(rows.map(r => r.pid))].filter(p => !winNameCache.has(p));
  if (unknown.length) {
    const csv = await run('tasklist', ['/FO', 'CSV', '/NH']);
    for (const line of csv.split('\n')) {
      const m = line.match(/^"([^"]*)","(\d+)"/);
      if (m) winNameCache.set(Number(m[2]), m[1]);
    }
  }
  for (const r of rows) r.name = winNameCache.get(r.pid) || null;
  return rows;
}

async function listListeners() {
  const rows = os.platform() === 'win32' ? await listWindows() : await listLinux();
  // Collapse IPv4/IPv6 duplicates of the same port+pid into one entry.
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.port}:${r.pid}`;
    const prev = byKey.get(key);
    if (!prev || (reachableHost(r.host) === '127.0.0.1' && reachableHost(prev.host) !== '127.0.0.1')) {
      byKey.set(key, { ...r, reachHost: reachableHost(r.host) });
    }
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port);
}

module.exports = { listListeners };
