#!/usr/bin/env node
// Command agents use to talk to the control room while they work.
//   node cli.js note "text"
//   node cli.js review --title "..." --summary "..." --file path [--file path]
//   node cli.js task --agent <id> --title "..." --detail "..."
//   node cli.js pitch --title "..." --body "..."
//   node cli.js ask "question"
const [cmd, ...rest] = process.argv.slice(2);
const url = process.env.NIGHTSHIFT_URL, task = process.env.NIGHTSHIFT_TASK;
if (!url || !task) { console.error('This command only works inside a Nightshift agent task.'); process.exit(1); }

const opts = { files: [] }, free = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--file') opts.files.push(rest[++i]);
  else if (a.startsWith('--')) opts[a.slice(2)] = rest[++i];
  else free.push(a);
}
if (free.length) opts.text = free.join(' ');
if (!['note', 'review', 'task', 'pitch', 'ask'].includes(cmd)) { console.error('Unknown command. Use: note, review, task, pitch, ask'); process.exit(1); }

fetch(`${url}/api/agent/${cmd}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-task': task, 'x-token': process.env.NIGHTSHIFT_TOKEN || '' },
  body: JSON.stringify(opts),
}).then(async r => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('Failed: ' + (j.error || r.status)); process.exit(1); }
  if (cmd === 'review') console.log(`Submitted for review${j.files && j.files.length ? ' with ' + j.files.length + ' file(s)' : ' (no files attached; check the paths if you meant to attach some)'}.`);
  else if (cmd === 'ask') console.log('Question sent. Stop working now; the owner will reply and the task will restart.');
  else console.log('OK');
}).catch(e => { console.error('Could not reach the control room: ' + e.message); process.exit(1); });
