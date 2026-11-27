// Small JSON-file store. One process owns the file; writes are debounced and atomic.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.NIGHTSHIFT_DATA || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'workspaces.json'), 'utf8'));

const blank = () => ({
  settings: { mode: 'auto', maxParallel: 3, model: '', nightlyCapUsd: 25, token: crypto.randomBytes(18).toString('hex') },
  projects: [], tasks: [], reviews: [], events: [], pitches: [], spendLog: [],
});

fs.mkdirSync(PROJECTS_DIR, { recursive: true });
let db = blank();
if (fs.existsSync(DB_FILE)) {
  try { db = Object.assign(blank(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch (e) { fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt-' + Date.now()); }
}
db.settings = Object.assign(blank().settings, db.settings);
if (!/^[a-f0-9]{20,}$/.test(String(db.settings.token || ''))) db.settings.token = crypto.randomBytes(18).toString('hex');

let timer = null, fails = 0;
function write() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  try { fs.renameSync(tmp, DB_FILE); }
  catch { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } // Windows can refuse the rename while another program has the file open
}
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try { write(); fails = 0; }
    catch (e) { if (++fails === 1) console.error('Could not save data, retrying:', e.message); setTimeout(save, 500); }
  }, 150);
}
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  try { write(); } catch (e) { console.error('Could not save data:', e.message); }
}

const id = (p) => p + '_' + crypto.randomBytes(5).toString('hex');
const now = () => new Date().toISOString();

const listeners = new Set();
function emit(type, payload) { for (const l of listeners) { try { l(type, payload); } catch {} } }

function event(e) {
  const ev = Object.assign({ id: id('ev'), ts: now() }, e);
  db.events.push(ev);
  if (db.events.length > 3000) db.events.splice(0, db.events.length - 3000);
  save(); emit('event', ev);
  return ev;
}
function changed() { save(); emit('state'); }

const workspace = (wid) => config.workspaces.find(w => w.id === wid);
const agentOf = (wid, aid) => (workspace(wid) || { agents: [] }).agents.find(a => a.id === aid);
const project = (pid) => db.projects.find(p => p.id === pid);
const task = (tid) => db.tasks.find(t => t.id === tid);
const projectDir = (p) => path.join(PROJECTS_DIR, p.id);

function spentToday() {
  const day = now().slice(0, 10);
  return db.spendLog.filter(s => s.ts.slice(0, 10) === day).reduce((a, s) => a + s.usd, 0);
}

module.exports = { ROOT, DATA_DIR, PROJECTS_DIR, config, get db() { return db; }, save, flush, id, now,
  listeners, emit, event, changed, workspace, agentOf, project, task, projectDir, spentToday };
