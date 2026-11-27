// Stands in for the server in the demo copy: answers the app's /api/ requests from demo-data.json,
// refuses every change with a plain message, and makes the Brain view flash as if agents were reading.
(function () {
  const realFetch = window.fetch.bind(window);
  const DEMO_ONLY = 'This is a demo copy, so nothing can be changed here. Run the app on your PC to use it for real.';
  const data = { states: {}, graphs: {}, notes: {}, files: {}, market: null, builtAt: Date.now() };

  // Shift example timestamps so "5 minutes ago" stays 5 minutes ago whenever the demo is opened.
  const shiftIso = (v, ms) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(Date.parse(v) + ms).toISOString() : v;
  function shift(state, ms) {
    const keys = ['createdAt', 'updatedAt', 'startedAt', 'decidedAt', 'ts'];
    for (const list of ['projects', 'tasks', 'reviews', 'events', 'pitches']) for (const o of state[list] || []) {
      for (const k of keys) if (k in o) o[k] = shiftIso(o[k], ms);
      for (const f of o.feedback || []) f.ts = shiftIso(f.ts, ms);
    }
  }

  const ready = realFetch('demo-data.json').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(records => {
    for (const r of records) {
      if (r.type === 'meta') data.builtAt = r.builtAt;
      else if (r.type === 'state') data.states[r.ws] = r.state;
      else if (r.type === 'graph') data.graphs[r.ws] = r.graph;
      else if (r.type === 'note') (data.notes[r.ws] = data.notes[r.ws] || {})[r.id] = r.text;
      else if (r.type === 'file') data.files[r.project + '|' + r.path] = r.text;
      else if (r.type === 'market') data.market = r.market;
    }
    const ms = Date.now() - data.builtAt;
    for (const s of Object.values(data.states)) shift(s, ms);
  });

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const firstWs = () => Object.keys(data.states)[0];

  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, init);
    try { await ready; } catch (e) { return json({ error: 'The demo data could not be loaded (' + e.message + '). Reload the page to try again.' }, 503); }
    if (init && init.method && init.method !== 'GET') return json({ error: DEMO_ONLY }, 400);
    const u = new URL(url, location.href), p = u.pathname, q = u.searchParams;
    const ws = data.states[q.get('ws')] ? q.get('ws') : firstWs();
    if (p === '/api/state') return json(data.states[ws]);
    if (p === '/api/vault') return json(data.graphs[ws] || { nodes: [], edges: [], words: 0, ideas: 0 });
    if (p === '/api/vault/note') { const t = (data.notes[ws] || {})[(q.get('id') || '').split('#')[0]]; return t === undefined ? json({ error: 'That note is not in the demo copy.' }, 404) : json({ text: t }); }
    if (p === '/api/market') return data.market ? json(data.market) : json({ error: 'No chart snapshot in this demo copy.' }, 502);
    if (p === '/api/file') { const t = data.files[q.get('project') + '|' + q.get('path')]; return t === undefined ? new Response('Not in the demo copy.', { status: 404 }) : new Response(t, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
    if (p === '/api/access') return json({ lan: false, urls: [] });
    return json({ error: 'Not available in the demo copy.' }, 404);
  };

  // No live stream in the demo. On the Brain view, play a reading signal every few seconds instead.
  window.EventSource = class {
    constructor() {
      this.handlers = {};
      ready.then(() => { this.onopen && this.onopen(); }).catch(() => {});
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!still) this.timer = setInterval(() => this.tick(), 3200);
    }
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
    close() { clearInterval(this.timer); }
    tick() {
      if (location.hash !== '#vault' || document.hidden) return;
      let wsId = null; try { wsId = localStorage.getItem('ns_ws'); } catch (e) {}
      const s = data.states[wsId] ? data.states[wsId] : data.states[firstWs()], g = data.graphs[data.states[wsId] ? wsId : firstWs()];
      if (!s || !g) return;
      const w = s.workspaces.find(x => x.id === (data.states[wsId] ? wsId : firstWs())), a = w.agents[Math.floor(Math.random() * w.agents.length)];
      const notes = g.nodes.filter(n => n.kind !== 'idea');
      const mine = notes.filter(n => (a.skills || []).some(k => n.id.toLowerCase().startsWith('skills/' + k.toLowerCase())) || (a.reads || []).some(c => n.chapter === c));
      const pick = (mine.length ? mine : notes)[Math.floor(Math.random() * (mine.length || notes.length))];
      if (!pick) return;
      const msg = { data: JSON.stringify({ kind: 'read', agentId: a.id, noteId: pick.id }) };
      for (const fn of this.handlers.event || []) fn(msg);
    }
  };
})();
