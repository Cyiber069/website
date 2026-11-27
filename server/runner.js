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

const CLI = path.join(S.ROOT, 'cli.js');
const MAX_ATTEMPTS = 3;
const PER_TASK_CAP = 5;
const running = new Map(); // taskId -> run { child, timers }
const checkChain = new Map(); // projectId -> promise, so one project's checks never overlap
let port = 4600;
let cliFound = null;

function liveAvailable() {
  if (cliFound === null) {
    try { cliFound = spawnSync('claude', ['--version'], { shell: WIN, timeout: 15000 }).status === 0; }
    catch { cliFound = false; }
  }
  return cliFound;
}
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
    `COMMANDS (run them with the Bash tool, exactly as written):
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
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    '--max-budget-usd', cap.toFixed(2), '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', '--add-dir', V.VAULT_DIR];
  if (V.skillsDir(ws)) args.push('--add-dir', V.skillsDir(ws));
  if (s.model) args.push('--model', s.model);
  const child = spawn('claude', WIN ? args.map(a => /[\s&|<>^%()!,;=]/.test(a) ? `"${a}"` : a) : args, {
    cwd: S.projectDir(p), shell: WIN, windowsHide: true,
    env: Object.assign({}, process.env, { NIGHTSHIFT_URL: `http://127.0.0.1:${port}`, NIGHTSHIFT_TOKEN: s.token, NIGHTSHIFT_TASK: t.id }),
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

// Demo mode: no AI runs. It walks the same pipeline with clearly labelled placeholder output
// so the control room can be tried before agents are connected.
function startDemo(t, p, ws, agent) {
  const timers = [], run = { timers };
  running.set(t.id, run);
  const at = (ms, fn) => timers.push(setTimeout(() => { if (running.get(t.id) === run && t.status === 'running') fn(); }, ms));
  const files = V.readingList(ws.id, agent).slice(0, 3);
  files.forEach((f, i) => at(700 + i * 900, () => ev(t, 'read', 'Read vault note ' + V.noteIdFromPath(ws.id, f), { noteId: V.noteIdFromPath(ws.id, f) })));
  const base = 900 + files.length * 900;
  at(base, () => ev(t, 'say', 'Demo mode: walking through the steps without running an AI agent.'));
  if (agent.isLead) {
    const mates = ws.agents.filter(a => !a.isLead).slice(0, 2);
    mates.forEach((a, i) => at(base + 900 + i * 700, () => {
      S.db.tasks.push(newTask(p.id, a.id, `Demo task for ${a.name}`, 'Placeholder handed out by the Lead in demo mode.', 'lead'));
      ev(t, 'handoff', `Handed work to ${a.name}`);
      S.changed();
    }));
    at(base + 2800, () => finish(t, p, { result: 'Demo: handed out two placeholder tasks.', cost: 0 }, run));
  } else {
    at(base + 1200, () => {
      const rel = path.join('deliverables', t.id + '.md');
      fs.mkdirSync(path.join(S.projectDir(p), 'deliverables'), { recursive: true });
      fs.writeFileSync(path.join(S.projectDir(p), rel), `# ${t.title}\n\nDEMO OUTPUT. No AI agent ran, so this file is a placeholder.\nSwitch to live mode in Settings once Claude Code is installed on this computer.\n`);
      ev(t, 'tool', 'Wrote ' + t.id + '.md');
      S.db.reviews.push({ id: S.id('rv'), taskId: t.id, projectId: p.id, agentId: t.agentId, title: t.title,
        summary: 'Demo placeholder. No real work was done.', files: [rel.split(path.sep).join('/')], status: 'pending', createdAt: S.now() });
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
    if (live) startLive(t, p, ws, agent, cap); else startDemo(t, p, ws, agent);
  }
}

function stop(t, sync) {
  const r = running.get(t.id);
  if (!r) return;
  running.delete(t.id);
  t.reservedUsd = 0;
  if (r.timers) r.timers.forEach(clearTimeout);
  if (r.child && r.child.pid) kill(r.child.pid, sync);
}

function boot(p) {
  port = p;
  for (const t of S.db.tasks) if (t.status === 'running' || t.status === 'checking') { t.status = 'queued'; t.attempts = Math.max(0, (t.attempts || 1) - 1); }
  setInterval(() => tick().catch(e => console.error('runner:', e.message)), 1500);
}

module.exports = { boot, stop, mode, newTask, ev, setStatus, liveAvailable, running };
