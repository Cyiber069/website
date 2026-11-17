// Small shared helpers: safe HTML templating, toasts, times, list syncing, dialogs.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
/** Mark a string as already safe HTML (only ever used on our own markup). */
export const raw = (s) => new Raw(String(s ?? ''));

/** Tagged template: every interpolated value is escaped unless it came from html`` or raw(). */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += flat(values[i]);
  });
  return new Raw(out);
}
function flat(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(flat).join('');
  return esc(v);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function setHTML(el, markup) { el.innerHTML = markup instanceof Raw ? markup.s : esc(markup); return el; }
export function el(markup) {
  const t = document.createElement('template');
  t.innerHTML = (markup instanceof Raw ? markup.s : esc(markup)).trim();
  return t.content.firstElementChild;
}

export const icon = (name, cls = '') => raw(`<svg class="${cls}" aria-hidden="true"><use href="#${name}"/></svg>`);

// ---- Channels -----------------------------------------------------------------------------------
export const CHANNELS = ['whatsapp', 'gmail', 'tiktok'];
export const CHANNEL_NAMES = { whatsapp: 'WhatsApp', gmail: 'Gmail', tiktok: 'TikTok' };
export const chName = (c) => CHANNEL_NAMES[c] || 'Message';
export function chBadge(channel, iconOnly = false) {
  if (!CHANNEL_NAMES[channel]) return iconOnly ? html`<span class="ch ch--icon" aria-hidden="true">${icon('i-dot', 'ch__glyph')}</span>` : '';
  return iconOnly
    ? html`<span class="ch ch--${channel} ch--icon" role="img" aria-label="${chName(channel)}">${icon('g-' + channel, 'ch__glyph')}</span>`
    : html`<span class="ch ch--${channel}">${icon('g-' + channel, 'ch__glyph')}${chName(channel)}</span>`;
}

// ---- Time -----------------------------------------------------------------------------------------
export function ago(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
export function shortAgo(ts, now = Date.now()) {
  if (!ts) return '';
  const m = Math.max(0, Math.floor((now - ts) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
export function waited(ts, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(m / 1440)}d`;
}
/** A length of time for the owner: "38s", "2 min 5s", "1 hr 10 min". */
export function span(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m} min ${r}s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} hr ${m % 60} min` : `${h} hr`;
}
export const clock = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export function dayClock(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return clock(ts);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${clock(ts)}`;
}
/** Elements with data-ago="<ms>" keep themselves fresh. */
export function refreshTimes(root = document) {
  const now = Date.now();
  for (const n of root.querySelectorAll('[data-ago]')) {
    const ts = Number(n.dataset.ago);
    const t = n.dataset.agoStyle === 'short' ? shortAgo(ts, now) : n.dataset.agoStyle === 'wait' ? waited(ts, now) : ago(ts, now);
    if (n.textContent !== t) n.textContent = t;
  }
}
export const timeTag = (ts, style = '') => html`<time class="num" datetime="${new Date(ts || 0).toISOString()}" data-ago="${ts}" data-ago-style="${style}">${style === 'short' ? shortAgo(ts) : style === 'wait' ? waited(ts) : ago(ts)}</time>`;

export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const num = (n) => Number(n || 0).toLocaleString('en-GB');

// ---- Toasts ---------------------------------------------------------------------------------------
const TOAST_ICONS = { ok: 'M4 10.5l4 4 8-9', warn: 'M10 4v7M10 15v.5', error: 'M5 5l10 10M15 5L5 15' };
export function toast(text, { type = 'ok', ms = 4000, action, onAction } = {}) {
  let host = $('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  while (host.children.length >= 3) host.firstElementChild.remove();
  const node = el(html`<div class="toast toast--${type}" style="--toast-ms:${ms}ms"><svg class="toast__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${TOAST_ICONS[type] || TOAST_ICONS.ok}"/></svg><span>${text}</span></div>`);
  const close = () => { node.classList.add('is-leaving'); setTimeout(() => node.remove(), 200); };
  if (action) {
    const b = el(html`<button type="button" class="toast__action">${action}</button>`);
    b.onclick = () => { onAction && onAction(); close(); };
    node.append(b);
  }
  host.append(node);
  setTimeout(close, ms);
  return close;
}
export const toastError = (err, fallback = 'That did not work. Check your connection and try again.') => {
  if (err && err.name === 'AuthError') return;
  toast(friendly(err, fallback), { type: 'error', ms: 6000 });
};
export function friendly(err, fallback = 'That did not work. Check your connection and try again.') {
  if (!err) return fallback;
  if (err.unavailable) return 'This part is not switched on yet. Try again a little later.';
  if (err.offline) return 'No connection. Check your internet and try again.';
  if (err.status >= 500) return 'Something went wrong on our side. Try again in a moment.';
  const m = err.userMessage;
  return m ? (/[.!?]$/.test(m) ? m : m + '.') : fallback;
}

// ---- Confirm dialog -------------------------------------------------------------------------------
export function confirmDialog({ title, text, confirm = 'Yes', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const d = el(html`<dialog class="dialog" aria-labelledby="dlg-t">
      <form method="dialog" class="dialog__body">
        <h2 class="dialog__title" id="dlg-t">${title}</h2>
        <p class="muted">${text}</p>
        <div class="dialog__actions">
          <button class="btn btn--ghost" value="no">${cancel}</button>
          <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" value="yes">${confirm}</button>
        </div>
      </form></dialog>`);
    document.body.append(d);
    d.addEventListener('close', () => { resolve(d.returnValue === 'yes'); d.remove(); });
    d.addEventListener('click', (e) => { if (e.target === d) d.close('no'); });
    d.showModal();
  });
}

// ---- Keyed list syncing: keeps untouched rows (and whatever the owner is typing in them) -----------
export function syncList(container, items, { key, render, sig = (x) => JSON.stringify(x), onNew } = {}) {
  const have = new Map();
  for (const child of [...container.children]) if (child.dataset.key) have.set(child.dataset.key, child);
  const first = container.dataset.synced !== '1';
  let prev = null;
  for (const item of items) {
    const k = String(key(item));
    const s = sig(item);
    let node = have.get(k);
    if (node) {
      have.delete(k);
      const busy = node.contains(document.activeElement) || node.dataset.busy === '1' || node.querySelector('textarea[data-dirty="1"], input[data-dirty="1"]');
      if (node.dataset.sig !== s && !busy) {
        const next = el(render(item));
        next.dataset.key = k; next.dataset.sig = s;
        node.replaceWith(next); node = next;
      }
    } else {
      node = el(render(item));
      node.dataset.key = k; node.dataset.sig = s;
      if (!first && onNew) onNew(node, item);
    }
    const want = prev ? prev.nextElementSibling : container.firstElementChild;
    if (want !== node) container.insertBefore(node, want);
    prev = node;
  }
  for (const gone of have.values()) gone.remove();
  container.dataset.synced = '1';
}

// ---- Common blocks --------------------------------------------------------------------------------
const WAVE = raw(`<svg class="empty__art" viewBox="0 0 260 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 26c22 0 22-12 44-12s22 12 44 12 22-12 44-12 22 12 44 12 22-12 44-12 22 12 36 12"/><path class="live" d="M90 26c22 0 22-12 44-12"/></svg>`);
export function emptyState({ title, text, action, href, id }) {
  return html`<div class="empty">${WAVE}<h2 class="empty__title">${title}</h2><p class="empty__text">${text}</p>${action ? (href
    ? html`<a class="btn btn--primary" href="${href}">${action}</a>`
    : html`<button type="button" class="btn btn--primary" data-action="${id}">${action}</button>`) : ''}</div>`;
}
export function unavailable(what, err) {
  const missing = !err || err.unavailable;
  return html`<div class="card notice" role="status">
    <span class="pill ${missing ? 'pill--info' : 'pill--down'}"><span class="dot ${missing ? '' : 'dot--down'}" aria-hidden="true"></span>${missing ? 'Not available yet' : 'Could not load'}</span>
    <p>${missing ? `${what} is still being set up on the server. Nothing is broken on your side.` : `${what} did not load. ${friendly(err, 'Check your connection and try again.')}`}</p>
    <button type="button" class="btn btn--ghost" data-action="retry">Try again</button>
  </div>`;
}
export function skeletonCards(n = 3) {
  return html`<div class="stack" aria-hidden="true">${Array.from({ length: n }, (_, i) => html`<div class="card stack"><span class="skel skel--title" style="--w:${[42, 58, 36][i % 3]}%"></span><span class="skel" style="--w:92%"></span><span class="skel" style="--w:70%"></span></div>`)}</div><p class="sr-only" role="status">Loading</p>`;
}
export function switchRow({ name, checked, label, hint, action, disabled }) {
  return html`<label class="switch switch--row"><input type="checkbox" role="switch" name="${name || ''}" ${checked ? raw('checked') : ''} ${disabled ? raw('disabled') : ''} ${action ? raw(`data-change="${esc(action)}"`) : ''}><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label">${label}${hint ? html`<span class="switch__hint">${hint}</span>` : ''}</span></label>`;
}
export function segmented({ name, value, options, legend, action }) {
  return html`<fieldset class="seg"><legend class="field__label">${legend}</legend><div class="seg__row" ${action ? raw(`data-change="${esc(action)}"`) : ''}>${options.map(([v, text]) => html`<label class="seg__opt"><input type="radio" name="${name}" value="${v}" ${String(v) === String(value) ? raw('checked') : ''}><span>${text}</span></label>`)}</div></fieldset>`;
}
export function field({ label, hint, name, value = '', type = 'text', attrs = '', textarea = false, rows = 3, placeholder = '' }) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  return html`<div class="field"><label class="field__label" for="${id}">${label}</label>${textarea
    ? html`<textarea class="input" id="${id}" name="${name}" rows="${rows}" placeholder="${placeholder}" ${raw(attrs)}>${value}</textarea>`
    : html`<input class="input" id="${id}" name="${name}" type="${type}" value="${value}" placeholder="${placeholder}" ${raw(attrs)}>`}${hint ? html`<p class="field__hint">${hint}</p>` : ''}</div>`;
}

export async function copyText(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.append(t); t.select();
    try { document.execCommand('copy'); } catch { /* shown below */ }
    t.remove();
  }
  toast(done);
}

/** Run an action from a button: locks it while busy so a double tap cannot send twice. */
export async function busy(button, fn) {
  if (!button || button.dataset.busy === '1') return;
  button.dataset.busy = '1'; button.setAttribute('aria-busy', 'true'); button.classList.add('is-busy');
  try { return await fn(); } finally { delete button.dataset.busy; button.removeAttribute('aria-busy'); button.classList.remove('is-busy'); }
}

export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export function transition(fn) {
  if (document.startViewTransition && !reduceMotion()) document.startViewTransition(fn); else fn();
}

// ---- Customer photos --------------------------------------------------------------------------------
const mediaUrl = (id) => `/api/media/${encodeURIComponent(id)}`;
const mediaAlt = (m) => (m.kind === 'video_frame' ? 'One frame of a video the customer sent' : 'Photo the customer sent');

/** Small thumbnail for a message's `media` ({ id, kind } or null). Tap opens it full size. */
export function mediaThumb(media) {
  if (!media || !media.id) return '';
  return html`<button type="button" class="thumb" data-media="${media.id}" data-media-kind="${media.kind}" aria-label="${mediaAlt(media)}. Open full size">
    <img class="thumb__img" src="${mediaUrl(media.id)}" alt="" loading="lazy" decoding="async">${media.kind === 'video_frame' ? html`<span class="thumb__tag">Video frame</span>` : ''}</button>`;
}

function openMedia(id, kind) {
  const d = el(html`<dialog class="lightbox" aria-label="${mediaAlt({ kind })}">
    <form method="dialog" class="lightbox__body">
      <img class="lightbox__img" src="${mediaUrl(id)}" alt="${mediaAlt({ kind })}">
      ${kind === 'video_frame' ? html`<p class="lightbox__note">One frame of a video. Open the chat to watch it.</p>` : ''}
      <button class="btn btn--ghost btn--sm lightbox__close">Close</button>
    </form></dialog>`);
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d || e.target.classList.contains('lightbox__img')) d.close(); });
  d.showModal();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-media]');
    if (!b) return;
    e.preventDefault();
    openMedia(b.dataset.media, b.dataset.mediaKind);
  });
  // A photo older than 14 days is gone from the server: drop the empty frame.
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('thumb__img')) t.closest('.thumb')?.remove();
  }, true);
}

/** Bubbles for a list of { direction, author, body, ts, media } messages. */
export function bubbles(messages) {
  return messages.map((m) => {
    const who = m.author === 'customer' || (m.direction === 'in' && !m.author) ? 'customer' : m.author === 'owner' ? 'owner' : 'agent';
    const by = who === 'customer' ? 'Customer' : who === 'owner' ? 'You' : 'Agent';
    return html`<div class="msg msg--${who}"><span class="msg__by">${by}</span>${mediaThumb(m.media)}<div class="bubble">${m.body || kindLabel(m.kind)}</div>${m.ts ? html`<span class="msg__meta">${dayClock(m.ts)}</span>` : ''}</div>`;
  });
}
export function kindLabel(kind) {
  return { image: 'Sent a photo', voice: 'Sent a voice note', video: 'Sent a video', sticker: 'Sent a sticker', document: 'Sent a file' }[kind] || 'Sent something that is not text';
}
