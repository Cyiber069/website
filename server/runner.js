// Runs queued tasks: launches the agent, streams what it does into the feed, runs the project's
// quality checks, enforces budgets, and routes the result to review.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, exec } = require('child_process');
const WIN = process.platform === 'win32';
const kill = (pid, sync) => { try { WIN ? (sync ? spawnSync : spawn)('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }) : process.kill(pid, 'SIGTERM'); } catch {} };
const S = require('./store');
const V = require('./vault');
const market = require('./market');
const secrets = require('./secrets');

// Forward slashes work in Bash, PowerShell and cmd on Windows, and avoid backslash-escaping surprises in Git Bash.
const CLI = path.join(S.ROOT, 'cli.js').split(path.sep).join('/');
const MAX_ATTEMPTS = 3;
const PER_TASK_CAP = 5;
const running = new Map(); // taskId -> run { child, timers }
const checkChain = new Map(); // projectId -> promise, so one project's checks never overlap
let port = 4600;
// ---- Finding Claude Code ----
// Looks on PATH and in the folders its installers use, so a new install is found even when this window's PATH
// is out of date. A positive result is kept; a negative one is re-checked every 20 seconds, so installing
// Claude Code while the app runs is picked up without a restart.
const os = require('os');
let cli = { found: false, path: '', version: '', checkedAt: 0 };

function candidates() {
  const home = os.homedir(), env = process.env, list = [];
  if (env.NIGHTSHIFT_CLAUDE) return [env.NIGHTSHIFT_CLAUDE]; // explicit override (also used by tests)
  if (WIN) {
    try { list.push(...spawnSync('where.exe', ['claude'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)); } catch {}
    list.push(path.join(home, '.local', 'bin', 'claude.exe'));
    if (env.APPDATA) list.push(path.join(env.APPDATA, 'npm', 'claude.cmd'));
    if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'claude.exe'));
  } else {
    try { const w = spawnSync('which', ['claude'], { encoding: 'utf8', timeout: 8000 }).stdout.trim(); if (w) list.push(w); } catch {}
    list.push(path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude');
  }
  return [...new Set(list)].filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}
const needsShell = (p) => WIN && /\.(cmd|bat)$/i.test(p); // Windows can only start .cmd files through cmd.exe
const quoteWin = (a) => /[\s&|<>^%()!,;="]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
// Runs Claude Code with the given arguments, safely on every platform.
function spawnClaude(args, opts) {
  const p = cli.path || 'claude';
  if (needsShell(p)) return spawn(quoteWin(p), args.map(quoteWin), Object.assign({ shell: true, windowsHide: true }, opts));
  return spawn(p, args, Object.assign({ windowsHide: true }, opts));
}
function detect(force) {
  if (cli.found && !force) return cli;
  if (!force && Date.now() - cli.checkedAt < 20000) return cli;
  cli = { found: false, path: '', version: '', checkedAt: Date.now() };
  for (const p of candidates()) {
    try {
      const r = spawnSync(needsShell(p) ? quoteWin(p) : p, ['--version'], { shell: needsShell(p), timeout: 20000, encoding: 'utf8', windowsHide: true });
      if (r.status === 0) { cli = { found: true, path: p, version: String(r.stdout || '').trim().split('\n')[0].slice(0, 60), checkedAt: Date.now() }; break; }
    } catch {}
  }
  return cli;
}
const liveAvailable = () => detect().found;
const cliInfo = (force) => { const c = detect(force); return { found: c.found, path: c.path, version: c.version }; };
function mode() {
  const m = S.db.settings.mode;
  if (m === 'demo') return 'demo';
  return liveAvailable() ? 'live' : 'demo';
}

const short = (s, n = 240) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function buildPrompt(t, p, ws, agent) {
  const files = V.readingList(ws.id, agent);
  const team = ws.agents.filter(a => a.id !== agent.id).map(a => `- ${a.id}: ${short(a.role, 110)}`).join('\n');
  const q = (s) => `"${s}"`;
  const fb = (t.feedback || []).map(f => `- (${f.from}, ${f.ts.slice(0, 10)}) ${f.text}`).join('\n');
  return [
    `You are ${agent.name}, an agent on the "${ws.name}" team inside the Nightshift control room. You work alone on one task and the owner reviews the result later, so nobody can answer questions while you work.`,
    `YOUR ROLE\n${agent.role}`,
    `PROJECT: ${p.name}\n${p.brief || '(no brief written yet)'}`,
    `WORKING FOLDER: ${S.projectDir(p)}\nKeep every file you create inside this folder.`,
    files.length ? `READ BEFORE YOU START (required, use the Read tool on each):\n${files.map(f => '- ' + f).join('\n')}` : '',
    `YOUR TASK: ${t.title}\n${t.detail || ''}`,
    fb ? `FEEDBACK ON EARLIER ATTEMPTS (fix all of this first):\n${fb}` : '',
    `COMMANDS (run them with your shell tool, Bash or PowerShell, exactly as written):
- Progress line for the owner:      node ${q(CLI)} note "what you are doing"
- Submit work for owner review:     node ${q(CLI)} review --title "..." --summary "what it is and how you checked it" --file relative/path [--file another]
- Hand work to a teammate:          node ${q(CLI)} task --agent <id> --title "..." --detail "everything they need"
- Pitch a new project:              node ${q(CLI)} pitch --title "..." --body "hook, loop, why now, risks"
- Blocked and need the owner:       node ${q(CLI)} ask "one clear question"`,
    `TEAMMATES\n${team}`,
    `RULES
- Follow the vault notes and your lessons file over your own habits.
- Do not say something works unless you ran or checked it; say what you could not verify.
- If you produced anything the owner should see, submit it with the review command before you finish.
- Finish with a short plain summary of what you did and what is left.`,
  ].filter(Boolean).join('\n\n');
}

function ev(t, kind, text, extra) {
  return S.event(Object.assign({ projectId: t.projectId, taskId: t.id, agentId: t.agentId, kind, text: short(text, 400) }, extra));
}
function setStatus(t, status, extra) {
  Object.assign(t, { status, updatedAt: S.now() }, extra);
  S.changed();
}

function handleLine(t, ws, line, acc) {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
    for (const c of m.message.content) {
      if (c.type === 'text' && c.text.trim()) { acc.lastText = c.text; ev(t, 'say', c.text); }
      else if (c.type === 'tool_use') {
        const i = c.input || {};
        if (c.name === 'Read') {
          const noteId = V.noteIdFromPath(ws.id, i.file_path);
          if (noteId) ev(t, 'read', 'Read vault note ' + noteId, { noteId });
          else ev(t, 'tool', 'Read ' + path.basename(String(i.file_path || '')));
        } else if (c.name === 'Bash') {
          if (!String(i.command || '').includes('cli.js')) ev(t, 'tool', 'Ran: ' + short(i.command, 140));
        } else if (c.name === 'Edit' || c.name === 'Write') ev(t, 'tool', (c.name === 'Write' ? 'Wrote ' : 'Changed ') + path.basename(String(i.file_path || '')));
        else ev(t, 'tool', c.name);
      }
    }
  } else if (m.type === 'result') {
    acc.result = m.result || acc.lastText || '';
    acc.cost = Number(m.total_cost_usd) || 0;
    acc.isError = !!m.is_error;
    acc.subtype = m.subtype || '';
  }
}

function runChecks(p) {
  const checks = (p.checks || []).filter(Boolean);
  const one = (cmd) => new Promise(resolve => {
    let done = false;
    const end = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const c = exec(cmd, { cwd: S.projectDir(p), maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, out, errOut) =>
      end(err ? { ok: false, cmd, output: short((out || '') + '\n' + (errOut || err.message), 1500) } : { ok: true }));
    const timer = setTimeout(() => { kill(c.pid); end({ ok: false, cmd, output: 'Timed out after 5 minutes.' }); }, 5 * 60 * 1000);
  });
  const job = () => checks.reduce((chain, cmd) => chain.then(res => res.ok === false ? res : one(cmd)), Promise.resolve({ ok: true }));
  const next = (checkChain.get(p.id) || Promise.resolve()).then(job, job);
  checkChain.set(p.id, next.catch(() => {}));
  return next;
}

async function finish(t, p, acc, run) {
  const current = running.get(t.id) === run;
  if (current) { running.delete(t.id); t.reservedUsd = 0; }
  if (acc.cost) {
    t.costUsd = (t.costUsd || 0) + acc.cost;
    p.spentUsd = (p.spentUsd || 0) + acc.cost;
    S.db.spendLog.push({ ts: S.now(), usd: acc.cost, projectId: p.id });
    if (S.db.spendLog.length > 5000) S.db.spendLog.splice(0, 1000);
  }
  if (!current || t.status !== 'running') { S.changed(); return; } // stopped, replaced by a newer run, or the agent asked a question
  t.result = short(acc.result, 2000);
  if (acc.failed || acc.isError) {
    const why = acc.subtype === 'error_max_budget_usd' ? 'It hit the spending limit for one task.' : (acc.error || acc.result || 'The agent stopped with an error.');
    ev(t, 'error', why);
    return setStatus(t, 'blocked', { question: 'This task failed: ' + short(why, 300) + ' Retry it, or reply with guidance.' });
  }
  if ((p.checks || []).length) {
    setStatus(t, 'checking');
    ev(t, 'check', 'Running quality checks');
    const res = await runChecks(p);
    if (t.status !== 'checking') return; // stopped or cancelled while the checks ran
    if (!res.ok) {
      ev(t, 'check', 'Check failed: ' + res.cmd);
      t.feedback = t.feedback || [];
      t.feedback.push({ from: 'quality check', ts: S.now(), text: `The check \`${res.cmd}\` failed:\n${res.output}` });
      for (const r of S.db.reviews) if (r.taskId === t.id && r.status === 'pending') r.status = 'withdrawn';
      t.checkFails = (t.checkFails || 0) + 1;
      if (t.checkFails < MAX_ATTEMPTS) return setStatus(t, 'queued');
      return setStatus(t, 'blocked', { question: `Quality checks still fail after ${MAX_ATTEMPTS} attempts (${res.cmd}). Reply with guidance or cancel.` });
    }
    t.checkFails = 0;
    ev(t, 'check', 'All checks passed');
  }
  const pending = S.db.reviews.some(r => r.taskId === t.id && r.status === 'pending');
  const agent = S.agentOf(p.workspace, t.agentId);
  if (!pending && agent && agent.isLead) { ev(t, 'done', 'Finished: ' + t.title); return setStatus(t, 'done'); }
  if (!pending) {
    S.db.reviews.push({ id: S.id('rv'), taskId: t.id, projectId: p.id, agentId: t.agentId, title: t.title,
      summary: t.result || 'The agent finished without a summary.', files: [], status: 'pending', createdAt: S.now() });
  }
  ev(t, 'review', 'Sent for review: ' + t.title);
  setStatus(t, 'review');
}

function startLive(t, p, ws, agent, cap) {
  const s = S.db.settings;
  const model = s.agentModels[ws.id + ':' + agent.id] || s.model;
  const key = secrets.get('anthropic');
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    '--max-budget-usd', cap.toFixed(2), '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', '--add-dir', V.VAULT_DIR];
  // On Windows without Git for Windows, Claude Code runs shell commands through its PowerShell tool instead of Bash.
  if (WIN) args.splice(args.indexOf('Grep') + 1, 0, 'PowerShell');
  if (V.skillsDir(ws)) args.push('--add-dir', V.skillsDir(ws));
  if (model) args.push('--model', model);
  const child = spawnClaude(args, {
    cwd: S.projectDir(p),
    env: Object.assign({}, process.env, key ? { ANTHROPIC_API_KEY: key } : {}, { NIGHTSHIFT_URL: `http://127.0.0.1:${port}`, NIGHTSHIFT_TOKEN: s.token, NIGHTSHIFT_TASK: t.id }),
  });
  const acc = {}, run = { child };
  running.set(t.id, run);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdin.on('error', () => {});
  let buf = '', err = '';
  child.stdout.on('data', d => {
    buf += d;
    let i; while ((i = buf.indexOf('\n')) >= 0) { handleLine(t, ws, buf.slice(0, i), acc); buf = buf.slice(i + 1); }
  });
  child.stderr.on('data', d => { err = (err + d).slice(-2000); });
  child.on('error', e => { acc.failed = true; acc.error = 'Could not start the agent: ' + e.message; finish(t, p, acc, run); });
  child.on('close', code => {
    if (buf.trim()) handleLine(t, ws, buf, acc);
    if (code !== 0 && acc.result === undefined) { acc.failed = true; acc.error = short(err, 400) || 'The agent exited with code ' + code; }
    finish(t, p, acc, run);
  });
  child.stdin.end(buildPrompt(t, p, ws, agent));
}

// ---- Free Cloudflare credits (Workers AI) ----
// A text-only model: it cannot run tools or edit files, so it is only used for agents whose work is a written
// document. It is tried first; when the free daily allowance runs out (or it fails) the task moves to Claude.
const utcDay = () => new Date().toISOString().slice(0, 10);
let cfUsedUpDay = '';
const cfReady = () => !!(S.db.settings.cfAccountId && secrets.get('cloudflare'));
const cfUsedUp = () => cfUsedUpDay === utcDay(); // the allowance resets at midnight UTC
const cfUrl = () => (S.db.settings.cfBaseUrl || `https://api.cloudflare.com/client/v4/accounts/${S.db.settings.cfAccountId}/ai/v1`) + '/chat/completions';

async function cfChat(messages, maxTokens, signal) {
  const r = await fetch(cfUrl(), { method: 'POST', signal,
    headers: { Authorization: 'Bearer ' + secrets.get('cloudflare'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: S.db.settings.cfModel, messages, max_tokens: maxTokens }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = (j.errors && j.errors[0]) || j.error || {};
    const msg = String(e.message || j.message || 'HTTP ' + r.status);
    throw Object.assign(new Error(msg), { quota: e.code === 3036 || /daily free allocation/i.test(msg) });
  }
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text || !String(text).trim()) throw new Error('It returned an empty reply');
  return String(text);
}

async function startText(t, p, ws, agent, cap, live) {
  const run = { abort: new AbortController() };
  running.set(t.id, run);
  const mine = () => running.get(t.id) === run && t.status === 'running';
  try {
    let room = 48000, docs = '';
    for (const f of V.readingList(ws.id, agent)) {
      const text = fs.readFileSync(f, 'utf8');
      if (text.length > room) continue;
      room -= text.length; docs += `\n\n===== ${path.basename(f)} =====\n${text}`;
      const noteId = V.noteIdFromPath(ws.id, f);
      if (noteId) ev(t, 'read', 'Read vault note ' + noteId, { noteId });
    }
    const fb = (t.feedback || []).map(f => `- (${f.from}) ${f.text}`).join('\n');
    const text = await cfChat([
      { role: 'system', content: `You are ${agent.name}, an agent on the "${ws.name}" team. ${agent.role}\nYou cannot run tools, edit files or hand work to anyone. Reply with the finished document only, in markdown, starting with a # title. Follow the reference notes over your own habits. Do not claim anything you could not verify; say what is an assumption.` },
      { role: 'user', content: `PROJECT: ${p.name}\n${p.brief || ''}\n\nYOUR TASK: ${t.title}\n${t.detail || ''}${fb ? '\n\nFEEDBACK ON EARLIER ATTEMPTS (fix all of this):\n' + fb : ''}\n\nREFERENCE NOTES:${docs || ' (none)'}` },
    ], 4000, AbortSignal.any([run.abort.signal, AbortSignal.timeout(180000)]));
    if (!mine()) return;
    const rel = 'deliverables/' + t.id + '.md';
    fs.mkdirSync(path.join(S.projectDir(p), 'deliverables'), { recursive: true });
    fs.writeFileSync(path.join(S.projectDir(p), rel), text);
    ev(t, 'tool', 'Wrote ' + t.id + '.md using free Cloudflare credits');
    S.db.reviews.push({ id: S.id('rv'), taskId: t.id, projectId: p.id, agentId: t.agentId, title: t.title,
      summary: 'Written with free Cloudflare credits (a smaller model than Claude, so check it carefully).\n\n' + short(text, 600), files: [rel], status: 'pending', createdAt: S.now() });
    finish(t, p, { result: short(text, 600), cost: 0 }, run);
  } catch (e) {
    if (!mine()) return; // stopped or cancelled
    running.delete(t.id);
    if (e.quota) {
      cfUsedUpDay = utcDay();
      once('cf-' + cfUsedUpDay, () => S.event({ kind: 'budget', text: 'Free Cloudflare credits are used up for today. Using Claude until they reset at midnight UTC.' }));
    } else ev(t, 'note', `Cloudflare could not do this task (${short(e.message, 140)}). Switching to Claude.`);
    if (live && cap >= 0.05) return startLive(t, p, ws, agent, cap);
    setStatus(t, 'blocked', { question: 'Cloudflare could not do this task and Claude is not available to take over (not installed, or the budget is used up). Retry later or cancel.' });
  }
}

// Demo mode: no AI runs. It walks the same pipeline with clearly labelled placeholder output
// so the control room can be tried before agents are connected.
function startDemo(t, p, ws, agent) {
  const timers = [], run = { timers };
  running.set(t.id, run);
  const at = (ms, fn) => timers.push(setTimeout(() => { if (running.get(t.id) === run && t.status === 'running') fn(); }, ms));
  const files = V.readingList(ws.id, agent).slice(0, 3);
  files.forEach((f, i) => at(700 + i * 900, () => ev(t, 'read', 'Read vault note ' + V.noteIdFromPath(ws.id, f), { noteId: V.noteIdFromPath(ws.id, f) })));
  const base = 900 + files.length * 900;
  t.ranInDemo = true;
  at(base, () => ev(t, 'say', S.db.settings.mode === 'demo' ? 'Demo mode is switched on in Settings, so no AI agent ran.' : 'Demo mode: Claude Code was not found on this computer, so no AI agent ran. See Settings.', { demo: true }));
  if (agent.isLead) {
    const mates = ws.agents.filter(a => !a.isLead).slice(0, 2);
    mates.forEach((a, i) => at(base + 900 + i * 700, () => {
      S.db.tasks.push(Object.assign(newTask(p.id, a.id, `Demo task for ${a.name}`, 'Placeholder handed out by the Lead in demo mode.', 'lead'), { demo: true }));
      ev(t, 'handoff', `Handed work to ${a.name}`);
      S.changed();
    }));
    at(base + 2800, () => finish(t, p, { result: 'Demo: handed out two placeholder tasks.', cost: 0 }, run));
  } else {
    at(base + 1200, () => {
      const rel = path.join('deliverables', t.id + '.md');
      fs.mkdirSync(path.join(S.projectDir(p), 'deliverables'), { recursive: true });
      fs.writeFileSync(path.join(S.projectDir(p), rel), `# ${t.title}\n\nDEMO PLACEHOLDER. No AI agent ran, so no real work was done.\n\nWhy: the app could not find Claude Code on this computer. A Claude API key on its own is not enough; Claude Code must be installed too.\nFix: open Settings in the app and follow the checklist at the top, then press "Clear demo work".\n`);
      ev(t, 'tool', 'Wrote ' + t.id + '.md');
      S.db.reviews.push({ id: S.id('rv'), taskId: t.id, projectId: p.id, agentId: t.agentId, title: t.title,
        summary: 'Demo placeholder: Claude Code was not found on this computer, so no AI agent ran. Open Settings to fix it, then clear demo work.', files: [rel.split(path.sep).join('/')], status: 'pending', createdAt: S.now(), demo: true });
    });
    at(base + 2200, () => finish(t, p, { result: 'Demo placeholder. No real work was done.', cost: 0 }, run));
  }
}

function newTask(projectId, agentId, title, detail, createdBy) {
  return { id: S.id('tk'), projectId, agentId, title: short(title, 160), detail: String(detail || ''), status: 'queued',
    attempts: 0, feedback: [], costUsd: 0, createdBy: createdBy || 'owner', createdAt: S.now(), updatedAt: S.now() };
}

const notified = new Set();
function once(key, fn) { if (!notified.has(key)) { notified.add(key); fn(); } }

// Money already promised to tasks that are still running, so parallel tasks cannot overshoot a limit together.
const reserved = (filter) => S.db.tasks.filter(o => o.status === 'running' && filter(o)).reduce((a, o) => a + (o.reservedUsd || 0), 0);

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try { await tickOnce(); } finally { ticking = false; }
}
async function tickOnce() {
  const s = S.db.settings;
  const queued = S.db.tasks.filter(t => t.status === 'queued');
  if (!queued.length) return;
  const live = mode() === 'live';
  const capOn = s.nightlyCapUsd > 0;
  if (live && capOn && S.spentToday() >= s.nightlyCapUsd) {
    return once('night-' + S.now().slice(0, 10) + '-' + s.nightlyCapUsd, () => S.event({ kind: 'budget', text: `Daily spending cap of $${s.nightlyCapUsd} reached. Agents are paused until tomorrow or until you raise it in Settings.` }));
  }
  for (const t of queued) {
    if (running.size >= s.maxParallel) break;
    if (t.status !== 'queued' || running.has(t.id)) continue;
    const p = S.project(t.projectId);
    if (!p || p.paused) continue;
    const busy = S.db.tasks.some(o => o.id !== t.id && o.projectId === t.projectId && (o.status === 'checking' || (o.agentId === t.agentId && o.status === 'running')));
    if (busy) continue;
    const ws = S.workspace(p.workspace), agent = S.agentOf(p.workspace, t.agentId);
    if (!agent) { setStatus(t, 'blocked', { question: 'This agent no longer exists. Cancel the task.' }); continue; }
    let cap = 0;
    if (live) {
      if ((p.spentUsd || 0) >= p.budgetUsd) {
        once('budget-' + p.id + '-' + p.budgetUsd, () => S.event({ projectId: p.id, kind: 'budget', text: `${p.name} has used its $${p.budgetUsd} budget. Its agents are paused until you raise it.` }));
        continue;
      }
      const left = [PER_TASK_CAP, p.budgetUsd - (p.spentUsd || 0) - reserved(o => o.projectId === p.id)];
      if (capOn) left.push(s.nightlyCapUsd - S.spentToday() - reserved(() => true));
      cap = Math.min(...left);
      if (cap < 0.05) continue; // the rest of the budget is promised to tasks still running
    }
    fs.mkdirSync(S.projectDir(p), { recursive: true });
    if (ws.hasMarket && agent.id === 'pulse') {
      try { fs.writeFileSync(path.join(S.projectDir(p), 'market-data.json'), JSON.stringify(market.view(await market.get()), null, 1)); } catch {}
      if (t.status !== 'queued' || running.has(t.id)) continue;
    }
    t.attempts = (t.attempts || 0) + 1;
    t.reservedUsd = cap;
    setStatus(t, 'running', { startedAt: S.now(), question: undefined });
    ev(t, 'start', (t.attempts > 1 ? `Attempt ${t.attempts}: ` : 'Started: ') + t.title);
    const freeFirst = s.mode !== 'demo' && agent.writer && s.agentFreeFirst[ws.id + ':' + agent.id] && cfReady() && !cfUsedUp();
    if (freeFirst) startText(t, p, ws, agent, cap, live);
    else if (live) startLive(t, p, ws, agent, cap); else startDemo(t, p, ws, agent);
  }
}

function stop(t, sync) {
  const r = running.get(t.id);
  if (!r) return;
  running.delete(t.id);
  t.reservedUsd = 0;
  if (r.timers) r.timers.forEach(clearTimeout);
  if (r.abort) r.abort.abort();
  if (r.child && r.child.pid) kill(r.child.pid, sync);
}

function boot(p) {
  port = p;
  for (const t of S.db.tasks) if (t.status === 'running' || t.status === 'checking') { t.status = 'queued'; t.attempts = Math.max(0, (t.attempts || 1) - 1); }
  setInterval(() => tick().catch(e => console.error('runner:', e.message)), 1500);
}

// One tiny real request, so the owner can see whether Claude Code is installed and signed in (or using the saved key).
function testAgents() {
  return new Promise(resolve => {
    const c = detect(true);
    if (!c.found) return resolve({ ok: false, step: 'install', message: 'Claude Code was not found on this computer.' });
    const key = secrets.get('anthropic');
    // The cheapest model is enough to prove Claude Code is installed and signed in.
    const args = ['-p', '--output-format', 'json', '--max-budget-usd', '0.25', '--model', 'claude-haiku-5-5', '--allowedTools', 'Read'];
    let out = '', err = '', done = false;
    const end = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    try { child = spawnClaude(args, { cwd: os.tmpdir(), env: Object.assign({}, process.env, key ? { ANTHROPIC_API_KEY: key } : {}) }); }
    catch (e) { return resolve({ ok: false, step: 'run', message: 'Claude Code could not be started: ' + e.message }); }
    const timer = setTimeout(() => { kill(child.pid); const said = short(err || out, 300); end({ ok: false, step: 'run', message: 'Claude Code did not answer within 2 minutes.' + (said ? ' Last thing it printed: ' + said : ' It printed nothing.') }); }, 120000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err = (err + d).slice(-3000); });
    child.stdin.on('error', () => {});
    child.on('error', e => end({ ok: false, step: 'run', message: 'Claude Code could not be started: ' + e.message }));
    child.on('close', code => {
      let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch {}
      const why = j && !j.result && j.subtype ? ({ error_max_budget_usd: 'It stopped at the test spending limit before answering.', error_max_turns: 'It ran out of turns before answering.' }[j.subtype] || 'It stopped early (' + j.subtype + ').') : '';
      const text = short(why || (j && j.result) || err || out, 400);
      if (code === 0 && j && !j.is_error && j.result) return end({ ok: true, via: key ? 'your saved API key' : 'the Claude login on this computer', reply: short(j.result, 80), costUsd: Number(j.total_cost_usd) || 0 });
      const auth = /log ?in|auth|api key|credential|401|403|invalid.*key|unauthori/i.test(text);
      end({ ok: false, step: auth ? 'signin' : 'run', message: text || ('Claude Code exited with code ' + code) });
    });
    child.stdin.end('Reply with the single word: ready');
  });
}

// Removes what demo mode produced, so the owner starts clean once agents are live.
// Tasks the owner asked for go back to the queue (or wait, if agents are still not live); placeholder tasks are deleted.
function clearDemo() {
  const db = S.db, live = mode() === 'live';
  const isPlaceholderTask = (t) => t.demo || /^Demo task for /.test(t.title || '');
  const ranInDemo = (t) => t.ranInDemo || /^Demo/.test(t.result || '');
  const removeIds = new Set(db.tasks.filter(isPlaceholderTask).map(t => t.id));
  let requeued = 0;
  for (const t of db.tasks) {
    if (removeIds.has(t.id) || !ranInDemo(t) || ['running', 'checking'].includes(t.status)) continue;
    Object.assign(t, { status: live ? 'queued' : 'stopped', attempts: 0, result: undefined, ranInDemo: false, question: undefined, updatedAt: S.now() });
    requeued++;
  }
  const before = db.reviews.length;
  db.reviews = db.reviews.filter(r => !(r.demo || removeIds.has(r.taskId) || /^Demo placeholder/.test(r.summary || '')));
  const reviews = before - db.reviews.length;
  db.tasks = db.tasks.filter(t => !removeIds.has(t.id));
  db.events = db.events.filter(e => !(e.demo || removeIds.has(e.taskId) || (e.kind === 'say' && /^Demo mode/.test(e.text || ''))));
  S.changed();
  return { removedTasks: removeIds.size, removedReviews: reviews, requeued, live };
}

module.exports = { boot, stop, mode, newTask, ev, setStatus, liveAvailable, cliInfo, testAgents, clearDemo, running, cfReady, cfUsedUp, cfChat };
