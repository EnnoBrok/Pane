// Plain node, no Electron: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/main/partitions');

const A = { key: 'pane:/h/a', dirs: ['/h/a'], port: 8770 };
const B = { key: 'pane:/h/b', dirs: ['/h/b'], port: 8770 };
const L = 'persist:app-8770';
const state = (over = {}) => ({ owned: {}, uses: {}, refs: [], hasData: () => false, ...over });
const rec = (key, cwd) => ({ key, exe: '/usr/bin/python3', cwd });

// Apply a decision the way main.js does.
function open(target, st) {
  const d = p.decide(target, st);
  if (d.claim) st.owned[target.key] = { partition: d.partition, port: target.port };
  return d.partition;
}

test('names', () => {
  assert.equal(p.legacy(8770), L);
  assert.match(p.fresh('pane:/h/a'), /^persist:id-[0-9a-f]{12}$/);
  assert.equal(p.fresh('pane:/h/a'), p.fresh('pane:/h/a'));
  assert.notEqual(p.fresh('pane:/h/a'), p.fresh('pane:/h/b'));
  assert.equal(p.dirName('persist:app-8770'), 'app-8770');
  assert.equal(p.shared(8770, {}), L);
  assert.equal(p.shared(8770, { [A.key]: { partition: L } }), `${L}-shared`);
});

test('rule 1: an empty, unused port partition is claimed by a verified pane.sh app', () => {
  const st = state();
  const d = p.decide({ ...A, server: 'verified' }, st);
  assert.deepEqual(d, { partition: L, claim: true });
});

test('rule 2: a partition with data is claimed only when every record names this app', () => {
  const data = { hasData: () => true };
  assert.deepEqual(p.decide({ ...A, server: 'verified' }, state(data)), { partition: L, claim: false });   // data, nobody known
  assert.deepEqual(p.decide({ ...A, server: 'verified' }, state({ ...data, uses: { [L]: [rec(A.key, '/h/a')] } })), { partition: L, claim: true });
  // recorded under the process name before the pane.sh existed, but in the app's folder
  assert.deepEqual(p.decide({ ...A, server: 'verified' }, state({ ...data, uses: { [L]: [rec('python3:8770', '/h/a/server')] } })), { partition: L, claim: true });
  assert.deepEqual(p.decide({ ...A, server: 'verified' }, state({ ...data, refs: [{ key: A.key, partition: L }] })), { partition: L, claim: true });
});

test('rule 3: any other recorded user, or no verified process, keeps the shared partition', () => {
  const data = { hasData: () => true };
  const mixed = state({ ...data, uses: { [L]: [rec(A.key, '/h/a'), rec('python3:8770', '/h/other')] } });
  assert.deepEqual(p.decide({ ...A, server: 'verified' }, mixed), { partition: L, claim: false });
  const pinned = state({ ...data, refs: [{ key: A.key, partition: L }, { key: 'node:8770', partition: L }] });
  assert.deepEqual(p.decide({ ...A, server: 'verified' }, pinned), { partition: L, claim: false });
  assert.deepEqual(p.decide({ ...A, server: 'unverified' }, state()), { partition: L, claim: false });   // matched by port only
  assert.deepEqual(p.decide({ ...A, server: 'none' }, state()), { partition: L, claim: false });         // down: no claim without its process
  const portOnly = state({ uses: { [L]: [rec(A.key, '')] } });                                            // matched by port, folder unknown
  assert.deepEqual(p.decide({ ...A, server: 'verified' }, portOnly), { partition: L, claim: false });
  const unknownUse = state({ uses: { [L]: [rec('docker-proxy:8770', '')] } });                           // unreadable process: not this app
  assert.deepEqual(p.decide({ ...A, server: 'verified' }, unknownUse), { partition: L, claim: false });
});

test('rule 4: a second app on the port gets a fresh partition; neither sees the other', () => {
  const st = state();
  assert.equal(open({ ...A, server: 'verified' }, st), L);
  assert.equal(open({ ...B, server: 'verified' }, st), p.fresh(B.key));
  assert.equal(open({ ...A, server: 'verified' }, st), L);               // stable
  assert.equal(open({ ...B, server: 'none' }, st), p.fresh(B.key));      // down: still its own
  // Owners keep their partition whoever is on the port; the request guard refuses what is not theirs.
  assert.equal(open({ ...A, server: 'unverified' }, st), L);
  assert.equal(open({ ...B, server: 'unverified' }, st), p.fresh(B.key));
  // A pane.sh app without a partition of its own, while something unverified is on the port: shared.
  const C = { key: 'pane:/h/c', dirs: ['/h/c'], port: 8770 };
  assert.equal(open({ ...C, server: 'unverified' }, st), `${L}-shared`);
});

test('plain servers share the port partition, and lose it to a pane.sh app that owns it', () => {
  const st = state();
  const plain = { key: 'python3:8770', port: 8770, dirs: [], server: 'verified' };
  assert.deepEqual(p.decide(plain, st), { partition: L, claim: false });
  open({ ...A, server: 'verified' }, st);
  assert.deepEqual(p.decide(plain, st), { partition: `${L}-shared`, claim: false });
});

test('an app that changed its port keeps its partition; its old port partition stays owned', () => {
  const st = state();
  open({ ...A, server: 'verified' }, st);
  const moved = { ...A, port: 8771 };
  assert.equal(open({ ...moved, server: 'verified' }, st), L);
  assert.equal(open({ ...B, server: 'verified' }, st), p.fresh(B.key));   // B on A's old port: still not A's data
  assert.equal(p.decide({ key: 'node:8771', port: 8771, dirs: [], server: 'verified' }, st).partition, 'persist:app-8771');
});

test('rollback: a claimed port partition keeps its old name, so Pane 0.4.3 still opens the owner\'s data', () => {
  // 0.4.3 picks persist:app-<port> for every local server on that port.
  const old = (port) => `persist:app-${port}`;
  const st = state({ hasData: () => true, uses: { [L]: [rec(A.key, '/h/a')] } });
  assert.equal(open({ ...A, server: 'verified' }, st), old(A.port));
  // what was added for the new version is extra keys in prefs.json, which 0.4.3 keeps but does not read
  assert.deepEqual(Object.keys(st.owned), [A.key]);
});

test('inside', () => {
  assert.equal(p.inside('/h/a/x', '/h/a'), true);
  assert.equal(p.inside('/h/a', '/h/a'), true);
  assert.equal(p.inside('/h/ab', '/h/a'), false);
  assert.equal(p.inside('', '/h/a'), false);
});

test('filePartition: one per file, except the files that already shared persist:files', () => {
  const a = 'file:///h/a.html';
  const b = 'file:///h/b.html';
  assert.match(p.filePartition(a), /^persist:file-[0-9a-f]{12}$/);
  assert.notEqual(p.filePartition(a), p.filePartition(b));
  assert.equal(p.filePartition(a), p.filePartition(a));   // the same file again: its storage comes back
  assert.equal(p.filePartition(a, [a]), 'persist:files');
  assert.equal(p.filePartition(b, [a]), p.filePartition(b));
});
