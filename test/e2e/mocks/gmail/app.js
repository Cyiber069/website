// Mock Gmail web app (page side). The mailbox itself lives in the test process (server.mjs) so it
// survives page loads; this script fetches it, renders Gmail-like DOM and posts every change back.
//
// Behaviours copied from the real thing because the adapter depends on them:
//   * hash routing: #inbox, #inbox/<16 hex thread or message id>, #search/<query>, #settings
//   * about 100 ms after a thread route the hash is rewritten to an opaque #inbox/FMfcgz... token
//   * views render a moment after the route changes; the list view stays in the page, hidden, without role=main
//   * opening a thread marks it read; older messages of a long thread are collapsed and have no body
//   * Reply opens an inline compose inside the last message's .ip container (class adB), with a signature
//   * Send needs mousedown + mouseup + click, shows "Message sent" in the permanent notice area, and the
//     new message gets its data-legacy-message-id a little later
//
// Test helpers: window.mock.deliver(), window.mock.sent(), window.mock.setDraft(), window.mock.failNextSend.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SIGNATURE_HTML = '<div class="gmail_signature_prefix">--</div><div class="gmail_signature" data-smartmail="gmail_signature"><div>ACX Ebikes</div><div>acxebikes.example</div></div>';

  let state = null; // { account, name, seq, threads: [], sent: [] }
  const tokens = new Map(); // FMfcgz... token -> thread id

  // ---- mailbox --------------------------------------------------------------------------------

  function push() {
    state.rev = (state.rev || 0) + 1; // saves can arrive out of order: the test process keeps the newest
    return fetch('/mock/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) }).catch(() => {});
  }
  const hexId = () => (0x19a8000000000000n + BigInt(state.seq++)).toString(16);
  const threadBy = (id) => state.threads.find((t) => t.id === id || t.messages.some((m) => m.id === id)) || null;
  const textToHtml = (text) => String(text).split('\n').map((l) => (l ? `<div>${esc(l)}</div>` : '<div><br></div>')).join('');
  const dateTitle = (ms) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const inboxThreads = () => state.threads.filter((t) => t.category === 'primary').sort((a, b) => lastOf(b).date - lastOf(a).date);
  const lastOf = (t) => t.messages[t.messages.length - 1];

  /** A new email arrives. With threadId it is a reply in that thread and quotes the previous message. */
  function deliver({ from, subject, text, html, threadId, category = 'primary', unsub = false }) {
    let thread = threadId ? threadBy(threadId) : null;
    let body = html || textToHtml(text);
    if (thread && !html) {
      const prev = lastOf(thread);
      body += `<br><div class="gmail_quote"><div class="gmail_attr">On ${esc(dateTitle(prev.date))} ${esc(prev.from.name)} &lt;${esc(prev.from.email)}&gt; wrote:<br></div><blockquote class="gmail_quote">${prev.html}</blockquote></div>`;
    }
    if (!thread) {
      thread = { id: null, subject: subject || '(no subject)', category, unread: true, draft: null, messages: [] };
      state.threads.push(thread);
    }
    const msg = { id: hexId(), from, to: { name: state.name, email: state.account }, date: Date.now(), html: body, unsub, legacy: true };
    if (!thread.id) thread.id = msg.id; // like Gmail: a thread's id is the id of its first message
    thread.messages.push(msg);
    thread.unread = true;
    push();
    render();
    return { threadId: thread.id, messageId: msg.id };
  }

  // ---- routing ----------------------------------------------------------------------------------

  let shown = { view: '', threadId: null, search: false };
  let routeTimer = null;

  function parseRoute() {
    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (!hash) return { view: 'list' };
    if (hash.startsWith('settings')) return { view: 'settings' };
    const parts = hash.split('/');
    const tail = parts[parts.length - 1];
    if (parts.length >= 2 && parts[0] !== 'search' || (parts[0] === 'search' && parts.length >= 3)) {
      const id = tokens.get(tail) || tail.toLowerCase();
      return { view: 'thread', id };
    }
    if (parts[0] === 'search') return { view: 'list', search: /is:unread/.test(hash) };
    return { view: 'list' };
  }

  function onRoute() {
    const r = parseRoute();
    clearTimeout(routeTimer);
    if (r.view === 'thread') {
      const thread = threadBy(r.id);
      if (!thread) { location.hash = '#inbox'; return; }
      if (shown.view === 'thread' && shown.threadId === thread.id) return; // the token rewrite of the same thread
      // Gmail swaps the hex id for its own token almost at once.
      setTimeout(() => {
        if (parseRoute().view !== 'thread') return;
        const token = `FMfcgz${btoa(thread.id).replace(/=/g, '')}`;
        tokens.set(token, thread.id);
        history.replaceState(null, '', `#inbox/${token}`);
      }, 100);
      routeTimer = setTimeout(() => showThread(thread), 160);
    } else if (r.view === 'settings') {
      show('settings');
    } else {
      routeTimer = setTimeout(() => { shown.search = !!r.search; show('list'); renderList(); }, r.search ? 220 : 60);
    }
  }

  /** Make one view the active one. The others stay in the page without role=main, as in Gmail. */
  function show(view) {
    for (const name of ['list', 'thread', 'settings']) {
      const el = $(`view-${name}`);
      if (name === view) { el.hidden = false; el.setAttribute('role', 'main'); } else { el.hidden = true; el.removeAttribute('role'); }
    }
    if (view !== 'thread') { shown.threadId = null; $('view-thread').textContent = ''; }
    shown.view = view;
  }

  function render() {
    const unread = state.threads.filter((t) => t.category === 'primary' && t.unread).length;
    document.title = `Inbox${unread ? ` (${unread})` : ''} - ${state.account} - Gmail`;
    renderList();
  }

  // ---- list ---------------------------------------------------------------------------------------

  function renderList() {
    const rows = $('rows');
    rows.textContent = '';
    const list = inboxThreads().filter((t) => !shown.search || t.unread);
    $('empty').hidden = list.length > 0;
    for (const t of list) {
      const last = lastOf(t);
      const first = t.messages[0];
      const tr = document.createElement('tr');
      tr.className = `zA ${t.unread ? 'zE' : 'yO'}`;
      tr.setAttribute('role', 'row');
      const text = last.html.replace(/<div class="gmail_quote">[\s\S]*$/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      tr.innerHTML = `
        <td class="xY"><div role="checkbox" aria-checked="false"></div></td>
        <td class="apU xY"><span class="T-KT" role="button"></span></td>
        <td class="yX xY"><div class="yW"><span class="bA4"><span email="${esc(first.from.email)}" name="${esc(first.from.name)}" class="${t.unread ? 'zF' : 'yP'}">${esc(first.from.name)}</span></span>${t.messages.length > 1 ? ` <span class="bx0">${t.messages.length}</span>` : ''}${t.draft != null ? ' <span class="boq">Draft</span>' : ''}</div></td>
        <td class="xY a4W"><div class="xS"><div class="xT"><div class="y6"><span id=":s${esc(t.id.slice(-4))}" class="bog"><span data-thread-id="#thread-f:${BigInt('0x' + t.id)}" data-legacy-thread-id="${t.id}" data-legacy-last-message-id="${last.id}">${esc(t.subject)}</span></span></div><span class="y2"><span class="Zt">&nbsp;-&nbsp;</span>${esc(text.slice(0, 90))}</span></div></div></td>
        <td class="xW xY"><span title="${esc(dateTitle(last.date))}"><span>${esc(new Date(last.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</span></span></td>`;
      tr.addEventListener('click', () => { location.hash = `#inbox/${t.id}`; });
      rows.appendChild(tr);
    }
  }

  // ---- thread -------------------------------------------------------------------------------------

  function showThread(thread) {
    if (thread.unread) { thread.unread = false; push(); render(); } // opening an email marks it read
    shown.threadId = thread.id;
    shown.expanded = thread.messages.length < 3; // long threads start with the older messages collapsed
    show('thread');
    shown.threadId = thread.id;
    renderThread(thread);
    if (thread.draft != null) openCompose(thread, thread.draft); // Gmail restores a saved draft
  }

  function renderThread(thread, { onlyLast = false } = {}) {
    const view = $('view-thread');
    const expandedFrom = shown.expanded && !onlyLast ? 0 : thread.messages.length - 1;
    const items = thread.messages.map((m, i) => {
      if (i < expandedFrom) {
        return `<div role="listitem" class="kv"><span class="yP" email="${esc(m.from.email)}" name="${esc(m.from.name)}">${esc(m.from.name)}</span> <span class="iA g6">${esc(m.html.replace(/<[^>]+>/g, ' ').slice(0, 60))}</span></div>`;
      }
      return `<div role="listitem" class="h7">
        <div class="adn ads" data-message-id="#msg-${m.legacy ? 'f' : 'a'}:${m.legacy ? BigInt('0x' + m.id) : `r${m.id.slice(-6)}`}"${m.legacy ? ` data-legacy-message-id="${m.id}"` : ''} data-mock-id="${m.id}">
          <table><tbody><tr class="acZ">
            <td class="gF gK"><h3 class="iw"><span class="qu"><span email="${esc(m.from.email)}" name="${esc(m.from.name)}" class="gD">${esc(m.from.name)}</span> <span class="go">&lt;${esc(m.from.email)}&gt;</span></span></h3>${m.unsub ? ' <span class="Ca" role="link" tabindex="0">Unsubscribe</span>' : ''}</td>
            <td class="gH"><div class="gK"><span class="g3" role="gridcell" title="${esc(dateTitle(m.date))}">${esc(new Date(m.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</span></div></td>
            <td class="gH"><div role="button" class="aaq" aria-label="Reply" data-tooltip="Reply"></div><button class="Wsq5Cf" aria-label="More"></button></td>
          </tr></tbody></table>
          <div class="hb">to <span email="${esc(m.to.email)}" name="${esc(m.to.name)}" class="g2">${esc(m.to.email === state.account ? 'me' : m.to.name)}</span></div>
          <div class="ii gt"><div class="a3s aiL">${m.html}</div></div>
          <div class="ip"></div>
        </div>
      </div>`;
    });
    view.innerHTML = `
      <div gh="mtb"><div class="lS" role="button" act="19">Back</div><div act="7" role="button">Archive</div><div act="10" role="button">Delete</div><div act="2" role="button">Mark unread</div></div>
      <div class="g id"><div class="a98 iY">
        <div class="ha"><h2 class="hP" data-legacy-thread-id="${thread.id}" data-thread-perm-id="thread-f:${BigInt('0x' + thread.id)}">${esc(thread.subject)}</h2>
          ${expandedFrom > 0 ? '<div role="button" aria-label="Expand all" id="expand-all"><img class="gx" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>' : ''}</div>
        <div role="list">${items.join('')}</div>
        <div class="amn"><span class="ams bkH" role="link" tabindex="0">Reply</span><span class="ams bkG" role="link" tabindex="0">Forward</span></div>
      </div></div>`;
    view.querySelector('.lS').addEventListener('click', () => { location.hash = '#inbox'; });
    const expand = view.querySelector('#expand-all');
    const expandNow = () => setTimeout(() => { if (shown.threadId === thread.id) { shown.expanded = true; renderThread(thread); } }, 120);
    if (expand) expand.addEventListener('click', expandNow);
    view.querySelectorAll('.kv').forEach((el) => el.addEventListener('click', expandNow));
    const reply = () => setTimeout(() => { if (shown.threadId === thread.id && !view.querySelector('.M9')) openCompose(thread, ''); }, 140);
    view.querySelector('.bkH').addEventListener('click', reply);
    view.querySelectorAll('.aaq').forEach((b) => b.addEventListener('click', reply));
  }

  // ---- compose ------------------------------------------------------------------------------------

  /** What the person typed: the editor content without the signature block. */
  function userText(editable) {
    const clone = editable.cloneNode(true);
    clone.querySelectorAll('.gmail_signature, .gmail_signature_prefix, .gmail_quote').forEach((n) => n.remove());
    return clone.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  function composeHtml({ to = '', subject = '', draft = '', standalone = false }) {
    return `<div class="M9"><form onsubmit="return false">
      <input type="hidden" name="draft" value="${draft ? 'r-123' : 'undefined'}"><input type="hidden" name="rm" value="">
      ${standalone ? `<div class="anm" name="to">${to.split(',').filter(Boolean).map((a) => `<div role="option" data-name="${esc(a)}" data-hovercard-id="${esc(a)}">${esc(a)}</div>`).join('')}<input role="combobox" aria-autocomplete="list" aria-label="To recipients"></div>` : ''}
      <input name="subjectbox" placeholder="Subject" value="${esc(subject)}"${standalone ? '' : ' style="display:none"'}>
      <div class="Ap"><div class="Am Al editable" g_editable="true" role="textbox" aria-multiline="true" aria-label="Message Body" contenteditable="true">${draft ? textToHtml(draft) : ''}<div><br></div>${SIGNATURE_HTML}</div></div>
      ${standalone ? '' : '<div class="ajR" role="button" aria-label="Show trimmed content">...</div>'}
      <div class="IZ"><div class="Up"><div><div role="button" class="T-I T-I-atl" aria-label="Send (Ctrl-Enter)" data-tooltip="Send (Ctrl-Enter)">Send</div><div role="button" class="T-I" aria-haspopup="true" aria-label="More send options"></div></div></div></div>
      <div class="gU"><div class="oh" role="button" aria-label="Discard draft" data-tooltip="Discard draft">Discard</div></div>
    </form></div>`;
  }

  /** Gmail's Send button reacts to a real press: mousedown, then mouseup, then click. */
  function onPress(btn, fn) {
    let down = false;
    let up = false;
    btn.addEventListener('mousedown', () => { down = true; up = false; });
    btn.addEventListener('mouseup', () => { up = down; });
    btn.addEventListener('click', () => { if (down && up) fn(); down = false; up = false; });
  }

  function notice(text) {
    const el = $('notice');
    el.querySelector('.bAq').textContent = text;
    el.style.display = '';
    el.parentElement.parentElement.classList.add('bAp');
    clearTimeout(notice.timer);
    notice.timer = setTimeout(() => { el.style.display = 'none'; el.parentElement.parentElement.classList.remove('bAp'); }, 6000);
  }

  function openCompose(thread, draft) {
    const view = $('view-thread');
    const holders = view.querySelectorAll('.ip');
    const ip = holders[holders.length - 1];
    if (!ip) return;
    ip.classList.add('adB');
    ip.innerHTML = composeHtml({ subject: `Re: ${thread.subject}`, draft });
    const editable = ip.querySelector('[g_editable]');
    let inputs = 0;
    editable.addEventListener('input', () => { inputs++; thread.draft = userText(editable); push(); }); // autosave
    const close = () => { ip.classList.remove('adB'); ip.textContent = ''; thread.draft = null; };
    onPress(ip.querySelector('.gU .oh'), () => { close(); push(); });
    onPress(ip.querySelector('.T-I-atl'), () => {
      const mode = window.mock.failNextSend;
      window.mock.failNextSend = null;
      if (mode === 'silent') return; // nothing visible happens
      if (mode === 'error') { notice('Message not sent. An error occurred, try again.'); return; }
      const text = userText(editable);
      const to = [...thread.messages].reverse().find((m) => m.from.email !== state.account)?.from || lastOf(thread).to;
      const prev = lastOf(thread);
      const html = `${editable.innerHTML}<br><div class="gmail_quote"><div class="gmail_attr">On ${esc(dateTitle(prev.date))} ${esc(prev.from.name)} wrote:<br></div><blockquote class="gmail_quote">${prev.html}</blockquote></div>`;
      const msg = { id: hexId(), from: { name: state.name, email: state.account }, to, date: Date.now(), html, unsub: false, legacy: false };
      thread.messages.push(msg);
      state.sent.push({ kind: 'reply', threadId: thread.id, messageId: msg.id, to: to.email, subject: `Re: ${thread.subject}`, text, inputEvents: inputs, at: Date.now() });
      close();
      push();
      // Gmail collapses the earlier messages of a long thread when the new one is added.
      renderThread(thread, { onlyLast: thread.messages.length >= 3 });
      render();
      notice('Message sent');
      // The permanent (legacy) id arrives once the server has the message.
      setTimeout(() => {
        msg.legacy = true;
        push();
        const el = view.querySelector(`[data-mock-id="${msg.id}"]`);
        if (el) { el.setAttribute('data-legacy-message-id', msg.id); el.setAttribute('data-message-id', `#msg-f:${BigInt('0x' + msg.id)}`); }
      }, 450);
    });
  }

  /** The full window compose page behind ?to=...&su=...&tf=cm (and the older ?view=cm form). */
  function standaloneCompose(params) {
    document.body.classList.add('xE', 'xp');
    document.title = 'Compose Mail - Gmail';
    $('loading').remove();
    $('views').hidden = false;
    for (const name of ['list', 'settings']) $(`view-${name}`).remove();
    const view = $('view-thread');
    view.hidden = false;
    view.setAttribute('role', 'main');
    setTimeout(() => {
      view.innerHTML = composeHtml({ to: params.get('to') || '', subject: params.get('su') || '', draft: params.get('body') || '', standalone: true });
      const editable = view.querySelector('[g_editable]');
      onPress(view.querySelector('.gU .oh'), () => { view.textContent = ''; });
      onPress(view.querySelector('.T-I-atl'), () => {
        const to = Array.from(view.querySelectorAll('[name=to] [role=option]')).map((c) => c.getAttribute('data-hovercard-id'));
        if (!to.length) { notice('Please specify at least one recipient.'); return; }
        const subject = view.querySelector('input[name=subjectbox]').value;
        const text = userText(editable);
        const msg = { id: hexId(), from: { name: state.name, email: state.account }, to: { name: to[0], email: to[0] }, date: Date.now(), html: editable.innerHTML, unsub: false, legacy: true };
        state.threads.push({ id: msg.id, subject, category: 'sent', unread: false, draft: null, messages: [msg] });
        state.sent.push({ kind: 'new', threadId: msg.id, messageId: msg.id, to: to.join(','), subject, text, at: Date.now() });
        push();
        view.innerHTML = '<div style="padding:40px">Your message has been sent.</div>';
        notice('Your message has been sent.');
      });
    }, 200);
  }

  // ---- start ----------------------------------------------------------------------------------------

  window.mock = {
    deliver,
    sent: () => state.sent.slice(),
    setDraft(threadId, text) { const t = threadBy(threadId); t.draft = text; push(); renderList(); },
    thread: (id) => threadBy(id),
    failNextSend: null,
    get state() { return state; },
  };

  fetch('/mock/state').then((r) => r.json()).then((s) => {
    state = s;
    const params = new URLSearchParams(location.search);
    if (params.get('tf') === 'cm' || params.get('view') === 'cm') { standaloneCompose(params); return; }
    // Gmail shows its loading screen for a moment before the app appears.
    setTimeout(() => {
      $('loading').remove();
      $('views').hidden = false;
      if (!location.hash) history.replaceState(null, '', '#inbox');
      window.addEventListener('hashchange', onRoute);
      render();
      const r = parseRoute();
      if (r.view === 'list') { show('list'); renderList(); } else onRoute();
      document.body.dataset.mockReady = '1';
    }, 250);
  });
})();
