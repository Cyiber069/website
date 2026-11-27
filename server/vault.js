// The library agents read before a task: vault notes, the skill library, and lessons written back from reviews.
const fs = require('fs');
const path = require('path');
const { ROOT, workspace } = require('./store');

const VAULT_DIR = path.join(ROOT, 'vault');
const SKILL_PREFIX = 'skills/';
// Documents every part of the skill library hangs off; drawn next to the core of the map.
const CORE_DOCS = /^(MASTER_PLAYBOOK|NEW_GAME_CHECKLIST|REUSABLE_TEMPLATE_PLAN)/i;

const skillsDir = (ws) => ws && ws.skillsDir ? path.join(ROOT, ws.skillsDir) : null;

function walk(dir, out = []) {
  if (!dir || !fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (f.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const pretty = (s) => s.replace(/^\d+-/, m => m.replace('-', ' ')).replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// Numbered items under a "Rules" heading (or all numbered items in a checklist-style file) become "ideas" on the map.
function ideas(text) {
  const out = [];
  let inRules = false, sawRules = /^##\s+Rules\b/im.test(text);
  for (const line of text.split('\n')) {
    const h = /^(#{1,3})\s+(.*)/.exec(line);
    if (h) { inRules = /^rules\b/i.test(h[2].trim()); continue; }
    const m = /^\s*(\d+)\.\s+(.+)/.exec(line);
    if (m && (inRules || !sawRules)) out.push(m[2].replace(/\*\*|`/g, '').replace(/\s*\[[^\]]*\]\s*$/, '').split(/\s+Why:/i)[0].trim());
  }
  return out;
}

function graph(wsId) {
  const ws = workspace(wsId);
  if (!ws) return { nodes: [], edges: [], words: 0, ideas: 0 };
  const base = path.join(VAULT_DIR, wsId), sdir = skillsDir(ws);
  const nodes = [];
  const add = (file, id, chapter, chapterName, isIndex, extra) => {
    const text = fs.readFileSync(file, 'utf8');
    const title = (text.match(/^#\s+(.+)$/m) || [, pretty(path.basename(file, '.md'))])[1].trim();
    const n = Object.assign({ id, title, summary: (text.match(/^>\s+(.+)$/m) || [, ''])[1].trim(), chapter, chapterName: chapterName || title, isIndex,
      kind: 'note', words: text.split(/\s+/).filter(Boolean).length,
      links: [...text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim()) }, extra);
    nodes.push(n);
    return { n, text };
  };
  for (const file of walk(base)) {
    const rel = path.relative(base, file).split(path.sep).join('/');
    const chapter = rel.includes('/') ? rel.split('/')[0] : 'root';
    add(file, rel, chapter, pretty(chapter), /(^|\/)index\.md$/.test(rel));
  }
  // Each skill file is its own cluster, with one spark per rule.
  for (const file of walk(sdir)) {
    const name = path.basename(file, '.md'), id = SKILL_PREFIX + path.relative(sdir, file).split(path.sep).join('/');
    const { n, text } = add(file, id, 'skill:' + name, null, true, { skill: true, core: CORE_DOCS.test(name) });
    ideas(text).forEach((t, i) => nodes.push({ id: id + '#' + (i + 1), title: t, kind: 'idea', parent: id, index: i + 1, chapter: n.chapter, chapterName: n.chapterName, words: 0, links: [] }));
  }
  const byTitle = new Map(nodes.filter(n => n.kind === 'note').map(n => [n.title.toLowerCase(), n.id]));
  const edges = [], seen = new Set();
  const link = (a, b) => { const k = a < b ? a + '|' + b : b + '|' + a; if (a !== b && !seen.has(k)) { seen.add(k); edges.push([a, b]); } };
  for (const n of nodes) {
    for (const l of n.links) { const t = byTitle.get(l.toLowerCase()); if (t) link(n.id, t); }
    delete n.links;
    if (n.kind === 'idea') link(n.id, n.parent);
    else if (!n.isIndex) { const idx = nodes.find(m => m.isIndex && m.chapter === n.chapter); if (idx) link(n.id, idx.id); }
  }
  return { nodes, edges, words: nodes.reduce((a, n) => a + n.words, 0), ideas: nodes.filter(n => n.kind === 'idea').length };
}

function safeNote(wsId, id) {
  const ws = workspace(wsId);
  if (!ws) return null;
  id = String(id || '').split('#')[0];
  const isSkill = id.startsWith(SKILL_PREFIX);
  const base = isSkill ? skillsDir(ws) : path.join(VAULT_DIR, wsId);
  if (!base) return null;
  const p = path.resolve(base, isSkill ? id.slice(SKILL_PREFIX.length) : id);
  if (!p.startsWith(base + path.sep) || !p.endsWith('.md') || !fs.existsSync(p)) return null;
  return p;
}
function note(wsId, id) {
  const p = safeNote(wsId, id);
  return p ? fs.readFileSync(p, 'utf8') : null;
}

// Files an agent must read for a task: its vault chapters, its skill files, and its own lessons.
function readingList(wsId, agent) {
  const ws = workspace(wsId), base = path.join(VAULT_DIR, wsId), sdir = skillsDir(ws);
  const files = [];
  if (sdir && (agent.skills || []).length) {
    const all = walk(sdir);
    for (const s of agent.skills) files.push(...all.filter(f => path.basename(f).toLowerCase().startsWith(s.toLowerCase())));
  }
  for (const ch of agent.reads || []) files.push(...walk(path.join(base, ch)));
  const lessons = path.join(base, 'lessons', agent.id + '.md');
  if (fs.existsSync(lessons)) files.push(lessons);
  return [...new Set(files)];
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
  if (!filePath) return null;
  const inside = (base, prefix) => {
    if (!base) return null;
    // path.relative compares case-insensitively on Windows, where agents may report c:/ or C:\ paths.
    const rel = path.relative(base, path.resolve(String(filePath)));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? prefix + rel.split(path.sep).join('/') : null;
  };
  return inside(path.join(VAULT_DIR, wsId), '') || inside(skillsDir(workspace(wsId)), SKILL_PREFIX);
}

module.exports = { VAULT_DIR, skillsDir, graph, note, readingList, writeLesson, noteIdFromPath };
