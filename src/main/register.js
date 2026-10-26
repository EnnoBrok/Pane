// "Open with Pane": registers Pane itself as a handler for HTML files, so a file
// manager offers it next to the browsers. Pane started with a file adds it to
// home and opens it (main.js openFileArg); a running instance takes it over.
// Linux: a pane.desktop entry with MimeType= in the user's app menu, which also
// gives the AppImage a proper launcher. Windows: a ProgID under HKCU with
// OpenWithProgids for .html/.htm, written with reg.exe. Neither makes Pane the
// default for HTML files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app } = require('electron');

const supported = process.platform === 'linux' || process.platform === 'win32';
const TYPES = ['.html', '.htm', '.xhtml'];

function quote(s) { return `"${s.replace(/(["`$\\])/g, '\\$1')}"`; }

function linuxFile() {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'applications', 'pane.desktop');
}

function linuxEntry(cmd, icon) {
  const exec = [cmd.file, ...cmd.args].map(quote).join(' ').replace(/%/g, '%%') + ' %f';
  return [
    '[Desktop Entry]', 'Type=Application', 'Name=Pane',
    'Comment=Local and network web apps as desktop apps',
    `Exec=${exec}`, `Icon=${icon}`, 'Terminal=false', 'Categories=Network;',
    'MimeType=text/html;application/xhtml+xml;', 'StartupWMClass=pane', '',
  ].join('\n');
}

function registerLinux(cmd) {
  const dir = path.join(app.getPath('userData'), 'icons');
  fs.mkdirSync(dir, { recursive: true });
  const icon = path.join(dir, 'pane.png');
  const png = fs.readFileSync(path.join(app.getAppPath(), 'src', 'assets', 'icon.png'));   // out of the asar
  let same = false;
  try { same = fs.readFileSync(icon).equals(png); } catch { /* not yet */ }
  if (!same) fs.writeFileSync(icon, png);
  const file = linuxFile();
  const entry = linuxEntry(cmd, icon);
  try { if (fs.readFileSync(file, 'utf8') === entry) return; } catch { /* not yet */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entry, { mode: 0o755 });
  // Lets file managers pick the new MimeType up at once; harmless when missing.
  execFile('update-desktop-database', [path.dirname(file)], () => {});
}

function reg(args) {
  return new Promise((resolve) => execFile('reg', args, { windowsHide: true }, (err) => resolve(!err)));
}

async function registerWindows(cmd) {
  const exe = cmd.file;
  const open = [`"${exe}"`, ...cmd.args.map(a => `"${a}"`), '"%1"'].join(' ');
  const progid = 'HKCU\\Software\\Classes\\Pane.HTML';
  // Skip when the command is already in place (reg.exe calls are slow).
  const current = await new Promise((resolve) =>
    execFile('reg', ['query', `${progid}\\shell\\open\\command`, '/ve'], { windowsHide: true }, (err, out) => resolve(err ? '' : String(out))));
  if (current.includes(open)) return;
  await reg(['add', progid, '/ve', '/d', 'HTML document (Pane)', '/f']);
  await reg(['add', progid, '/v', 'FriendlyTypeName', '/d', 'HTML document (Pane)', '/f']);
  await reg(['add', `${progid}\\DefaultIcon`, '/ve', '/d', `"${exe}",0`, '/f']);
  await reg(['add', `${progid}\\shell\\open`, '/ve', '/d', 'Open with Pane', '/f']);
  await reg(['add', `${progid}\\shell\\open\\command`, '/ve', '/d', open, '/f']);
  for (const ext of TYPES) await reg(['add', `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids`, '/v', 'Pane.HTML', '/t', 'REG_NONE', '/d', '', '/f']);
}

// Registers the running Pane (or, on Windows, the installed copy) once it has a
// stable location: packaged builds always, from source only with PANE_REGISTER=1.
async function register(launchCommand) {
  if (!supported) return;
  if (!app.isPackaged && process.env.PANE_REGISTER !== '1') return;
  try {
    const cmd = launchCommand();
    if (process.platform === 'win32') await registerWindows(cmd);
    else registerLinux(cmd);
  } catch { /* a read-only home or a missing reg.exe; nothing to do about it */ }
}

module.exports = { register };
