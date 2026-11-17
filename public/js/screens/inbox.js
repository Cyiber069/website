// Inbox: every conversation, with the thread, a manual reply box and per thread controls.
import { get, post } from '../api.js';
import { $, html, raw, icon, setHTML, chBadge, chName, CHANNELS, toast, toastError, syncList, emptyState, unavailable, timeTag, dayClock, kindLabel, mediaThumb, confirmDialog, refreshTimes, ago } from '../ui.js';

function row(c, activeId) {
  return html`<li><a class="conv ${c.id === activeId ? 'is-active' : ''}" href="#/inbox/${c.id}" ${c.id === activeId ? raw('aria-current="true"') : ''}>
    ${chBadge(c.channel, true)}
    <span class="conv__main"><span class="conv__top"><b class="truncate">${c.customer}</b><span class="meta">${timeTag(c.updated_at, 'short')}</span></span>
    <span class="conv__preview truncate">${c.last_direction === 'out' ? html`<span class="conv__you">Sent: </span>` : ''}${c.preview || c.subject || 'No messages yet'}</span>
    ${c.paused || c.opted_out ? html`<span class="wrap conv__flags">${c.paused ? html`<span class="tag tag--wait">Agent paused</span>` : ''}${c.opted_out ? html`<span class="tag tag--down">Do not contact</span>` : ''}</span>` : ''}</span>
  </a></li>`;
}

function message(m) {
  const who = m.author === 'customer' ? 'customer' : m.author === 'owner' ? 'owner' : 'agent';
  const by = who === 'customer' ? 'Customer' : who === 'owner' ? 'You' : 'Agent';
  const failed = m.status === 'failed';
  return html`<div class="msg msg--${who}"><span class="msg__by">${by}</span>${mediaThumb(m.media)}<div class="bubble">${m.body || kindLabel(m.kind)}</div><span class="msg__meta">${failed ? html`<span class="bad">Not delivered · </span>` : ''}${dayClock(m.ts)}</span></div>`;
}
function pendingBubble(p) {
  const label = p.status === 'review' ? 'Waiting for your OK' : p.local ? 'Sending to your laptop' : 'Waiting to send';
  return html`<div class="msg msg--${p.source === 'manual' ? 'owner' : 'agent'} msg--pending"><span class="msg__by">${p.source === 'manual' ? 'You' : 'Agent'}</span><div class="bubble">${p.parts.join('\n')}</div><span class="msg__meta">${label}${p.status === 'review' ? html` · <a href="#/urgent">Check it in Urgent</a>` : ''}</span></div>`;
}

export default {
  title: 'Inbox',
  mount(view, ctx, params) {
    let channel = '';
    let q = '';
    let list = null;
    let listError = null;
    let activeId = params[0] || null;
    let thread = null;
    let threadError = null;
    let localPending = [];
    let searchTimer = null;
    let seq = 0;

    setHTML(view, html`<div class="inbox" data-open="${activeId ? 'thread' : 'list'}">
      <section class="inbox__list" aria-label="Conversations">
        <div class="inbox__filters">
          <div class="search"><label class="sr-only" for="inbox-q">Search conversations</label>${icon('i-search', 'search__icon')}<input class="input" id="inbox-q" type="search" placeholder="Search by name or message" autocomplete="off" enterkeyhint="search"></div>
          <div class="chips" role="group" aria-label="Filter by channel">
            <button type="button" class="chip" data-ch="" aria-pressed="true">All</button>
            ${CHANNELS.map((c) => html`<button type="button" class="chip" data-ch="${c}" aria-pressed="false">${icon('g-' + c, 'chip__glyph')}${chName(c)}</button>`)}
          </div>
        </div>
        <ul class="convs" id="convs">${[0, 1, 2, 3, 4].map(() => html`<li class="conv"><span class="skel skel--circle"></span><span class="conv__main"><span class="skel" style="--w:45%"></span><span class="skel" style="--w:80%"></span></span></li>`)}</ul>
      </section>
      <section class="inbox__thread card" aria-label="Conversation" id="thread"></section>
    </div>`);

    const convs = $('#convs', view);
    const threadEl = $('#thread', view);

    function paintList() {
      if (!list) { if (listError) setHTML(convs, html`<li>${unavailable('Your inbox', listError)}</li>`); return; }
      if (!list.length) {
        delete convs.dataset.synced;
        setHTML(convs, html`<li>${q || channel
          ? emptyState({ title: 'No matches', text: 'Nothing fits that search. Try a shorter word or another channel.', action: 'Clear search', id: 'clear' })
          : emptyState({ title: 'No chats yet', text: 'When a customer messages you on WhatsApp, Gmail or TikTok, the chat shows up here.', action: 'Check the laptop is paired', href: '#/connections' })}</li>`);
        return;
      }
      if (convs.querySelector('.skel, .empty, .notice')) { convs.innerHTML = ''; delete convs.dataset.synced; }
      syncList(convs, list, { key: (c) => c.id, render: (c) => row(c, activeId), sig: (c) => JSON.stringify([c, c.id === activeId]) });
      refreshTimes(convs);
    }

    async function loadList() {
      const mine = ++seq;
      try {
        const res = await get(`/api/conversations?channel=${encodeURIComponent(channel)}&q=${encodeURIComponent(q)}`);
        if (mine !== seq) return;
        list = res.conversations || []; listError = null;
      } catch (err) { if (err.name === 'AuthError' || mine !== seq) return; listError = err; }
      paintList();
    }

    function paintThread() {
      view.firstElementChild.dataset.open = activeId ? 'thread' : 'list';
      if (!activeId) {
        ctx.setTitle('Inbox');
        setHTML(threadEl, emptyState({ title: 'Pick a chat', text: 'Choose a conversation on the left to read it, reply yourself or pause the agent.' }));
        threadEl.dataset.id = '';
        return;
      }
      if (!thread) {
        setHTML(threadEl, threadError
          ? html`<a class="backlink" href="#/inbox">${icon('i-back')}All chats</a>${threadError.status === 404 && !threadError.unavailable ? emptyState({ title: 'Chat not found', text: 'This conversation is not here any more.', action: 'Back to all chats', href: '#/inbox' }) : unavailable('This conversation', threadError)}`
          : html`<div class="stack" aria-hidden="true"><span class="skel skel--title" style="--w:40%"></span><span class="skel skel--bubble"></span><span class="skel skel--bubble" style="--w:48%;margin-left:auto"></span><span class="skel skel--bubble" style="--w:55%"></span></div>`);
        threadEl.dataset.id = '';
        return;
      }
      const c = thread.conversation;
      ctx.setTitle(c.customer || 'Inbox');
      const contactLine = [c.phone, c.email, c.handle ? '@' + String(c.handle).replace(/^@/, '') : ''].filter(Boolean).join(' · ');
      if (threadEl.dataset.id !== c.id) {
        setHTML(threadEl, html`
          <header class="thead">
            <a class="backlink" href="#/inbox" aria-label="Back to all chats">${icon('i-back')}<span>All chats</span></a>
            <div class="thead__who"><h2 class="thead__name truncate" id="th-name"></h2><p class="meta truncate" id="th-sub"></p></div>
            <span id="th-badge"></span>
          </header>
          <div class="thead__state" id="th-state"></div>
          <div class="thread thread--main" id="msgs" role="log" aria-label="Messages" aria-live="polite"></div>
          <form class="composer" id="composer" data-quick-send novalidate>
            <label class="sr-only" for="compose">Write a message yourself</label>
            <textarea class="input" id="compose" rows="1" placeholder="Write a message yourself"></textarea>
            <button class="btn btn--primary" type="submit">${icon('i-send')}<span class="composer__label">Send message</span></button>
          </form>
          <p class="field__hint" id="compose-hint">This goes out exactly as you type it, through your laptop.</p>`);
        threadEl.dataset.id = c.id;
        threadEl.dataset.fresh = '1';
      }
      $('#th-name', threadEl).textContent = c.customer;
      $('#th-sub', threadEl).textContent = [c.subject, contactLine].filter(Boolean).join(' · ') || chName(c.channel);
      setHTML($('#th-badge', threadEl), chBadge(c.channel));
      const stateSig = JSON.stringify([c.paused_until, c.opted_out, c.pause_reason, c.contact_id]);
      const stateEl = $('#th-state', threadEl);
      if (stateEl.dataset.sig !== stateSig) {
        stateEl.dataset.sig = stateSig;
        const canOpt = Boolean(c.contact_id);
        setHTML(stateEl, html`
          ${c.paused_until ? html`<p class="banner banner--wait">${icon('i-pause')}<span><b>The agent is staying out of this chat.</b> ${c.pause_reason && c.pause_reason !== 'Paused by you' ? c.pause_reason + '. ' : ''}${c.paused_until - Date.now() < 36 * 3600e3 ? `It comes back ${dayClock(c.paused_until)}.` : 'It stays out until you resume it.'}</span></p>` : ''}
          ${c.opted_out ? html`<p class="banner banner--down">${icon('i-stop')}<span><b>Do not contact.</b> The agent never messages this person.</span></p>` : ''}
          <div class="wrap">
            ${c.paused_until
              ? html`<button type="button" class="btn btn--sm" data-action="resume">${icon('i-play')}Let the agent reply again</button>`
              : html`<button type="button" class="btn btn--sm" data-action="pause">${icon('i-pause')}Pause the agent here</button>`}
            <a class="btn btn--sm" href="#/discounts/new/${encodeURIComponent(c.id)}">${icon('i-tag')}Make discount code</a>
            <button type="button" class="btn btn--ghost btn--sm" data-action="optout" ${canOpt ? '' : raw('disabled title="Not available yet"')}>${c.opted_out ? 'Allow contact again' : 'Mark do not contact'}</button>
            ${canOpt ? '' : html`<span class="meta">Do not contact is not available yet.</span>`}
          </div>`);
      }
      const msgs = $('#msgs', threadEl);
      const before = msgs.childElementCount;
      const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160 || msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 120;
      const serverPending = thread.pending || [];
      const sentBodies = new Set([...thread.messages.filter((m) => m.direction === 'out').slice(-6).map((m) => m.body), ...serverPending.flatMap((p) => p.parts)]);
      localPending = localPending.filter((p) => !sentBodies.has(p.parts[0]) && Date.now() - p.at < 30000);
      const items = [
        ...thread.messages.map((m) => ({ k: 'm' + m.id, m })),
        ...serverPending.map((p) => ({ k: 'p' + p.id, p })),
        ...localPending.map((p) => ({ k: p.id, p })),
      ];
      if (!items.length) { setHTML(msgs, html`<p class="voice muted thread__empty">No messages in this chat yet.</p>`); delete msgs.dataset.synced; } else {
        if (msgs.querySelector('.thread__empty')) { msgs.innerHTML = ''; delete msgs.dataset.synced; }
        syncList(msgs, items, { key: (i) => i.k, render: (i) => (i.m ? message(i.m) : pendingBubble(i.p)), sig: (i) => JSON.stringify(i.m ? [i.m.body, i.m.status, i.m.media?.id] : [i.p.status, i.p.parts]) });
      }
      if (threadEl.dataset.fresh === '1' || (msgs.childElementCount !== before && nearBottom)) {
        delete threadEl.dataset.fresh;
        requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; if (matchMedia('(max-width: 899px)').matches) window.scrollTo(0, document.documentElement.scrollHeight); });
      }
    }

    async function loadThread() {
      if (!activeId) return;
      const id = activeId;
      try {
        const res = await get(`/api/conversations/${encodeURIComponent(id)}`);
        if (id !== activeId) return;
        thread = res; threadError = null;
      } catch (err) { if (err.name === 'AuthError' || id !== activeId) return; if (!thread) threadError = err; }
      paintThread();
    }

    function open(id) {
      activeId = id || null; thread = null; threadError = null; localPending = [];
      paintThread(); paintList();
      if (activeId) loadThread();
    }

    view.addEventListener('input', (e) => {
      if (e.target.id === 'inbox-q') { clearTimeout(searchTimer); searchTimer = setTimeout(() => { q = e.target.value.trim(); loadList(); }, 250); }
      if (e.target.id === 'compose') { e.target.style.height = 'auto'; e.target.style.height = Math.min(160, e.target.scrollHeight + 2) + 'px'; e.target.removeAttribute('aria-invalid'); }
    });
    view.addEventListener('submit', async (e) => {
      if (e.target.id !== 'composer') return;
      e.preventDefault();
      const box = $('#compose', threadEl);
      const text = box.value.trim();
      if (!text) { box.setAttribute('aria-invalid', 'true'); box.focus(); return; }
      const local = { id: 'l' + Date.now(), parts: [text], source: 'manual', status: 'pending', local: true, at: Date.now() };
      localPending.push(local);   // optimistic bubble
      box.value = ''; box.dataset.dirty = '0'; box.style.height = 'auto';
      threadEl.dataset.fresh = '1';
      paintThread();
      try {
        await post(`/api/conversations/${encodeURIComponent(activeId)}/send`, { text });
        toast('Message queued. Your laptop sends it in a moment.');
        loadThread();
      } catch (err) {
        localPending = localPending.filter((p) => p !== local);
        box.value = text; box.dataset.dirty = '1';
        paintThread();
        toastError(err, 'Not sent. Your message is still in the box, try again.');
      }
    });
    view.addEventListener('click', async (e) => {
      const chip = e.target.closest('[data-ch]');
      if (chip) {
        channel = chip.dataset.ch;
        for (const b of view.querySelectorAll('[data-ch]')) b.setAttribute('aria-pressed', String(b === chip));
        return loadList();
      }
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const action = b.dataset.action;
      if (action === 'retry') { loadList(); loadThread(); return; }
      if (action === 'clear') { q = ''; channel = ''; $('#inbox-q', view).value = ''; for (const x of view.querySelectorAll('[data-ch]')) x.setAttribute('aria-pressed', String(x.dataset.ch === '')); return loadList(); }
      if (!thread) return;
      const c = thread.conversation;
      if (action === 'pause' || action === 'resume') {
        const pausing = action === 'pause';
        const before = c.paused_until;
        c.paused_until = pausing ? Date.now() + 365 * 86400e3 : null; c.pause_reason = pausing ? 'Paused by you' : null;   // optimistic
        paintThread();
        try {
          await post(`/api/conversations/${encodeURIComponent(c.id)}/pause`, pausing ? {} : { minutes: 0 });
          toast(pausing ? 'Agent paused in this chat. You reply here now.' : 'Agent is back in this chat.');
          loadList();
        } catch (err) { c.paused_until = before; paintThread(); toastError(err, 'Could not change that. Try again.'); }
        return;
      }
      if (action === 'optout') {
        const next = !c.opted_out;
        if (next && !(await confirmDialog({ title: 'Mark as do not contact?', text: 'The agent stops replying to this person and they never get a checkout reminder. You can undo this later.', confirm: 'Do not contact', danger: true }))) return;
        c.opted_out = next; paintThread();
        try {
          await post(`/api/contacts/${encodeURIComponent(c.contact_id)}/opt-out`, { opted_out: next });
          toast(next ? 'Marked do not contact.' : 'Contact allowed again.');
          loadList();
        } catch (err) { c.opted_out = !next; paintThread(); toastError(err, 'Could not change that. Try again.'); }
      }
    });

    loadList();
    open(activeId);
    return {
      tick: async () => { await Promise.all([loadList(), loadThread()]); },
      update(p) { if ((p[0] || null) !== activeId) { open(p[0]); window.scrollTo(0, 0); } },
    };
  },
};
