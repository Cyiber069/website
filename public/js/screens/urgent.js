// Urgent: customers waiting on the owner, plus drafts waiting for a yes.
import { get, post } from '../api.js';
import { $, html, raw, icon, setHTML, chBadge, toast, toastError, syncList, emptyState, unavailable, skeletonCards, bubbles, mediaThumb, mediaNote, timeTag, waited, dayClock, plural, transition, confirmDialog, refreshTimes } from '../ui.js';

const WHY = { low_confidence: 'The agent was not sure enough to answer on its own.', needs_human: 'This one needs a person.', unknown: 'The agent could not find this in what it knows.' };
const SENT_HOLD_MS = 20000;

function heat(ts) { const m = (Date.now() - ts) / 60000; return m < 5 ? 'fresh' : m < 10 ? 'warm' : 'hot'; }
const quote = (t) => `“${String(t || '').trim()}”`;
/** Photos the customer sent in the last few messages, newest 3, shown on the card itself. */
const photosOf = (u) => (u.recent || []).filter((m) => m.direction === 'in' && m.media).slice(-3);
const photoRow = (u) => { const p = photosOf(u); return p.length ? html`<div class="thumbs" aria-label="${plural(p.length, 'photo')} from the customer">${p.map((m) => mediaThumb(m.media))}</div>${p.map((m) => mediaNote(m.media))}` : ''; };

function urgentCard(u) {
  if (u._sent) {
    return html`<article class="ucard is-sent" aria-label="Reply queued for ${u.customer}">
      <header class="ucard__head">${chBadge(u.channel)}<span class="ucard__who">${u.customer}</span><span class="pill pill--live"><span class="dot" aria-hidden="true"></span>Queued</span></header>
      <p class="ucard__q">${quote(u.customer_message || u.question)}</p>
      <div class="queued"><span class="eyebrow">${u._sent.dismissed ? 'Closed' : 'This is what the agent will send'}</span>
        ${u._sent.dismissed ? html`<p class="muted">Closed with no reply.</p>` : html`<div class="thread">${u._sent.parts.map((p) => html`<div class="msg msg--agent"><div class="bubble">${p}</div></div>`)}</div>
        <p class="meta">${u._sent.learned ? 'Saved to Knowledge so the agent knows next time. ' : ''}Your laptop sends it in a moment.</p>`}
      </div>
    </article>`;
  }
  const id = u.id;
  const showQuestion = u.question && u.customer_message && u.question.trim() !== u.customer_message.trim();
  return html`<article class="ucard" data-heat="${heat(u.created_at)}" data-since="${u.created_at}" aria-labelledby="q-${id}">
    <header class="ucard__head">${chBadge(u.channel)}<a class="ucard__who" href="#/inbox/${u.conversation_id}">${u.customer}</a><span class="ucard__wait"><span class="sr-only">Waiting </span>${timeTag(u.created_at, 'wait')}</span></header>
    <p class="ucard__q" id="q-${id}">${quote(u.customer_message || u.question)}</p>
    ${photoRow(u)}
    ${showQuestion ? html`<p class="ucard__why"><b>What the agent needs to know:</b> ${u.question}</p>` : ''}
    <p class="ucard__why"><b>Why it stopped:</b> ${WHY[u.reason] || u.reason || WHY.unknown}</p>
    ${u.recent?.length ? html`<details class="ucard__ctx"><summary>Recent chat (${u.recent.length})</summary><div class="thread thread--mini">${bubbles(u.recent)}</div></details>` : ''}
    ${u.category === 'discount_code' ? codeBlock(u) : ''}
    ${u.draft ? html`<div class="draft"><span class="eyebrow">The agent's draft</span><p class="draft__text">${u.draft}</p>
      <div class="wrap"><button type="button" class="btn btn--sm" data-action="send-draft" data-id="${id}">Send this draft</button><button type="button" class="btn btn--ghost btn--sm" data-action="edit-draft" data-id="${id}">Edit it first</button></div></div>` : ''}
    <div class="tabsrow" role="group" aria-label="How to answer">
      <button type="button" class="chip chip--sm" data-action="mode-reply" data-id="${id}" aria-pressed="true">Write reply</button>
      <button type="button" class="chip chip--sm" data-action="mode-note" data-id="${id}" aria-pressed="false" title="Tell the agent what's going on">Add a note</button>
    </div>
    <form class="ucard__form ucard__note" data-note-send data-id="${id}" novalidate hidden>
      <label class="field__label" for="n-${id}">What is going on</label>
      <textarea class="input" id="n-${id}" rows="3" placeholder="For example: he already got a refund last week, tell him politely we cannot do another one." aria-describedby="nh-${id}"></textarea>
      <p class="field__hint" id="nh-${id}" data-hint>The agent writes the reply in the customer's style. It never quotes your note.</p>
      <div class="ucard__actions">
        <label class="check"><input type="checkbox" name="remember" checked> Remember this for next time</label>
        <button type="submit" class="btn btn--primary btn--send"><span class="btn__label">Let the agent reply</span><svg class="btn__check" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.500l4 4 8-9"/></svg></button>
      </div>
    </form>
    <form class="ucard__form" data-quick-send data-id="${id}" novalidate>
      <label class="field__label" for="a-${id}">${u.draft ? 'Or type your own answer' : 'Your answer'}</label>
      <textarea class="input" id="a-${id}" rows="3" placeholder="Type it rough. The agent tidies it up and sends it in the customer's style." aria-describedby="h-${id}"></textarea>
      <p class="field__hint" id="h-${id}" data-hint>Spelling and tone do not matter here.</p>
      <div class="ucard__actions">
        <label class="check"><input type="checkbox" name="learn" checked> Remember this for next time</label>
        <button type="button" class="btn btn--ghost btn--sm" data-action="dismiss" data-id="${id}">No reply needed</button>
        <button type="submit" class="btn btn--primary btn--send"><span class="btn__label">Send reply</span><svg class="btn__check" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.500l4 4 8-9"/></svg></button>
      </div>
    </form>
  </article>`;
}

// A creator asked for their own discount code and the agent wants your OK first.
function codeBlock(u) {
  const d = u.discount;
  if (!d) return html`<p class="meta">There is no draft code to approve. Answer below, or make one on the <a href="#/discounts/new/${u.conversation_id}">Discount codes</a> screen.</p>`;
  const live = d.shopify_status === 'created' || d.shopify_status === 'owner_confirmed';
  return html`<div class="draft"><span class="eyebrow">Code they asked for</span>
    <p class="draft__text"><b class="num">${d.code}</b> · £${Number.isInteger(Number(d.amount)) ? Number(d.amount) : Number(d.amount).toFixed(2)} off</p>
    <div class="thread thread--mini"><div class="msg msg--agent"><span class="msg__by">Sent when you approve</span><div class="bubble">${d.message_text}</div></div></div>
    <p class="meta">${live ? 'The code is live in Shopify.' : 'Approve makes it in Shopify, then sends this message.'}</p>
    <div class="wrap"><button type="button" class="btn btn--primary btn--sm" data-action="approve-code" data-id="${u.id}" data-discount="${d.id}">Approve code</button><a class="btn btn--ghost btn--sm" href="#/discounts">See all codes</a></div></div>`;
}

function reviewCard(r) {
  return html`<article class="ucard ucard--review" data-heat="fresh" aria-labelledby="r-${r.id}">
    <header class="ucard__head">${chBadge(r.channel)}<a class="ucard__who" href="${r.conversation_id ? `#/inbox/${r.conversation_id}` : '#/inbox'}">${r.customer}</a><span class="ucard__wait">${timeTag(r.created_at, 'wait')}</span></header>
    ${r.subject ? html`<p class="ucard__why"><b>Subject:</b> ${r.subject}</p>` : ''}
    ${r.customer_message ? html`<p class="ucard__q" id="r-${r.id}">${quote(r.customer_message)}</p>` : html`<p class="ucard__q" id="r-${r.id}">New message to ${r.customer}</p>`}
    <div class="draft"><span class="eyebrow">The agent wants to send</span>
      <div class="thread" data-parts>${r.parts.map((p) => html`<div class="msg msg--agent"><div class="bubble">${p}</div></div>`)}</div>
      <div class="edit" hidden><label class="field__label" for="e-${r.id}">Edit the reply</label><textarea class="input" id="e-${r.id}" rows="4">${r.parts.join('\n')}</textarea><p class="field__hint">Each line is sent as its own message. Three at most.</p></div>
    </div>
    <div class="ucard__actions">
      <button type="button" class="btn btn--danger btn--sm" data-action="reject" data-id="${r.id}">Do not send</button>
      <button type="button" class="btn btn--ghost btn--sm" data-action="edit-review" data-id="${r.id}">Edit</button>
      <button type="button" class="btn btn--primary btn--send" data-action="approve" data-id="${r.id}"><span class="btn__label">Approve and send</span><svg class="btn__check" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.500l4 4 8-9"/></svg></button>
    </div>
  </article>`;
}

function doneCard(u) {
  const state = u.status === 'dismissed' ? 'Closed with no reply' : u.sent_at ? 'Sent' : 'Queued to send';
  return html`<article class="card donecard">
    <header class="ucard__head">${chBadge(u.channel)}<a class="ucard__who" href="#/inbox/${u.conversation_id}">${u.customer}</a><span class="meta">${dayClock(u.answered_at || u.created_at)}</span></header>
    <p class="donecard__q">${quote(u.customer_message || u.question)}</p>
    ${u.owner_answer ? html`<p class="ucard__why"><b>You said:</b> ${u.owner_answer}</p>` : ''}
    ${u.owner_note ? html`<p class="ucard__why"><b>You told the agent:</b> ${u.owner_note}</p>` : ''}
    ${u.sent_text && u.status !== 'dismissed' ? html`<div class="thread"><div class="msg msg--agent"><span class="msg__by">${state}</span><div class="bubble">${u.sent_text}</div></div></div>` : html`<p class="meta">${state}</p>`}
  </article>`;
}

export default {
  title: 'Urgent',
  focus: true,
  mount(view, ctx, params) {
    let tab = params[0] === 'done' ? 'done' : 'open';
    let data = null;
    let error = null;
    let loading = false;
    const sent = new Map();   // id -> { item, until }
    const gone = new Set();   // ids we have acted on, hidden until the server agrees

    setHTML(view, html`
      <div class="tabsrow" role="tablist" aria-label="Urgent lists">
        <button type="button" role="tab" class="chip" data-tab-id="open" aria-selected="true">Needs you <span class="count count--urgent" id="open-count" hidden>0</span></button>
        <button type="button" role="tab" class="chip" data-tab-id="done" aria-selected="false">Done</button>
      </div>
      <div id="body">${skeletonCards(2)}</div>`);

    function paintTabs() {
      for (const b of view.querySelectorAll('[data-tab-id]')) b.setAttribute('aria-selected', String(b.dataset.tabId === tab));
    }

    function paint() {
      const body = $('#body', view);
      if (!data) {
        if (error) setHTML(body, unavailable('The Urgent list', error));
        return;
      }
      if (tab === 'done') {
        if (!data.urgent.length) { setHTML(body, emptyState({ title: 'Nothing here yet', text: 'Questions you have answered show up here, with what the agent sent.', action: 'Back to needs you', id: 'tab-open' })); return; }
        if (!$('#done-list', body)) setHTML(body, html`<div class="ulist" id="done-list"></div>`);
        syncList($('#done-list', body), data.urgent, { key: (u) => u.id, render: doneCard });
        return;
      }
      const now = Date.now();
      for (const [id, s] of sent) if (s.until < now) sent.delete(id);
      const open = data.urgent.filter((u) => !gone.has(u.id));
      const held = [...sent.values()].map((s) => s.item);
      const review = data.review.filter((r) => !gone.has(r.id));
      const n = open.length + review.length;
      const badge = $('#open-count', view);
      badge.textContent = n; badge.hidden = n === 0;
      if (!n && !held.length) {
        setHTML(body, emptyState({ title: 'All clear', text: 'Nobody is waiting on you. The agent is handling the rest.', action: 'See what it is doing', href: '#/live' }));
        return;
      }
      if (!$('#open-list', body)) {
        setHTML(body, html`
          <p class="muted lead" id="lead"></p>
          <div class="ulist" id="open-list"></div>
          <section id="review-wrap" hidden><div class="sechead"><h2 class="eyebrow">Drafts waiting for your OK</h2><p class="meta">From channels set to "ask me first".</p></div><div class="ulist" id="review-list"></div></section>`);
      }
      $('#lead', body).textContent = open.length ? `${plural(open.length, 'customer is', 'customers are')} waiting on you. Oldest first.` : review.length ? 'No questions. Just drafts to check.' : 'Sent. Nobody else is waiting.';
      syncList($('#open-list', body), [...held, ...open], { key: (u) => u.id, render: urgentCard, sig: (u) => JSON.stringify([u._sent || 0, u.draft, u.question, u.customer_message, u.recent?.length, photosOf(u).map((m) => [m.media.id, m.media.description || '']), heat(u.created_at), u.discount]) });
      $('#review-wrap', body).hidden = review.length === 0;
      syncList($('#review-list', body), review, { key: (r) => r.id, render: reviewCard });
      refreshTimes(body);
    }

    async function load() {
      if (loading) return;
      loading = true;
      try {
        const res = await get(`/api/urgent?status=${tab}`);
        data = { urgent: res.urgent || [], review: res.review || [] };
        error = null;
        // The server now agrees these are gone.
        const ids = new Set([...data.urgent.map((u) => u.id), ...data.review.map((r) => r.id)]);
        for (const id of gone) if (!ids.has(id)) gone.delete(id);
      } catch (err) {
        if (err.name === 'AuthError') return;
        error = err;
        if (data) console.warn('urgent refresh failed');
      } finally { loading = false; }
      paint();
    }

    function setTab(next) {
      if (tab === next) return;
      tab = next; data = null; error = null;
      setHTML($('#body', view), skeletonCards(2));
      paintTabs();
      history.replaceState(null, '', next === 'done' ? '#/urgent/done' : '#/urgent');
      load();
    }

    function holdSent(item, result) {
      sent.set(item.id, { item: { ...item, _sent: result }, until: Date.now() + SENT_HOLD_MS });
      gone.add(item.id);
      if (view.contains(document.activeElement)) document.activeElement.blur();   // so the card may be swapped for its sent state
      transition(paint);
      setTimeout(() => { if (view.isConnected) transition(paint); }, SENT_HOLD_MS + 200);
      ctx.refreshOverview();
    }
    const findUrgent = (id) => data?.urgent.find((u) => u.id === id);

    async function sendAnswer(form) {
      const id = form.dataset.id;
      const item = findUrgent(id);
      const box = form.querySelector('textarea');
      const btn = form.querySelector('.btn--send');
      const hint = form.querySelector('[data-hint]');
      const text = box.value.trim();
      if (!text) { box.setAttribute('aria-invalid', 'true'); hint.textContent = 'Type an answer first, then send.'; hint.classList.add('is-error'); box.focus(); return; }
      if (!item || btn.classList.contains('is-sending')) return;
      box.removeAttribute('aria-invalid');
      btn.classList.add('is-sending'); btn.querySelector('.btn__label').textContent = 'Sending';
      const card = form.closest('.ucard'); card.dataset.busy = '1';
      const asDraft = form.dataset.mode === 'draft';
      try {
        const res = asDraft
          ? await post(`/api/urgent/${encodeURIComponent(id)}/send-draft`, { text })
          : await post(`/api/urgent/${encodeURIComponent(id)}/answer`, { answer: text, learn: form.elements.learn.checked });
        btn.classList.replace('is-sending', 'is-sent'); btn.querySelector('.btn__label').textContent = 'Queued';
        navigator.vibrate && navigator.vibrate(12);
        toast('Reply queued. Your laptop sends it in a moment.');
        box.dataset.dirty = '0';
        setTimeout(() => { delete card.dataset.busy; holdSent(item, { parts: res.parts?.length ? res.parts : [text], learned: Boolean(res.learned) }); }, 500);
      } catch (err) {
        delete card.dataset.busy;
        btn.classList.remove('is-sending'); btn.querySelector('.btn__label').textContent = 'Send reply';
        if (err.status === 404 || err.status === 409) { toast('That question was already dealt with.', { type: 'warn' }); gone.add(id); load(); return; }
        toastError(err, 'Not sent. Check your connection and try again.');
      }
    }

    async function sendNote(form) {
      const id = form.dataset.id;
      const item = findUrgent(id);
      const box = form.querySelector('textarea');
      const btn = form.querySelector('.btn--send');
      const hint = form.querySelector('[data-hint]');
      const note = box.value.trim();
      if (!note) { box.setAttribute('aria-invalid', 'true'); hint.textContent = 'Say what is going on first.'; hint.classList.add('is-error'); box.focus(); return; }
      if (!item || btn.classList.contains('is-sending')) return;
      box.removeAttribute('aria-invalid');
      btn.classList.add('is-sending'); btn.querySelector('.btn__label').textContent = 'Writing';
      const card = form.closest('.ucard'); card.dataset.busy = '1';
      try {
        const res = await post(`/api/urgent/${encodeURIComponent(id)}/note`, { note, remember: form.elements.remember.checked });
        btn.classList.replace('is-sending', 'is-sent'); btn.querySelector('.btn__label').textContent = 'Done';
        navigator.vibrate && navigator.vibrate(12);
        toast(!res.parts?.length ? 'Noted. The agent is not replying for now.' : res.queued_as === 'review' ? 'The agent wrote a reply. It waits for your OK below.' : 'The agent wrote the reply. Your laptop sends it in a moment.');
        box.dataset.dirty = '0';
        setTimeout(() => { delete card.dataset.busy; holdSent(item, res.parts?.length ? { parts: res.parts, learned: Boolean(res.learned) } : { dismissed: true, parts: [] }); }, 500);
      } catch (err) {
        delete card.dataset.busy;
        btn.classList.remove('is-sending'); btn.querySelector('.btn__label').textContent = 'Let the agent reply';
        if (err.status === 404 || err.status === 409) { toast('That question was already dealt with.', { type: 'warn' }); gone.add(id); load(); return; }
        toastError(err, 'The agent did not reply. Try again or write the reply yourself.');
      }
    }

    view.addEventListener('submit', (e) => {
      const form = e.target.closest('.ucard__form');
      if (!form) return;
      e.preventDefault();
      if (form.matches('[data-note-send]')) sendNote(form); else sendAnswer(form);
    });
    view.addEventListener('input', (e) => {
      if (e.target.matches('.ucard__form textarea')) { e.target.removeAttribute('aria-invalid'); const h = e.target.form.querySelector('[data-hint]'); h.classList.remove('is-error'); }
    });
    view.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-tab-id]');
      if (t) return setTab(t.dataset.tabId);
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const { action, id } = b.dataset;
      if (action === 'retry') return load();
      if (action === 'tab-open') return setTab('open');
      const card = b.closest('.ucard');
      if (action === 'mode-reply' || action === 'mode-note') {
        const toNote = action === 'mode-note';
        card.querySelector('[data-note-send]').hidden = !toNote;
        card.querySelector('[data-quick-send]').hidden = toNote;
        for (const x of card.querySelectorAll('[data-action^="mode-"]')) x.setAttribute('aria-pressed', String(x.dataset.action === action));
        card.querySelector(toNote ? '[data-note-send] textarea' : '[data-quick-send] textarea').focus();
        return;
      }
      if (action === 'edit-draft') {
        const item = findUrgent(id); const form = card.querySelector('.ucard__form'); const box = form.querySelector('textarea');
        box.value = item?.draft || ''; box.dataset.dirty = '1'; form.dataset.mode = 'draft';
        form.querySelector('.field__label').textContent = 'Edit the draft, then send';
        form.querySelector('[data-hint]').textContent = 'This is sent exactly as you leave it.';
        form.querySelector('.check').hidden = true;
        box.focus(); return;
      }
      if (action === 'send-draft') {
        const item = findUrgent(id); if (!item) return;
        b.disabled = true; card.dataset.busy = '1';
        try {
          const res = await post(`/api/urgent/${encodeURIComponent(id)}/send-draft`, {});
          toast('Draft queued. Your laptop sends it in a moment.');
          delete card.dataset.busy;
          holdSent(item, { parts: res.parts?.length ? res.parts : [item.draft], learned: false });
        } catch (err) { b.disabled = false; delete card.dataset.busy; toastError(err, 'Not sent. Check your connection and try again.'); }
        return;
      }
      if (action === 'approve-code') {
        const item = findUrgent(id); if (!item?.discount) return;
        const code = item.discount.code;
        const go = async (confirmExists) => {
          b.disabled = true; card.dataset.busy = '1';
          try {
            const res = await post(`/api/discounts/${encodeURIComponent(item.discount.id)}/approve`, confirmExists ? { confirm_exists: true } : {});
            toast(`${code} is live. Your laptop sends the message in a moment.`);
            delete card.dataset.busy;
            holdSent(item, { parts: res.parts?.length ? res.parts : [item.discount.message_text], learned: false });
          } catch (err) {
            b.disabled = false; delete card.dataset.busy;
            if (err.code === 'needs_confirm') {
              const ok = await confirmDialog({ title: `Is ${code} in Shopify?`, text: `${err.userMessage} Only send it once you made ${code} in Shopify yourself.`, confirm: 'It is in Shopify. Send', cancel: 'Not yet' });
              if (ok) return go(true);
              return;
            }
            toastError(err, 'Not approved. Check your connection and try again.');
          }
        };
        return go(false);
      }
      if (action === 'dismiss') {
        const item = findUrgent(id); if (!item) return;
        if (!(await confirmDialog({ title: 'Close with no reply?', text: 'The customer gets nothing from this question. Use this for spam or when you already answered them yourself.', confirm: 'Close it', cancel: 'Keep it' }))) return;
        gone.add(id); transition(paint);   // optimistic
        try { await post(`/api/urgent/${encodeURIComponent(id)}/dismiss`); toast('Closed. No reply was sent.'); ctx.refreshOverview(); }
        catch (err) { gone.delete(id); paint(); toastError(err, 'Could not close it. Try again.'); }
        return;
      }
      if (action === 'edit-review') {
        const edit = card.querySelector('.edit'); const parts = card.querySelector('[data-parts]');
        const editing = edit.hidden;
        edit.hidden = !editing; parts.hidden = editing;
        b.textContent = editing ? 'Cancel edit' : 'Edit';
        card.querySelector('[data-action="approve"] .btn__label').textContent = editing ? 'Send edited reply' : 'Approve and send';
        const box = edit.querySelector('textarea');
        if (editing) { box.dataset.dirty = '1'; box.focus(); } else box.dataset.dirty = '0';
        return;
      }
      if (action === 'approve') {
        const edit = card.querySelector('.edit');
        const text = edit.hidden ? undefined : edit.querySelector('textarea').value.trim();
        if (!edit.hidden && !text) { edit.querySelector('textarea').setAttribute('aria-invalid', 'true'); toast('Type the reply first, or press Do not send.', { type: 'warn' }); return; }
        if (b.classList.contains('is-sending')) return;
        b.classList.add('is-sending'); card.dataset.busy = '1';
        try {
          await post(`/api/review/${encodeURIComponent(id)}/approve`, text ? { text } : {});
          b.classList.replace('is-sending', 'is-sent'); b.querySelector('.btn__label').textContent = 'Approved';
          card.classList.add('is-sent');
          navigator.vibrate && navigator.vibrate(12);
          toast('Approved. Your laptop sends it in a moment.');
          setTimeout(() => { delete card.dataset.busy; const box = card.querySelector('textarea'); if (box) box.dataset.dirty = '0'; gone.add(id); transition(paint); ctx.refreshOverview(); }, 900);
        } catch (err) {
          delete card.dataset.busy; b.classList.remove('is-sending');
          if (err.status === 404) { toast('That draft is already gone.', { type: 'warn' }); gone.add(id); paint(); return; }
          toastError(err, 'Not approved. Check your connection and try again.');
        }
        return;
      }
      if (action === 'reject') {
        gone.add(id); transition(paint);
        try { await post(`/api/review/${encodeURIComponent(id)}/reject`); toast('Draft thrown away. Nothing was sent.'); ctx.refreshOverview(); }
        catch (err) { gone.delete(id); paint(); toastError(err, 'Could not throw it away. Try again.'); }
      }
    });

    paintTabs();
    load();
    return { tick: load, update(p) { setTab(p[0] === 'done' ? 'done' : 'open'); } };
  },
};
