// Plain node, no Electron: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paneapps = require('../src/main/paneapps');

const dirs = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-test-'))); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function script(dir, header, { exec = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'pane.sh');
  fs.writeFileSync(file, header);
  fs.chmodSync(file, exec ? 0o755 : 0o644);
  return file;
}
const HEADER = (name, port) => `#!/usr/bin/env bash\n# pane.name: ${name}\n# pane.port: ${port}\nexec python3 -m http.server ${port}\n`;

test('parseHeader reads pane.* lines of the leading comment block only', () => {
  const meta = paneapps.parseHeader([
    '#!/usr/bin/env bash',
    '',
    '# Builds manufacturing jobs.',
    '#   pane.name:  MFG Builder  ',
    '# pane.port: 8770',
    '# PANE.Icon: ui/favicon.svg',
    '# pane.name: second one is ignored',
    'set -e',
    '# pane.description: after code, ignored',
  ].join('\r\n'));
  assert.deepEqual(meta, { name: 'MFG Builder', port: '8770', icon: 'ui/favicon.svg' });
  assert.deepEqual(paneapps.parseHeader('exec foo\n# pane.name: x'), {});
  assert.deepEqual(paneapps.parseHeader(''), {});
});

test('appFrom needs a name and a valid port; the icon stays inside the folder', () => {
  const f = '/home/u/apps/mfg/pane.sh';
  assert.match(paneapps.appFrom(f, { port: '1' }).error, /pane\.name/);
  assert.match(paneapps.appFrom(f, { name: 'A' }).error, /pane\.port/);
  assert.match(paneapps.appFrom(f, { name: 'A', port: '70000' }).error, /not a port/);
  assert.match(paneapps.appFrom(f, { name: 'A', port: '80a' }).error, /not a port/);
  const { app } = paneapps.appFrom(f, { name: 'A', port: '8770', icon: 'ui/favicon.svg', description: 'd' });
  assert.equal(app.key, 'pane:/home/u/apps/mfg');
  assert.equal(app.dir, '/home/u/apps/mfg');
  assert.equal(app.port, 8770);
  assert.equal(app.iconFile, '/home/u/apps/mfg/ui/favicon.svg');
  assert.equal(app.description, 'd');
  assert.equal(paneapps.appFrom(f, { name: 'A', port: '1', icon: '../../etc/x.png' }).app.iconFile, '');
  assert.equal(paneapps.appFrom(f, { name: 'A', port: '1', icon: '/etc/x.png' }).app.iconFile, '');
});

test('findFiles looks one and two folders deep and skips tool folders', async () => {
  const root = tmp();
  const ok1 = script(path.join(root, 'a'), HEADER('A', 1));
  const ok2 = script(path.join(root, 'group', 'b'), HEADER('B', 2));
  script(path.join(root, 'group', 'b', 'deep', 'c'), HEADER('C', 3));        // three deep
  script(root, HEADER('Root', 4));                                          // the root itself
  for (const skip of ['node_modules', '.git', 'venv', 'dist', 'out', '.cache']) script(path.join(root, skip, 'x'), HEADER('S', 5));
  script(path.join(root, 'proj', 'node_modules'), HEADER('S', 6));
  const elsewhere = tmp();
  const ok3 = script(path.join(elsewhere, 'linked'), HEADER('L', 7));
  fs.symlinkSync(path.join(elsewhere, 'linked'), path.join(root, 'link'));
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'));
  const found = await paneapps.findFiles([root, root, path.join(root, 'missing')]);
  assert.deepEqual(found, [ok1, path.join(root, 'group', 'b', 'pane.sh'), path.join(root, 'link', 'pane.sh')].sort());
  assert.ok(ok2 && ok3);
});

test('parentRoot only inside home', () => {
  assert.equal(paneapps.parentRoot('/home/u/Dokumente/app', '/home/u'), '/home/u/Dokumente');
  assert.equal(paneapps.parentRoot('/home/u/app', '/home/u'), '/home/u');
  assert.equal(paneapps.parentRoot('/', '/home/u'), null);
  assert.equal(paneapps.parentRoot('/srv/app', '/home/u'), null);
  assert.equal(paneapps.parentRoot('/home/u', '/home/u'), null);
  assert.equal(paneapps.parentRoot('', '/home/u'), null);
});

test('rootsFor: defaults or configured folders, plus server parents, existing ones only', () => {
  const home = tmp();
  for (const d of ['Dokumente', 'src', 'work/x', 'other']) fs.mkdirSync(path.join(home, d), { recursive: true });
  assert.deepEqual(paneapps.rootsFor({ home }), [path.join(home, 'Dokumente'), path.join(home, 'src')]);
  assert.deepEqual(
    paneapps.rootsFor({ home, folders: ['~/other', '~/nope'], cwds: [path.join(home, 'work/x'), '/'], parents: [path.join(home, 'other'), '/etc'] }),
    [path.join(home, 'other'), path.join(home, 'work')]);
});

test('matchApp: port, then the working folder, or the pid Pane started', () => {
  const a = { key: 'pane:/h/a', dir: '/h/a', realDir: '/data/a', port: 8770 };
  const b = { key: 'pane:/h/b', dir: '/h/b', realDir: '/h/b', port: 8770 };
  const list = [a, b];
  assert.equal(paneapps.matchApp(list, { port: 9000, cwd: '/h/a' }), null);
  assert.equal(paneapps.matchApp(list, { port: 8770, cwd: '/h/b' }), b);
  assert.equal(paneapps.matchApp(list, { port: 8770, cwd: '/h/a/server' }), a);
  assert.equal(paneapps.matchApp(list, { port: 8770, cwd: '/data/a' }), a);          // the folder through a symlink
  assert.equal(paneapps.matchApp(list, { port: 8770, cwd: '/h/ab' }), null);         // a sibling, not inside
  assert.equal(paneapps.matchApp(list, { port: 8770, cwd: '/elsewhere' }), null);
  assert.equal(paneapps.matchApp(list, { port: 8770, cwd: '' }), a);                // unknown folder: the port decides
  assert.equal(paneapps.matchApp(list, { port: 8770, cwd: '/elsewhere', pid: 42 }, new Map([[b.key, 42]])), b);
});

test('refresh finds apps, logs unusable files once, notices changes', async () => {
  const root = tmp();
  script(path.join(root, 'good'), `#!/bin/sh\n# pane.name: Good\n# pane.port: 8123\n# pane.icon: icon.svg\n# pane.description: A good app\nexec true\n`);
  script(path.join(root, 'noport'), '#!/bin/sh\n# pane.name: No port\n');
  script(path.join(root, 'noexec'), HEADER('No exec', 8124), { exec: false });
  const logs = [];
  const log = (m) => logs.push(m);
  assert.equal(await paneapps.refresh([root], log), true);
  const key = `pane:${path.join(root, 'good')}`;
  assert.deepEqual(paneapps.list().map(a => a.key), [key]);
  const app = paneapps.get(key);
  assert.equal(app.name, 'Good');
  assert.equal(app.port, 8123);
  assert.equal(app.description, 'A good app');
  assert.equal(app.iconFile, path.join(root, 'good', 'icon.svg'));
  assert.equal(logs.length, 2);
  assert.ok(logs.some(m => m.includes('noport') && m.includes('pane.port')));
  assert.ok(logs.some(m => m.includes('noexec') && m.includes('executable')));

  assert.equal(await paneapps.refresh([root], log), false);   // nothing changed, nothing logged again
  assert.equal(logs.length, 2);

  fs.chmodSync(path.join(root, 'noexec', 'pane.sh'), 0o755);   // keeps the mtime: the cache must see the mode
  assert.equal(await paneapps.refresh([root], log), true);
  assert.equal(paneapps.list().length, 2);

  fs.rmSync(path.join(root, 'good'), { recursive: true });
  assert.equal(await paneapps.refresh([root], log), true);
  assert.equal(paneapps.get(key), null);
});
