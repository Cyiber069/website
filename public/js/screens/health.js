// Health: is everything working, and what went wrong if not.
import { del, get, post } from '../api.js';
import { $, html, icon, setHTML, unavailable, skeletonCards, ago, dayClock, chBadge, chName, CHANNELS, num, plural, copyText, toastError, clock, span } from '../ui.js';
import { channelState } from './live.js';

const LIMITS = { read: 5000000, write: 100000 };

const JOB_ERRORS = {
  thread_not_found: 'The chat could not be found on the page', composer_missing: 'The message box was not on the page', send_not_confirmed: 'The message was typed but did not show as sent',
  not_on_whatsapp: 'That number is not on WhatsApp', invalid_number: 'The phone number is not valid', logged_out: 'The laptop was signed out of the site', tab_missing: 'The tab was closed on the laptop',
  blocked: 'The site blocked the action', timeout: 'It took too long and gave up', unknown: 'Something unexpected happened on the page',
};
const SOURCE = { auto: 'Agent reply', manual: 'Your message', review: 'Reply you approved', urgent: 'Your answer', recovery: 'Checkout reminder', alert: 'Alert to you', holding: 'Holding line', discount: 'Code message' };
const KIND = { selector_miss: 'Could not find part of the page', dom_snapshot: 'Saved a copy of the page for fixing', error: 'Problem on the page', note: 'Note from the laptop' };
const PROVIDER = { anthropic: 'Claude', workers_ai: 'Backup brain', mock: 'Test brain', gemini: 'Photos and videos' };

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
    let share = { active: false, url: '', expires_at: null, busy: false };
    setHTML(view, skeletonCards(3));

    function paint() {
      if (!data) { setHTML(view, unavailable('The health check', error)); return; }
      const ov = ctx.overview;
      // The laptop the summary talks about: one that answers, else the main laptop (never one on another account).
      const dev = data.device ?? data.devices?.[0];
      const devName = dev ? (dev.person ? `${dev.person}’s laptop` : dev.name || 'Laptop') : 'Laptop';
      const failed = data.failed_jobs || [];
      const errors = data.errors || [];
      const diags = data.diagnostics || [];
      const misses = diags.filter((d) => d.kind === 'selector_miss');
      const usage = data.llm_usage || [];
      const chProblems = ov ? CHANNELS.filter((c) => ['pill--down'].includes(channelState(ov, c).pill)).length : 0;
      const mon = data.monitor || ov?.monitor || {};
      const stuck = Object.values(mon.stuck || {}).reduce((n, x) => n + x, 0);
      const u = data.d1_usage;
      const usageHigh = u && Math.max(u.read_pct || 0, u.write_pct || 0) > 60;
      const problems = (dev?.online ? 0 : 1) + (failed.length ? 1 : 0) + (errors.length ? 1 : 0) + (misses.length ? 1 : 0) + chProblems + (mon.ai_failing ? 1 : 0) + (stuck ? 1 : 0) + (usageHigh ? 1 : 0);
      setHTML(view, html`
        <section class="hero ${problems ? (dev?.online ? 'is-paused' : 'is-offline') : ''}" aria-label="Summary">
          <span class="eyebrow">Last 24 hours</span>
          <p class="hero__state">${problems ? `${plural(problems, 'thing needs', 'things need')} a look.` : 'All good.'}</p>
          <p class="hero__sub">${problems ? 'Details below, with what to do about each one.' : 'The laptop is online and nothing has failed.'}</p>
        </section>

        <section class="card stack" aria-labelledby="hx-h">
          <div class="card__head"><h2 class="eyebrow" id="hx-h">Share with Claude</h2>${share.active ? html`<span class="pill pill--live"><span class="dot dot--live" aria-hidden="true"></span>Sharing</span>` : ''}</div>
          ${share.url ? html`<p class="muted">Copy this link and send it to Claude. It works until ${clock(share.expires_at)} tomorrow.</p>
            <input class="input num" type="text" readonly value="${share.url}" aria-label="Report link" data-share-url>
            <div class="row"><button type="button" class="btn btn--primary" data-action="share-copy">Copy link</button><button type="button" class="btn" data-action="share-stop">Stop sharing</button></div>`
          : share.active ? html`<p class="muted">A link is live until ${clock(share.expires_at)}. Make a new one if you lost it. The old one stops working.</p>
            <div class="row"><button type="button" class="btn btn--primary" data-action="share-make" ${share.busy ? 'disabled' : ''}>Make a new link</button><button type="button" class="btn" data-action="share-stop">Stop sharing</button></div>`
          : html`<p class="muted">If something is not working, make a link and send it to Claude. It shows what your laptop and the agent did today so the fault can be found and fixed. What customers wrote, their numbers and their emails are left out. The link stops working after 24 hours.</p>
            <div><button type="button" class="btn btn--primary" data-action="share-make" ${share.busy ? 'disabled' : ''}>Make a link</button></div>`}
        </section>

        <section class="card stack" aria-labelledby="hl-h">
          <div class="card__head"><h2 class="eyebrow" id="hl-h">Laptop</h2>${dev ? html`<span class="pill ${dev.online ? 'pill--live' : 'pill--down'}"><span class="dot ${dev.online ? 'dot--live' : 'dot--down'}" aria-hidden="true"></span>${dev.online ? 'Online' : 'Offline'}</span>` : html`<span class="pill pill--wait"><span class="dot dot--wait" aria-hidden="true"></span>Not paired</span>`}</div>
          ${dev ? html`<p class="muted">${devName} ${dev.last_seen_at ? `last checked in ${ago(dev.last_seen_at, data.now)}` : 'has not checked in yet'}.${dev.online ? '' : ' Open the laptop, make sure Chrome is running and it has internet.'}${dev.status?.paused_locally ? ' It is paused from the extension on the laptop.' : ''}</p>`
            : html`<p class="muted">No laptop is paired, so the agent cannot read or send anything.</p><div><a class="btn btn--primary" href="#/connections">Pair this laptop</a></div>`}
          ${ov ? html`<ul class="rows">${CHANNELS.map((c) => {
            const st = channelState(ov, c); const cs = ((data.lanes ? data.lanes[c]?.device : null) ?? dev)?.status?.channels?.[c]; const un = cs?.unread; const seen = st.seen;
            const facts = [seen ? seen.text : '', un ? plural(un, 'unread chat') : '', cs?.recoveries ? `fixed itself ${plural(cs.recoveries, 'time')} today` : '', seen?.stuck ? `${plural(seen.stuck, 'chat')} waiting with no reply` : ''].filter(Boolean).map((f) => f[0].toUpperCase() + f.slice(1));
            return html`<li class="rowline">${chBadge(c)}<span class="pill ${st.pill}"><span class="dot ${st.dot}" aria-hidden="true"></span>${st.text}</span><span class="meta">${seen?.reason || st.hint}${facts.length ? html`<span class="rowline__sub ${seen && seen.level !== 'ok' ? `seen--${seen.level}` : ''}">${facts.join('. ')}</span>` : ''}${cs?.last_error && cs.last_error !== seen?.reason ? html`<span class="rowline__sub break">Last problem: ${cs.last_error}</span>` : ''}</span></li>`;
          })}</ul>` : ''}
        </section>

        ${replyCard(data.reply_time)}

        ${mon.ai_failing ? html`<p class="banner banner--down" role="status">${icon('i-stop')}<span><b>The AI is failing.</b> It did not answer 3 times in a row. Check the key or the free daily limit in <a href="#/connections">Connections</a>.</span></p>` : ''}

        ${u ? html`<section class="card stack" aria-labelledby="hd-h">
          <div class="card__head"><h2 class="eyebrow" id="hd-h">Database use today</h2><span class="meta">Estimate</span></div>
          ${meter('read', u.rows_read, LIMITS.read, u.read_pct)}
          ${meter('written', u.rows_written, LIMITS.write, u.write_pct)}
          <p class="field__hint">Cloudflare's free plan allows ${num(LIMITS.read)} rows read and ${num(LIMITS.write)} rows written a day. It starts again at midnight UTC. The agent counts this itself and can miss some, so the real number may be a bit higher. Cloudflare's own page has the exact count.</p>
        </section>` : ''}

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

    /** How fast the agent answered today: the average, the slowest one, and each channel. */
    function replyCard(rt) {
      rt = rt || {};
      const slow = rt.slowest;
      const per = CHANNELS.filter((c) => rt.by_channel?.[c]);
      return html`<section class="card stack" aria-labelledby="hr-h">
        <div class="card__head"><h2 class="eyebrow" id="hr-h">Reply time today</h2>${rt.count ? html`<span class="meta num">${plural(rt.count, 'reply', 'replies')}</span>` : ''}</div>
        ${rt.count ? html`<p class="muted">Average reply time today: <b class="num">${span(rt.avg_ms)}</b>.${slow ? html` The slowest took <b class="num">${span(slow.ms)}</b>, to ${slow.conversation_id ? html`<a href="#/inbox/${slow.conversation_id}">${slow.customer}</a>` : slow.customer} at ${clock(slow.sent_at)}.` : ''}</p>
          ${per.length > 1 ? html`<ul class="rows">${per.map((c) => html`<li class="rowline">${chBadge(c)}<span>Average ${span(rt.by_channel[c].avg_ms)}</span><span class="meta num">${plural(rt.by_channel[c].count, 'reply', 'replies')}</span></li>`)}</ul>` : ''}
          <p class="field__hint">From the customer's last message to the reply going out. Drafts you approve and answers you write are left out.</p>`
        : html`<p class="voice muted">The agent has not sent a reply today yet.</p>`}
      </section>`;
    }

    function meter(what, n, limit, pct) {
      const p = Math.min(1, (n || 0) / limit);
      const level = pct >= 85 ? 'down' : pct > 60 ? 'wait' : 'ok';
      return html`<div class="meter meter--${level}">
        <p class="meter__label">About <b class="num">${num(Math.round(n || 0))}</b> rows ${what} today of <span class="num">${num(limit)}</span></p>
        <div class="progress meter__bar" role="progressbar" aria-label="Rows ${what} today" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p * 100)}"><i style="--p:${p.toFixed(4)}"></i></div>
        <p class="meta num">${pct < 1 && n ? 'Under 1%' : `${Math.round(pct)}%`}</p>
      </div>`;
    }

    async function load() {
      try { data = await get('/api/health'); error = null; }
      catch (err) { if (err.name === 'AuthError') return; if (!data) error = err; else return; }
      const sig = JSON.stringify([{ ...data, now: 0, devices: (data.devices || []).map((d) => [d.id, d.online, d.status]), device: data.device?.id ?? null, lanes: Object.entries(data.lanes || {}).map(([c, l]) => [c, l.device?.id, l.role]) }, ctx.overview?.channels, Math.floor(Date.now() / 60000)]);
      if (sig !== lastSig) { lastSig = sig; paint(); }
    }
    async function loadShare() {
      try { const l = await get('/api/support/link'); share = { ...share, active: Boolean(l.active), expires_at: l.expires_at }; } catch { /* the card still offers a new link */ }
    }
    view.addEventListener('click', async (e) => {
      if (e.target.closest('[data-action="retry"]')) load();
      if (e.target.closest('[data-action="share-make"]')) {
        share.busy = true; paint();
        try { const l = await post('/api/support/link'); share = { active: true, url: l.url, expires_at: l.expires_at, busy: false }; }
        catch (err) { share.busy = false; toastError(err); }
        paint();
      }
      if (e.target.closest('[data-action="share-copy"]')) copyText(share.url, 'Link copied');
      if (e.target.closest('[data-action="share-stop"]')) {
        try { await del('/api/support/link'); share = { active: false, url: '', expires_at: null, busy: false }; paint(); } catch (err) { toastError(err); }
      }
    });
    loadShare().then(() => { if (data) paint(); });
    load();
    return { tick: load };
  },
};
