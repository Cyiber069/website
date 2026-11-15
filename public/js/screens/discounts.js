// Discount codes: codes for creators and sponsorship asks. Made in Shopify when it is connected,
// then a message to the customer in the same chat.
import { get, post, del } from '../api.js';
import { $, html, raw, icon, setHTML, chBadge, chName, toast, toastError, friendly, unavailable, skeletonCards, emptyState, busy, confirmDialog, timeTag, refreshTimes, syncList } from '../ui.js';

const DEFAULT_AMOUNT = 20;
const DEFAULT_APPLIES = 'kits, bundles and batteries';

const pounds = (n) => `£${Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2)}`;
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const dateOnly = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });

/** Handle if there is one, else the first name, upper case, letters and digits only, plus the amount. */
export function suggestCode(customer, handle, amount) {
  const tail = String(Number.isInteger(Number(amount)) && Number(amount) > 0 ? Number(amount) : DEFAULT_AMOUNT);
  let base = cleanCode(String(handle || '').replace(/^@/, ''));
  if (base.length < 2) base = cleanCode(String(customer || '').trim().split(/\s+/)[0]);
  if (base.length < 2) base = 'ACX';
  return (base.slice(0, 30 - tail.length) + tail);
}
export function messageFor(code, amount, appliesTo) {
  return `Your discount code ${code || 'CODE'} is now live!! It's ${pounds(amount || DEFAULT_AMOUNT)} off all ${appliesTo || DEFAULT_APPLIES}`;
}

const STATUS = {
  draft: ['Draft', ''],
  live: ['Live', 'tag--live'],
  sent: ['Sent', 'tag--live'],
  failed: ['Failed', 'tag--down'],
};
const SHOPIFY = {
  created: 'Made in Shopify',
  owner_confirmed: 'You made it in Shopify',
  not_connected: 'Not in Shopify yet',
  failed: 'Shopify did not make it',
};
function messageLine(d) {
  if (d.status === 'sent') return d.sent_at ? html`Message sent ${timeTag(d.sent_at)}` : 'Message sent';
  if (d.status === 'failed') return d.error || 'The message did not send.';
  if (d.message_status === 'pending' || d.message_status === 'leased') return 'Message waiting for your laptop';
  return 'Message not sent yet';
}

function card(d) {
  const [label, cls] = STATUS[d.status] || STATUS.draft;
  const canSend = d.status === 'draft' || d.status === 'failed' || (d.status === 'live' && !d.outbox_id);
  return html`<li class="dcode">
    <div class="dcode__top">
      <span class="dcode__code num">${d.code}</span>
      <span class="tag ${cls}">${label}</span>
    </div>
    <p class="dcode__who">${chBadge(d.channel, true)}<b class="truncate">${d.customer}</b><span class="meta num">${pounds(d.amount)} off</span></p>
    <p class="meta">${d.applies_to}${d.expires_at ? ` · ends ${dateOnly(d.expires_at)}` : ''}${d.usage_limit ? ` · ${d.usage_limit === 1 ? 'one use' : `${d.usage_limit} uses`}` : ''}</p>
    <ul class="dcode__facts">
      <li><span class="dot ${d.shopify_status === 'created' || d.shopify_status === 'owner_confirmed' ? '' : 'dot--wait'}" aria-hidden="true"></span>${SHOPIFY[d.shopify_status] || 'Not in Shopify yet'}</li>
      <li><span class="dot ${d.status === 'sent' ? '' : d.status === 'failed' ? 'dot--down' : 'dot--pause'}" aria-hidden="true"></span>${messageLine(d)}</li>
      <li class="meta">Made ${timeTag(d.created_at)}</li>
    </ul>
    ${d.status === 'draft' && d.error ? html`<p class="banner banner--wait">${icon('i-shop')}<span>${d.error}</span></p>` : ''}
    <div class="wrap">
      ${canSend ? html`<button type="button" class="btn btn--sm ${d.status === 'draft' ? '' : 'btn--primary'}" data-action="send" data-id="${d.id}">${icon('i-send')}${d.status === 'failed' ? 'Send again' : 'Send message'}</button>` : ''}
      ${d.conversation_id ? html`<a class="btn btn--ghost btn--sm" href="#/inbox/${d.conversation_id}">Open chat</a>` : ''}
      ${d.status === 'draft' && !d.outbox_id ? html`<button type="button" class="btn btn--ghost btn--sm" data-action="remove" data-id="${d.id}">${icon('i-trash')}Remove</button>` : ''}
    </div>
  </li>`;
}

export default {
  title: 'Discount codes',
  mount(view, ctx, params) {
    let data = null;
    let error = null;
    let mode = params[0] === 'new' ? 'form' : 'list';
    let form = null;          // { conv, code, amount, applies, expires, uses, message, codeTouched, msgTouched }
    let convs = null;
    let convQ = '';
    let convTimer = null;
    let result = null;        // what Done said, shown above the form
    let seq = 0;

    function freshForm() {
      return { conv: null, handle: null, code: '', amount: DEFAULT_AMOUNT, applies: DEFAULT_APPLIES, expires: '', uses: '', message: '', codeTouched: false, msgTouched: false };
    }

    function paint() {
      if (!data) { setHTML(view, error ? unavailable('Discount codes', error) : skeletonCards(2)); return; }
      const list = data.discounts || [];
      const connected = data.shopify?.connected;
      setHTML(view, html`
        ${!connected ? html`<p class="banner banner--wait">${icon('i-shop')}<span><b>Shopify is not connected.</b> You can still save a code here. Make it in Shopify yourself, then send the message. <a href="#/connections">Connect Shopify</a></span></p>` : ''}
        ${mode === 'form' ? html`<section class="card stack" id="dc-form-card" aria-labelledby="dc-form-h"></section>`
          : html`<section class="card dcode__lead"><div><h2 class="eyebrow">For creators and sponsors</h2><p class="meta">Make a code for someone who asked in a chat. It is sent to them in the same chat.</p></div>
              <a class="btn btn--primary" href="#/discounts/new">${icon('i-tag')}Make a discount code</a></section>`}
        <section class="card" aria-labelledby="dc-list-h">
          <div class="card__head"><h2 class="eyebrow" id="dc-list-h">Your codes</h2><span class="meta num">${list.length || ''}</span></div>
          ${list.length ? html`<ul class="dcodes" id="dc-list"></ul>`
            : html`<p class="voice muted pad">No codes yet. When a creator asks for a code, open the chat in Inbox and press Make discount code.</p>`}
        </section>`);
      paintList();
      if (mode === 'form') paintForm();
    }

    function paintList() {
      const ul = $('#dc-list', view);
      if (!ul || !data) return;
      syncList(ul, data.discounts, { key: (d) => d.id, render: card, sig: (d) => JSON.stringify(d) });
      refreshTimes(ul);
    }

    // ---- the form ----------------------------------------------------------------------------------
    function paintForm() {
      const box = $('#dc-form-card', view);
      if (!box) return;
      const f = form;
      const message = f.msgTouched ? f.message : messageFor(cleanCode(f.code), f.amount, f.applies);
      setHTML(box, html`
        <div class="card__head"><div><h2 class="eyebrow" id="dc-form-h">New discount code</h2><p class="meta">Fill this in, check the message, then press Done.</p></div>
          <a class="btn btn--ghost btn--sm" href="#/discounts">Cancel</a></div>
        ${result ? resultBlock(result) : ''}
        <form class="stack form" id="dc-form" novalidate>
          <div class="field"><span class="field__label"><span class="stepno">1</span> Who is it for</span>
            ${f.conv ? html`<div class="picked">${chBadge(f.conv.channel, true)}<span class="picked__body"><b class="truncate">${f.conv.customer}</b><span class="meta truncate">${[chName(f.conv.channel), f.handle ? '@' + String(f.handle).replace(/^@/, '') : ''].filter(Boolean).join(' · ')}</span></span><button type="button" class="btn btn--ghost btn--sm" data-action="change-conv">Change</button></div>`
              : html`<div class="search"><label class="sr-only" for="dc-q">Search your chats</label>${icon('i-search', 'search__icon')}<input class="input" id="dc-q" type="search" placeholder="Search by name or message" autocomplete="off" value="${convQ}"></div>
                <ul class="convs dc-convs" id="dc-convs">${convRows()}</ul>
                <p class="field__hint">Pick the chat the customer asked in. The message goes there.</p>`}
          </div>
          <div class="grid grid--2">
            <div class="field"><label class="field__label" for="dc-code"><span class="stepno">2</span> Code</label>
              <input class="input dc-codein num" id="dc-code" name="code" value="${f.code}" maxlength="30" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="NAME20">
              <p class="field__hint">Letters and numbers only. 3 to 30 of them.</p></div>
            <div class="field"><label class="field__label" for="dc-amount">Amount off</label>
              <div class="moneyin"><span aria-hidden="true">£</span><input class="input num" id="dc-amount" name="amount" type="number" min="1" max="500" step="0.01" inputmode="decimal" value="${f.amount}"></div>
              <p class="field__hint">From £1 to £500, taken off the order.</p></div>
          </div>
          <div class="field"><label class="field__label" for="dc-applies">What it works on</label>
            <input class="input" id="dc-applies" name="applies" value="${f.applies}" maxlength="120" autocomplete="off">
            <p class="field__hint">In Shopify it works on your Kits, Bundles and Batteries collections. This wording is for the message.</p></div>
          <details class="fold fold--in" ${f.expires || f.uses ? raw('open') : ''}><summary><span><b>Last day and how many uses</b> <span class="meta">optional</span></span></summary>
            <div class="grid grid--2 fold__body">
              <div class="field"><label class="field__label" for="dc-exp">Last day it works</label><input class="input" id="dc-exp" name="expires" type="date" value="${f.expires}"><p class="field__hint">Empty means it never runs out.</p></div>
              <div class="field"><label class="field__label" for="dc-uses">Times it can be used</label><input class="input num" id="dc-uses" name="uses" type="number" min="1" max="100000" inputmode="numeric" value="${f.uses}" placeholder="No limit"><p class="field__hint">Across all customers.</p></div>
            </div></details>
          <div class="field"><label class="field__label" for="dc-msg"><span class="stepno">3</span> Message to the customer</label>
            <textarea class="input" id="dc-msg" name="message" rows="3" maxlength="1000">${message}</textarea>
            <p class="field__hint">Goes out exactly as written, in the same chat, through your laptop. <button type="button" class="linkbtn" data-action="reset-msg" id="dc-reset" ${f.msgTouched ? '' : raw('hidden')}>Use the standard message</button></p></div>
          <div class="thread thread--mini" aria-label="Preview"><div class="msg msg--owner"><span class="msg__by">Preview</span><div class="bubble" id="dc-preview">${message}</div></div></div>
          <p class="form-error" role="alert" hidden></p>
          <div class="wrap"><button type="submit" class="btn btn--primary btn--lg">${icon('i-check')}Done</button><span class="meta">${data.shopify?.connected ? 'Makes the code in Shopify, then sends the message.' : 'Saves the code. Shopify is not connected, so you make it there yourself.'}</span></div>
        </form>`);
    }

    function resultBlock(r) {
      if (r.ok) return html`<p class="banner banner--ok" role="status">${icon('i-check')}<span><b>${r.code} is live in Shopify.</b> ${r.queued ? 'The message is waiting for your laptop to send it.' : ''}</span></p>`;
      return html`<div class="banner banner--wait" role="alert">${icon('i-shop')}<div class="stack"><span><b>${r.code} is saved as a draft.</b> ${r.message}</span>
        <div class="wrap"><button type="button" class="btn btn--sm btn--primary" data-action="send" data-id="${r.id}" data-confirmed="1">${icon('i-send')}It is in Shopify. Send message</button><a class="btn btn--ghost btn--sm" href="#/discounts">Keep as draft</a></div></div></div>`;
    }

    function convRows() {
      if (!convs) return html`<li class="meta pad">Loading your chats</li>`;
      if (!convs.length) return html`<li class="meta pad">${convQ ? 'No chats match that search.' : 'No chats yet.'}</li>`;
      return html`${convs.slice(0, 30).map((c) => html`<li><button type="button" class="conv" data-pick="${c.id}">${chBadge(c.channel, true)}<span class="conv__main"><span class="conv__top"><b class="truncate">${c.customer}</b><span class="meta">${timeTag(c.updated_at, 'short')}</span></span><span class="conv__preview truncate">${c.preview || c.subject || chName(c.channel)}</span></span></button></li>`)}`;
    }

    async function loadConvs() {
      const mine = ++seq;
      try {
        const res = await get(`/api/conversations?q=${encodeURIComponent(convQ)}`);
        if (mine !== seq) return;
        convs = res.conversations || [];
      } catch (err) { if (err.name === 'AuthError') return; convs = []; toastError(err, 'Could not load your chats.'); }
      const ul = $('#dc-convs', view);
      if (ul) setHTML(ul, convRows());
    }

    async function pick(id, known) {
      let conv = known || convs?.find((c) => c.id === id) || null;
      let handle = null;
      try {
        const res = await get(`/api/conversations/${encodeURIComponent(id)}`);
        const c = res.conversation;
        conv = { id: c.id, channel: c.channel, customer: c.customer };
        handle = c.handle;
      } catch (err) {
        if (err.name === 'AuthError') return;
        if (!conv) { toastError(err, 'Could not open that chat.'); return; }
      }
      form.conv = conv; form.handle = handle;
      if (!form.codeTouched) form.code = suggestCode(conv.customer, handle, form.amount);
      paintForm();
      $('#dc-code', view)?.focus();
    }

    function openForm(convId) {
      mode = 'form'; result = null; form = freshForm(); convs = null; convQ = '';
      paint();
      if (convId) pick(convId);
      else loadConvs();
    }

    function readForm() {
      const f = $('#dc-form', view);
      if (!f) return;
      form.code = f.elements.code.value;
      form.amount = f.elements.amount.value;
      form.applies = f.elements.applies.value;
      form.expires = f.elements.expires.value;
      form.uses = f.elements.uses.value;
      form.message = f.elements.message.value;
    }

    function syncPreview() {
      if (!form.msgTouched) {
        const m = messageFor(cleanCode(form.code), form.amount, form.applies);
        const box = $('#dc-msg', view); if (box) box.value = m;
        form.message = m;
      }
      const p = $('#dc-preview', view); if (p) p.textContent = form.msgTouched ? form.message : messageFor(cleanCode(form.code), form.amount, form.applies);
    }

    async function submit(btn) {
      readForm();
      const f = $('#dc-form', view); const errBox = f.querySelector('.form-error');
      const fail = (m, el) => { errBox.textContent = m; errBox.hidden = false; if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } };
      for (const el of f.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
      const code = cleanCode(form.code);
      const amount = Number(form.amount);
      if (!form.conv) return fail('Pick who the code is for first.', $('#dc-q', view));
      if (code.length < 3 || code.length > 30 || code !== String(form.code).trim().toUpperCase()) return fail('The code should be 3 to 30 letters or numbers, no spaces or symbols.', f.elements.code);
      if (!(amount >= 1 && amount <= 500)) return fail('The amount should be between £1 and £500.', f.elements.amount);
      if (form.uses && !(Number.isInteger(Number(form.uses)) && Number(form.uses) >= 1)) return fail('Times it can be used should be a whole number, or empty for no limit.', f.elements.uses);
      const message = (form.msgTouched ? form.message : messageFor(code, amount, form.applies)).trim();
      if (!message) return fail('Write the message to the customer.', f.elements.message);
      if (!message.includes(code) && !(await confirmDialog({ title: 'The message does not have the code', text: `The customer would not see ${code}. Send it anyway?`, confirm: 'Send anyway', cancel: 'Go back' }))) return;
      errBox.hidden = true;
      await busy(btn, async () => {
        try {
          const res = await post('/api/discounts', {
            conversation_id: form.conv.id, code, amount, applies_to: form.applies.trim(), message_text: message,
            expires_at: form.expires || null, usage_limit: form.uses ? Number(form.uses) : null, send: true,
          });
          if (res.shopify?.ok) {
            toast(`${code} is live. The message goes out from your laptop in a moment.`, { ms: 6000 });
            mode = 'list'; form = null; ctx.go('#/discounts');
            await load();
          } else {
            result = { ok: false, id: res.discount.id, code, message: res.shopify?.message || 'Shopify did not make the code.' };
            await load({ withForm: true });
            view.querySelector('#dc-form-card')?.scrollIntoView({ block: 'start' });
          }
        } catch (err) {
          const map = { code: f.elements.code, amount: f.elements.amount, expires_at: f.elements.expires, usage_limit: f.elements.uses, conversation_id: $('#dc-q', view) };
          fail(friendly(err, 'Not saved. Try again.'), map[err.extra?.field]);
        }
      });
    }

    const askExists = (code, text) => confirmDialog({ title: `Is ${code} in Shopify?`, text, confirm: 'It is in Shopify. Send', cancel: 'Not yet' });

    // confirmed: the owner already pressed a button that says the code is in Shopify.
    async function send(id, btn, confirmed) {
      const d = data?.discounts?.find((x) => x.id === id);
      const code = d?.code || result?.code || 'the code';
      const live = d && (d.shopify_status === 'created' || d.shopify_status === 'owner_confirmed');
      let confirmExists = Boolean(confirmed);
      if (!live && !confirmExists && !data?.shopify?.connected) {
        if (!(await askExists(code, `Only send it once you made ${code} in Shopify. Otherwise the customer gets a code that does not work.`))) return;
        confirmExists = true;
      }
      await busy(btn, async () => {
        try {
          const res = await post(`/api/discounts/${encodeURIComponent(id)}/send`, confirmExists ? { confirm_exists: true } : {});
          toast(res.already_queued ? 'That message was already sent or is waiting to send.' : 'Message queued. Your laptop sends it in a moment.');
          if (result?.id === id) { result = null; form = null; mode = 'list'; ctx.go('#/discounts'); }
          await load();
        } catch (err) {
          if (err.code === 'needs_confirm') {
            await load();
            if (await askExists(code, `${err.userMessage} If you made it in Shopify yourself, you can send the message now.`)) return send(id, null, true);
            return;
          }
          toastError(err, 'Not sent. Try again.');
        }
      });
    }

    // withForm: also repaint the form (after Done), keeping what the owner typed.
    async function load({ withForm = false } = {}) {
      try { data = await get('/api/discounts'); error = null; }
      catch (err) { if (err.name === 'AuthError') return; if (!data) error = err; else return; }
      if (mode === 'form' && form && $('#dc-form-card', view)) {
        readForm();
        if (withForm || (!$('#dc-list', view) && data.discounts.length)) { paint(); return; }
        paintList();
        return;
      }
      paint();
    }

    view.addEventListener('input', (e) => {
      const t = e.target;
      if (t.id === 'dc-q') { clearTimeout(convTimer); convTimer = setTimeout(() => { convQ = t.value.trim(); loadConvs(); }, 250); return; }
      if (!form || !t.closest('#dc-form')) return;
      t.removeAttribute('aria-invalid');
      if (t.id === 'dc-code') {
        const at = t.selectionStart; const v = t.value.toUpperCase();
        if (v !== t.value) { t.value = v; try { t.setSelectionRange(at, at); } catch { /* number inputs */ } }
        form.code = v; form.codeTouched = Boolean(v);
      }
      if (t.id === 'dc-amount') {
        form.amount = t.value;
        if (!form.codeTouched && form.conv) { form.code = suggestCode(form.conv.customer, form.handle, t.value); $('#dc-code', view).value = form.code; }
      }
      if (t.id === 'dc-applies') form.applies = t.value;
      if (t.id === 'dc-msg') { form.message = t.value; form.msgTouched = true; $('#dc-reset', view).hidden = false; }
      syncPreview();
    });
    view.addEventListener('submit', (e) => {
      if (e.target.id !== 'dc-form') return;
      e.preventDefault();
      submit(e.target.querySelector('[type=submit]'));
    });
    view.addEventListener('click', async (e) => {
      const p = e.target.closest('[data-pick]');
      if (p) { readForm(); return pick(p.dataset.pick); }
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const action = b.dataset.action;
      if (action === 'retry') return load();
      if (action === 'change-conv') { readForm(); form.conv = null; form.handle = null; paintForm(); loadConvs(); $('#dc-q', view)?.focus(); return; }
      if (action === 'reset-msg') { readForm(); form.msgTouched = false; paintForm(); return; }
      if (action === 'send') return send(b.dataset.id, b, b.dataset.confirmed === '1');
      if (action === 'remove') {
        const d = data?.discounts?.find((x) => x.id === b.dataset.id);
        if (!(await confirmDialog({ title: `Remove ${d?.code || 'this draft'}?`, text: 'It is only removed here. Nothing was sent to the customer.', confirm: 'Remove', danger: true }))) return;
        try { await del(`/api/discounts/${encodeURIComponent(b.dataset.id)}`); toast('Draft removed.'); await load(); }
        catch (err) { toastError(err, 'Could not remove it. Try again.'); }
      }
    });

    if (mode === 'form') { form = freshForm(); }
    load().then(() => { if (mode === 'form') openForm(params[1]); });
    return {
      tick: async () => { if (mode === 'list' || !document.activeElement?.closest?.('#dc-form')) await load(); },
      update(p) {
        if (p[0] === 'new') openForm(p[1]);
        else { mode = 'list'; form = null; result = null; paint(); }
        window.scrollTo(0, 0);
      },
    };
  },
};
