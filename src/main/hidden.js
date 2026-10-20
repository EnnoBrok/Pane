// Local servers the user hid. Keyed by process name + port so the choice
// survives restarts even though pids change.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'hidden.json');
let keys = new Set();

function keyOf(s) { return `${s.name || ''}:${s.port}`; }
function load() { try { keys = new Set(JSON.parse(fs.readFileSync(FILE(), 'utf8'))); } catch { /* first run */ } }
function save() { try { fs.writeFileSync(FILE(), JSON.stringify([...keys], null, 2)); } catch { /* ignore */ } }
function isHidden(s) { return keys.has(keyOf(s)); }
function hide(s) { keys.add(keyOf(s)); save(); }
function unhide(s) { keys.delete(keyOf(s)); save(); }

module.exports = { load, isHidden, hide, unhide };
