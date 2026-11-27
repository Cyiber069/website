#!/usr/bin/env node
// Builds a view-only demo copy of the app that runs without the server, for sharing as a link.
//   node scripts/build-demo.js [outDir]      (default: demo-build/)
// Writes:
//   index.html       the page (no <html>/<body> wrapper: the artifact host adds one)
//   demo-data.json   example state, the vault and skill notes, live market snapshot (one record per line)
//   preview.html     the same page wrapped in a full HTML document, for checking locally
// Everything shown is example data, clearly labelled on the page. Nothing in the demo runs agents or saves changes.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'demo-build'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rgf-demo-'));
process.env.NIGHTSHIFT_DATA = TMP;

const NOW = Date.now();
const at = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
let seq = 0;
const id = (p) => `${p}_demo${String(++seq).padStart(4, '0')}`;

/* ---------------- example data ---------------- */
const P1 = id('pj'), P2 = id('pj'), P3 = id('pj');
const projects = [
  { id: P1, workspace: 'roblox', name: 'Lava Mountain Climb', brief: 'Example project. A tower obby up a volcano: 50 stages, checkpoints, a best-time board. Phone first. Template 6 (Tower Obby) with one new mechanic: rising lava that speeds up when you stand still.', budgetUsd: 15, spentUsd: 3.42, paused: false, checks: ['rojo build -o build.rbxlx'], createdAt: at(300) },
  { id: P2, workspace: 'roblox', name: 'Crystal Collect', brief: 'Example project. Template 2 (Collect and Sell): mine crystals until the backpack is full, sell at the pad, upgrade the pickaxe and bag, open the next cave.', budgetUsd: 10, spentUsd: 6.1, paused: true, checks: ['rojo build -o build.rbxlx'], createdAt: at(1500) },
  { id: P3, workspace: 'acx', name: 'Spring ad tests', brief: 'Example project. Three short-video ad hooks for a spring test. Every product fact must come from the store, not from memory.', budgetUsd: 5, spentUsd: 0.38, paused: false, checks: [], createdAt: at(200) },
];
const T = {};
const task = (key, projectId, agentId, title, status, minAgo, extra = {}) => {
  T[key] = Object.assign({ id: id('tk'), projectId, agentId, title, detail: '', status, attempts: 1, feedback: [], costUsd: 0, createdBy: 'lead', createdAt: at(minAgo + 5), updatedAt: at(minAgo) }, extra);
};
task('plan', P1, 'lead', 'Plan the first milestone', 'done', 290, { createdBy: 'owner', costUsd: 0.21 });
task('design', P1, 'architect', 'Write the game design and the folder layout', 'review', 240, { costUsd: 0.86 });
task('hud', P1, 'frame', 'Design the phone HUD', 'review', 35, { attempts: 2, costUsd: 0.64, feedback: [{ from: 'owner', ts: at(120), text: 'Buttons are too small for thumbs. Use the 44 pixel minimum from the playbook.' }] });
task('checkpoints', P1, 'builder', 'Build checkpoints and stage saving', 'running', 6, { costUsd: 0.92 });
task('stages', P1, 'scenic', 'Block out stages 1 to 10', 'running', 3, { costUsd: 0.31 });
task('playtest', P1, 'playtest', 'Playtest stages 1 to 10 on a phone', 'queued', 2);
task('coins', P1, 'balance', 'Set coin rewards per stage', 'blocked', 18, { costUsd: 0.12, question: 'Should coins be earned per stage cleared or per checkpoint reached? The brief does not say, and it changes the whole reward table.' });
task('pitch', P1, 'pulse', 'Pitch three games from today\'s charts', 'done', 60, { createdBy: 'owner', costUsd: 0.36 });
task('cplan', P2, 'lead', 'Plan the first milestone', 'done', 1490, { createdBy: 'owner', costUsd: 0.18 });
task('bag', P2, 'builder', 'Build the backpack and the sell pad', 'done', 1200, { costUsd: 2.4 });
task('cave', P2, 'scenic', 'Build cave 2 and its gate', 'queued', 1100);
task('hooks', P3, 'copy', 'Write three ad hooks for the spring test', 'review', 40, { costUsd: 0.38 });
task('research', P3, 'scout', 'Find five competitor ads running now', 'queued', 30);
const tasks = Object.values(T);

const files = {
  [P1 + '|deliverables/game-design.md']: `# Lava Mountain Climb: game design

Example deliverable written for the demo.

## Core loop
- Do: clear a stage.
- Earn: coins and a checkpoint.
- Upgrade: trails and a speed coil.
- Repeat: climb higher, beat your best time.

## The one new mechanic
Rising lava under the player. It creeps up while you stand still and drops back when you clear a stage, so the player always has a reason to move.

## Data saved per player
| Field | Type | Notes |
|---|---|---|
| stage | number | highest checkpoint reached |
| coins | number | changed only by the server |
| bestTime | number | seconds, lower is better |
| trails | list | owned trail ids |

## Server events
- ReachedCheckpoint(stageId): the server checks the player is standing on that stage's pad and that it is the next stage.
- BuyItem(itemId): item id only; the price is looked up on the server.

## Folder layout
- src/shared/Config.luau: names, colours, stage list
- src/server/Data.luau, Currency.luau, Stages.luau
- src/client/Hud.luau, Trails.luau
`,
  [P1 + '|deliverables/hud-layout.md']: `# Phone HUD layout

Example deliverable written for the demo. Second attempt, after the owner asked for bigger buttons.

- Top left: coins pill with a plus button.
- Top centre: stage progress, "Stage 13 of 50", with a bar.
- Top right: best time.
- Left column: Shop, Trails, Stages, Daily. Each 68 by 68, above the 44 pixel minimum.
- Bottom centre: Checkpoint button (Roblox's own jump button stays bottom right, nothing placed over it).

All sizes use Scale with an aspect ratio lock, checked at 390, 768 and 1366 pixels wide.
`,
  [P2 + '|deliverables/backpack.md']: `# Backpack and sell pad

Example deliverable written for the demo.

- Backpack holds 25 crystals at the start. Collecting stops at full and the bag icon shakes.
- The sell pad pays out on the server only; the client sends nothing but "I am standing on the pad".
- Checked with two players at once: both bags fill and empty correctly.
`,
  [P3 + '|deliverables/ad-hooks.md']: `# Three hooks for the spring test

Example deliverable written for the demo.

1. "Your commute, minus the traffic." Opens on a rider passing a queue of cars.
2. "What 30 days of riding to work looks like." A quick montage, one shot per day.
3. "Three questions people ask before buying their first e-bike." Answered on screen, one by one.

## Facts to confirm from the store
- Range per charge, top speed and charging time: not stated in any hook until confirmed.
- Any legal note about where e-bikes may be ridden in the target area.
`,
};

const R = {};
const review = (key, taskKey, title, summary, file, status, minAgo, extra = {}) => {
  const t = T[taskKey];
  R[key] = Object.assign({ id: id('rv'), taskId: t.id, projectId: t.projectId, agentId: t.agentId, title, summary, files: file ? [file] : [], status, createdAt: at(minAgo) }, extra);
};
review('design', 'design', 'Game design and folder layout', 'The loop, the rising-lava mechanic, what is saved per player, the two server events and the folder layout. Checked against the Tower Obby template and the code architecture skill.', 'deliverables/game-design.md', 'pending', 238);
review('hud1', 'hud', 'Phone HUD, first attempt', 'Layout for coins, stage progress and four side buttons.', null, 'changes', 150, { note: 'Buttons are too small for thumbs. Use the 44 pixel minimum from the playbook.', decidedAt: at(120) });
review('hud2', 'hud', 'Phone HUD, second attempt', 'Bigger buttons (68 by 68), the Checkpoint button kept clear of Roblox\'s jump button, checked at three screen widths.', 'deliverables/hud-layout.md', 'pending', 33);
review('bag', 'bag', 'Backpack and sell pad', 'Bag fills to 25, sell pad pays out on the server, tested with two players.', 'deliverables/backpack.md', 'approved', 1210, { decidedAt: at(1180) });
review('hooks', 'hooks', 'Three ad hooks for the spring test', 'Three hooks, no product numbers until they are confirmed from the store.', 'deliverables/ad-hooks.md', 'pending', 38);
const reviews = Object.values(R);

const pitches = [
  { id: id('pt'), workspace: 'roblox', title: 'Toss a Treat for Sea Creatures', body: 'Hook: throw a snack as far as you can; the farther it lands, the rarer the creature it attracts. Loop: throw, collect the creature, it earns coins at your base, train to throw farther. Why now: several "send something far to attract creatures" games are in this week\'s charts. Risk: a crowded idea, so it needs a clear twist (the treat bounces off waves).', agentId: 'pulse', status: 'new', createdAt: at(58) },
  { id: id('pt'), workspace: 'roblox', title: 'Volcano Tycoon', body: 'Hook: build a lava-powered factory on the side of a volcano. Loop: place machines, cash per second, expand up the mountain. Why now: tycoons stay steady in Top Revisited. Risk: slower to build than an obby (template 3, medium risk).', agentId: 'pulse', status: 'new', createdAt: at(57) },
];

const ev = [];
const e = (minAgo, projectId, taskKey, agentId, kind, text, extra = {}) => ev.push(Object.assign({ id: id('ev'), ts: at(minAgo), projectId, taskId: taskKey ? T[taskKey].id : undefined, agentId, kind, text }, extra));
e(300, P1, null, undefined, 'project', 'New project: Lava Mountain Climb');
e(295, P1, 'plan', 'lead', 'start', 'Started: Plan the first milestone');
e(294, P1, 'plan', 'lead', 'read', 'Read vault note skills/MASTER_PLAYBOOK.md', { noteId: 'skills/MASTER_PLAYBOOK.md' });
e(293, P1, 'plan', 'lead', 'read', 'Read vault note skills/NEW_GAME_CHECKLIST.md', { noteId: 'skills/NEW_GAME_CHECKLIST.md' });
e(291, P1, 'plan', 'lead', 'handoff', 'Handed work to Architect: Write the game design and the folder layout');
e(290, P1, 'plan', 'lead', 'handoff', 'Handed work to Frame: Design the phone HUD');
e(289, P1, 'plan', 'lead', 'done', 'Finished: Plan the first milestone');
e(285, P1, 'design', 'architect', 'start', 'Started: Write the game design and the folder layout');
e(284, P1, 'design', 'architect', 'read', 'Read vault note skills/07-code-architecture.md', { noteId: 'skills/07-code-architecture.md' });
e(250, P1, 'design', 'architect', 'tool', 'Wrote game-design.md');
e(242, P1, 'design', 'architect', 'check', 'All checks passed');
e(240, P1, 'design', 'architect', 'review', 'Sent for review: Write the game design and the folder layout');
e(155, P1, 'hud', 'frame', 'read', 'Read vault note skills/13-ui-craft-from-videos.md', { noteId: 'skills/13-ui-craft-from-videos.md' });
e(150, P1, 'hud', 'frame', 'review', 'Sent for review: Design the phone HUD');
e(120, P1, 'hud', 'frame', 'verdict', 'Owner asked for changes on: Phone HUD, first attempt');
e(120, P1, 'hud', 'frame', 'lesson', 'New lesson saved for Frame', { noteId: 'lessons/frame.md' });
e(64, P1, 'pitch', 'pulse', 'read', 'Read vault note skills/01-market-research.md', { noteId: 'skills/01-market-research.md' });
e(58, P1, 'pitch', 'pulse', 'pitch', 'New pitch: Toss a Treat for Sea Creatures');
e(57, P1, 'pitch', 'pulse', 'pitch', 'New pitch: Volcano Tycoon');
e(40, P3, 'hooks', 'copy', 'review', 'Sent for review: Write three ad hooks for the spring test');
e(36, P1, 'hud', 'frame', 'tool', 'Changed hud-layout.md');
e(33, P1, 'hud', 'frame', 'review', 'Sent for review: Design the phone HUD');
e(18, P1, 'coins', 'balance', 'ask', 'Needs you: should coins be earned per stage cleared or per checkpoint reached?');
e(7, P1, 'checkpoints', 'builder', 'start', 'Started: Build checkpoints and stage saving');
e(6, P1, 'checkpoints', 'builder', 'read', 'Read vault note skills/08-security-and-anti-exploit.md', { noteId: 'skills/08-security-and-anti-exploit.md' });
e(5, P1, 'checkpoints', 'builder', 'note', 'Checkpoint pads save the stage on the server; testing a late joiner next');
e(4, P1, 'stages', 'scenic', 'start', 'Started: Block out stages 1 to 10');
e(3, P1, 'stages', 'scenic', 'read', 'Read vault note skills/09-performance-on-low-end-phones.md', { noteId: 'skills/09-performance-on-low-end-phones.md' });
e(2, P1, 'checkpoints', 'builder', 'tool', 'Ran: rojo build -o build.rbxlx');
e(1, P1, 'stages', 'scenic', 'tool', 'Wrote Stages01to10.luau');

const spendLog = [[0.21, P1, 290], [0.86, P1, 240], [0.64, P1, 33], [0.36, P1, 58], [0.38, P3, 40], [0.31, P1, 3], [0.92, P1, 2]].map(([usd, projectId, m]) => ({ ts: at(m), usd, projectId }));

const db = {
  settings: { mode: 'auto', maxParallel: 3, model: 'claude-haiku-5-5', nightlyCapUsd: 10, cfAccountId: '', cfModel: '@cf/zai-org/glm-4.7-flash', cfBaseUrl: '', token: 'demo0000000000000000000000',
    agentModels: { 'roblox:builder': 'claude-sonnet-5-5', 'roblox:architect': 'claude-sonnet-5-5', 'roblox:playtest': 'claude-sonnet-5-5' },
    agentFreeFirst: { 'roblox:pulse': true, 'roblox:balance': true } },
  projects, tasks, reviews, events: ev, pitches, spendLog,
};
fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(db));

/* ---------------- read through the app's own modules ---------------- */
const S = require(path.join(ROOT, 'server/store.js'));
const V = require(path.join(ROOT, 'server/vault.js'));
const market = require(path.join(ROOT, 'server/market.js'));
const MODELS = ['', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'];

function publicState(wsId) { // mirrors publicState() in server/index.js
  const d = S.db, pids = new Set(d.projects.filter(p => p.workspace === wsId).map(p => p.id));
  const { token, ...settings } = d.settings;
  return {
    workspaces: S.config.workspaces.map(w => ({ id: w.id, name: w.name, tagline: w.tagline, hasMarket: w.hasMarket,
      agents: w.agents.map(a => ({ id: a.id, name: a.name, color: a.color, isLead: !!a.isLead, role: a.role, reads: a.reads, skills: a.skills || [], writer: !!a.writer })) })),
    keys: { anthropic: { set: false, hint: '' }, cloudflare: { set: false, hint: '' } }, cfReady: false, cfUsedUp: false, models: MODELS,
    settings, mode: 'live', liveAvailable: true, spentToday: S.spentToday(),
    projects: d.projects.filter(p => p.workspace === wsId),
    tasks: d.tasks.filter(t => pids.has(t.projectId)),
    reviews: d.reviews.filter(r => pids.has(r.projectId) && r.status !== 'withdrawn'),
    pitches: d.pitches.filter(p => p.workspace === wsId),
    events: d.events.filter(x => !x.projectId || pids.has(x.projectId)).slice(-250),
  };
}

(async () => {
  const records = [{ type: 'meta', builtAt: NOW, note: 'Example data for the Roblox Game Factory demo. Nothing here is real activity.' }];
  for (const w of S.config.workspaces) {
    records.push({ type: 'state', ws: w.id, state: publicState(w.id) });
    const g = V.graph(w.id);
    records.push({ type: 'graph', ws: w.id, graph: g });
    for (const n of g.nodes) if (n.kind !== 'idea') { const text = V.note(w.id, n.id); if (text !== null) records.push({ type: 'note', ws: w.id, id: n.id, text }); }
  }
  for (const [k, text] of Object.entries(files)) { const [project, p] = k.split('|'); records.push({ type: 'file', project, path: p, text }); }
  try { records.push({ type: 'market', market: market.view(await market.get(true)) }); }
  catch (err) { console.log('Market snapshot skipped:', err.message); }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'demo-data.json'), '[\n' + records.map(r => JSON.stringify(r)).join(',\n') + '\n]\n');

  /* ---------------- assemble the page ---------------- */
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const swap = (src, from, to, count, label) => { const n = src.split(from).length - 1; if (n !== count) throw new Error(`${label}: expected ${count} of ${JSON.stringify(from)}, found ${n}. The app changed; update build-demo.js.`); return src.split(from).join(to); };
  let app = read('public/app.js');
  // claude.ai reserves #settings in an artifact's address, so the demo calls that page #setup.
  app = swap(app, "['settings', 'Settings', '']", "['setup', 'Settings', '']", 1, 'nav item');
  app = swap(app, "route === 'settings'", "route === 'setup'", 3, 'settings route checks');
  app = swap(app, 'href="#settings"', 'href="#setup"', 2, 'settings links');
  app = swap(app, 'settings: viewSettings', 'setup: viewSettings', 1, 'view table');
  app = swap(app, "localStorage.getItem('ns_ws')", "(() => { try { return localStorage.getItem('ns_ws'); } catch (e) { return null; } })()", 1, 'storage read');
  app = swap(app, "localStorage.setItem('ns_ws', id);", "try { localStorage.setItem('ns_ws', id); } catch (e) {}", 1, 'storage write');
  app += '\nICON.setup = ICON.settings;\n';
  const css = read('public/styles.css').replace(/\[data-k=settings\]/g, '[data-k=settings], [data-k=setup]');
  const body = read('public/index.html').match(/<body>([\s\S]*?)<script/)[1];
  const shim = read('scripts/demo-shim.js');

  const page = `<title>Roblox Game Factory</title>
<meta name="description" content="View-only demo of the Roblox Game Factory control room with example data.">
<style>
:root { color-scheme: dark; }
${css}
/* demo frame: a banner above the app, the app fills the rest of the screen */
html, body { height: 100%; }
body { display: flex; flex-direction: column; background: #07080f; }
.demo-banner { flex: none; display: flex; gap: 10px; align-items: center; justify-content: center; flex-wrap: wrap; padding: 7px 16px; font-size: 12.5px; line-height: 1.35; color: #fff3d6; text-align: center;
  background: linear-gradient(90deg, #3b2a6e, #6a2a5a 55%, #6b4a1c); border-bottom: 1px solid #ffffff22; }
.demo-banner b { color: #ffd27a; }
.demo-banner a { color: #ffd27a; text-decoration: underline; }
#app { flex: 1; min-height: 0; height: auto; }
main { height: auto; min-height: 0; }
@media (max-width: 760px) { .demo-banner { font-size: 11.5px; padding: 6px 16px; } #view { padding-left: 16px; padding-right: 16px; } }
</style>
<div class="demo-banner" role="note"><span><b>Demo copy</b> with example data. Nothing here runs or saves.</span><span>The real app runs on your PC: <a href="https://github.com/Cyiber069/website/tree/claude/clever-goodall-7x0n4e" target="_blank" rel="noopener">get it on GitHub</a>.</span></div>
${body.trim()}
<script>
${shim}
</script>
<script>
${read('public/galaxy.js')}
</script>
<script>
${app}
</script>
`;
  fs.writeFileSync(path.join(OUT, 'index.html'), page);
  fs.writeFileSync(path.join(OUT, 'preview.html'), `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>\n${page}</body></html>\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  const kb = (f) => Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
  console.log(`Wrote ${OUT}/index.html (${kb('index.html')} KB), demo-data.json (${kb('demo-data.json')} KB, ${records.length} records), preview.html`);
})().catch(err => { console.error(err.message); process.exit(1); });
