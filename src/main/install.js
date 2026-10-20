// Windows self-install. The portable exe unpacks the whole app to %TEMP% on every
// start, which takes seconds (more with a virus scanner) and hit standalone
// launchers just as hard. So the portable copy installs itself once to
// %LOCALAPPDATA%\Programs\Pane\app-<version>, with a "Pane" Start menu entry, and
// launcher entries point there. One folder per version: a running older copy
// keeps its files locked, so it is removed on a later start instead.
// original-fs: Electron's fs treats app.asar as a folder and would copy it as one.
const fs = require('original-fs');
const path = require('node:path');
const { app, shell } = require('electron');

const portable = process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;

function root() {
  const local = process.env.LOCALAPPDATA || path.join(app.getPath('appData'), '..', 'Local');
  return path.join(local, 'Programs', 'Pane');
}
function dirFor(version) { return path.join(root(), `app-${version}`); }
function exeName() { return path.basename(process.execPath); }

// The installed Pane.exe of this version, or null while there is none.
function installedExe() {
  if (process.platform !== 'win32') return null;
  const exe = path.join(dirFor(app.getVersion()), exeName());
  return fs.existsSync(exe) ? exe : null;
}

function startMenuShortcut(exe) {
  const file = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Pane.lnk');
  shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', {
    target: exe, icon: exe, iconIndex: 0, appUserModelId: 'io.github.ennobrok.pane', description: 'Pane',
  });
}

// Older app-* folders; the one in use stays locked and is retried next time.
async function removeOld(keep) {
  let names = [];
  try { names = await fs.promises.readdir(root()); } catch { return; }
  for (const n of names) {
    if (n === path.basename(keep) || !/^app-/.test(n)) continue;
    try { await fs.promises.rm(path.join(root(), n), { recursive: true, force: true }); } catch { /* in use */ }
  }
}

// Copies the running portable app into place (to a .partial folder first, renamed
// when complete). Resolves to true when launcher entries should be rewritten.
async function selfInstall() {
  if (!portable) return false;
  const dest = dirFor(app.getVersion());
  if (!installedExe()) {
    const partial = dest + '.partial';
    try {
      await fs.promises.rm(partial, { recursive: true, force: true });
      await fs.promises.mkdir(root(), { recursive: true });
      await fs.promises.cp(path.dirname(process.execPath), partial, { recursive: true });
      await fs.promises.rename(partial, dest);
    } catch {
      fs.promises.rm(partial, { recursive: true, force: true }).catch(() => {});
      return false;
    }
  }
  try { startMenuShortcut(path.join(dest, exeName())); } catch { /* ignore */ }
  removeOld(dest);
  return true;
}

module.exports = { installedExe, selfInstall };
