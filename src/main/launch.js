// Starts a pinned local app's server again with the command it was last seen
// running with: executable, arguments and working folder, read from /proc on
// Linux (scanner.js). Windows does not expose another process's folder, so
// there a pinned local app can be opened but not started. The server runs on
// its own, detached from Pane; its output goes to userData/logs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app } = require('electron');

// What a running server needs to be started again, or null.
function commandOf(s) {
  if (!s || !s.argv || !s.argv.length || !s.cwd) return null;
  return { exe: s.exe || '', argv: s.argv, cwd: s.cwd };
}

function canStart(cmd) { return !!(cmd && cmd.argv && cmd.argv.length && cmd.cwd && fs.existsSync(cmd.cwd)); }

function logFile(key) {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, crypto.createHash('sha1').update(key).digest('hex').slice(0, 12) + '.log');
}
function hasLog(key) { try { return fs.statSync(logFile(key)).size > 0; } catch { return false; } }

// Pane's own environment, minus what Electron changed in it for itself.
function cleanEnv(bin) {
  const env = { ...process.env };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'CHROME_DESKTOP', 'APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete env[k];
  if (env.ORIGINAL_XDG_CURRENT_DESKTOP) {
    env.XDG_CURRENT_DESKTOP = env.ORIGINAL_XDG_CURRENT_DESKTOP;
    delete env.ORIGINAL_XDG_CURRENT_DESKTOP;
  }
  // The server's own runtime first: Pane started from a launcher may lack e.g. nvm's node on its PATH.
  if (path.isAbsolute(bin)) env.PATH = [path.dirname(bin), env.PATH].filter(Boolean).join(path.delimiter);
  return env;
}

// The program as it was started ("python3", not the "python3.13" it links to):
// Linux names a process after the file it was started from, and Pane knows
// apps by process name and port, so a pinned app must come back under its old name.
function program(cmd, env) {
  const name = cmd.argv[0];
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : cmd.exe;
  if (!name.includes('/')) {
    for (const dir of String(env.PATH || '').split(path.delimiter)) {
      const file = dir && path.join(dir, name);
      if (file && fs.existsSync(file)) return file;
    }
  }
  return cmd.exe && fs.existsSync(cmd.exe) ? cmd.exe : path.resolve(cmd.cwd, name);
}

// A child would inherit Electron's open sockets and pipes (Chromium leaves some
// without close-on-exec), so on Linux bash closes everything above stderr first
// and then becomes the server.
const CLOSE_FDS = 'for p in /proc/$$/fd/*; do n=${p##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done 2>/dev/null; exec -a "$1" "${@:2}"';

// Returns the child process; throws when it cannot be spawned.
function start(key, cmd) {
  const env = cleanEnv(cmd.exe || cmd.argv[0]);
  const bin = program(cmd, env);
  const [file, args] = process.platform === 'linux' && fs.existsSync('/bin/bash')
    ? ['/bin/bash', ['-c', CLOSE_FDS, 'pane-start', cmd.argv[0], bin, ...cmd.argv.slice(1)]]
    : [bin, cmd.argv.slice(1)];
  const out = fs.openSync(logFile(key), 'w');
  try {
    const child = spawn(file, args, {
      cwd: cmd.cwd, env, argv0: file === bin ? cmd.argv[0] : undefined,
      detached: true, stdio: ['ignore', out, out], windowsHide: true,
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(out);
  }
}

module.exports = { commandOf, canStart, start, logFile, hasLog };
