// Live: is it alive, does it need me, what did it just do.
import { get, post } from '../api.js';
import { toast } from '../ui.js';
import { $, html, raw, icon, setHTML, chBadge, chName, CHANNELS, ago, clock, num, syncList, unavailable, timeTag, plural } from '../ui.js';
import { agentStatus, urgentCount } from '../app.js';

const STATE_TEXT = {
  ready: ['Connected', 'pill--live', 'dot--live'], loading: ['Loading', 'pill--wait', 'dot--wait'], no_tab: ['Tab not open', 'pill--wait', 'dot--wait'],
  logged_out: ['Signed out', 'pill--down', 'dot--down'], blocked: ['Blocked', 'pill--down', 'dot--down'], error: ['Problem', 'pill--down', 'dot--down'],
};
const MODE_TEXT = { auto: 'Replies on its own', review: 'Asks you first', off: 'Switched off' };
export function channelState(ov, ch) {
  const mode = ov.channels?.[ch]?.mode || 'off';
  if (mode === 'off') return { text: 'Off', pill: 'pill--pause', dot: 'dot--pause', mode, hint: 'Switched off in Connections' };
  const device = ov.device;
  if (!device) return { text: 'No laptop', pill: 'pill--wait', dot: 'dot--wait', mode, hint: MODE_TEXT[mode] };
  if (!device.online) return { text: 'Laptop offline', pill: 'pill--down', dot: 'dot--down', mode, hint: MODE_TEXT[mode] };
  const st = device.status?.channels?.[ch];
  if (!st) return { text: 'Tab not open', pill: 'pill--wait', dot: 'dot--wait', mode, hint: `Open ${chName(ch)} in Chrome on the laptop` };
  const [text, pill, dot] = STATE_TEXT[st.state] || ['Checking', 'pill--pause', 'dot--pause'];
  const hints = { no_tab: `Open ${chName(ch)} in Chrome on the laptop`, logged_out: `Sign in to ${chName(ch)} on the laptop`, blocked: st.detail || `${chName(ch)} is blocking the page. Check it on the laptop`, error: st.detail || 'Look at the tab on the laptop' };
  const inbox = ch === 'gmail' && st.state === 'ready' && st.detail.includes('@') ? `${st.detail}. ` : '';
  const out = { text, pill, dot, mode, hint: hints[st.state] || `${inbox}${MODE_TEXT[mode]}`, unread: st.unread || 0, seen: channelSeen(ov, ch) };
  // A tab that says it is fine but has not read anything for 10 minutes is not fine.
  if (out.seen?.level === 'down' && st.state === 'ready') Object.assign(out, { text: 'Stopped reading', pill: 'pill--down', dot: 'dot--down' });
  return out;
}

const SEEN_WARN_MS = 5 * 60000, SEEN_DOWN_MS = 10 * 60000;
/** "Last read 2 min ago" from the last good scan the laptop reported. Amber after 5 min, red after 10 with the reason. */
export function channelSeen(ov, ch) {
  const mode = ov.channels?.[ch]?.mode || 'off';
  const d = ov.device;
  const st = d?.status?.channels?.[ch];
  if (mode === 'off' || !d?.online || !st?.last_ok_at) return null;
  const age = Math.max(0, (ov.now || Date.now()) - st.last_ok_at);
  const level = age >= SEEN_DOWN_MS ? 'down' : age >= SEEN_WARN_MS ? 'wait' : 'ok';
  const reason = level === 'ok' ? '' : (ov.monitor?.channels?.[ch]?.reason || st.last_error || st.detail || '');
  const stuck = ov.monitor?.stuck?.[ch] || 0;
  return { age, level, text: `Last read ${ago(st.last_ok_at, ov.now)}`, reason, stuck };
}

/** Shown on Live when the AI is failing or the database use is getting near the free limit. */
function warnings(ov) {
  const out = [];
  if (ov.monitor?.ai_failing) out.push(html`<p class="banner banner--down" role="status">${icon('i-stop')}<span><b>The AI is failing.</b> Check the key or the free daily limit in <a href="#/connections">Connections</a>. Customers are not getting answers.</span></p>`);
  const stuck = Object.values(ov.monitor?.stuck || {}).reduce((n, x) => n + x, 0);
  if (stuck) out.push(html`<p class="banner banner--wait" role="status">${icon('i-dot')}<span><b>${stuck === 1 ? 'One customer has' : `${stuck} customers have`} waited over 15 min with no reply.</b> The agent keeps trying. <a href="#/health">See Health</a></span></p>`);
  const u = ov.usage;
  const pct = u ? Math.max(u.read_pct || 0, u.write_pct || 0) : 0;
  if (pct > 60) out.push(html`<p class="banner ${pct >= 85 ? 'banner--down' : 'banner--wait'}" role="status">${icon('i-dot')}<span><b>Database use is high today.</b> About ${Math.round(pct)}% of the free daily ${(u.read_pct || 0) >= (u.write_pct || 0) ? 'reads' : 'writes'} are used. This is an estimate. <a href="#/health">See Health</a></span></p>`);
  return out;
}

const STEPS = [
  ['device_paired', 'Pair your laptop', 'So the agent can read and send messages.', '#/connections'],
  ['brain_ready', 'Connect the AI brain', 'Paste your Claude key so replies are smart.', '#/connections'],
  ['knowledge_added', 'Add what the agent should know', 'Prices, delivery, returns. Upload files or type notes.', '#/knowledge'],
  ['shopify_connected', 'Connect your Shopify store', 'Needed for checkout reminders.', '#/connections'],
  ['recovery_taught', 'Write your checkout reminder', 'Teach the message sent to people who left a checkout.', '#/recovery'],
  ['push_enabled', 'Turn on phone notifications', 'Get a ping the moment a customer needs you.', '#/connections'],
];

function signalPath(values, w = 600, h = 44, pad = 6) {
  const max = Math.max(1, ...values), step = w / Math.max(1, values.length - 1);
  return values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${(h - pad - (v / max) * (h - pad * 2)).toFixed(1)}`).join(' ');
}

export default {
  title: 'Live',
  mount(view, ctx) {
    let lastEventId = 0;
    let events = [];
    let eventsError = null;
    let eventsLoaded = false;

    setHTML(view, html`
      <section class="hero" aria-label="Agent status" id="hero">
        <div class="hero__top">
          <div class="stack hero__words">
            <span class="eyebrow">Agent</span>
            <p class="hero__state" id="hero-state"><span class="skel skel--value" style="--w:240px"></span></p>
            <p class="hero__sub" id="hero-sub"><span class="skel" style="--w:70%"></span></p>
          </div>
          <label class="switch switch--big"><input type="checkbox" role="switch" id="hero-switch" aria-label="Agent on"><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label" id="hero-switch-label">Agent</span></label>
        </div>
        <svg class="signal" viewBox="0 0 600 44" preserveAspectRatio="none" aria-hidden="true"><path class="signal__base" pathLength="100" d="M0 38 L600 38"/><path class="signal__pulse" pathLength="100" d="M0 38 L600 38"/></svg>
      </section>
      <section class="stack" id="warnings" hidden></section>
      <section class="chgrid" aria-label="Laptop and channels" id="channels"></section>
      <section class="grid grid--stats" aria-label="Today" id="stats">
        ${[0, 1, 2, 3].map(() => html`<div class="stat"><span class="skel" style="--w:60%"></span><span class="skel skel--value"></span><span class="skel" style="--w:45%"></span></div>`)}
      </section>
      <section id="takeover" hidden></section>
      <section id="setup"></section>
      <section class="card" aria-labelledby="act-h">
        <div class="card__head"><h2 class="eyebrow" id="act-h">What just happened</h2><span class="meta">Updates on its own</span></div>
        <ol class="feed" id="feed">${[0, 1, 2, 3].map(() => html`<li class="feed__item"><span class="skel" style="--w:34px"></span><span class="skel skel--circle"></span><span class="skel" style="--w:70%"></span></li>`)}</ol>
      </section>
      <section class="card danger-zone" aria-labelledby="stop-h">
        <div><h2 class="eyebrow" id="stop-h">Emergency stop</h2><p class="muted">Switches the agent off and throws away every message that is waiting to send.</p></div>
        <button type="button" class="btn btn--danger" id="panic">${icon('i-stop')}Stop everything</button>
      </section>`);

    $('#hero-switch', view).addEventListener('change', (e) => ctx.setAgent(e.target.checked));
    $('#panic', view).addEventListener('click', () => ctx.panic());

    function paint(ov, err) {
      if (!ov) {
        if (err) { $('#hero-state', view).textContent = 'No connection.'; $('#hero-sub', view).textContent = 'Could not reach the server. Trying again every few seconds.'; }
        return;
      }
      const s = agentStatus(ov);
      const hero = $('#hero', view);
      hero.classList.toggle('is-paused', s.key === 'off' || s.key === 'paused' || s.key === 'unpaired');
      hero.classList.toggle('is-offline', s.key === 'offline');
      $('#hero-state', view).textContent = s.line;
      const ready = CHANNELS.filter((c) => channelState(ov, c).text === 'Connected').length;
      const waiting = urgentCount(ov);
      $('#hero-sub', view).textContent = s.key === 'live'
        ? `${plural(ready, 'channel')} connected. ${waiting ? `${plural(waiting, 'customer')} waiting on you.` : 'Nobody is waiting on you.'}`
        : s.sub;
      const sw = $('#hero-switch', view);
      if (document.activeElement !== sw || sw.checked === ov.agent.enabled) sw.checked = Boolean(ov.agent.enabled);
      $('#hero-switch-label', view).textContent = ov.agent.enabled ? 'Agent on' : 'Agent off';

      // Laptop + channels
      const d = ov.device;
      const laptop = !d ? ['Not paired', 'pill--wait', 'dot--wait', 'Pair it in Connections'] : d.online ? ['Online', 'pill--live', 'dot--live', `Checked in ${ago(d.last_seen_at, ov.now)}`] : ['Offline', 'pill--down', 'dot--down', `Last seen ${ago(d.last_seen_at, ov.now)}`];
      setHTML($('#channels', view), html`
        <a class="chcard" href="#/connections"><span class="ch ch--icon" aria-hidden="true">${icon('i-laptop', 'ch__glyph')}</span><span class="chcard__name">${d?.name || 'Laptop'}</span><span class="pill ${laptop[1]}"><span class="dot ${laptop[2]}" aria-hidden="true"></span>${laptop[0]}</span><span class="chcard__hint">${laptop[3]}</span></a>
        ${CHANNELS.map((c) => { const st = channelState(ov, c); const seen = st.seen; return html`<a class="chcard" href="${seen && seen.level !== 'ok' ? '#/health' : '#/connections'}">${chBadge(c, true)}<span class="chcard__name">${chName(c)}</span><span class="pill ${st.pill}"><span class="dot ${st.dot}" aria-hidden="true"></span>${st.text}</span>${seen ? html`<span class="chcard__seen chcard__seen--${seen.level}">${seen.text}</span>` : ''}<span class="chcard__hint">${seen?.reason || st.hint}</span>${seen?.stuck ? html`<span class="chcard__seen chcard__seen--wait">${seen.stuck === 1 ? 'One chat' : `${seen.stuck} chats`} waiting with no reply</span>` : ''}</a>`; })}`);
      const warn = warnings(ov);
      const wbox = $('#warnings', view);
      wbox.hidden = !warn.length;
      if (warn.length) setHTML(wbox, html`${warn}`); else wbox.innerHTML = '';

      // Numbers
      const c = ov.counts || {};
      const handled = (c.auto_today || 0) + (c.escalated_today || 0);
      const alone = handled ? Math.round(((c.auto_today || 0) / handled) * 100) : null;
      setHTML($('#stats', view), html`
        <a class="stat ${waiting ? 'stat--urgent' : ''}" href="#/urgent"><h2 class="stat__label">Waiting on you</h2><p class="stat__value">${num(waiting)}</p><p class="stat__delta">${waiting ? 'Tap to answer' : 'All clear'}</p></a>
        <article class="stat"><h2 class="stat__label">Replies sent today</h2><p class="stat__value">${num(c.sent_today)}</p><p class="stat__delta">${c.queued ? `${num(c.queued)} about to send` : 'Nothing waiting to send'}</p></article>
        <article class="stat"><h2 class="stat__label">Handled alone</h2><p class="stat__value">${alone === null ? raw('<span class="stat__none">0</span>') : html`${alone}<span class="stat__unit">%</span>`}</p><p class="stat__delta">${alone === null ? 'No chats yet today' : `${num(c.escalated_today)} passed to you`}</p></article>
        <article class="stat"><h2 class="stat__label">Messages in today</h2><p class="stat__value">${num(c.inbound_today)}</p><p class="stat__delta">${plural(c.conversations_today || 0, 'chat')}</p></article>`);

      // Setup checklist
      const setup = ov.setup || {};
      const left = STEPS.filter(([k]) => !setup[k]);
      const box = $('#setup', view);
      if (!left.length) { box.innerHTML = ''; box.hidden = true; } else {
        box.hidden = false;
        const done = STEPS.length - left.length;
        setHTML(box, html`<div class="card"><div class="card__head"><h2 class="eyebrow">Finish setting up</h2><span class="meta num">${done} of ${STEPS.length} done</span></div>
          <div class="progress" role="progressbar" aria-label="Setup progress" aria-valuemin="0" aria-valuemax="${STEPS.length}" aria-valuenow="${done}"><i style="--p:${done / STEPS.length}"></i></div>
          <ol class="steps">${STEPS.map(([k, title, text, href]) => setup[k]
            ? html`<li class="step is-done"><span class="step__mark">${icon('i-check')}</span><span class="step__body"><b>${title}</b><span>Done</span></span></li>`
            : html`<li class="step"><a class="step__link" href="${href}"><span class="step__mark" aria-hidden="true"></span><span class="step__body"><b>${title}</b><span>${text}</span></span>${icon('i-chev', 'step__chev')}</a></li>`)}</ol></div>`);
      }
    }

    function paintFeed() {
      const feed = $('#feed', view);
      if (eventsError && !events.length) { setHTML(feed, html`<li>${unavailable('The activity feed', eventsError)}</li>`); return; }
      if (!events.length) {
        setHTML(feed, html`<li class="feed__empty"><p class="voice muted">Quiet so far. When a customer writes in, you will see it here.</p></li>`);
        delete feed.dataset.synced;
        return;
      }
      if (feed.querySelector('.skel, .feed__empty, .notice')) { feed.innerHTML = ''; delete feed.dataset.synced; }
      syncList(feed, events.slice(0, 50), {
        key: (e) => e.id,
        sig: (e) => String(e.id),
        render: (e) => html`<li class="feed__item feed__item--${e.level}"><time class="feed__time" datetime="${new Date(e.ts).toISOString()}">${clock(e.ts)}</time>${e.channel ? chBadge(e.channel, true) : html`<span class="ch ch--icon lvl lvl--${e.level}" aria-hidden="true">${icon(e.level === 'error' || e.level === 'warn' ? 'i-stop' : e.level === 'good' ? 'i-check' : 'i-dot', 'ch__glyph')}</span>`}<span class="feed__text">${e.conversation_id ? html`<a href="#/inbox/${e.conversation_id}">${e.message}</a>` : e.message}</span></li>`,
        onNew: (node) => node.classList.add('is-new'),
      });
      // The signal line is today's real activity: one point per half hour for the last 12 hours.
      const now = Date.now(), slot = 30 * 60000, buckets = new Array(24).fill(0);
      for (const e of events) { const i = 23 - Math.floor((now - e.ts) / slot); if (i >= 0 && i < 24) buckets[i]++; }
      const d = signalPath(buckets);
      for (const p of view.querySelectorAll('.signal path')) p.setAttribute('d', d);
    }

    async function loadEvents() {
      try {
        const res = await get(lastEventId ? `/api/events?after=${lastEventId}&limit=60` : '/api/events?limit=60');
        const fresh = res.events || [];
        if (fresh.length) {
          const seen = new Set(events.map((e) => e.id));
          events = [...fresh.filter((e) => !seen.has(e.id)), ...events].sort((a, b) => b.id - a.id).slice(0, 80);
          lastEventId = events[0].id;
        }
        eventsError = null;
      } catch (err) {
        if (err.name === 'AuthError') return;
        eventsError = err;
      }
      eventsLoaded = true;
      paintFeed();
    }

    // ---- Chats taken over: the agent stays out until the timer ends, or until you hand it back --------
    let takeovers = [];
    let skew = 0; // server clock minus this device's clock
    const left = (until) => {
      const ms = Math.max(0, until - (Date.now() + skew));
      const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
      return `${m}:${String(s).padStart(2, '0')}`;
    };
    function paintTakeovers() {
      const box = $('#takeover', view);
      box.hidden = !takeovers.length;
      if (!takeovers.length) return;
      setHTML(box, html`<div class="card"><div class="card__head"><h2 class="eyebrow">Chats taken over</h2><span class="meta num">${takeovers.length}</span></div>
        <p class="muted">The agent stays out of these. When the timer ends it answers again on its own.</p>
        <ul class="list">${takeovers.map((t) => html`<li class="row" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid var(--line, #262a31)">
          <a href="#/inbox/${t.id}" style="display:flex;gap:10px;align-items:center;min-width:0;flex:1 1 220px;color:inherit;text-decoration:none">${chBadge(t.channel)}
            <span style="min-width:0"><b>${t.customer}</b><br><span class="meta">${t.customer_waiting ? 'Customer is waiting for a reply' : t.preview}</span></span></a>
          <span class="num" style="font-weight:700;min-width:64px;text-align:right" data-until="${t.until_unpaused ? '' : t.paused_until}">${t.until_unpaused ? 'Paused' : left(t.paused_until)}</span>
          <span style="display:flex;gap:8px">
            <button type="button" class="btn btn--primary" data-handback="${t.id}">Let agent reply</button>
            ${t.until_unpaused ? '' : html`<button type="button" class="btn" data-hold="${t.id}">Pause</button>`}
          </span></li>`)}</ul></div>`);
    }
    async function loadTakeovers() {
      try {
        const res = await get('/api/takeovers');
        skew = (res.now || Date.now()) - Date.now();
        takeovers = res.chats || [];
        paintTakeovers();
      } catch { /* the rest of the screen still works */ }
    }
    let beat = 0;
    const timer = setInterval(() => {
      if (!view.isConnected) { clearInterval(timer); return; }
      // Every 15 s look again too, so a chat you take over while this screen is open shows up.
      let ended = ++beat % 15 === 0;
      for (const el of view.querySelectorAll('[data-until]')) {
        const until = Number(el.dataset.until);
        if (!until) continue;
        el.textContent = left(until);
        if (until - (Date.now() + skew) <= 0) ended = true;
      }
      if (ended) loadTakeovers();
    }, 1000);
    view.addEventListener('click', async (e) => {
      const back = e.target.closest('[data-handback]');
      const hold = e.target.closest('[data-hold]');
      if (!back && !hold) return;
      const id = (back || hold).dataset.handback || (back || hold).dataset.hold;
      (back || hold).disabled = true;
      try {
        await post(`/api/conversations/${encodeURIComponent(id)}/pause`, back ? { minutes: 0 } : {});
        toast(back ? 'Handed back. The agent will reply if the customer is waiting.' : 'Paused. The agent waits until you press Let agent reply.');
      } catch {
        toast('That did not work. Try again.', { type: 'error' });
      }
      loadTakeovers();
    });
    loadTakeovers();

    ctx.onOverview(paint);
    if (ctx.overview) paint(ctx.overview, null);
    loadEvents();
    view.addEventListener('click', (e) => { if (e.target.closest('[data-action="retry"]')) { loadEvents(); ctx.refreshOverview(); } });

    return { tick: () => { loadEvents(); loadTakeovers(); } };
  },
};
