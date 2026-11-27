# Roblox Game Factory

A control room for a team of AI agents. You write a brief, the Lead breaks it into tasks, specialists do the work, and finished work lands in a review queue for your verdict. It runs two teams from one app:

- **Roblox Studio**: a game factory (Lead, Architect, Builder, Frame, Scenic, Balance, Playtest, Pulse, Librarian, Liveops).
- **ACX E-Bikes**: a growth team (Lead, Scout, Copy, Creative, Store, Inbox, Analyst, Librarian).

## What it does

- **Live feed** of what every agent is doing, and a "Needs you" list of anything waiting on you.
- **Review queue**: approve, ask for changes, polish, or reject. A note is required to send work back, and every note is saved as a lesson that agent reads before its next task.
- **Quality checks**: each project can list commands that must pass after every task. Work that fails goes back to the agent, not to you. After three failed attempts it is escalated to you.
- **Budgets**: a spending limit per project, per task, and per day. Agents stop when a limit is reached.
- **Brain**: everything the team knows, drawn as a glowing 3D map you can rotate, zoom and read: one cluster per topic, one spark per rule. A signal fires from the core when an agent reads a note.
- **Skill library** (`GameFactorySkills/`): the rules every Roblox game starts from. Each agent is handed the skill files for its job.
- **Market** (Roblox): live player counts from Roblox's public charts, with change since the last refresh.
- **A model per agent**: pick a cheap model for simple agents and a stronger one for the agents that write code (Team page).
- **Keys** (Settings): an optional Claude API key, and optional free Cloudflare Workers AI credits. Agents that write documents can use the free credits first and switch to Claude automatically when the daily allowance runs out. Keys are stored only in `data/` on the computer and can only be changed from that computer.
- **Phone access**: the whole app works at phone width.

## Run it

Needs [Node.js](https://nodejs.org) 20 or newer. No install step and no dependencies.

```
npm start
```

Then open http://localhost:4600.

On Windows you can instead double-click `start.bat`: it starts the app and opens it in your browser. `phone.bat` does the same with phone access turned on.

On Windows, agents work best with [Git for Windows](https://git-scm.com/download/win) installed, so Claude Code can use Bash. Without it, Claude Code uses PowerShell, which the app also allows.

Agents do real work only when [Claude Code](https://claude.com/claude-code) is installed and signed in on the same computer. Without it the app runs in **demo mode**: tasks walk through the pipeline and produce clearly labelled placeholders, with no AI and no cost.

### Phone

```
npm run phone
```

Open **Settings** in the app on the computer and it shows a private link to open on a phone on the same Wi-Fi. Anything not coming from the computer itself needs the access key in that link.

On Windows, click **Allow** when the firewall asks about Node.js. If the phone still cannot connect, allow `node.exe` under Windows Defender Firewall > Allowed apps.

## How agents work

Each task launches Claude Code in the project's own folder (`data/projects/<id>/`) with:

1. the agent's role (`config/workspaces.json`),
2. the vault chapters that agent must read (`vault/<workspace>/...`) plus its own lessons file,
3. the task, and any feedback from earlier attempts.

Agents talk back to the control room with `cli.js` (progress notes, review submissions, handing tasks to teammates, pitches, questions for the owner).

## Editing the team and the vault

- Agents: edit `config/workspaces.json` (name, role, which vault chapters they read) and restart.
- Vault: add or edit markdown files under `vault/<workspace>/<chapter>/`. Line 1 is `# Title`, an optional `> summary` line follows, and `[[Title]]` links notes together.
- Lessons from your reviews are written to `vault/<workspace>/lessons/`.

## Honest limits

- The starter vault is original and deliberately modest. Its value grows as you review work and lessons accumulate.
- Agents do not yet drive Roblox Studio directly. They write the project files (Luau, design docs, Rojo layout); connecting Studio is the next step and needs Studio on the same computer.
- Spending is what Claude Code reports per task. On a Claude subscription it is an equivalent estimate, not a charge.
- All data lives in `data/` on the computer running it. Nothing is uploaded anywhere.
