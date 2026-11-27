// The vault: markdown notes agents read before a task, plus lessons written back from reviews.
const fs = require('fs');
const path = require('path');
const { ROOT, workspace } = require('./store');

const VAULT_DIR = path.join(ROOT, 'vault');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (f.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const pretty = (s) => s.replace(/^\d+-/, m => m.replace('-', ' ')).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function graph(wsId) {
  const base = path.join(VAULT_DIR, wsId);
  const nodes = [];
  for (const file of walk(base)) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(base, file).split(path.sep).join('/');
    const chapter = rel.includes('/') ? rel.split('/')[0] : 'root';
    const title = (text.match(/^#\s+(.+)$/m) || [, path.basename(file, '.md')])[1].trim();
    const summary = (text.match(/^>\s+(.+)$/m) || [, ''])[1].trim();
    const links = [...text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim());
    nodes.push({ id: rel, title, summary, chapter, chapterName: pretty(chapter), isIndex: /(^|\/)index\.md$/.test(rel),
      words: text.split(/\s+/).filter(Boolean).length, links });
  }
  const byTitle = new Map(nodes.map(n => [n.title.toLowerCase(), n.id]));
  const edges = [];
  const seen = new Set();
  const add = (a, b) => { const k = a < b ? a + '|' + b : b + '|' + a; if (a !== b && !seen.has(k)) { seen.add(k); edges.push([a, b]); } };
  for (const n of nodes) {
    for (const l of n.links) { const t = byTitle.get(l.toLowerCase()); if (t) add(n.id, t); }
    delete n.links;
    if (!n.isIndex) { const idx = nodes.find(m => m.isIndex && m.chapter === n.chapter); if (idx) add(n.id, idx.id); }
  }
  return { nodes, edges, words: nodes.reduce((a, n) => a + n.words, 0) };
}

function safeNote(wsId, id) {
  const base = path.join(VAULT_DIR, wsId);
  const p = path.resolve(base, id);
  if (!p.startsWith(base + path.sep) || !p.endsWith('.md') || !fs.existsSync(p)) return null;
  return p;
}
function note(wsId, id) {
  const p = safeNote(wsId, id);
  return p ? fs.readFileSync(p, 'utf8') : null;
}

// Files an agent must read for a task: its chapters plus its own lessons.
function readingList(wsId, agent) {
  const base = path.join(VAULT_DIR, wsId);
  const files = [];
  for (const ch of agent.reads || []) files.push(...walk(path.join(base, ch)));
  const lessons = path.join(base, 'lessons', agent.id + '.md');
  if (fs.existsSync(lessons)) files.push(lessons);
  return files;
}

// A review verdict with a note becomes a permanent lesson for that agent.
function writeLesson(wsId, agent, taskTitle, verdict, noteText) {
  const ws = workspace(wsId);
  const dir = path.join(VAULT_DIR, wsId, 'lessons');
  fs.mkdirSync(dir, { recursive: true });
  const idx = path.join(dir, 'index.md');
  if (!fs.existsSync(idx)) fs.writeFileSync(idx, `# Lessons (${ws.name})\n\n> What the owner corrected in review. Each agent reads its own lessons before every task.\n`);
  const file = path.join(dir, agent.id + '.md');
  const title = `Lessons for ${agent.name} (${ws.name})`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# ${title}\n\n> Corrections from the owner's reviews. Follow these before anything else in the vault.\n\nSee [[Lessons (${ws.name})]].\n`);
    fs.appendFileSync(idx, `\n- [[${title}]]`);
  }
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(file, `\n## ${day}: ${taskTitle.replace(/\n/g, ' ')}\n\n- Verdict: ${verdict}\n- Owner said: ${noteText.trim().replace(/\n+/g, ' ')}\n`);
  return 'lessons/' + agent.id + '.md';
}

function noteIdFromPath(wsId, filePath) {
  const base = path.join(VAULT_DIR, wsId);
  const p = path.resolve(String(filePath || ''));
  return p.startsWith(base + path.sep) ? path.relative(base, p).split(path.sep).join('/') : null;
}

module.exports = { VAULT_DIR, graph, note, readingList, writeLesson, noteIdFromPath };
