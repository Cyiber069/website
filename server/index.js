// Nightshift control room server. No dependencies: plain Node http + server-sent events.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const S = require('./store');
const V = require('./vault');
const R = require('./runner');
const market = require('./market');

const PORT = Number(process.env.PORT) || 4600;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(S.ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.lua': 'text/plain; charset=utf-8',
  '.luau': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm' };

const send = (res, code, body, headers) => {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers));
  res.end(data);
};
const bad = (res, msg, code = 400) => send(res, code, { error: msg });
const readBody = (req) => new Promise((resolve, reject) => {
  let b = ''; req.on('data', d => { b += d; if (b.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('Invalid JSON')); } });
});
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const cookieToken = (req) => (/(?:^|;\s*)ns_token=([a-f0-9]+)/.exec(req.headers.cookie || '') || [])[1];

function publicState(wsId) {
  const db = S.db;
  const pids = new Set(db.projects.filter(p => p.workspace === wsId).map(p => p.id));
  const { token, ...settings } = db.settings;
  return {
    workspaces: S.config.workspaces.map(w => ({ id: w.id, name: w.name, tagline: w.tagline, hasMarket: w.hasMarket,
      agents: w.agents.map(a => ({ id: a.id, name: a.name, color: a.color, isLead: !!a.isLead, role: a.role, reads: a.reads })) })),
    settings, mode: R.mode(), liveAvailable: R.liveAvailable(), spentToday: S.spentToday(),
    projects: db.projects.filter(p => p.workspace === wsId),
    tasks: db.tasks.filter(t => pids.has(t.projectId)),
    reviews: db.reviews.filter(r => pids.has(r.projectId) && r.status !== 'withdrawn'),
    pitches: db.pitches.filter(p => p.workspace === wsId),
    events: db.events.filter(e => !e.projectId || pids.has(e.projectId)).slice(-250),
  };
}

function createProject(b) {
  const ws = S.workspace(b.workspace);
  if (!ws) throw new Error('Unknown workspace');
  const name = String(b.name || '').trim();
  if (!name) throw new Error('Give the project a name');
  const p = { id: S.id('pj'), workspace: ws.id, name: name.slice(0, 80), brief: String(b.brief || '').slice(0, 8000),
    budgetUsd: Math.max(0, Number(b.budgetUsd) || 10), spentUsd: 0, paused: false,
    checks: Array.isArray(b.checks) ? b.checks.map(String).filter(Boolean).slice(0, 10) : [], createdAt: S.now() };
  S.db.projects.push(p);
  fs.mkdirSync(S.projectDir(p), { recursive: true });
  fs.writeFileSync(path.join(S.projectDir(p), 'BRIEF.md'), `# ${p.name}\n\n${p.brief}\n`);
  const lead = ws.agents.find(a => a.isLead);
  if (lead && b.kickoff !== false) S.db.tasks.push(R.newTask(p.id, lead.id, 'Plan the first milestone', 'Read the brief, decide the smallest version worth reviewing, and hand out the tasks to build it.'));
  S.event({ projectId: p.id, kind: 'project', text: 'New project: ' + p.name });
  S.changed();
  return p;
}

// What the owner does to a review item. Notes become lessons the agent reads next time.
function reviewAction(r, action, note) {
  const t = S.task(r.taskId), p = S.project(r.projectId);
  if (!t || !p) throw new Error('This review item is no longer attached to a task');
  if (r.status !== 'pending') throw new Error('Already decided');
  const agent = S.agentOf(p.workspace, r.agentId);
  note = String(note || '').trim();
  if ((action === 'changes' || action === 'reject') && !note) throw new Error('Say what was wrong so the agent can learn from it');
  const lesson = () => { if (note && agent) { const id = V.writeLesson(p.workspace, agent, t.title, action === 'reject' ? 'rejected' : 'changes asked', note); S.event({ projectId: p.id, agentId: r.agentId, kind: 'lesson', text: 'New lesson saved for ' + agent.name, noteId: id }); } };
  r.note = note; r.decidedAt = S.now();
  const others = S.db.reviews.filter(o => o.taskId === t.id && o.status === 'pending' && o.id !== r.id);
  if (action === 'approve') {
    r.status = 'approved';
    if (!others.length) { t.status = 'done'; t.updatedAt = S.now(); }
  } else if (action === 'changes' || action === 'polish') {
    r.status = 'changes';
    for (const o of others) o.status = 'withdrawn';
    t.feedback.push({ from: 'owner', ts: S.now(), text: action === 'polish'
      ? 'Good direction. Polish it to a higher standard: tighten details, fix rough edges, re-check it against the vault notes.' + (note ? ' ' + note : '')
      : note });
    if (action === 'changes') lesson();
    t.status = 'queued'; t.updatedAt = S.now();
  } else if (action === 'reject') {
    r.status = 'rejected';
    for (const o of others) o.status = 'withdrawn';
    lesson();
    t.status = 'failed'; t.updatedAt = S.now();
  } else throw new Error('Unknown action');
  S.event({ projectId: p.id, taskId: t.id, agentId: r.agentId, kind: 'verdict', text: `Owner ${({ approve: 'approved', changes: 'asked for changes on', polish: 'asked to polish', reject: 'rejected' })[action]}: ${r.title}` });
  S.changed();
}

function taskAction(t, action, note) {
  note = String(note || '').trim();
  if (action === 'stop' || action === 'cancel') {
    R.stop(t);
    for (const r of S.db.reviews) if (r.taskId === t.id && r.status === 'pending') r.status = 'withdrawn';
    t.status = action === 'stop' ? 'stopped' : 'failed'; t.updatedAt = S.now();
  } else if (action === 'retry' || action === 'reply') {
    if (['running', 'checking', 'queued'].includes(t.status)) throw new Error('Already in progress');
    if (note) t.feedback.push({ from: 'owner', ts: S.now(), text: note });
    t.status = 'queued'; t.question = undefined; t.updatedAt = S.now();
  } else throw new Error('Unknown action');
  S.changed();
}

// Calls made by agents through cli.js. Each is tied to the task the agent is running.
function agentCall(kind, b, taskId) {
  const t = S.task(taskId);
  if (!t) throw new Error('Unknown task');
  const p = S.project(t.projectId), ws = S.workspace(p.workspace);
  if (kind === 'note') { R.ev(t, 'note', b.text); return {}; }
  if (kind === 'ask') {
    R.ev(t, 'ask', 'Needs you: ' + b.text);
    R.setStatus(t, 'blocked', { question: String(b.text || '').slice(0, 1000) });
    return {};
  }
  if (kind === 'review') {
    const dir = S.projectDir(p);
    const files = (b.files || []).map(String).map(f => path.relative(dir, path.resolve(dir, f)).split(path.sep).join('/'))
      .filter(f => f && !f.startsWith('..') && fs.existsSync(path.join(dir, f)));
    S.db.reviews.push({ id: S.id('rv'), taskId: t.id, projectId: p.id, agentId: t.agentId, title: String(b.title || t.title).slice(0, 160),
      summary: String(b.summary || '').slice(0, 4000), files, status: 'pending', createdAt: S.now() });
    S.changed();
    return { files };
  }
  if (kind === 'task') {
    const a = S.agentOf(ws.id, b.agent);
    if (!a) throw new Error('No agent called ' + b.agent + '. Agents: ' + ws.agents.map(x => x.id).join(', '));
    if (!b.title) throw new Error('A task needs a title');
    const open = S.db.tasks.filter(x => x.projectId === p.id && ['queued', 'running', 'checking'].includes(x.status)).length;
    if (open >= 40) throw new Error('Too many open tasks in this project. Finish some first.');
    const nt = R.newTask(p.id, a.id, b.title, b.detail, t.agentId);
    S.db.tasks.push(nt);
    R.ev(t, 'handoff', `Handed work to ${a.name}: ${nt.title}`);
    S.changed();
    return { id: nt.id };
  }
  if (kind === 'pitch') {
    if (!b.title) throw new Error('A pitch needs a title');
    S.db.pitches.push({ id: S.id('pt'), workspace: ws.id, title: String(b.title).slice(0, 120), body: String(b.body || '').slice(0, 4000),
      agentId: t.agentId, status: 'new', createdAt: S.now() });
    R.ev(t, 'pitch', 'New pitch: ' + b.title);
    S.changed();
    return {};
  }
  throw new Error('Unknown command');
}

const sse = new Set();
S.listeners.add((type, payload) => {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload || {})}\n\n`;
  for (const res of sse) res.write(msg);
});

async function api(req, res, url) {
  const p = url.pathname, q = url.searchParams, m = req.method;
  const body = m === 'POST' ? await readBody(req) : {};
  let x;
  if (p === '/api/state') return send(res, 200, publicState(q.get('ws') || S.config.workspaces[0].id));
  if (p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    sse.add(res);
    const ka = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ka); sse.delete(res); });
    return;
  }
  if (p === '/api/projects' && m === 'POST') return send(res, 200, createProject(body));
  if ((x = /^\/api\/projects\/(\w+)$/.exec(p)) && m === 'POST') {
    const pr = S.project(x[1]); if (!pr) return bad(res, 'No such project', 404);
    if ('paused' in body) pr.paused = !!body.paused;
    if ('budgetUsd' in body) pr.budgetUsd = Math.max(0, Number(body.budgetUsd) || 0);
    if ('brief' in body) { pr.brief = String(body.brief).slice(0, 8000); fs.writeFileSync(path.join(S.projectDir(pr), 'BRIEF.md'), `# ${pr.name}\n\n${pr.brief}\n`); }
    if ('checks' in body) pr.checks = (body.checks || []).map(String).filter(Boolean).slice(0, 10);
    S.changed(); return send(res, 200, pr);
  }
  if (p === '/api/tasks' && m === 'POST') {
    const pr = S.project(body.projectId); if (!pr) return bad(res, 'Pick a project');
    if (!S.agentOf(pr.workspace, body.agentId)) return bad(res, 'Pick an agent');
    if (!String(body.title || '').trim()) return bad(res, 'Give the task a title');
    const t = R.newTask(pr.id, body.agentId, body.title, body.detail);
    S.db.tasks.push(t); S.changed(); return send(res, 200, t);
  }
  if ((x = /^\/api\/tasks\/(\w+)\/action$/.exec(p)) && m === 'POST') {
    const t = S.task(x[1]); if (!t) return bad(res, 'No such task', 404);
    taskAction(t, body.action, body.note); return send(res, 200, t);
  }
  if ((x = /^\/api\/reviews\/(\w+)\/action$/.exec(p)) && m === 'POST') {
    const r = S.db.reviews.find(r => r.id === x[1]); if (!r) return bad(res, 'No such review item', 404);
    reviewAction(r, body.action, body.note); return send(res, 200, r);
  }
  if ((x = /^\/api\/pitches\/(\w+)\/action$/.exec(p)) && m === 'POST') {
    const pt = S.db.pitches.find(i => i.id === x[1]); if (!pt) return bad(res, 'No such pitch', 404);
    if (body.action === 'start') { pt.status = 'started'; createProject({ workspace: pt.workspace, name: pt.title, brief: pt.body, budgetUsd: body.budgetUsd }); }
    else pt.status = 'dismissed';
    S.changed(); return send(res, 200, pt);
  }
  if (p === '/api/settings' && m === 'POST') {
    const s = S.db.settings;
    if (['auto', 'demo'].includes(body.mode)) s.mode = body.mode;
    if ('maxParallel' in body) s.maxParallel = Math.min(8, Math.max(1, Math.round(Number(body.maxParallel) || 1)));
    if ('nightlyCapUsd' in body) s.nightlyCapUsd = Math.max(0, Number(body.nightlyCapUsd) || 0);
    if ('model' in body) s.model = String(body.model || '').replace(/[^\w.\-\[\]]/g, '').slice(0, 60);
    S.changed(); return send(res, 200, {});
  }
  if (p === '/api/vault') return send(res, 200, V.graph(q.get('ws')));
  if (p === '/api/vault/note') { const t = V.note(q.get('ws'), q.get('id') || ''); return t === null ? bad(res, 'No such note', 404) : send(res, 200, { text: t }); }
  if (p === '/api/market') {
    try { return send(res, 200, market.view(await market.get(q.get('refresh') === '1'))); }
    catch (e) { return bad(res, e.message, 502); }
  }
  if (p === '/api/file') {
    const pr = S.project(q.get('project')); if (!pr) return bad(res, 'No such project', 404);
    const dir = S.projectDir(pr), f = path.resolve(dir, q.get('path') || '');
    if (!f.startsWith(dir + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return bad(res, 'No such file', 404);
    return send(res, 200, fs.readFileSync(f), { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  }
  if ((x = /^\/api\/agent\/(\w+)$/.exec(p)) && m === 'POST') return send(res, 200, agentCall(x[1], body, req.headers['x-task']));
  if (p === '/api/access') {
    const nets = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    return send(res, 200, { lan: HOST !== '127.0.0.1', urls: nets.map(a => `http://${a}:${PORT}/?token=${S.db.settings.token}`) });
  }
  bad(res, 'Not found', 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // Anything not coming from this computer needs the access token (phone on the same Wi-Fi, a tunnel).
    const given = url.searchParams.get('token') || req.headers['x-token'] || cookieToken(req);
    const authed = given === S.db.settings.token;
    if (!isLocal(req) && !authed) return send(res, 401, 'Access token required. Open the link shown in Settings on the computer running Nightshift.', { 'Content-Type': 'text/plain' });
    if (url.pathname === '/api/access' && !isLocal(req)) return bad(res, 'Only available on the computer itself', 403);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(PUBLIC, 'index.html');
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
    if (url.searchParams.get('token') && authed) headers['Set-Cookie'] = `ns_token=${S.db.settings.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
    send(res, 200, fs.readFileSync(file), headers);
  } catch (e) { bad(res, e.message || 'Something went wrong'); }
});

server.listen(PORT, HOST, () => {
  R.boot(PORT);
  console.log(`\n  Nightshift is running:  http://localhost:${PORT}`);
  console.log(`  Agents: ${R.mode() === 'live' ? 'live (Claude Code found)' : 'demo mode (Claude Code not found on this computer)'}`);
  if (HOST !== '127.0.0.1') console.log('  Phone access is on. Open Settings in the app for the link.');
  console.log('');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const t of S.db.tasks) if (R.running.has(t.id)) R.stop(t); S.flush(); process.exit(0); });
