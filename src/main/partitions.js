// Which cookie partition a local app opens in. Local apps used to share one per
// port (persist:app-<port>), so whatever listened on that port later got the
// cookies and storage of whatever listened before. Now a pane.sh app, known by
// its folder, can own a partition: its port's old one when nothing shows that
// anybody else used it, or a fresh one. Nothing is copied or moved. The old name
// simply gets an owner, so going back to Pane 0.4.3 (which uses
// persist:app-<port> for everything) still finds the owner's data where it was.
// Rules and invariants: docs/app-identity.md. No Electron in here, so `node --test` can load it.
const crypto = require('node:crypto');
const path = require('node:path');

function legacy(port) { return `persist:app-${port}`; }
function fresh(key) { return `persist:id-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`; }
// owned: key -> { partition, port }
function ownerOf(partition, owned) {
  for (const [key, o] of Object.entries(owned || {})) if (o && o.partition === partition) return key;
  return '';
}
// What every program on the port shares unless it owns something: the old
// partition, or once a pane.sh app owns that, a separate shared one.
function shared(port, owned) { const l = legacy(port); return ownerOf(l, owned) ? `${l}-shared` : l; }
// The folder in Chromium's userData/Partitions that holds a persist: partition.
function dirName(partition) { return String(partition).replace(/^persist:/, ''); }

function inside(file, dir) {
  if (!file || !dir) return false;
  const rel = path.relative(dir, file);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
// A recorded user (identity.js record) that is this app: a process working in its folder, or one
// recorded under its key with a known folder (Pane started it and its pane.sh changed folder).
// The key with no folder is a match by port alone, which proves nothing.
function isApp(rec, key, dirs) {
  if (!rec.cwd) return false;
  return rec.key === key || dirs.some(d => inside(rec.cwd, d));
}

// target: { key, port, dirs, server }, where server is what listens on the port now:
//   'verified'   the app's own process (Pane started it, or it works in the app's folder)
//   'unverified' something else, or the app matched by port alone
//   'none'       nothing
// state: { owned, uses: partition -> [records], refs: [{ key, partition }] from pins,
//          session and launcher entries, hasData(partition) }
// Returns { partition, claim }; claim: record the partition as the app's own from now on.
function decide(target, state) {
  const { key, port } = target;
  const owned = state.owned || {};
  const common = { partition: shared(port, owned), claim: false };
  if (!String(key).startsWith('pane:')) return common;   // "name:port" is a process name, not an identity
  // An app that owns a partition always opens in it, whoever is on the port: main.js
  // guards owned partitions, so another program's page is refused instead of shown
  // in the shared one (where it would leave its cookies for every unverified tab).
  const mine = owned[key];
  if (mine) return { partition: mine.partition, claim: false };
  if (target.server !== 'verified') return common;        // a claim needs the app's process in front of Pane

  const l = legacy(port);
  if (ownerOf(l, owned)) return { partition: fresh(key), claim: true };   // another app owns the port's partition
  const dirs = target.dirs || [];
  const uses = (state.uses || {})[l] || [];
  const refs = (state.refs || []).filter(r => r.partition === l);
  const others = uses.some(u => !isApp(u, key, dirs)) || refs.some(r => r.key !== key);
  if (others) return { partition: l, claim: false };      // used by others too: stays shared
  if (!uses.length && !refs.length && state.hasData(l)) return { partition: l, claim: false };   // data, but nobody known
  return { partition: l, claim: true };                   // empty, or only this app ever used it
}

module.exports = { legacy, fresh, shared, ownerOf, dirName, inside, decide };
