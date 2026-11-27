/* Nightshift control room UI. Vanilla JS: state comes from /api/state, live updates over server-sent events. */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 45 ? 'now' : s < 3600 ? Math.round(s / 60) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
const ic = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  home: ic('<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  team: ic('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.5" cy="9" r="2.4"/><path d="M16 14.200c3 .2 5 2.5 5 5.8"/>'),
  tasks: ic('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>'),
  review: ic('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  projects: ic('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  vault: ic('<circle cx="12" cy="12" r="2"/><circle cx="5" cy="6" r="1.5"/><circle cx="19" cy="7" r="1.5"/><circle cx="6" cy="18" r="1.5"/><circle cx="18" cy="18" r="1.5"/><path d="M10.5 10.700L6.2 7M13.7 11l4-3.200M10.6 13.400L7 17M13.5 13.400l3.5 3.5"/>'),
  market: ic('<path d="M4 19V5M4 19h16M8 15v-4M12 15V8M16 15v-6"/>'),
  settings: ic('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.300l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.2-1.300L14 3h-4l-.4 2.400a7 7 0 0 0-2.2 1.300l-2.3-.9-2 3.4 2 1.500a7 7 0 0 0 0 2.600l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2.2 1.300L10 21h4l.4-2.400a7 7 0 0 0 2.2-1.300l2.3.9 2-3.4-2-1.500c.1-.4.1-.9.1-1.300z"/>'),
  more: ic('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'),
};

let ST = null, wsId = localStorage.getItem('ns_ws') || '', route = 'home', dirty = false;
let reviewTab = 'pending', marketSort = '', marketData = null, marketErr = '', galaxy = null, vaultGraph = null, openNote = null, access = null;
const ws = () => ST.workspaces.find(w => w.id === wsId) || ST.workspaces[0];
const agent = (id) => ws().agents.find(a => a.id === id) || { id, name: id || 'System', color: '#667085' };
const proj = (id) => ST.projects.find(p => p.id === id) || { name: 'Unknown project' };
const avatar = (a, cls = '') => `<span class="av ${cls}" style="--c:${a.color};background:${a.color}">${esc(a.name[0])}</span>`;

function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', err ? 5000 : 2400); }
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
const act = (fn) => fn().catch(e => toast(e.message, true));
async function load() {
  ST = await api('/api/state?ws=' + encodeURIComponent(wsId));
  if (!ST.workspaces.some(w => w.id === wsId)) wsId = ST.workspaces[0].id;
  if (route === 'market' && !ws().hasMarket) route = 'home';
  render();
}

/* ---------- counts shared by nav and home ---------- */
function counts() {
  const pending = ST.reviews.filter(r => r.status === 'pending');
  const blocked = ST.tasks.filter(t => t.status === 'blocked');
  const working = ST.tasks.filter(t => t.status === 'running' || t.status === 'checking');
  const pitches = ST.pitches.filter(p => p.status === 'new');
  return { pending, blocked, working, pitches, needs: pending.length + blocked.length + pitches.length };
}

/* ---------- shell ---------- */
function renderShell() {
  const w = ws(), c = counts();
  $('#wsBtn').innerHTML = `<span><b>${esc(w.name)}</b><small>${esc(w.tagline)}</small></span><span class="faint">⌄</span>`;
  $('#wsMenu').innerHTML = ST.workspaces.map(x => `<button data-ws="${x.id}" aria-current="${x.id === w.id}"><b>${esc(x.name)}</b> <span class="dim">· ${esc(x.tagline)}</span></button>`).join('');
  const items = [
    ['home', 'Home', c.needs ? `<span class="count hot">${c.needs}</span>` : ''],
    ['team', 'Team', c.working.length ? `<span class="count live">${c.working.length}</span>` : ''],
    ['tasks', 'Tasks', ''],
    ['review', 'Review', c.pending.length ? `<span class="count hot">${c.pending.length}</span>` : ''],
    ['projects', 'Projects', c.pitches.length ? `<span class="count">${c.pitches.length}</span>` : ''],
    ['vault', 'Brain', ''],
    ...(w.hasMarket ? [['market', 'Market', '']] : []),
    ['settings', 'Settings', ''],
  ];
  const link = ([id, label, badge]) => `<a href="#${id}" data-k="${id}" ${route === id ? 'aria-current="page"' : ''}><i class="chip">${ICON[id]}</i><span>${label}</span>${badge}</a>`;
  $('#nav').innerHTML = `<div class="group">Workspace</div>` + items.slice(0, 5).map(link).join('') + `<div class="group">Knowledge</div>` + items.slice(5).map(link).join('');
  const main = ['home', 'review', 'tasks', 'projects', 'vault'];
  $('#tabbar').innerHTML = items.filter(i => main.includes(i[0])).map(link).join('') + `<a href="#" data-k="more" data-act="more"><i class="chip">${ICON.more}</i><span>More</span></a>`;
  const live = ST.mode === 'live';
  $('#sideFoot').innerHTML = `<span class="pill ${live ? 'live' : 'demo'}"><span class="dot ${c.working.length ? 'pulse' : ''}"></span>${live ? 'Agents live' : 'Demo mode'}</span>
    <span>${c.working.length} working · ${money(ST.spentToday)} today</span>
    ${ST.settings.nightlyCapUsd ? `<div class="bar energy" title="Today's spending against your daily cap"><i style="width:${Math.min(100, 100 * ST.spentToday / ST.settings.nightlyCapUsd)}%"></i></div>` : ''}
    <div class="crew">${ws().agents.map(a => `<span class="av ${c.working.some(t => t.agentId === a.id) ? 'on' : ''}" style="--c:${a.color};background:${a.color}" title="${esc(a.name)}">${esc(a.name[0])}</span>`).join('')}</div>`;
}

function setTop(title, sub, actions = '') {
  const live = ST.mode === 'live';
  $('#top').innerHTML = `<div class="grow"><h1>${esc(title)}</h1><p>${sub}</p></div>
    ${live ? '' : '<a href="#settings" class="pill demo" title="No AI is running. Open Settings to see why.">Demo mode</a>'}${actions}`;
}

/* ---------- views ---------- */
function feedItem(e) {
  const a = agent(e.agentId);
  return `<li class="k-${e.kind}">${avatar(a)}<div><span class="who">${esc(a.name)}</span> <span class="faint">${e.projectId ? '· ' + esc(proj(e.projectId).name) : ''}</span><div class="what">${esc(e.text)}</div></div><time>${ago(e.ts)}</time></li>`;
}

function viewHome() {
  const c = counts(), s = ST.settings;
  setTop(`${ws().name}`, `${c.working.length} agent${c.working.length === 1 ? '' : 's'} working across ${ST.projects.length} project${ST.projects.length === 1 ? '' : 's'}`,
    `<button class="btn" data-act="newTask">New task</button><button class="btn primary" data-act="newProject">New project</button>`);
  if (!ST.projects.length) return `<div class="card"><div class="empty" style="padding:56px 20px"><b style="font-size:17px">Nothing running yet</b>
    Create a project, write a short brief, and the Lead will break it into tasks for the team.<br><br><button class="btn primary" data-act="newProject">Start the first project</button></div></div>`;
  const needs = [
    ...c.blocked.map(t => `<div class="need"><div class="row">${avatar(agent(t.agentId))}<div class="grow"><b>${esc(t.title)}</b><div class="dim">${esc(agent(t.agentId).name)} · ${esc(proj(t.projectId).name)}</div></div></div>
      <div>${esc(t.question || 'This task is waiting on you.')}</div><div class="row"><button class="btn small primary" data-act="reply" data-id="${t.id}">Reply</button><button class="btn small" data-act="taskAct" data-do="retry" data-id="${t.id}">Retry as is</button><button class="btn small ghost" data-act="taskAct" data-do="cancel" data-id="${t.id}">Cancel task</button></div></div>`),
    ...c.pending.slice(0, 6).map(r => `<div class="need"><div class="row">${avatar(agent(r.agentId))}<div class="grow"><b>${esc(r.title)}</b><div class="dim">${esc(agent(r.agentId).name)} finished this · ${esc(proj(r.projectId).name)}</div></div><button class="btn small primary" data-act="openReview" data-id="${r.id}">Review</button></div></div>`),
    ...c.pitches.map(p => `<div class="need"><div class="row">${avatar(agent(p.agentId))}<div class="grow"><b>Pitch: ${esc(p.title)}</b><div class="dim">from ${esc(agent(p.agentId).name)}</div></div><a class="btn small" href="#projects">Read</a></div></div>`),
  ];
  const events = ST.events.slice(-80).reverse();
  return `<div class="grid">
    <div class="stats">
      <div class="stat ${c.needs ? 'hot' : ''}" data-k="needs"><b>${c.needs}</b><span>Needs you</span></div>
      <div class="stat" data-k="working"><b>${c.working.length}</b><span>Agents working</span></div>
      <div class="stat" data-k="queued"><b>${ST.tasks.filter(t => t.status === 'queued').length}</b><span>Tasks queued</span></div>
      <div class="stat" data-k="spent"><b>${money(ST.spentToday)}</b><span>Spent today${s.nightlyCapUsd ? ' of ' + money(s.nightlyCapUsd) + ' cap' : ''}</span></div>
    </div>
    <div class="grid cols">
      <div class="grid">
        <div class="card"><header><h2 class="grow">Needs you</h2><span class="count ${c.needs ? 'hot' : ''}">${c.needs}</span></header>
          ${needs.length ? needs.join('') : '<div class="empty"><b>All clear</b>Nothing is waiting on you.</div>'}</div>
        <div class="card"><header><h2 class="grow">What's happening</h2>${c.working.length ? '<span class="pill live"><span class="dot pulse"></span>live</span>' : ''}</header>
          ${events.length ? `<ul class="feed">${events.map(feedItem).join('')}</ul>` : '<div class="empty">Activity shows up here as agents work.</div>'}</div>
      </div>
      <div class="card"><header><h2 class="grow">Projects</h2><a class="btn small ghost" href="#projects">Manage</a></header>${ST.projects.map(projRow).join('')}</div>
    </div></div>`;
}

function projRow(p) {
  const open = ST.tasks.filter(t => t.projectId === p.id && ['queued', 'running', 'checking'].includes(t.status)).length;
  const pct = p.budgetUsd ? Math.min(100, 100 * (p.spentUsd || 0) / p.budgetUsd) : 0;
  const over = p.budgetUsd && (p.spentUsd || 0) >= p.budgetUsd;
  return `<div class="proj"><div class="row"><b class="grow">${esc(p.name)}</b>${p.paused ? '<span class="pill">Paused</span>' : over ? '<span class="pill bad">Budget used</span>' : open ? `<span class="pill live"><span class="dot"></span>${open} open</span>` : '<span class="pill">Idle</span>'}</div>
    <div class="bar ${over ? 'over' : ''}"><i style="width:${pct}%"></i></div>
    <div class="row dim num" style="font-size:12.5px"><span class="grow">${money(p.spentUsd)} of ${money(p.budgetUsd)} budget</span>
    <button class="btn small ghost" data-act="pause" data-id="${p.id}">${p.paused ? 'Resume' : 'Pause'}</button><button class="btn small ghost" data-act="editProject" data-id="${p.id}">Edit</button></div></div>`;
}

function viewTeam() {
  setTop('Team', `${ws().agents.length} specialists. Each reads its vault chapters and its own lessons before every task.`, `<button class="btn primary" data-act="newTask">New task</button>`);
  return `<div class="team">${ws().agents.map(a => {
    const mine = ST.tasks.filter(t => t.agentId === a.id);
    const now = mine.filter(t => t.status === 'running' || t.status === 'checking');
    const done = mine.filter(t => t.status === 'done').length, q = mine.filter(t => t.status === 'queued').length;
    return `<div class="agent"><div class="row">${avatar(a, 'lg')}<div class="grow"><h3>${esc(a.name)}</h3><span class="dim" style="font-size:12.5px">${done} done · ${q} queued</span></div>
      ${now.length ? '<span class="pill live"><span class="dot pulse"></span>Working</span>' : '<span class="pill">Idle</span>'}</div>
      <p>${esc(a.role)}</p>
      <div class="row wrap">${(a.reads || []).map(r => `<span class="pill">${esc(r.replace(/^\d+-/, '').replace(/-/g, ' '))}</span>`).join('')}</div>
      <div class="now">${now.length ? now.map(t => `<div><b>${esc(t.title)}</b> <span class="dim">· ${esc(proj(t.projectId).name)}</span></div>`).join('') : '<span class="dim">Waiting for work</span>'}</div>
      <div><button class="btn small" data-act="newTask" data-agent="${a.id}">Give ${esc(a.name)} a task</button></div></div>`;
  }).join('')}</div>`;
}

const STATUS = { queued: 'Queued', running: 'Working', checking: 'Running checks', review: 'In review', blocked: 'Needs you', done: 'Done', failed: 'Closed', stopped: 'Stopped' };
function taskCard(t) {
  const a = agent(t.agentId);
  const btn = (label, d, cls = '') => `<button class="btn small ${cls}" data-act="taskAct" data-do="${d}" data-id="${t.id}">${label}</button>`;
  const actions = t.status === 'running' || t.status === 'checking' ? btn('Stop', 'stop')
    : t.status === 'queued' ? btn('Cancel', 'cancel', 'ghost')
    : t.status === 'blocked' ? `<button class="btn small primary" data-act="reply" data-id="${t.id}">Reply</button>` + btn('Cancel', 'cancel', 'ghost')
    : t.status === 'review' ? `<a class="btn small" href="#review">Open review</a>`
    : t.status === 'failed' || t.status === 'stopped' ? btn('Run again', 'retry') : '';
  return `<div class="tcard"><div class="t">${esc(t.title)}</div>
    <div class="meta">${avatar(a)}<span>${esc(a.name)}</span><span>· ${esc(proj(t.projectId).name)}</span></div>
    <div class="meta"><span class="pill ${t.status === 'running' ? 'live' : t.status === 'blocked' ? 'demo' : ''}">${t.status === 'running' ? '<span class="dot pulse"></span>' : ''}${STATUS[t.status] || t.status}</span>
      ${t.attempts > 1 ? `<span>attempt ${t.attempts}</span>` : ''}${t.costUsd ? `<span class="num">${money(t.costUsd)}</span>` : ''}<span>${ago(t.updatedAt)}</span></div>
    ${t.status === 'blocked' && t.question ? `<div class="dim">${esc(t.question)}</div>` : ''}
    ${actions ? `<div class="row wrap">${actions}</div>` : ''}</div>`;
}
function viewTasks() {
  setTop('Tasks', 'Everything the team has been asked to do, and where each one stands.', `<button class="btn primary" data-act="newTask">New task</button>`);
  const by = (...s) => ST.tasks.filter(t => s.includes(t.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const cols = [['Queued', by('queued').reverse()], ['Working', by('running', 'checking')], ['Waiting on you', by('blocked', 'review')], ['Closed', by('done', 'failed', 'stopped').slice(0, 40)]];
  return `<div class="board">${cols.map(([name, list], i) => `<div class="col" data-k="${i}"><header><h2 class="grow">${name}</h2><span class="count">${list.length}</span></header>
    ${list.length ? list.map(taskCard).join('') : '<div class="empty">Empty</div>'}</div>`).join('')}</div>`;
}

const IMG = /\.(png|jpe?g|gif|webp|svg)$/i, VID = /\.(mp4|webm)$/i;
const fileUrl = (r, f) => `/api/file?project=${r.projectId}&path=${encodeURIComponent(f)}`;
function viewReview() {
  const tabs = [['pending', 'To review'], ['changes', 'Changes asked'], ['approved', 'Approved'], ['rejected', 'Rejected']];
  const n = (s) => ST.reviews.filter(r => r.status === s).length;
  setTop('Review', 'What the agents made for you. Approve it, ask for changes, or reject it. Your notes become lessons the agent reads next time.');
  const list = ST.reviews.filter(r => r.status === reviewTab).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return `<div class="tabs" role="tablist">${tabs.map(([id, l]) => `<button role="tab" aria-selected="${reviewTab === id}" data-act="rtab" data-id="${id}">${l} <span class="faint num">${n(id)}</span></button>`).join('')}</div>
    ${list.length ? `<div class="reviews">${list.map(r => {
      const a = agent(r.agentId), img = (r.files || []).find(f => IMG.test(f));
      return `<button class="rv" data-act="openReview" data-id="${r.id}"><div class="thumb">${img ? `<img src="${fileUrl(r, img)}" alt="" loading="lazy">` : `<pre>${esc((r.summary || '').slice(0, 420))}</pre>`}</div>
        <div class="info"><div class="row">${avatar(a)}<b class="grow">${esc(r.title)}</b></div><p>${esc(r.summary)}</p>
        <div class="row dim" style="font-size:12.5px"><span class="grow">${esc(a.name)} · ${esc(proj(r.projectId).name)}</span><span>${(r.files || []).length} file${(r.files || []).length === 1 ? '' : 's'} · ${ago(r.createdAt)}</span></div></div></button>`;
    }).join('')}</div>` : `<div class="card" style="margin-top:14px"><div class="empty"><b>${reviewTab === 'pending' ? 'All caught up' : 'Nothing here'}</b>${reviewTab === 'pending' ? 'Finished work lands here for your verdict.' : ''}</div></div>`}`;
}

function viewProjects() {
  setTop('Projects', 'Each project has a brief, a spending budget, and optional quality checks that must pass before work reaches you.', `<button class="btn primary" data-act="newProject">New project</button>`);
  const pitches = ST.pitches.filter(p => p.status === 'new');
  return `<div class="grid cols">
    <div class="card"><header><h2>Projects</h2></header>${ST.projects.length ? ST.projects.map(p => projRow(p) + `<div class="proj" style="padding-top:0"><div class="dim summary">${esc((p.brief || 'No brief yet.').slice(0, 400))}</div>
      ${(p.checks || []).length ? `<div class="row wrap">${p.checks.map(c => `<span class="pill mono">${esc(c)}</span>`).join('')}</div>` : ''}</div>`).join('') : '<div class="empty"><b>No projects yet</b>Create one to put the team to work.</div>'}</div>
    <div class="card"><header><h2 class="grow">Pitches</h2><span class="count">${pitches.length}</span></header>
      ${pitches.length ? pitches.map(p => `<div class="need"><div class="row">${avatar(agent(p.agentId))}<b class="grow">${esc(p.title)}</b><span class="faint">${ago(p.createdAt)}</span></div><div class="summary dim">${esc(p.body)}</div>
        <div class="row"><button class="btn small primary" data-act="pitch" data-do="start" data-id="${p.id}">Start this project</button><button class="btn small ghost" data-act="pitch" data-do="dismiss" data-id="${p.id}">Dismiss</button></div></div>`).join('')
      : `<div class="empty"><b>No pitches waiting</b>${ws().hasMarket ? 'Give Pulse a task like "Pitch three games from today\'s market data" and ideas will show up here.' : 'Agents can pitch new projects; they show up here.'}</div>`}</div></div>`;
}

function viewMarket() {
  setTop('Market', marketData ? `Live player counts from Roblox's public charts, fetched ${ago(new Date(marketData.fetchedAt).toISOString())} ago.${marketData.comparedTo ? ' Change is versus ' + new Date(marketData.comparedTo).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.' : ' Change appears after the next refresh.'}`.replace('now ago', 'just now') : 'Live data from Roblox\'s public charts.',
    `<button class="btn" data-act="marketRefresh">Refresh</button>`);
  if (marketErr) return `<div class="card"><div class="empty"><b>Could not load the charts</b>${esc(marketErr)}</div></div>`;
  if (!marketData) { loadMarket(); return `<div class="card"><div class="empty">Loading charts…</div></div>`; }
  const sort = marketData.sorts.find(s => s.id === marketSort) || marketData.sorts[0];
  if (!sort) return `<div class="card"><div class="empty">Roblox returned no charts.</div></div>`;
  return `<div class="tabs" role="tablist">${marketData.sorts.map(s => `<button role="tab" aria-selected="${s.id === sort.id}" data-act="msort" data-id="${esc(s.id)}">${esc(s.name)}</button>`).join('')}</div>
    <div class="card" style="margin-top:14px"><div class="tablewrap"><table><thead><tr><th class="r">#</th><th>Game</th><th>Genre</th><th class="r">Playing now</th><th class="r">Change</th><th class="r">Likes</th></tr></thead><tbody>
    ${sort.games.map(g => `<tr><td class="r faint">${g.rank}</td><td><a href="https://www.roblox.com/games/${g.placeId}" target="_blank" rel="noopener" style="color:inherit">${esc(g.name)}</a></td><td class="dim">${esc(g.genre)}</td>
      <td class="r">${g.players.toLocaleString()}</td><td class="r ${g.change > 0 ? 'up' : g.change < 0 ? 'down' : 'faint'}">${g.change === null ? '–' : (g.change > 0 ? '+' : '') + g.change.toLocaleString()}</td><td class="r dim">${g.likePct === null ? '–' : g.likePct + '%'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}
async function loadMarket(refresh) {
  try { marketData = await api('/api/market' + (refresh ? '?refresh=1' : '')); marketErr = ''; }
  catch (e) { marketErr = e.message; }
  if (route === 'market') render(true);
}

function viewSettings() {
  const s = ST.settings;
  setTop('Settings', 'How the agents run and how much they may spend.');
  if (!access) api('/api/access').then(a => { access = a; if (route === 'settings') render(true); }).catch(() => { access = { remote: true }; if (route === 'settings') render(true); });
  return `<div class="grid cols">
    <form class="card" data-form="settings"><header><h2>Agents</h2></header><div class="body grid">
      <div class="row wrap"><span class="pill ${ST.mode === 'live' ? 'live' : 'demo'}"><span class="dot"></span>${ST.mode === 'live' ? 'Live' : 'Demo mode'}</span>
        <span class="dim">${ST.liveAvailable ? 'Claude Code is installed on this computer, so agents can do real work.' : 'Claude Code was not found on this computer, so tasks only produce labelled placeholders. Install it and sign in, then restart Nightshift.'}</span></div>
      <label>Mode<select name="mode"><option value="auto" ${s.mode === 'auto' ? 'selected' : ''}>Live when Claude Code is available</option><option value="demo" ${s.mode === 'demo' ? 'selected' : ''}>Always demo (no AI, no cost)</option></select></label>
      <div class="two"><label>Agents working at once<input name="maxParallel" type="number" min="1" max="8" value="${s.maxParallel}"></label>
      <label>Daily spending cap (USD)<input name="nightlyCapUsd" type="number" min="0" step="1" value="${s.nightlyCapUsd}"></label></div>
      <label>Model (leave empty for your Claude Code default)<input name="model" value="${esc(s.model)}" placeholder="for example: sonnet"></label>
      <p class="dim" style="margin:0">Spending is what Claude Code reports per task. On a Claude subscription it is an equivalent estimate, not a charge. When a project or the daily cap runs out, agents stop until you raise it.</p>
      <div class="actions"><button class="btn primary">Save</button></div></div></form>
    <div class="card"><header><h2>Use it from your phone</h2></header><div class="body grid">
      ${!access ? '<span class="dim">Checking…</span>' : access.remote ? '<span class="dim">You are already connected remotely.</span>'
      : access.lan ? `<span class="dim">Phone access is on. With your phone on the same Wi-Fi, open one of these links (they contain your private access key, so do not share them):</span>${access.urls.map(u => `<input readonly value="${esc(u)}" onclick="this.select()">`).join('') || '<span class="dim">No network address found.</span>'}`
      : `<span class="dim">Phone access is off: the app only answers on this computer. To turn it on, close it and start it with <span class="mono">npm run phone</span>. This page will then show the link to open on your phone.</span>`}
    </div></div></div>`;
}

/* ---------- vault ---------- */
function md(text) {
  // One pass over the raw text: every captured piece is escaped on its own, so generated tags are never re-scanned.
  const TOKEN = /`([^`]+)`|\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s][^*]*)\*(?![\w*])/g;
  const inline = (s) => {
    let out = '', last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(s))) {
      out += esc(s.slice(last, m.index)); last = m.index + m[0].length;
      if (m[1] !== undefined) out += `<code>${esc(m[1])}</code>`;
      else if (m[2] !== undefined) out += `<button class="wl" data-act="wl" data-title="${esc(m[2].trim())}">${esc(m[3] || m[2])}</button>`;
      else if (m[4] !== undefined) out += `<a href="${esc(m[5])}" target="_blank" rel="noopener noreferrer">${esc(m[4])}</a>`;
      else if (m[6] !== undefined) out += `<b>${esc(m[6])}</b>`;
      else out += `<i>${esc(m[7])}</i>`;
    }
    return out + esc(s.slice(last));
  };
  const out = []; const lines = text.replace(/\r/g, '').split('\n'); let i = 0, list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { closeList(); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue; }
    if (/^\|.*\|\s*$/.test(l) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      closeList(); const row = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      const head = row(l); i += 2; const rows = []; while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue;
    }
    let m;
    if ((m = /^(#{1,4})\s+(.*)/.exec(l))) { closeList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = /^>\s?(.*)/.exec(l))) { closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
    else if ((m = /^\s*[-*]\s+(.*)/.exec(l))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1].replace(/^\[( |x)\]\s*/, (a, b) => b === 'x' ? '☑ ' : '☐ '))}</li>`); }
    else if ((m = /^\s*\d+\.\s+(.*)/.exec(l))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!l.trim()) closeList();
    else { closeList(); out.push(`<p>${inline(l)}</p>`); }
    i++;
  }
  closeList(); return out.join('');
}
async function mountVault() {
  const v = $('#view');
  v.innerHTML = `<canvas id="galaxy" aria-label="Map of the vault. Drag to rotate, scroll to zoom, select a star to read the note."></canvas><div class="vault-hud" id="vhud"></div><div class="legend" id="vlegend"></div><div id="vreader"></div>`;
  galaxy = Galaxy($('#galaxy'), { onSelect: (id, rule) => id ? showNote(id, rule) : closeNote() });
  try { vaultGraph = await api('/api/vault?ws=' + wsId); } catch { vaultGraph = { nodes: [], edges: [], words: 0 }; }
  if (route !== 'vault' || !galaxy) return;
  galaxy.setData(vaultGraph);
  const notes = vaultGraph.nodes.filter(n => n.kind !== 'idea');
  $('#vhud').innerHTML = vaultGraph.nodes.length ? `<h1>The brain</h1><p>${vaultGraph.ideas ? vaultGraph.ideas.toLocaleString() + ' ideas across ' : ''}${notes.length} notes, ${vaultGraph.words.toLocaleString()} words. A signal fires from the core when an agent reads a note.</p>`
    : `<h1>The vault is empty</h1><p>Add markdown notes under vault/${esc(wsId)}/ and they appear here.</p>`;
  if (vaultGraph.nodes.length) {
    const groups = {};
    for (const n of notes) { const g = n.skill ? 'Skill library' : n.chapterName; (groups[g] = groups[g] || []).push(n); }
    $('#vhud').innerHTML += `<label class="notepick">Open a note<select id="vpick"><option value="">Choose a note…</option>${Object.keys(groups).sort().map(g =>
      `<optgroup label="${esc(g)}">${groups[g].sort((a, b) => b.isIndex - a.isIndex || a.title.localeCompare(b.title)).map(n => `<option value="${esc(n.id)}">${esc(n.title)}</option>`).join('')}</optgroup>`).join('')}</select></label>`;
    $('#vpick').onchange = (e) => e.target.value && showNote(e.target.value);
  }
  $('#vlegend').innerHTML = galaxy.chapters().map(c => `<button data-act="vfocus" data-id="${esc(c.id)}"><span class="dot" style="color:${c.color}"></span>${esc(c.name)}${c.ideas ? ` <span class="faint num">${c.ideas}</span>` : ''}</button>`).join('');
  if (openNote) showNote(openNote);
}
async function showNote(id, rule) {
  openNote = id; galaxy && galaxy.select(rule ? id + '#' + rule : id);
  try {
    const { text } = await api(`/api/vault/note?ws=${wsId}&id=${encodeURIComponent(id)}`);
    if (route !== 'vault') return;
    $('#vreader').innerHTML = `<div class="reader"><button class="btn small close" data-act="closeNote">Close</button><div class="faint mono">${esc(id)}</div><div class="md">${md(text)}</div></div>`;
    if (rule) { // jump to the rule that was clicked on the map
      const h = [...document.querySelectorAll('.reader .md h2')].find(x => /^rules/i.test(x.textContent)), ol = h ? h.nextElementSibling : $('.reader .md ol');
      const li = ol && ol.tagName === 'OL' && ol.children[rule - 1];
      if (li) { li.classList.add('hl'); li.scrollIntoView({ block: 'center' }); }
    }
  } catch (e) { toast(e.message, true); }
}
function closeNote() { openNote = null; const r = $('#vreader'); if (r) r.innerHTML = ''; galaxy && galaxy.select(null); }

/* ---------- render ---------- */
const VIEWS = { home: viewHome, team: viewTeam, tasks: viewTasks, review: viewReview, projects: viewProjects, market: viewMarket, settings: viewSettings };
function render(force) {
  if (!ST) return;
  renderShell();
  const v = $('#view');
  if (route === 'vault') {
    setTop('Brain', 'Everything the team knows. Agents read their part before each task; your review notes are added as lessons.');
    v.classList.add('flush');
    if (!galaxy) mountVault();
    return;
  }
  if (galaxy) { galaxy.destroy(); galaxy = null; v._html = null; }
  v.classList.remove('flush');
  const f = document.activeElement;
  if (!force && route === 'settings' && $('[data-form=settings]', v)) return; // never rebuild a form the owner may be editing
  if (!force && f && v.contains(f) && /INPUT|TEXTAREA|SELECT/.test(f.tagName)) { dirty = true; return; }
  const html = (VIEWS[route] || viewHome)();
  dirty = false;
  if (html === v._html && v._route === route) return; // nothing changed: keep focus, scroll and loaded images
  const y = v.scrollTop, feed = $('.feed', v), fy = feed ? feed.scrollTop : 0;
  v.innerHTML = html; v._html = html; v._route = route;
  v.scrollTop = y; const nf = $('.feed', v); if (nf) nf.scrollTop = fy;
}
function go() {
  const r = location.hash.slice(1) || 'home';
  route = VIEWS[r] || r === 'vault' ? r : 'home';
  if (ST && route === 'market' && !ws().hasMarket) route = 'home';
  if (ST) { render(true); $('#view').scrollTop = 0; }
}

/* ---------- dialogs ---------- */
const dlg = $('#dlg');
function dialog(html, onSubmit) {
  dlg.innerHTML = html;
  const form = $('form', dlg);
  let busy = false;
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    const d = Object.fromEntries(new FormData(form)), buttons = [...form.querySelectorAll('button')];
    buttons.forEach(b => b.disabled = true);
    let err = $('.formerr', form); if (err) err.remove();
    try { if (await onSubmit(d, e.submitter) !== false) dlg.close(); }
    catch (ex) { // errors are shown inside the dialog, where the owner is looking
      err = document.createElement('p'); err.className = 'formerr'; err.setAttribute('role', 'alert'); err.textContent = ex.message;
      ($('.actions', form) || form.lastElementChild).before(err);
    } finally { busy = false; buttons.forEach(b => b.disabled = false); }
  };
  if (!dlg.open) dlg.showModal();
  const h = $('h2', dlg); if (h) { h.tabIndex = -1; h.id = 'dlgTitle'; dlg.setAttribute('aria-labelledby', 'dlgTitle'); h.focus(); }
}
let downOnBackdrop = false;
dlg.addEventListener('pointerdown', e => { downOnBackdrop = e.target === dlg; });
dlg.addEventListener('click', e => { if ((e.target === dlg && downOnBackdrop) || e.target.dataset.close !== undefined) dlg.close(); });

function newProject() {
  const rb = wsId === 'roblox';
  dialog(`<form><h2>New project</h2>
    <label>Name<input name="name" required maxlength="80" placeholder="${rb ? 'Lava Mountain Climb' : 'Spring launch campaign'}"></label>
    <label>Brief: what is it, who is it for, and what does a good first version look like?<textarea name="brief" rows="6" required></textarea></label>
    <div class="two"><label>Budget (USD)<input name="budgetUsd" type="number" min="1" step="1" value="10" required></label>
    <label>Quality checks, one command per line (optional)<textarea name="checks" rows="2" placeholder="${rb ? 'rojo build -o build.rbxlx' : ''}" style="min-height:58px" class="mono"></textarea></label></div>
    <p class="dim" style="margin:0">The Lead starts planning as soon as you create it. Checks run in the project folder after every task; work that fails goes back to the agent instead of to you.</p>
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create and start</button></div></form>`,
    async (d) => { await api('/api/projects', { workspace: wsId, name: d.name, brief: d.brief, budgetUsd: d.budgetUsd, checks: d.checks.split('\n').map(s => s.trim()).filter(Boolean) }); toast('Project created. The Lead is planning.'); });
}
function editProject(id) {
  const p = proj(id);
  dialog(`<form><h2>${esc(p.name)}</h2>
    <label>Brief<textarea name="brief" rows="7">${esc(p.brief)}</textarea></label>
    <div class="two"><label>Budget (USD), ${money(p.spentUsd)} used so far<input name="budgetUsd" type="number" min="0" step="1" value="${p.budgetUsd}"></label>
    <label>Quality checks, one command per line<textarea name="checks" rows="2" class="mono" style="min-height:58px">${esc((p.checks || []).join('\n'))}</textarea></label></div>
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
    async (d) => { await api('/api/projects/' + id, { brief: d.brief, budgetUsd: d.budgetUsd, checks: d.checks.split('\n').map(s => s.trim()).filter(Boolean) }); toast('Saved'); });
}
function newTask(agentId) {
  if (!ST.projects.length) return newProject();
  dialog(`<form><h2>New task</h2>
    <div class="two"><label>Project<select name="projectId">${ST.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
    <label>Agent<select name="agentId">${ws().agents.map(a => `<option value="${a.id}" ${a.id === agentId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label></div>
    <label>What should they do?<input name="title" required maxlength="160"></label>
    <label>Details (optional)<textarea name="detail" rows="5"></textarea></label>
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Add to queue</button></div></form>`,
    async (d) => { await api('/api/tasks', d); toast('Task queued'); });
}
function reply(id) {
  const t = ST.tasks.find(x => x.id === id); if (!t) return;
  dialog(`<form><h2>${esc(t.title)}</h2><div class="summary">${esc(t.question || '')}</div>
    <label>Your answer. The agent restarts the task with it.<textarea name="note" rows="4" required></textarea></label>
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Send and restart</button></div></form>`,
    async (d) => { await api(`/api/tasks/${id}/action`, { action: 'reply', note: d.note }); toast('Sent'); });
}
let opening = false;
async function openReview(id) {
  if (opening) return;
  opening = true;
  try { await openReviewNow(id); } finally { opening = false; }
}
async function openReviewNow(id) {
  const r = ST.reviews.find(x => x.id === id); if (!r) return;
  const a = agent(r.agentId), pending = r.status === 'pending';
  const previews = await Promise.all((r.files || []).map(async f => {
    const u = fileUrl(r, f), name = `<div class="fname">${esc(f)}</div>`;
    if (IMG.test(f)) return `<div class="preview">${name}<img src="${u}" alt="${esc(f)}"></div>`;
    if (VID.test(f)) return `<div class="preview">${name}<video src="${u}" controls></video></div>`;
    const t = await fetch(u).then(x => x.ok ? x.text() : 'This file could not be opened.').catch(() => 'This file could not be opened.');
    return `<div class="preview">${name}<pre>${esc(t.slice(0, 30000))}${t.length > 30000 ? '\n… (cut for length)' : ''}</pre></div>`;
  }));
  dialog(`<form><div class="row">${avatar(a, 'lg')}<div class="grow"><h2>${esc(r.title)}</h2><span class="dim">${esc(a.name)} · ${esc(proj(r.projectId).name)} · ${ago(r.createdAt)}</span></div></div>
    <div class="summary">${esc(r.summary)}</div>${previews.join('')}
    ${pending ? `<label>Note for the agent (required to ask for changes or reject; saved as a lesson)<textarea name="note" rows="3"></textarea></label>
    <div class="actions"><button class="btn bad" value="reject">Reject</button><button class="btn" value="polish">Polish</button><button class="btn" value="changes">Ask for changes</button><button class="btn good" value="approve">Approve</button></div>`
    : `${r.note ? `<blockquote class="dim" style="margin:0">Your note: ${esc(r.note)}</blockquote>` : ''}<div class="actions"><button type="button" class="btn" data-close>Close</button></div>`}</form>`,
    async (d, btn) => { await api(`/api/reviews/${id}/action`, { action: btn.value, note: d.note }); toast({ approve: 'Approved', changes: 'Sent back with your note', polish: 'Sent back for polish', reject: 'Rejected and lesson saved' }[btn.value]); });
}
function more() {
  const w = ws();
  dialog(`<div class="dbody"><h2>${esc(w.name)}</h2>
    ${ST.workspaces.filter(x => x.id !== w.id).map(x => `<button class="btn" data-ws="${x.id}" data-close>Switch to ${esc(x.name)}</button>`).join('')}
    <a class="btn" href="#team" data-close>Team</a>${w.hasMarket ? '<a class="btn" href="#market" data-close>Market</a>' : ''}<a class="btn" href="#settings" data-close>Settings</a></div>`);
}

/* ---------- events ---------- */
function switchWs(id) { wsId = id; localStorage.setItem('ns_ws', id); $('#wsMenu').hidden = true; if (galaxy) { galaxy.destroy(); galaxy = null; } openNote = null; marketData = null; act(load); }
document.addEventListener('click', (e) => {
  const w = e.target.closest('[data-ws]'); if (w) return switchWs(w.dataset.ws);
  if (e.target.closest('#wsBtn')) { $('#wsMenu').hidden = !$('#wsMenu').hidden; return; }
  $('#wsMenu').hidden = true;
  const el = e.target.closest('[data-act]'); if (!el) return;
  const { act: a, id } = el.dataset;
  if (a === 'more') { e.preventDefault(); more(); }
  else if (a === 'newProject') newProject();
  else if (a === 'editProject') editProject(id);
  else if (a === 'newTask') newTask(el.dataset.agent);
  else if (a === 'reply') reply(id);
  else if (a === 'openReview') { e.preventDefault(); act(() => openReview(id)); }
  else if (a === 'rtab') { reviewTab = id; render(true); }
  else if (a === 'msort') { marketSort = id; render(true); }
  else if (a === 'marketRefresh') { marketData = null; marketErr = ''; render(true); loadMarket(true); }
  else if (a === 'pause') act(() => api('/api/projects/' + id, { paused: !proj(id).paused }));
  else if (a === 'taskAct') act(() => api(`/api/tasks/${id}/action`, { action: el.dataset.do }));
  else if (a === 'pitch') act(() => api(`/api/pitches/${id}/action`, { action: el.dataset.do }));
  else if (a === 'closeNote') closeNote();
  else if (a === 'vfocus') galaxy && galaxy.focus(id);
  else if (a === 'wl') { const n = vaultGraph && vaultGraph.nodes.find(n => n.title.toLowerCase() === el.dataset.title.toLowerCase()); n ? showNote(n.id) : toast('That note does not exist yet', true); }
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-form=settings]'); if (!f) return;
  e.preventDefault();
  act(async () => { await api('/api/settings', Object.fromEntries(new FormData(f))); toast('Saved'); await load(); render(true); });
});
document.addEventListener('focusout', () => setTimeout(() => { if (dirty) render(); }, 0));
window.addEventListener('hashchange', go);

let reload = 0;
function connect() {
  const es = new EventSource('/api/stream');
  const bump = () => { clearTimeout(reload); reload = setTimeout(() => act(load), 200); };
  es.addEventListener('state', bump);
  es.addEventListener('event', (m) => {
    bump();
    try { const ev = JSON.parse(m.data); if (galaxy && ev.noteId) { const a = agent(ev.agentId); galaxy.pulse(ev.noteId, a.color, a.name); } } catch {}
  });
  es.onopen = () => act(load);
}
go(); act(load).then(connect);
