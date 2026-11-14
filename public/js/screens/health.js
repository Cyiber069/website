// Health: is everything working, and what went wrong if not.
import { get } from '../api.js';
import { $, html, icon, setHTML, unavailable, skeletonCards, ago, dayClock, chBadge, chName, CHANNELS, num, plural } from '../ui.js';
import { channelState } from './live.js';

const JOB_ERRORS = {
  thread_not_found: 'The chat could not be found on the page', composer_missing: 'The message box was not on the page', send_not_confirmed: 'The message was typed but did not show as sent',
  not_on_whatsapp: 'That number is not on WhatsApp', invalid_number: 'The phone number is not valid', logged_out: 'The laptop was signed out of the site', tab_missing: 'The tab was closed on the laptop',
  blocked: 'The site blocked the action', timeout: 'It took too long and gave up', unknown: 'Something unexpected happened on the page',
};
const SOURCE = { auto: 'Agent reply', manual: 'Your message', review: 'Reply you approved', urgent: 'Your answer', recovery: 'Checkout reminder', alert: 'Alert to you', holding: 'Holding line' };
const KIND = { selector_miss: 'Could not find part of the page', dom_snapshot: 'Saved a copy of the page for fixing', error: 'Problem on the page', note: 'Note from the laptop' };
const PROVIDER = { anthropic: 'Claude', workers_ai: 'Backup brain', mock: 'Test brain' };

function jobError(text) {
  if (!text) return JOB_ERRORS.unknown;
  const code = String(text).split(/[:\s]/)[0];
  return JOB_ERRORS[code] || (/^[a-z_]+$/.test(text) ? JOB_ERRORS.unknown : text);
}
function diagDetail(d) {
  const x = d.data || {};
  for (const k of ['label', 'what', 'name', 'key', 'selector', 'message', 'error', 'note']) if (typeof x[k] === 'string' && x[k]) return x[k].slice(0, 140);
  return '';
}

export default {
  title: 'Health',
  focus: true,
  mount(view, ctx) {
    let data = null, error = null, lastSig = '';
    setHTML(view, skeletonCards(3));

    function paint() {
      if (!data) { setHTML(view, unavailable('The health check', error)); return; }
      const ov = ctx.overview;
      const dev = data.devices?.[0];
      const failed = data.failed_jobs || [];
      const errors = data.errors || [];
      const diags = data.diagnostics || [];
      const misses = diags.filter((d) => d.kind === 'selector_miss');
      const usage = data.llm_usage || [];
      const chProblems = ov ? CHANNELS.filter((c) => ['pill--down'].includes(channelState(ov, c).pill)).length : 0;
      const problems = (dev?.online ? 0 : 1) + (failed.length ? 1 : 0) + (errors.length ? 1 : 0) + (misses.length ? 1 : 0) + chProblems;
      setHTML(view, html`
        <section class="hero ${problems ? (dev?.online ? 'is-paused' : 'is-offline') : ''}" aria-label="Summary">
          <span class="eyebrow">Last 24 hours</span>
          <p class="hero__state">${problems ? `${plural(problems, 'thing needs', 'things need')} a look.` : 'All good.'}</p>
          <p class="hero__sub">${problems ? 'Details below, with what to do about each one.' : 'The laptop is online and nothing has failed.'}</p>
        </section>

        <section class="card stack" aria-labelledby="hl-h">
          <div class="card__head"><h2 class="eyebrow" id="hl-h">Laptop</h2>${dev ? html`<span class="pill ${dev.online ? 'pill--live' : 'pill--down'}"><span class="dot ${dev.online ? 'dot--live' : 'dot--down'}" aria-hidden="true"></span>${dev.online ? 'Online' : 'Offline'}</span>` : html`<span class="pill pill--wait"><span class="dot dot--wait" aria-hidden="true"></span>Not paired</span>`}</div>
          ${dev ? html`<p class="muted">${dev.name || 'Laptop'} ${dev.last_seen_at ? `last checked in ${ago(dev.last_seen_at, data.now)}` : 'has not checked in yet'}.${dev.online ? '' : ' Open the laptop, make sure Chrome is running and it has internet.'}${dev.status?.paused_locally ? ' It is paused from the extension on the laptop.' : ''}</p>`
            : html`<p class="muted">No laptop is paired, so the agent cannot read or send anything.</p><div><a class="btn btn--primary" href="#/connections">Pair this laptop</a></div>`}
          ${ov ? html`<ul class="rows">${CHANNELS.map((c) => { const st = channelState(ov, c); const un = dev?.status?.channels?.[c]?.unread; return html`<li class="rowline">${chBadge(c)}<span class="pill ${st.pill}"><span class="dot ${st.dot}" aria-hidden="true"></span>${st.text}</span><span class="meta">${st.hint}${un ? ` · ${plural(un, 'unread chat')}` : ''}</span></li>`; })}</ul>` : ''}
        </section>

        <section class="card stack" aria-labelledby="hf-h">
          <div class="card__head"><h2 class="eyebrow" id="hf-h">Messages that did not send</h2><span class="count ${failed.length ? 'count--danger' : ''}">${failed.length}</span></div>
          ${failed.length ? html`<ul class="rows">${failed.map((f) => html`<li class="rowline">${chBadge(f.channel, true)}<span><b>${SOURCE[f.source] || 'Message'}</b>${f.target ? ` to ${f.target}` : ''}<span class="rowline__sub">${jobError(f.error)}</span></span><span class="meta num">${dayClock(f.created_at)}</span></li>`)}</ul>
            <p class="field__hint">Open the chat in Inbox and send it again yourself if it still matters.</p>` : html`<p class="voice muted">Everything that was meant to send, sent.</p>`}
        </section>

        <section class="card stack" aria-labelledby="he-h">
          <div class="card__head"><h2 class="eyebrow" id="he-h">Errors</h2><span class="count ${errors.length ? 'count--danger' : ''}">${errors.length}</span></div>
          ${errors.length ? html`<ul class="rows">${errors.map((e) => html`<li class="rowline">${e.channel ? chBadge(e.channel, true) : html`<span class="ch ch--icon lvl lvl--error" aria-hidden="true">${icon('i-stop', 'ch__glyph')}</span>`}<span class="break">${e.message}</span><span class="meta num">${dayClock(e.ts)}</span></li>`)}</ul>` : html`<p class="voice muted">No errors.</p>`}
        </section>

        <section class="card stack" aria-labelledby="hs-h">
          <div class="card__head"><h2 class="eyebrow" id="hs-h">Pages the agent struggled to read</h2><span class="count ${misses.length ? 'count--urgent' : ''}">${misses.length}</span></div>
          ${diags.length ? html`<p class="muted">${misses.length ? 'WhatsApp, Gmail or TikTok may have changed their page. If replies stop on one channel, send this screen to whoever set the agent up.' : 'Notes from the laptop. Nothing to do.'}</p>
            <ul class="rows">${CHANNELS.map((c) => { const n = misses.filter((d) => d.channel === c).length; return n ? html`<li class="rowline">${chBadge(c)}<span>${plural(n, 'time')} it could not find part of the page</span><span class="meta">latest ${ago(misses.find((d) => d.channel === c).ts, data.now)}</span></li>` : ''; })}</ul>
            <details class="fold fold--in"><summary><span>Show the last ${Math.min(diags.length, 20)}</span></summary><ul class="rows fold__body">${diags.slice(0, 20).map((d) => html`<li class="rowline">${chBadge(d.channel, true)}<span>${KIND[d.kind] || 'Note from the laptop'}${diagDetail(d) ? html`<span class="rowline__sub break">${diagDetail(d)}</span>` : ''}</span><span class="meta num">${dayClock(d.ts)}</span></li>`)}</ul></details>`
            : html`<p class="voice muted">The agent read every page without trouble.</p>`}
        </section>

        <section class="card stack" aria-labelledby="hu-h">
          <div class="card__head"><h2 class="eyebrow" id="hu-h">AI use</h2><span class="meta">Last 24 hours</span></div>
          ${usage.length ? html`<div class="tablewrap"><table class="table"><thead><tr><th scope="col">Brain</th><th scope="col" class="r">Times used</th><th scope="col" class="r">Did not answer</th><th scope="col" class="r">Average wait</th><th scope="col" class="r">Words read</th><th scope="col" class="r">Words written</th></tr></thead>
            <tbody>${usage.map((u) => html`<tr><th scope="row">${PROVIDER[u.provider] || 'AI'}<span class="rowline__sub">${String(u.model || '').replace(/^@cf\/[^/]+\//, '').replace(/^claude-/, 'Claude ').replace(/-/g, ' ')}</span></th><td class="r num">${num(u.calls)}</td><td class="r num">${num((u.calls || 0) - (u.ok || 0))}</td><td class="r num">${((u.avg_ms || 0) / 1000).toFixed(1)}s</td><td class="r num">${num(Math.round(((u.input_tokens || 0) + (u.cache_read_tokens || 0)) * 0.75))}</td><td class="r num">${num(Math.round((u.output_tokens || 0) * 0.75))}</td></tr>`)}</tbody></table></div>
            <p class="field__hint">Words are a rough count. Your Anthropic bill is based on these.</p>` : html`<p class="voice muted">The AI has not been used in the last day.</p>`}
        </section>`);
    }

    async function load() {
      try { data = await get('/api/health'); error = null; }
      catch (err) { if (err.name === 'AuthError') return; if (!data) error = err; else return; }
      const sig = JSON.stringify([{ ...data, now: 0, devices: (data.devices || []).map((d) => [d.id, d.online, d.status]) }, ctx.overview?.channels, Math.floor(Date.now() / 60000)]);
      if (sig !== lastSig) { lastSig = sig; paint(); }
    }
    view.addEventListener('click', (e) => { if (e.target.closest('[data-action="retry"]')) load(); });
    load();
    return { tick: load };
  },
};
