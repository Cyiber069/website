// Recovery: the 20:00 checkout reminder. Teach the message, choose who gets it, see tonight's list.
import { get, post, put } from '../api.js';
import { $, html, raw, icon, setHTML, toast, toastError, friendly, unavailable, skeletonCards, emptyState, switchRow, field, busy, dayClock, num, plural, confirmDialog } from '../ui.js';

const VARS = { '{first_name}': 'First name', '{product}': 'What they left', '{total}': 'Basket total', '{checkout_link}': 'Checkout link', '{shop}': 'Shop name' };
const londonClock = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
}
const money = (total, currency) => {
  if (total == null || total === '') return '';
  const n = Number(total);
  if (!Number.isFinite(n)) return String(total);
  try { return n.toLocaleString('en-GB', { style: 'currency', currency: currency || 'GBP' }); } catch { return `${n.toFixed(2)} ${currency || ''}`.trim(); }
};

export default {
  title: 'Recovery',
  mount(view, ctx) {
    let data = null;
    let error = null;
    let draft = null;            // text in the message box while the owner works on it
    let consent = null;
    let lastRun = null;
    let timer = null;

    setHTML(view, skeletonCards(3));

    function paint() {
      if (!data) { setHTML(view, unavailable('Checkout recovery', error)); return; }
      const s = data.settings || {};
      const tpl = data.template || { text: '', approved: false };
      if (draft === null) draft = tpl.text || '';
      if (consent === null) consent = s.consent_confirmed ? s.consent_mode : null;
      const live = data.blocked_by === undefined ? Boolean(tpl.approved && s.consent_confirmed && s.enabled) : !data.blocked_by;
      const todo = [];
      if (!data.shopify?.connected) todo.push(['Connect your Shopify store', 'Without it the agent cannot see who left a checkout.', '#/connections']);
      if (!tpl.text?.trim()) todo.push(['Write the reminder message', 'Teach it below. One rough sentence is enough.', '#teach']);
      else if (!tpl.approved || !s.consent_confirmed) todo.push(['Approve the message', 'Check the wording and choose who gets it, below.', '#teach']);
      if (!s.enabled) todo.push(['Switch reminders on', 'They are switched off right now.', '#rec-settings']);
      const ov = ctx.overview;
      if (ov && !ov.agent?.enabled) todo.push(['Switch the agent on', 'Nothing sends while the agent is off.', '#/live']);
      if (ov && !ov.device) todo.push(['Pair your laptop', 'Reminders go out through WhatsApp on your laptop.', '#/connections']);
      const stats = data.stats || {};
      const eligible = data.eligible || [];
      const skipped = data.skipped || [];
      const runs = data.runs || [];
      const spacing = Array.isArray(s.spacing_seconds) ? s.spacing_seconds : [180, 480];

      setHTML(view, html`
        <section class="hero ${live ? '' : 'is-paused'}" aria-label="Next run">
          <div class="hero__top">
            <div class="ring" id="ring" style="--p:0"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ring__track" cx="18" cy="18" r="16" pathLength="100"/><circle class="ring__bar" cx="18" cy="18" r="16" pathLength="100"/></svg>${icon('i-recovery', 'ring__icon')}</div>
            <div class="stack hero__words">
              <span class="eyebrow">Next run at ${londonClock(data.next_run_at)} UK time</span>
              <p class="hero__state num" id="count" aria-live="off">${countdown(data.next_run_at - Date.now())}</p>
              <p class="hero__sub">${live
                ? `It will message up to ${plural(Math.min(eligible.length, s.daily_cap || eligible.length), 'person', 'people')} for real.`
                : `It will be a practice run only${data.blocked_by ? `, because ${data.blocked_by}` : ''}. Nothing is sent.`}</p>
            </div>
            <span class="pill ${live ? 'pill--live' : 'pill--wait'}"><span class="dot ${live ? 'dot--live' : 'dot--wait'}" aria-hidden="true"></span>${live ? 'Ready to send' : 'Practice only'}</span>
          </div>
        </section>

        ${todo.length ? html`<section class="card"><div class="card__head"><h2 class="eyebrow">Still missing</h2><span class="meta num">${plural(todo.length, 'thing')}</span></div>
          <ol class="steps">${todo.map(([t, d, href]) => html`<li class="step"><a class="step__link" href="${href}" ${href.startsWith('#/') ? '' : raw('data-jump')}><span class="step__mark" aria-hidden="true"></span><span class="step__body"><b>${t}</b><span>${d}</span></span>${icon('i-chev', 'step__chev')}</a></li>`)}</ol></section>` : ''}

        <section class="grid grid--3" aria-label="Last 30 days">
          <article class="stat"><h2 class="stat__label">Messaged, 30 days</h2><p class="stat__value">${num(stats.messaged_30d)}</p></article>
          <article class="stat"><h2 class="stat__label">Replied</h2><p class="stat__value">${num(stats.replied_30d)}</p></article>
          <article class="stat"><h2 class="stat__label">Came back and bought</h2><p class="stat__value">${num(stats.recovered_30d)}</p></article>
        </section>

        <section class="card stack" id="teach" aria-labelledby="teach-h">
          <div class="card__head"><div><h2 class="eyebrow" id="teach-h">The message</h2><p class="meta">${tpl.approved ? `Approved${tpl.updated_at ? ' ' + dayClock(tpl.updated_at) : ''}. Edit and approve again to change it.` : tpl.text ? 'Saved as a draft. Not approved yet, so nothing is sent.' : 'Nothing written yet.'}</p></div>
            <span class="pill ${tpl.approved ? 'pill--live' : 'pill--wait'}"><span class="dot ${tpl.approved ? '' : 'dot--wait'}" aria-hidden="true"></span>${tpl.approved ? 'Approved' : 'Not approved'}</span></div>
          <form class="stack" id="rough-form" novalidate>
            <div class="field"><label class="field__label" for="rough"><span class="stepno">1</span> Say it rough</label>
              <textarea class="input" id="rough" rows="2" placeholder="hey saw you left the bike in your basket, want me to hold it for you?"></textarea>
              <p class="field__hint">Type it how you would say it. The agent turns it into a tidy message.</p></div>
            <div><button type="submit" class="btn">Suggest a message</button></div>
          </form>
          <form class="stack" id="tpl-form" novalidate>
            <div class="field"><label class="field__label" for="tpl"><span class="stepno">2</span> Check the message</label>
              <textarea class="input" id="tpl" rows="4" maxlength="900" placeholder="Hey {first_name}, you left {product} in your basket. Want a hand finishing the order?">${draft}</textarea>
              <div class="wrap vars" role="group" aria-label="Add a detail that is filled in for each customer">${(data.variables || Object.keys(VARS)).map((v) => html`<button type="button" class="chip chip--sm" data-var="${v}" title="${data.variable_notes?.[v] || ''}">+ ${VARS[v] || v}</button>`)}</div>
              <p class="field__hint">The bits in curly brackets are filled in for each customer.</p></div>
            <fieldset class="consent"><legend class="field__label"><span class="stepno">3</span> Who gets it</legend>
              <label class="choice"><input type="radio" name="consent" value="opted_in" ${consent === 'opted_in' ? raw('checked') : ''}><span class="choice__body"><b>Only people who ticked marketing</b><span>Safest. Fewer messages go out, but UK marketing rules are met because they said yes at checkout.</span></span></label>
              <label class="choice"><input type="radio" name="consent" value="all" ${consent === 'all' ? raw('checked') : ''}><span class="choice__body"><b>Everyone who left a number</b><span>Reaches more people, but cold WhatsApp messages can get your number restricted and UK marketing rules still apply to you.</span></span></label>
            </fieldset>
            <p class="form-error" role="alert" hidden></p>
            <div class="wrap"><button type="submit" class="btn btn--primary" data-approve="1">Approve this message</button><button type="button" class="btn btn--ghost" data-action="save-draft">Save as draft</button></div>
          </form>
        </section>

        <section class="card stack" id="rec-settings" aria-labelledby="set-h">
          <h2 class="eyebrow" id="set-h">Settings</h2>
          <form class="stack form" id="set-form" novalidate>
            ${switchRow({ name: 'enabled', checked: s.enabled, label: 'Send checkout reminders', hint: `Every day at ${String(s.send_hour_london ?? 20).padStart(2, '0')}:00 UK time` })}
            <div class="grid grid--2">
              ${field({ label: 'Most messages per day', name: 'daily_cap', type: 'number', value: s.daily_cap, attrs: 'min="1" max="50" inputmode="numeric"', hint: 'Keep this small. New chats are what get numbers restricted.' })}
              <div class="field"><span class="field__label" id="gap-l">Wait between messages (minutes)</span><div class="row"><input class="input" type="number" name="space_min" aria-label="Shortest wait in minutes" min="1" max="60" inputmode="numeric" value="${Math.round(spacing[0] / 60)}"><span class="muted">to</span><input class="input" type="number" name="space_max" aria-label="Longest wait in minutes" min="1" max="120" inputmode="numeric" value="${Math.round(spacing[1] / 60)}"></div><p class="field__hint">A random gap looks like a person, not a machine.</p></div>
            </div>
            ${switchRow({ name: 'include_link', checked: s.include_link, label: 'Put the checkout link in the first message', hint: 'Off is safer: the link goes out when they reply' })}
            ${switchRow({ name: 'opt_out_line', checked: s.opt_out_line, label: 'Add a "reply stop" line', hint: 'Lets people opt out with one word' })}
            <p class="form-error" role="alert" hidden></p>
            <div><button type="submit" class="btn" disabled>Save settings</button></div>
          </form>
        </section>

        <section class="card" aria-labelledby="el-h">
          <div class="card__head"><div><h2 class="eyebrow" id="el-h">Tonight's list</h2><p class="meta">${eligible.length ? `${plural(eligible.length, 'person', 'people')} would get a message.` : 'Nobody is on the list right now.'}</p></div>
            <div class="wrap"><button type="button" class="btn btn--ghost btn--sm" data-action="refresh">Check for new checkouts</button><button type="button" class="btn btn--sm" data-action="dry">Run a dry run now</button></div></div>
          <div id="run-result">${lastRun ? runResult(lastRun) : ''}</div>
          ${eligible.length ? html`<ul class="people">${eligible.map((p) => html`<li class="person">
            <div class="person__head"><b>${p.first_name || 'No name'}</b><span class="meta num">${[p.phone_masked, p.country, money(p.total, p.currency), `${p.age_hours < 1 ? 'under 1' : Math.round(p.age_hours)} hr ago`].filter(Boolean).join(' · ')}</span></div>
            ${p.items?.length ? html`<p class="meta">Left: ${p.items.map((i) => `${i.quantity > 1 ? i.quantity + ' x ' : ''}${i.title}`).join(', ')}</p>` : ''}
            ${p.preview_text ? html`<div class="thread"><div class="msg msg--agent"><div class="bubble">${p.preview_text}</div></div></div>` : html`<p class="meta">No preview yet. Write the message above.</p>`}
            <div><button type="button" class="btn btn--ghost btn--sm" data-action="skip" data-id="${p.id}">Do not message ${p.first_name || 'this one'}</button></div>
          </li>`)}</ul>` : html`<p class="voice muted pad">When someone leaves a checkout with a phone number, they show up here before 20:00.</p>`}
        </section>

        ${skipped.length ? html`<details class="card fold"><summary><span class="eyebrow">Left out (${skipped.length})</span><span class="meta">and why</span></summary>
          <ul class="rows">${skipped.map((p) => html`<li class="rowline"><b>${p.first_name || 'No name'}</b><span class="muted">${p.reason}</span></li>`)}</ul></details>` : ''}

        <section class="card" aria-labelledby="runs-h">
          <div class="card__head"><h2 class="eyebrow" id="runs-h">Past runs</h2></div>
          ${runs.length ? html`<ul class="rows">${runs.map((r) => html`<li class="rowline rowline--run"><span class="num meta">${dayClock(r.started_at)}</span>
            <span class="tag ${r.status === 'error' ? 'tag--down' : r.summary?.mode === 'live' ? 'tag--live' : ''}">${r.status === 'error' ? 'Failed' : r.status === 'running' ? 'Running' : r.summary?.mode === 'live' ? 'Sent for real' : 'Practice'}</span>
            <span class="muted break">${r.summary?.line || `${num(r.queued)} queued, ${num(r.skipped)} left out`}</span></li>`)}</ul>`
            : html`<p class="voice muted pad">No runs yet. The first one happens at 20:00 UK time, or press "Run a dry run now".</p>`}
        </section>`);
      tickClock();
    }

    function runResult(r) {
      const msgs = r.summary?.messages || [];
      return html`<div class="banner ${r.status === 'error' ? 'banner--down' : 'banner--info'}" role="status">${icon('i-check')}<span><b>${r.status === 'error' ? 'The dry run failed.' : 'Dry run finished. Nothing was sent.'}</b> ${r.summary?.line || `${plural(msgs.length, 'message')} would go out.`}${r.summary?.pull?.error ? ` Shopify said: ${r.summary.pull.error}` : ''}</span></div>`;
    }

    function tickClock() {
      const c = $('#count', view); if (!c || !data) return;
      const left = data.next_run_at - Date.now();
      c.textContent = countdown(left);
      const ring = $('#ring', view); if (ring) ring.style.setProperty('--p', String(Math.min(1, Math.max(0, 1 - left / 86400e3))));
      if (left <= 0) load();
    }

    async function load() {
      try { data = await get('/api/recovery'); error = null; }
      catch (err) { if (err.name === 'AuthError') return; if (!data) error = err; else return; }
      paint();
    }

    async function saveTemplate(approved, btn) {
      const f = $('#tpl-form', view); const errBox = f.querySelector('.form-error');
      const text = $('#tpl', view).value.trim();
      const mode = f.elements.consent.value || null;
      const fail = (m, focus) => { errBox.textContent = m; errBox.hidden = false; focus && focus.focus(); };
      if (!text) return fail('Write the message first.', $('#tpl', view));
      if (approved && !mode) return fail('Choose who gets it before you approve. Step 3 above.', f.elements.consent[0]);
      if (approved && mode === 'all' && !(await confirmDialog({ title: 'Message everyone who left a number?', text: 'Cold WhatsApp messages can get your number restricted, and UK marketing rules apply to you. You can switch to marketing ticks only at any time.', confirm: 'Yes, approve', cancel: 'Go back' }))) return;
      errBox.hidden = true;
      await busy(btn, async () => {
        try {
          await put('/api/recovery/template', approved ? { text, approved: true, consent_mode: mode } : { text, approved: false });
          draft = null; consent = null;
          for (const i of view.querySelectorAll('[data-dirty]')) i.dataset.dirty = '0';
          toast(approved ? 'Message approved. It goes out at the next run.' : 'Saved as a draft. Nothing is sent until you approve it.');
          ctx.refreshOverview();
          await load();
        } catch (err) { fail(friendly(err, 'Not saved. Try again.')); }
      });
    }

    view.addEventListener('input', (e) => {
      if (e.target.id === 'tpl') draft = e.target.value;
      if (e.target.closest('#set-form')) $('#set-form [type=submit]', view).disabled = false;
    });
    view.addEventListener('change', (e) => {
      if (e.target.name === 'consent') consent = e.target.value;
      if (e.target.closest('#set-form')) $('#set-form [type=submit]', view).disabled = false;
    });
    view.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.id === 'rough-form') {
        const box = $('#rough', view); const rough = box.value.trim();
        if (!rough) { box.setAttribute('aria-invalid', 'true'); box.focus(); return; }
        box.removeAttribute('aria-invalid');
        const btn = f.querySelector('[type=submit]');
        await busy(btn, async () => {
          btn.textContent = 'Thinking';
          try {
            const res = await post('/api/recovery/teach', { rough });
            draft = res.suggestion || rough;
            const tplBox = $('#tpl', view); tplBox.value = draft; tplBox.dataset.dirty = '1'; tplBox.focus();
            toast('Here is a suggestion. Change anything, then approve it.');
          } catch (err) { toastError(err, 'Could not suggest a message. Type it straight into step 2 instead.'); }
          btn.textContent = 'Suggest a message';
        });
        return;
      }
      if (f.id === 'tpl-form') return saveTemplate(true, f.querySelector('[type=submit]'));
      if (f.id === 'set-form') {
        const errBox = f.querySelector('.form-error');
        const capN = Number(f.elements.daily_cap.value), a = Number(f.elements.space_min.value), b = Number(f.elements.space_max.value);
        if (!(capN >= 1 && capN <= 50)) { errBox.textContent = 'Messages per day should be between 1 and 50.'; errBox.hidden = false; return; }
        if (!(a >= 1) || !(b >= a)) { errBox.textContent = 'The longest wait should be the same as or more than the shortest.'; errBox.hidden = false; return; }
        errBox.hidden = true;
        const btn = f.querySelector('[type=submit]');
        await busy(btn, async () => {
          try {
            await put('/api/settings/recovery', { enabled: f.elements.enabled.checked, daily_cap: Math.round(capN), spacing_seconds: [Math.round(a * 60), Math.round(b * 60)], include_link: f.elements.include_link.checked, opt_out_line: f.elements.opt_out_line.checked });
            toast('Settings saved.');
            await load();
          } catch (err) { errBox.textContent = friendly(err, 'Not saved. Try again.'); errBox.hidden = false; }
        });
      }
    });
    view.addEventListener('click', async (e) => {
      const jump = e.target.closest('[data-jump]');
      if (jump) { e.preventDefault(); const t = view.querySelector(jump.getAttribute('href')); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); t.querySelector('textarea, input')?.focus({ preventScroll: true }); } return; }
      const v = e.target.closest('[data-var]');
      if (v) {
        const box = $('#tpl', view); const at = box.selectionStart ?? box.value.length;
        box.setRangeText(v.dataset.var, at, box.selectionEnd ?? at, 'end'); box.focus(); draft = box.value; box.dataset.dirty = '1';
        return;
      }
      const b = e.target.closest('[data-action]'); if (!b) return;
      const action = b.dataset.action;
      if (action === 'retry') return load();
      if (action === 'save-draft') return saveTemplate(false, b);
      if (action === 'dry') {
        return busy(b, async () => {
          b.textContent = 'Running';
          try { const res = await post('/api/recovery/run', { dry_run: true }); lastRun = res.run; toast('Dry run finished. Nothing was sent.'); await load(); }
          catch (err) { toastError(err, 'The dry run did not start. Try again.'); }
          if (b.isConnected) b.textContent = 'Run a dry run now';
        });
      }
      if (action === 'refresh') {
        return busy(b, async () => {
          try { const r = await post('/api/recovery/refresh'); r.ok === false ? toast(r.error ? `Shopify said: ${r.error}` : 'Could not read new checkouts from Shopify. Check the connection.', { type: 'warn', ms: 6000 }) : toast('Checked. The list is up to date.'); await load(); }
          catch (err) { toastError(err, 'Could not check just now. Try again.'); }
        });
      }
      if (action === 'skip') {
        const id = b.dataset.id; const before = data.eligible;
        data.eligible = data.eligible.filter((p) => p.id !== id); paint();
        try { await post(`/api/recovery/checkouts/${encodeURIComponent(id)}/skip`); toast('Left out. They will not be messaged.'); load(); }
        catch (err) { data.eligible = before; paint(); toastError(err, 'Could not leave them out. Try again.'); }
      }
    });

    load();
    timer = setInterval(tickClock, 1000);
    return { destroy() { clearInterval(timer); } };
  },
};
