// "Detach as standalone app": a launcher entry (the app menu on Linux desktops,
// the Start menu on Windows) with the app's own name and icon. It starts Pane
// with --pane-app=<id>, which opens just that app in its own window, without
// the home screen.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, shell } = require('electron');
const { installedExe } = require('./install');

const ARG = '--pane-app=';
const supported = process.platform === 'linux' || process.platform === 'win32';

function idFor(key) { return crypto.createHash('sha1').update(key).digest('hex').slice(0, 10); }
function fromArgv(argv) { const a = argv.find(x => x.startsWith(ARG)); return a ? a.slice(ARG.length) : null; }
function appUserModelId(id) { return `io.github.ennobrok.pane.app.${id}`; }

// How to start Pane from outside: on Windows the self-installed copy (install.js),
// the AppImage or portable exe (their real location, not the temporary copy that
// runs), or electron + the app folder from source.
function launchCommand() {
  const installed = installedExe();
  if (installed) return { file: installed, args: [] };
  if (process.env.APPIMAGE) {
    // Without FUSE the AppImage only runs extracted; launcher entries must ask for that too.
    const extracted = /[/\\]appimage_extracted_/.test(process.execPath) || process.env.APPIMAGE_EXTRACT_AND_RUN === '1';
    return { file: process.env.APPIMAGE, args: extracted ? ['--appimage-extract-and-run'] : [] };
  }
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { file: process.env.PORTABLE_EXECUTABLE_FILE, args: [] };
  if (app.isPackaged) return { file: process.execPath, args: [] };
  return { file: process.execPath, args: [app.getAppPath()] };
}

function iconPath(id, ext) {
  const dir = path.join(app.getPath('userData'), 'icons');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.${ext}`);
}

// Windows shortcuts want .ico; an ICO file may simply wrap one 256 px PNG.
function pngToIco(png) {
  const h = Buffer.alloc(22);
  h.writeUInt16LE(0, 0); h.writeUInt16LE(1, 2); h.writeUInt16LE(1, 4);   // icon file, one image
  h.writeUInt8(0, 6); h.writeUInt8(0, 7);                                 // 0 means 256 px
  h.writeUInt16LE(1, 10); h.writeUInt16LE(32, 12);
  h.writeUInt32LE(png.length, 14); h.writeUInt32LE(22, 18);
  return Buffer.concat([h, png]);
}

function linuxFile(id) {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'applications', `pane-${id}.desktop`);
}
// Start menu shortcuts are named after the app; a second app with the same name gets its id appended.
function windowsFile(id, name, previous) {
  const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const base = name.replace(/[\\/:*?"<>|]/g, '').trim() || 'App';
  const file = path.join(dir, `${base}.lnk`);
  return file === previous || !fs.existsSync(file) ? file : path.join(dir, `${base} (${id.slice(0, 4)}).lnk`);
}
// Desktop entry Exec quoting: double quotes, with " ` $ \ escaped.
function quote(s) { return `"${s.replace(/(["`$\\])/g, '\\$1')}"`; }

// Writes (or rewrites) the launcher entry and returns its path, or null when
// unsupported. previous: the entry's old path, removed if the name changed.
function install(id, name, png, previous = null) {
  if (!supported) return null;
  const cmd = launchCommand();
  const pngFile = iconPath(id, 'png');
  fs.writeFileSync(pngFile, png);
  let file = null;
  if (process.platform === 'win32') {
    const ico = iconPath(id, 'ico');
    fs.writeFileSync(ico, pngToIco(png));
    file = windowsFile(id, name, previous);
    const args = [...cmd.args.map(a => `"${a}"`), `${ARG}${id}`].join(' ');
    const ok = shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', {
      target: cmd.file, args, icon: ico, iconIndex: 0, appUserModelId: appUserModelId(id), description: name,
    });
    if (!ok) return null;
  } else {
    file = linuxFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const exec = [cmd.file, ...cmd.args].map(quote).join(' ').replace(/%/g, '%%') + ` ${ARG}${id}`;
    fs.writeFileSync(file, [
      '[Desktop Entry]', 'Type=Application', `Name=${name.replace(/\s+/g, ' ')}`, 'Comment=Opens in Pane',
      `Exec=${exec}`, `Icon=${pngFile}`, 'Terminal=false', 'Categories=Network;', '',
    ].join('\n'), { mode: 0o755 });
  }
  if (previous && previous !== file) { try { fs.unlinkSync(previous); } catch { /* already gone */ } }
  return file;
}

function exists(file) { return !!file && fs.existsSync(file); }

// True when the entry already starts Pane the way it would be written now, so a
// start need not rewrite it (Windows shortcuts are slow to write).
function isCurrent(id, file) {
  const cmd = launchCommand();
  try {
    if (process.platform === 'win32') {
      const l = shell.readShortcutLink(file);
      return path.resolve(l.target) === path.resolve(cmd.file) && (l.args || '').endsWith(`${ARG}${id}`)
        && l.appUserModelId === appUserModelId(id);
    }
    const exec = [cmd.file, ...cmd.args].map(quote).join(' ').replace(/%/g, '%%') + ` ${ARG}${id}`;
    return fs.readFileSync(file, 'utf8').split('\n').includes(`Exec=${exec}`);
  } catch { return false; }
}

function uninstall(id, file) {
  for (const f of [file, linuxFile(id), iconPath(id, 'png'), iconPath(id, 'ico')]) {
    if (f) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  }
}

module.exports = { supported, idFor, fromArgv, appUserModelId, install, exists, isCurrent, uninstall, iconPath };
