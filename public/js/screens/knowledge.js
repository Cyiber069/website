// Knowledge: what the agent knows. Upload files, add notes, answer "teach me" questions.
import { api, get, post, patch, del } from '../api.js';
import { $, html, raw, icon, setHTML, toast, toastError, friendly, syncList, emptyState, unavailable, skeletonCards, ago, num, confirmDialog, field, busy } from '../ui.js';

const CATEGORIES = [['general', 'General'], ['products', 'Products'], ['policies', 'Policies'], ['shipping', 'Delivery'], ['faq', 'Common questions'], ['learned', 'Learned from you']];
const CAT = Object.fromEntries(CATEGORIES);
const SOURCE = { upload: 'Uploaded file', note: 'Your note', store: 'From your store', learned: 'Learned from your answers', seed: 'Starter knowledge' };
const words = (tokens) => { const w = Math.round((tokens || 0) * 0.75); return w < 1000 ? `about ${Math.max(1, Math.round(w / 10) * 10)} words` : `about ${(w / 1000).toFixed(1)}k words`; };
const catSelect = (value, id = 'cat') => html`<select class="input" id="${id}" name="category">${CATEGORIES.map(([v, t]) => html`<option value="${v}" ${v === value ? raw('selected') : ''}>${t}</option>`)}</select>`;

function docRow(d) {
  return html`<li class="doc ${d.enabled ? '' : 'is-off'}">
    <a class="doc__main" href="#/knowledge/${d.id}"><span class="doc__title"><b class="break">${d.title}</b>${d.pinned ? html`<span class="tag tag--live">Pinned</span>` : ''}${d.enabled ? '' : html`<span class="tag">Off</span>`}</span>
      <span class="meta">${CAT[d.category] || 'General'} · ${SOURCE[d.source] || 'Added'} · ${words(d.token_estimate)} · updated ${ago(d.updated_at)}</span>
      <span class="doc__preview">${d.preview}</span></a>
    <div class="doc__actions">
      <label class="switch" title="Let the agent use this"><input type="checkbox" role="switch" data-toggle="enabled" data-id="${d.id}" ${d.enabled ? raw('checked') : ''} aria-label="Let the agent use ${d.title}"><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span></label>
      <button type="button" class="btn btn--ghost btn--icon ${d.pinned ? 'is-on' : ''}" data-action="pin" data-id="${d.id}" aria-pressed="${d.pinned ? 'true' : 'false'}" aria-label="${d.pinned ? 'Unpin' : 'Pin'} ${d.title}" title="${d.pinned ? 'Unpin' : 'Pin so the agent always reads it'}">${icon('i-pin')}</button>
      <button type="button" class="btn btn--ghost btn--icon" data-action="delete" data-id="${d.id}" aria-label="Delete ${d.title}" title="Delete">${icon('i-trash')}</button>
    </div>
  </li>`;
}

function gapCard(g, i) {
  return html`<article class="ucard gap" data-heat="fresh"><span class="eyebrow">Teach me</span>
    <p class="ucard__q" id="gap-${i}">${g.question}</p>
    ${g.why_it_matters ? html`<p class="ucard__why"><b>Why it matters:</b> ${g.why_it_matters}</p>` : ''}
    <form class="ucard__form" data-gap data-quick-send novalidate>
      <label class="sr-only" for="gap-a-${i}">Your answer</label>
      <textarea class="input" id="gap-a-${i}" rows="2" placeholder="Type the answer in your own words"></textarea>
      <div class="ucard__actions"><button type="button" class="btn btn--ghost btn--sm" data-action="gap-skip">Skip this one</button><button type="submit" class="btn btn--primary btn--send"><span class="btn__label">Save answer</span><svg class="btn__check" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.500l4 4 8-9"/></svg></button></div>
    </form></article>`;
}

function mountList(view, ctx) {
  let data = null;
  let error = null;
  let filter = '';
  let q = '';
  const uploads = [];

  setHTML(view, html`
    <p class="muted lead" id="kb-lead">Everything the agent is allowed to say comes from here. If it is not here, it asks you.</p>
    <section id="gaps" hidden></section>
    <section class="stack" aria-label="Add knowledge">
      <label class="drop" id="drop" tabindex="-1">
        ${icon('i-upload', 'drop__icon')}
        <span class="drop__title">Drop files here</span>
        <span class="drop__hint">or tap to choose. PDF, Word, text or spreadsheet, up to 10 MB each.</span>
        <input class="sr-only" type="file" id="file" multiple accept=".pdf,.txt,.md,.csv,.json,.html,.htm,.doc,.docx,.rtf,.xlsx,.xls,text/*,application/pdf">
      </label>
      <ul class="stack" id="uploads" aria-live="polite"></ul>
      <div class="wrap">
        <button type="button" class="btn" data-action="note-open">Add a note</button>
        <button type="button" class="btn btn--ghost" data-action="sync">Sync from store</button>
        <span class="meta" id="sync-hint">Pulls your products and policies from acxebikes.com.</span>
      </div>
      <form class="card stack" id="note-form" hidden novalidate>
        <h2 class="eyebrow">New note</h2>
        ${field({ label: 'Title', name: 'title', placeholder: 'For example: Delivery times', attrs: 'maxlength="160" required' })}
        ${field({ label: 'What should the agent know?', name: 'content', textarea: true, rows: 5, placeholder: 'Write it like you would tell a new member of staff', attrs: 'required' })}
        <div class="field"><label class="field__label" for="note-cat">Type</label>${catSelect('general', 'note-cat')}</div>
        <label class="check"><input type="checkbox" name="pinned"> Pin it, so the agent always reads it</label>
        <p class="form-error" role="alert" hidden></p>
        <div class="wrap"><button type="submit" class="btn btn--primary">Save note</button><button type="button" class="btn btn--ghost" data-action="note-close">Cancel</button></div>
      </form>
    </section>
    <section class="card" aria-labelledby="docs-h">
      <div class="card__head"><h2 class="eyebrow" id="docs-h">What the agent knows</h2><span class="meta num" id="totals"></span></div>
      <div class="inbox__filters">
        <div class="search"><label class="sr-only" for="kb-q">Search knowledge</label>${icon('i-search', 'search__icon')}<input class="input" id="kb-q" type="search" placeholder="Search titles and text" autocomplete="off"></div>
        <div class="chips" role="group" aria-label="Filter by type"><button type="button" class="chip" data-cat="" aria-pressed="true">All</button>${CATEGORIES.map(([v, t]) => html`<button type="button" class="chip" data-cat="${v}" aria-pressed="false">${t}</button>`)}</div>
      </div>
      <ul class="docs" id="docs">${[0, 1, 2].map(() => html`<li class="doc"><span class="doc__main"><span class="skel skel--title" style="--w:40%"></span><span class="skel" style="--w:70%"></span></span></li>`)}</ul>
    </section>`);

  const docsEl = $('#docs', view);

  function paint() {
    if (!data) {
      if (error) { setHTML(docsEl, html`<li>${unavailable('Knowledge', error)}</li>`); $('#totals', view).textContent = ''; }
      return;
    }
    $('#totals', view).textContent = `${num(data.totals?.docs)} in use · ${words(data.totals?.tokens)}`;
    const gaps = data.gaps || [];
    const gapsEl = $('#gaps', view);
    gapsEl.hidden = gaps.length === 0;
    if (gaps.length) {
      if (!$('#gap-list', gapsEl)) setHTML(gapsEl, html`<div class="sechead"><h2 class="eyebrow">Teach me</h2><p class="meta">Things customers ask that the agent cannot answer yet. One box each.</p></div><div class="ulist" id="gap-list"></div>`);
      syncList($('#gap-list', gapsEl), gaps.slice(0, 6).map((g, i) => ({ ...g, i })), { key: (g) => g.question, render: (g) => gapCard(g, g.i), sig: (g) => g.question });
    }
    const needle = q.toLowerCase();
    const shown = data.docs.filter((d) => (!filter || d.category === filter) && (!needle || `${d.title} ${d.preview}`.toLowerCase().includes(needle)));
    if (!data.docs.length) {
      delete docsEl.dataset.synced;
      setHTML(docsEl, html`<li>${emptyState({ title: 'Nothing here yet', text: 'The agent cannot answer much until you teach it. Start with your delivery times and returns rules.', action: 'Add a note', id: 'note-open' })}</li>`);
    } else if (!shown.length) {
      delete docsEl.dataset.synced;
      setHTML(docsEl, html`<li class="feed__empty"><p class="voice muted">Nothing matches. Try another word or pick All.</p></li>`);
    } else {
      if (docsEl.querySelector('.skel, .empty, .notice, .feed__empty')) { docsEl.innerHTML = ''; delete docsEl.dataset.synced; }
      syncList(docsEl, shown, { key: (d) => d.id, render: docRow });
    }
  }

  async function load() {
    try { data = await get('/api/kb'); data.docs = data.docs || []; error = null; }
    catch (err) { if (err.name === 'AuthError') return; if (!data) error = err; }
    paint();
  }

  function paintUploads() {
    setHTML($('#uploads', view), uploads.map((u) => html`<li class="file">${icon(u.state === 'done' ? 'i-check' : u.state === 'failed' ? 'i-x' : 'i-upload', `file__icon file__icon--${u.state}`)}<span class="file__name">${u.name}</span><span class="meta">${u.state === 'done' ? 'Added' : u.state === 'failed' ? '' : 'Reading'}</span>${u.state === 'failed' ? html`<span class="file__err">${u.error}</span>` : html`<span class="file__bar"><i style="--p:${u.state === 'done' ? 1 : 0.6}"></i></span>`}</li>`));
  }

  async function uploadFiles(files) {
    for (const file of [...files]) {
      const u = { name: file.name, state: 'busy' };
      uploads.unshift(u); paintUploads();
      if (file.size > 10 * 1024 * 1024) { u.state = 'failed'; u.error = 'This file is over 10 MB. Split it or save a smaller copy, then try again.'; paintUploads(); continue; }
      const form = new FormData();
      form.append('file', file);
      try {
        await api('/api/kb/upload', { form });
        u.state = 'done';
        toast(`Added ${file.name}. The agent can use it now.`);
      } catch (err) {
        if (err.name === 'AuthError') return;
        u.state = 'failed';
        u.error = err.code === 'unsupported_type' ? 'The agent cannot read this kind of file. Save it as a PDF or a text file and try again.'
          : err.code === 'too_large' ? 'This file is over 10 MB. Split it or save a smaller copy, then try again.'
          : err.code === 'empty_text' ? 'No text was found in this file. If it is a scan, type the important parts as a note instead.'
          : friendly(err, 'The upload did not go through. Try again.');
      }
      paintUploads();
    }
    setTimeout(() => { for (let i = uploads.length - 1; i >= 0; i--) if (uploads[i].state === 'done') uploads.splice(i, 1); if (view.isConnected) paintUploads(); }, 5000);
    load();
  }

  const drop = $('#drop', view);
  $('#file', view).addEventListener('change', (e) => { if (e.target.files.length) uploadFiles(e.target.files); e.target.value = ''; });
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.toggle('is-over', type === 'dragenter' || type === 'dragover');
      if (type === 'drop' && e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
    });
  }
  // Dropping a file anywhere else on the page should not navigate away from the app.
  const stop = (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); };
  window.addEventListener('dragover', stop); window.addEventListener('drop', stop);

  view.addEventListener('input', (e) => { if (e.target.id === 'kb-q') { q = e.target.value.trim(); paint(); } });
  view.addEventListener('change', async (e) => {
    const t = e.target.closest('[data-toggle="enabled"]');
    if (!t) return;
    const d = data.docs.find((x) => x.id === t.dataset.id); if (!d) return;
    d.enabled = t.checked; paint();
    try { await patch(`/api/kb/${encodeURIComponent(d.id)}`, { enabled: d.enabled }); toast(d.enabled ? 'On. The agent can use this.' : 'Off. The agent ignores this now.'); load(); }
    catch (err) { d.enabled = !d.enabled; paint(); toastError(err, 'Could not change that. Try again.'); }
  });
  view.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.id === 'note-form') {
      const errBox = form.querySelector('.form-error');
      const title = form.elements.title.value.trim(), content = form.elements.content.value.trim();
      if (!title || !content) { errBox.textContent = !title ? 'Give the note a title.' : 'Write what the agent should know.'; errBox.hidden = false; (title ? form.elements.content : form.elements.title).focus(); return; }
      errBox.hidden = true;
      await busy(form.querySelector('[type=submit]'), async () => {
        try {
          await post('/api/kb/note', { title, content, category: form.elements.category.value, pinned: form.elements.pinned.checked });
          toast('Note saved. The agent can use it now.');
          form.reset(); form.hidden = true;
          for (const i of form.querySelectorAll('[data-dirty]')) i.dataset.dirty = '0';
          load();
        } catch (err) { errBox.textContent = friendly(err, 'The note was not saved. Try again.'); errBox.hidden = false; }
      });
      return;
    }
    if (form.matches('[data-gap]')) {
      const card = form.closest('.gap'); const question = card.dataset.key; const box = form.querySelector('textarea');
      const answer = box.value.trim();
      if (!answer) { box.setAttribute('aria-invalid', 'true'); box.focus(); return; }
      const btn = form.querySelector('.btn--send');
      btn.classList.add('is-sending');
      try {
        await post('/api/kb/gaps/answer', { question, answer });
        btn.classList.replace('is-sending', 'is-sent'); btn.querySelector('.btn__label').textContent = 'Saved';
        box.dataset.dirty = '0';
        toast('Saved. The agent knows this now.');
        setTimeout(load, 700);
      } catch (err) { btn.classList.remove('is-sending'); toastError(err, 'Not saved. Try again.'); }
    }
  });
  view.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-cat]');
    if (chip) { filter = chip.dataset.cat; for (const b of view.querySelectorAll('[data-cat]')) b.setAttribute('aria-pressed', String(b === chip)); return paint(); }
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const { action, id } = b.dataset;
    if (action === 'retry') return load();
    if (action === 'note-open') { const f = $('#note-form', view); f.hidden = false; f.elements.title.focus(); f.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    if (action === 'note-close') { $('#note-form', view).hidden = true; return; }
    if (action === 'sync') {
      return busy(b, async () => {
        b.textContent = 'Syncing';
        try { const r = await post('/api/kb/sync-store'); toast(r.added || r.updated ? `Store synced. ${r.added || 0} added, ${r.updated || 0} updated.` : 'Store synced. Nothing had changed.'); load(); }
        catch (err) { toastError(err, 'Could not read the store just now. Try again in a minute.'); }
        b.textContent = 'Sync from store';
      });
    }
    if (action === 'gap-skip') {
      const card = b.closest('.gap'); const question = card.dataset.key;
      data.gaps = data.gaps.filter((g) => g.question !== question); card.querySelector('textarea').dataset.dirty = '0'; paint();
      try { await post('/api/kb/gaps/dismiss', { question }); } catch (err) { toastError(err, 'Could not skip that one. Try again.'); load(); }
      return;
    }
    const d = data?.docs.find((x) => x.id === id);
    if (!d) return;
    if (action === 'pin') {
      d.pinned = !d.pinned; paint();
      try { await patch(`/api/kb/${encodeURIComponent(id)}`, { pinned: d.pinned }); toast(d.pinned ? 'Pinned. The agent always reads this.' : 'Unpinned.'); load(); }
      catch (err) { d.pinned = !d.pinned; paint(); toastError(err, 'Could not change that. Try again.'); }
      return;
    }
    if (action === 'delete') {
      if (!(await confirmDialog({ title: 'Delete this?', text: `"${d.title}" is removed and the agent forgets it. This cannot be undone.`, confirm: 'Delete', danger: true }))) return;
      const before = data.docs; data.docs = data.docs.filter((x) => x.id !== id); paint();
      try { await del(`/api/kb/${encodeURIComponent(id)}`); toast('Deleted. The agent no longer uses it.'); load(); }
      catch (err) { data.docs = before; paint(); toastError(err, 'Could not delete it. Try again.'); }
    }
  });

  load();
  return { destroy() { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); } };
}

function mountDoc(view, ctx, id) {
  setHTML(view, skeletonCards(1));
  let doc = null;
  async function load() {
    try {
      doc = (await get(`/api/kb/${encodeURIComponent(id)}`)).doc;
    } catch (err) {
      if (err.name === 'AuthError') return;
      setHTML(view, html`<a class="backlink" href="#/knowledge">${icon('i-back')}All knowledge</a>${err.status === 404 && !err.unavailable ? emptyState({ title: 'Not found', text: 'This was deleted or never existed.', action: 'Back to knowledge', href: '#/knowledge' }) : unavailable('This document', err)}`);
      return;
    }
    ctx.setTitle('Knowledge');
    setHTML(view, html`
      <a class="backlink" href="#/knowledge">${icon('i-back')}All knowledge</a>
      <form class="card stack" id="doc-form" novalidate>
        <p class="meta">${SOURCE[doc.source] || 'Added'}${doc.filename ? ` · ${doc.filename}` : ''} · ${words(doc.token_estimate)} · updated ${ago(doc.updated_at)}</p>
        ${field({ label: 'Title', name: 'title', value: doc.title, attrs: 'maxlength="160" required' })}
        <div class="field"><label class="field__label" for="doc-cat">Type</label>${catSelect(doc.category, 'doc-cat')}</div>
        ${field({ label: 'What the agent reads', name: 'content', value: doc.content || '', textarea: true, rows: 16, hint: 'Change anything that is wrong or out of date. The agent uses the new text straight away.' })}
        <label class="switch switch--row"><input type="checkbox" role="switch" name="enabled" ${doc.enabled ? raw('checked') : ''}><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label">Let the agent use this<span class="switch__hint">Switch off to keep it without using it</span></span></label>
        <label class="switch switch--row"><input type="checkbox" role="switch" name="pinned" ${doc.pinned ? raw('checked') : ''}><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label">Pinned<span class="switch__hint">The agent reads pinned items every time</span></span></label>
        <p class="form-error" role="alert" hidden></p>
        <div class="actionbar"><button type="button" class="btn btn--danger" data-action="delete">Delete</button><span class="top__spacer"></span><button type="submit" class="btn btn--primary">Save changes</button></div>
      </form>`);
  }
  view.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const errBox = f.querySelector('.form-error');
    const title = f.elements.title.value.trim(), content = f.elements.content.value.trim();
    if (!title || !content) { errBox.textContent = !title ? 'Give it a title.' : 'The text is empty. Add some text or delete this instead.'; errBox.hidden = false; return; }
    errBox.hidden = true;
    await busy(f.querySelector('[type=submit]'), async () => {
      try {
        const body = { title, category: f.elements.category.value, enabled: f.elements.enabled.checked, pinned: f.elements.pinned.checked };
        if (content !== (doc.content || '').trim()) body.content = content;
        await patch(`/api/kb/${encodeURIComponent(id)}`, body);
        toast('Saved. The agent uses the new text now.');
        for (const i of f.querySelectorAll('[data-dirty]')) i.dataset.dirty = '0';
        location.hash = '#/knowledge';
      } catch (err) { errBox.textContent = friendly(err, 'Not saved. Try again.'); errBox.hidden = false; }
    });
  });
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]'); if (!b) return;
    if (b.dataset.action === 'retry') return load();
    if (b.dataset.action === 'delete') {
      if (!(await confirmDialog({ title: 'Delete this?', text: `"${doc.title}" is removed and the agent forgets it. This cannot be undone.`, confirm: 'Delete', danger: true }))) return;
      try { await del(`/api/kb/${encodeURIComponent(id)}`); toast('Deleted. The agent no longer uses it.'); location.hash = '#/knowledge'; }
      catch (err) { toastError(err, 'Could not delete it. Try again.'); }
    }
  });
  load();
  return {};
}

export default {
  title: 'Knowledge',
  focus: true,
  mount(view, ctx, params) {
    // No update(): moving between the list and a document remounts the screen.
    return params[0] ? mountDoc(view, ctx, params[0]) : mountList(view, ctx);
  },
};
