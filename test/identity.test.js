// Plain node, no Electron: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const id = require('../src/main/identity');

const APP = { key: 'pane:/h/mfg', exe: '/usr/bin/python3.13', cwd: '/h/mfg' };
const OTHER = { key: 'pane:/h/other', exe: '/usr/bin/python3.13', cwd: '/h/other' };
const ROOT = { key: 'docker-proxy:8080', exe: '', cwd: '' };   // another user's process: /proc unreadable
const ev = (rec, launchedKey = '') => ({ ...rec, launchedKey });

// A fake /proc: pid -> { ppid, start }
function fakeProc(table) { return { stat: (pid) => table[pid] || null }; }

test('parseStat reads ppid and start time, also with odd process names', () => {
  const line = (comm) => `4242 (${comm}) S 17 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 987654 1000 10 18446744073709551615`;
  assert.deepEqual(id.parseStat(line('python3')), { ppid: 17, start: '987654' });
  assert.deepEqual(id.parseStat(line('a) S 99 (b')), { ppid: 17, start: '987654' });
  assert.equal(id.parseStat(''), null);
  assert.equal(id.parseStat('garbage'), null);
});

test('launches: the started pid or its descendants, never a reused pid', () => {
  const table = { 100: { ppid: 1, start: '500' }, 101: { ppid: 100, start: '510' }, 102: { ppid: 101, start: '520' }, 200: { ppid: 1, start: '600' } };
  const l = id.createLaunches(fakeProc(table));
  l.note(APP.key, 100);
  assert.equal(l.keyOf(100), APP.key);   // pane.sh exec'd its server
  assert.equal(l.keyOf(102), APP.key);   // server is a grandchild of the script
  assert.equal(l.keyOf(200), '');        // unrelated
  assert.equal(l.keyOf(999), '');        // gone
  table[100] = { ppid: 1, start: '900' };   // pid 100 died and was reused
  assert.equal(l.keyOf(100), '');
  assert.equal(l.keyOf(102), '');
  l.note(APP.key, 200);
  l.forget(200);
  assert.equal(l.keyOf(200), '');
});

test('evidenceOf and combine: one program per port, or a conflict', () => {
  const l = id.createLaunches(fakeProc({ 7: { ppid: 1, start: '1' } }));
  l.note(APP.key, 7);
  const e = id.evidenceOf({ pid: 7, exe: APP.exe, cwd: APP.cwd }, APP.key, l);
  assert.deepEqual(e, ev(APP, APP.key));
  assert.deepEqual(id.evidenceOf({ pid: null }, 'x:1'), { key: 'x:1', exe: '', cwd: '', launchedKey: '' });
  assert.equal(id.combine([]), null);
  assert.deepEqual(id.combine([e, { ...e }]), e);              // IPv4 and IPv6 rows of one program
  assert.deepEqual(id.combine([e, ev(OTHER)]), { conflict: true });
  assert.deepEqual(id.combine([e, ev(APP)]), { conflict: true });   // same folder, but one not started by Pane
});

test('level: launched only for pane.sh keys, recognized by exe and folder', () => {
  assert.equal(id.level(ev(APP, APP.key), APP), id.LAUNCHED);
  assert.equal(id.level(ev(APP), APP), id.RECOGNIZED);
  assert.equal(id.level(ev({ ...APP, exe: '/x/python3' }, APP.key), { key: APP.key }), id.LAUNCHED);   // record without a fingerprint
  assert.equal(id.level(ev(OTHER), APP), id.UNKNOWN);
  assert.equal(id.level(ev(OTHER, OTHER.key), APP), id.UNKNOWN);   // launched, but for another app
  assert.equal(id.level(ev(OTHER, APP.key), APP), id.LAUNCHED);    // the app's own pane.sh cd'd elsewhere: still the app
  const pin = { key: 'python3:8000', exe: APP.exe, cwd: '/h/x' };
  assert.equal(id.level(ev({ ...pin, cwd: '/h/y' }, pin.key), pin), id.UNKNOWN);   // a pin's start command proves nothing
  assert.equal(id.level(ev(pin, pin.key), pin), id.RECOGNIZED);
  assert.equal(id.level({ conflict: true }, APP), id.UNKNOWN);
  assert.equal(id.level(null, APP), id.UNKNOWN);
  assert.equal(id.level(ev(ROOT), ROOT), id.UNKNOWN);   // nothing to compare
});

test('mayFill: only into a program the login was saved with or typed into', () => {
  assert.equal(id.mayFill([APP], ev(APP)), true);
  assert.equal(id.mayFill([OTHER, APP], ev(APP)), true);
  assert.equal(id.mayFill([APP], ev(OTHER)), false);                // port taken over by another app
  assert.equal(id.mayFill(undefined, ev(APP)), false);              // saved before owners were kept
  assert.equal(id.mayFill([APP], null), false);                     // nobody listens
  assert.equal(id.mayFill([APP], { conflict: true }), false);       // two programs on the port
  assert.equal(id.mayFill([ROOT], ev(ROOT)), true);                 // unreadable then and now
  assert.equal(id.mayFill([ROOT], ev(APP)), false);                 // never from an unreadable owner to a readable process
  assert.equal(id.mayFill([APP], ev(ROOT)), false);                 // nor the other way
  assert.equal(id.mayFill([APP], ev({ ...APP, exe: '/usr/bin/python3.14' })), false);   // upgraded runtime: typed once more
});

test('addOwner and addUse: newest first, deduplicated, capped, unchanged array when nothing new', () => {
  const o1 = id.addOwner(undefined, ev(APP));
  assert.deepEqual(o1, [APP]);
  assert.equal(id.addOwner(o1, ev(APP, APP.key)), o1);   // launchedKey is not part of the record
  const o2 = id.addOwner(o1, ev(OTHER));
  assert.deepEqual(o2, [OTHER, APP]);
  assert.deepEqual(id.addOwner(o2, ev(APP)), [APP, OTHER]);
  let many;
  for (let i = 0; i < 10; i++) many = id.addOwner(many, ev({ key: `k${i}`, exe: '/e', cwd: `/c${i}` }));
  assert.equal(many.length, 4);
  assert.equal(many[0].key, 'k9');

  const u1 = id.addUse([], ev(APP), 1000);
  assert.deepEqual(u1, [{ ...APP, since: 1000 }]);
  assert.equal(id.addUse(u1, ev(APP), 2000), u1);
  const u2 = id.addUse(id.addUse(u1, ev(OTHER), 3000), ev(APP), 4000);
  assert.deepEqual(u2, [{ ...APP, since: 1000 }, { ...OTHER, since: 3000 }]);   // first-seen time is kept
});

test('isLocal: loopback hosts, or the address a local listener was found on', () => {
  assert.equal(id.isLocal('http://127.0.0.1:8770/x'), true);
  assert.equal(id.isLocal('http://localhost:3000'), true);
  assert.equal(id.isLocal('http://[::1]:3000'), true);
  assert.equal(id.isLocal('https://tools.local'), false);
  assert.equal(id.isLocal('file:///h/a.html'), false);
  assert.equal(id.isLocal('not a url'), false);
  const listeners = [{ port: 8080, reachHost: '192.168.1.5' }, { port: 443, reachHost: '[fe80::1]' }];
  assert.equal(id.isLocal('http://192.168.1.5:8080', listeners), true);
  assert.equal(id.isLocal('http://192.168.1.5:9090', listeners), false);
  assert.equal(id.isLocal('https://[fe80::1]/', listeners), true);
  assert.equal(id.portOf(new URL('https://x')), 443);
  assert.equal(id.portOf(new URL('http://x')), 80);
});
