// API keys entered in Settings. Kept in the data folder on this computer only, never sent to the browser,
// never committed, and only changeable from the computer itself.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const FILE = path.join(DATA_DIR, 'secrets.json');
const NAMES = ['anthropic', 'cloudflare'];
let data = {};
try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}

const get = (name) => data[name] || '';
function set(name, value) {
  if (!NAMES.includes(name)) throw new Error('Unknown key');
  value = String(value || '').trim();
  if (value && (value.length < 20 || value.length > 400 || /\s/.test(value))) throw new Error('That does not look like a valid key');
  if (value) data[name] = value; else delete data[name];
  fs.writeFileSync(FILE, JSON.stringify(data), { mode: 0o600 });
}
// What the browser is allowed to know: whether a key is saved, and its last four characters.
const status = () => Object.fromEntries(NAMES.map(n => [n, { set: !!data[n], hint: data[n] ? '…' + data[n].slice(-4) : '' }]));

module.exports = { get, set, status };
