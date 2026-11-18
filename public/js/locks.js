// Settings locks: a lock button at the top right of every settings box. A locked box shows a Locked pill and its
// inputs, selects, switches and save buttons are disabled. The server decides what is locked (src/lib/locks.ts):
// every owner answer carries it (x-acx-locks, read in api.js), so a lock made on one device shows on the others at
// their next refresh, and a change the server refuses (423) locks the box here too, with a toast.
//
// Screens only mark their boxes:
//   data-lock="<section>"       the box gets the lock button and the pill
//   data-lock-part="<section>"  governed by that section, no button of its own (Knowledge: adding files, Teach me)
//   data-lock-keep              a control (or a group) that stays usable in a locked box, like search or Show more
// Copy, Try again and the Test buttons always stay usable: they change nothing.
import { get, post, setLocksWatcher } from './api.js';
import { $$, el, html, raw, toast, friendly, busy } from './ui.js';

/** The same boxes and names as the server (LOCK_SECTIONS in src/lib/locks.ts; a unit test keeps them equal). */
export const LOCK_LABELS = {
  voice: 'Voice style',
  brain: 'AI brain',
  vision: 'Google AI Studio',
  shopify: 'Shopify',
  alerts: 'Phone notifications',
  channels: 'Channel modes',
  gmail: 'Gmail inbox',
  pacing: 'Pacing',
  laptops: 'Laptops',
  recovery_message: 'Reminder message',
  recovery_settings: 'Reminder settings',
  discounts: 'Discount code settings',
  sales: 'Sales settings',
  knowledge: 'Knowledge',
};
export const LOCKED_TEXT = 'This is locked. Unlock it with your PIN.';
export const PIN_RE = /^\d{4,8}$/;

const REGION = '[data-lock], [data-lock-part]';
const CONTROLS = 'input, select, textarea, button';
const KEEP = '[data-copy], [data-action="retry"], [data-action$="-test"], input[type="search"]';
const SVG = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const CLOSED_SVG = SVG('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>');
const OPEN_SVG = SVG('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.7-1.6"/>');

const state = { pin: false, locked: new Set(), known: false };

/** What the server said: { pin, locked } (header, 423) or { pin_set, locked } (the lock routes). */
export function applyLocks(summary) {
  if (!summary || typeof summary !== 'object') return;
  const next = new Set((Array.isArray(summary.locked) ? summary.locked : []).filter((id) => LOCK_LABELS[id]));
  const pin = Boolean(summary.pin ?? summary.pin_set);
  const same = state.known && pin === state.pin && next.size === state.locked.size && [...next].every((id) => state.locked.has(id));
  state.pin = pin; state.locked = next; state.known = true;
  if (!same) decorate();
}

const sectionOf = (region) => region.dataset.lock || region.dataset.lockPart || '';
const keeps = (c) => c.matches(KEEP) || Boolean(c.closest('[data-lock-keep]'));
function lockedRegionOf(node) {
  const region = node && node.closest ? node.closest(REGION) : null;
  return region && state.locked.has(sectionOf(region)) ? region : null;
}

let toastTimer = null;
/** One toast, unless the screen already shows the same words (its own error toast for the refused change). */
function lockedToast() {
  if (toastTimer) return;
  toastTimer = setTimeout(() => {
    toastTimer = null;
    if ($$('.toast span').some((s) => s.textContent === LOCKED_TEXT)) return;
    toast(LOCKED_TEXT, { type: 'warn', ms: 5000 });
  }, 80);
}

function paintControl(region, id, locked) {
  let ctl = region.querySelector(':scope > .lockctl');
  if (!ctl) {
    ctl = el(html`<div class="lockctl"><span class="pill pill--info lockctl__pill" hidden>${raw(CLOSED_SVG)}Locked</span><button type="button" class="btn btn--ghost lockctl__btn" data-lock-btn="${id}"></button></div>`);
    region.append(ctl);
  }
  const want = locked ? 'locked' : 'open';
  if (ctl.dataset.state === want) return;
  ctl.dataset.state = want;
  const label = LOCK_LABELS[id];
  const btn = ctl.querySelector('.lockctl__btn');
  ctl.querySelector('.lockctl__pill').hidden = !locked;
  btn.classList.toggle('is-on', locked);
  btn.setAttribute('aria-label', locked ? `Unlock ${label}` : `Lock ${label}`);
  btn.title = locked ? `${label} is locked. Unlock it with your PIN.` : `Lock ${label}`;
  btn.innerHTML = locked ? CLOSED_SVG : OPEN_SVG;
}

/** A part with no button of its own says it is locked where its controls are (once a page), with a way to unlock it. */
function paintPart(region, id, locked) {
  const note = region.querySelector(':scope > .lockpart');
  if (!locked) { if (note) note.remove(); return; }
  if (note) return;
  const label = LOCK_LABELS[id];
  region.prepend(el(html`<div class="lockpart"><span class="pill pill--info lockctl__pill">${raw(CLOSED_SVG)}Locked</span><span class="meta">Unlock ${label} with your PIN to change it.</span>
    <button type="button" class="btn btn--ghost lockctl__btn is-on" data-lock-btn="${id}" aria-label="Unlock ${label}" title="Unlock ${label}">${raw(CLOSED_SVG)}</button></div>`));
}

/** Give every marked box its button, and disable (or give back) what is inside it. Runs after any change to the page. */
export function decorate(root = typeof document !== 'undefined' ? document : null) {
  if (!root) return;
  const noted = new Set();
  for (const region of $$(REGION, root)) {
    const id = sectionOf(region);
    if (!LOCK_LABELS[id]) continue;
    const locked = state.locked.has(id);
    region.classList.toggle('is-locked', locked);
    if (region.hasAttribute('data-lock')) paintControl(region, id, locked);
    else { paintPart(region, id, locked && !noted.has(id)); if (locked && !region.hidden) noted.add(id); }
    for (const c of region.querySelectorAll(CONTROLS)) {
      if (c.closest(REGION) !== region || c.closest('.lockctl, .lockpart')) continue;
      if (locked && !keeps(c)) {
        // Remember whether the screen had it off already, so unlocking gives back exactly that.
        if (!c.dataset.lockOff) c.dataset.lockOff = c.disabled ? 'was' : '1';
        c.disabled = true;
      } else if (c.dataset.lockOff) {
        c.disabled = c.dataset.lockOff === 'was';
        delete c.dataset.lockOff;
      }
    }
  }
}

// ---- the PIN dialog ------------------------------------------------------------------------------------
const pinField = (name, label, auto, first) => html`<div class="field"><label class="field__label" for="lk-${name}">${label}</label>
  <input class="input lockdlg__pin" id="lk-${name}" name="${name}" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="${auto}" spellcheck="false" ${first ? raw('autofocus') : ''} required></div>`;

const COPY = {
  set: (label, locked) => ({
    title: 'Set a PIN',
    text: locked ? `Pick a new PIN of 4 to 8 numbers. Then ${label} unlocks.` : 'Pick 4 to 8 numbers. You need this PIN to lock and unlock settings on any device.',
    confirm: locked ? 'Set PIN and unlock' : 'Set PIN and lock',
    fields: [['new_pin', 'New PIN', 'new-password'], ['again', 'Type it again', 'new-password']],
  }),
  lock: (label) => ({ title: `Lock ${label}?`, text: 'Nobody can change it on any device until it is unlocked with your PIN.', confirm: 'Lock', fields: [['pin', 'Your PIN', 'off']] }),
  unlock: (label) => ({ title: `Unlock ${label}`, text: 'Enter your PIN to change it again.', confirm: 'Unlock', fields: [['pin', 'Your PIN', 'off']] }),
  change: () => ({
    title: 'Change your PIN', text: 'Enter your old PIN, then pick a new one of 4 to 8 numbers.', confirm: 'Change PIN',
    fields: [['old_pin', 'Old PIN', 'off'], ['new_pin', 'New PIN', 'new-password'], ['again', 'Type it again', 'new-password']],
  }),
};

function pinDialog({ id, mode, note = '' }) {
  if (document.querySelector('.lockdlg')) return;
  const label = LOCK_LABELS[id];
  const locked = state.locked.has(id);
  const copy = COPY[mode](label, locked);
  const d = el(html`<dialog class="dialog lockdlg" aria-labelledby="lk-t" aria-describedby="lk-d">
    <form class="dialog__body" novalidate>
      <h2 class="dialog__title" id="lk-t">${copy.title}</h2>
      <p class="muted" id="lk-d">${copy.text}</p>
      ${copy.fields.map(([name, text, auto], i) => pinField(name, text, auto, i === 0))}
      <p class="form-error" role="alert" ${note ? '' : raw('hidden')}>${note}</p>
      <div class="dialog__actions"><button type="button" class="btn btn--ghost" data-lk="cancel">Cancel</button><button type="submit" class="btn btn--primary">${copy.confirm}</button></div>
      <p class="field__hint lockdlg__foot">${mode === 'lock' || mode === 'unlock' ? html`<button type="button" class="lockdlg__link" data-lk="change">Change PIN</button><br>` : ''}Forgot your PIN? You can clear it in your Cloudflare dashboard. The setup guide shows how, under "Forgot your PIN".</p>
    </form></dialog>`);
  const form = d.querySelector('form');
  const errBox = form.querySelector('.form-error');
  const value = (name) => (form.elements[name] ? form.elements[name].value.trim() : '');
  const fail = (msg, focus) => {
    errBox.textContent = msg; errBox.hidden = false;
    const f = focus && form.elements[focus];
    if (f) { f.focus(); f.select(); }
  };
  const reopen = (nextMode, why) => { d.close(); pinDialog({ id, mode: nextMode, note: why }); };

  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => {
    if (e.target === d) return d.close();
    const b = e.target.closest('[data-lk]');
    if (!b) return;
    if (b.dataset.lk === 'cancel') d.close();
    if (b.dataset.lk === 'change') reopen('change', '');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const [name] of copy.fields) if (!PIN_RE.test(value(name))) return fail('Use 4 to 8 numbers for the PIN.', name);
    if (copy.fields.some(([n]) => n === 'again') && value('new_pin') !== value('again')) return fail('The two new PINs are not the same.', 'again');
    errBox.hidden = true;
    await busy(form.querySelector('[type=submit]'), async () => {
      try {
        let res;
        if (mode === 'set') {
          await post('/api/locks/pin', { pin: value('new_pin') });
          res = await post(`/api/locks/sections/${encodeURIComponent(id)}`, { locked: !locked, pin: value('new_pin') });
        } else if (mode === 'change') {
          res = await post('/api/locks/pin', { pin: value('new_pin'), old_pin: value('old_pin') });
        } else {
          res = await post(`/api/locks/sections/${encodeURIComponent(id)}`, { locked: mode === 'lock', pin: value('pin') });
        }
        applyLocks(res);
        d.close();
        toast(mode === 'change' ? 'PIN changed.' : state.locked.has(id) ? `${label} is locked on every device.` : `${label} is unlocked.`, { type: 'ok' });
      } catch (err) {
        if (err.name === 'AuthError') { d.close(); return; }
        if (err.extra?.locks) applyLocks(err.extra.locks);
        if (err.code === 'pin_exists' && mode === 'set') return reopen(locked ? 'unlock' : 'lock', friendly(err));
        if (err.code === 'no_pin' && mode !== 'set') return reopen('set', 'There is no PIN yet. Pick one first.');
        const field = err.code === 'wrong_pin' ? (mode === 'change' ? 'old_pin' : 'pin') : null;
        if (field && form.elements[field]) form.elements[field].value = '';
        fail(friendly(err, 'That did not work. Try again.'), field);
      }
    });
  });
  document.body.append(d);
  d.showModal();
}

/** The lock button: ask the server first (a PIN may have been set on another device), then the right dialog. */
async function openLock(id, btn) {
  if (btn.dataset.busy === '1' || document.querySelector('.lockdlg')) return;
  await busy(btn, async () => {
    try { applyLocks(await get('/api/locks')); } catch (err) { if (err.name === 'AuthError') return; /* go on with what is known */ }
  });
  pinDialog({ id, mode: !state.pin ? 'set' : state.locked.has(id) ? 'unlock' : 'lock' });
}

if (typeof document !== 'undefined') {
  setLocksWatcher((header, refused) => {
    if (header) { try { applyLocks(JSON.parse(header)); } catch { /* an old server: nothing locked */ } }
    if (refused) { if (refused.locks) applyLocks(refused.locks); lockedToast(); }
  });
  // Screens paint their boxes whenever they like: look again after every change to the page.
  new MutationObserver(() => decorate()).observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-lock-btn]');
    if (b) { e.preventDefault(); openLock(b.dataset.lockBtn, b); }
  });
  // Belt and braces: nothing in a locked box goes through, even a control a screen switched back on.
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest(`${CONTROLS}, label`);
    if (!t || t.closest('.lockctl, .lockpart') || keeps(t) || !lockedRegionOf(t)) return;
    e.preventDefault(); e.stopPropagation(); lockedToast();
  }, true);
  document.addEventListener('submit', (e) => {
    if (!lockedRegionOf(e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation(); lockedToast();
  }, true);
  for (const type of ['dragenter', 'dragover', 'drop']) {
    document.addEventListener(type, (e) => {
      if (!lockedRegionOf(e.target)) return;
      e.preventDefault(); e.stopPropagation();
      if (type === 'drop') lockedToast();
    }, true);
  }
}
