// People and their laptops: the chips next to the logo, the People panel, and opening a channel's tab on
// a laptop (this one at once through the extension, any other through the server on its next sync).
// The data is the overview's `people` and `lanes` (src/pipeline/leader.ts teamView).
import { get, patch, post, put } from './api.js';
import { $, $$, html, icon, setHTML, el, toast, toastError, friendly, chBadge, chName, CHANNELS, ago, confirmDialog } from './ui.js';
import { openHere, thisLaptop, onThisLaptop } from './bridge.js';

const STATE = {
  ready: ['Connected', 'pill--live', 'dot--live'], loading: ['Loading', 'pill--wait', 'dot--wait'], no_tab: ['Tab not open', 'pill--wait', 'dot--wait'],
  logged_out: ['Signed out', 'pill--down', 'dot--down'], blocked: ['Blocked', 'pill--down', 'dot--down'], error: ['Problem', 'pill--down', 'dot--down'],
};
const initial = (name) => ([...String(name || '?').trim()][0] || '?').toUpperCase();

let current = { ov: null, refresh: () => {}, me: null };
let panel = null; // { dialog, key }

/** Every laptop in the overview, with the name of its person group. */
export function allLaptops(ov) {
  return (ov?.people || []).flatMap((p) => p.devices.map((d) => ({ ...d, personKey: p.key })));
}

/**
 * What a laptop does on a channel, in a few words for the owner: [pill text, pill, dot, what it does].
 * A tab on another account is not a fault: it says so in plain words and stays out of the shop's channel.
 */
export function roleText(ov, d, ch) {
  const c = d.channels?.[ch] || { state: 'no_tab', role: 'not_ready' };
  const leader = ov?.lanes?.[ch]?.leader;
  const main = ov?.main?.label || 'the main laptop';
  if (c.role === 'off') return ['Switched off', 'pill--pause', 'dot--pause', ''];
  if (!d.online && c.role !== 'other_account' && c.role !== 'unconfirmed') return ['Laptop offline', 'pill--down', 'dot--down', c.role === 'active' ? 'Answers here.' : ''];
  if (c.role === 'other_account') return ['Connected to another account', 'pill--pause', 'dot--pause', 'Not the shop’s account, so it stays out of this channel.'];
  if (c.role === 'unconfirmed') return ['Account not confirmed', 'pill--pause', 'dot--pause', c.account ? 'The shop’s account is not set for this channel yet.' : 'This laptop cannot say which account it is on. Update its extension.'];
  if (c.role === 'active') return c.state === 'ready' ? ['Connected', 'pill--live', 'dot--live', 'Answers here.'] : [...(STATE[c.state] || ['Checking', 'pill--pause', 'dot--pause']), 'Answers here.'];
  if (c.role === 'handing_back') return ['Connected', 'pill--live', 'dot--live', `Handing back to ${main}.`];
  if (c.role === 'standby') return ['Connected', 'pill--live', 'dot--live', leader?.online ? `Standing by for ${leader.label}.` : 'Standing by.'];
  return [...(STATE[c.state] || ['Checking', 'pill--pause', 'dot--pause']), ''];
}

// ---- chips next to the logo --------------------------------------------------------------------------

/** Paint the people chips (sidebar and the phone's top bar), and the panel when it is open. */
export function paintPeople(ov, { refresh } = {}) {
  current = { ...current, ov, refresh: refresh || current.refresh };
  const people = ov?.people || [];
  const chips = people.map((p) => html`<button type="button" class="pchip" data-person="${p.key}" aria-label="${p.name}. ${p.online ? 'Online' : 'Offline'}. Show laptop and channels" title="${p.online ? 'Online' : 'Offline'}">
    <span class="dot ${p.online ? 'dot--live pchip__on' : 'dot--down pchip__off'}" aria-hidden="true"></span><span class="pchip__init" aria-hidden="true">${initial(p.name)}</span><span class="pchip__name">${p.name}</span></button>`);
  const sig = JSON.stringify(people.map((p) => [p.key, p.name, p.online]));
  for (const box of $$('[data-people]')) {
    if (box.dataset.sig === sig) continue;
    box.dataset.sig = sig;
    if (people.length) setHTML(box, html`${chips}`); else box.innerHTML = '';
  }
  if (panel && panel.dialog.open) paintPanel();
}

document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-people] [data-person]');
  if (chip) openPeople(chip.dataset.person);
});
onThisLaptop(async () => {
  current.me = await thisLaptop(0).catch(() => null);
  if (panel && panel.dialog.open) paintPanel();
});

// ---- the People panel ----------------------------------------------------------------------------------

/** Open the panel on one person: whether their laptop is on, and each channel there. */
export async function openPeople(key) {
  if (!panel) {
    const dialog = el(html`<dialog class="dialog dialog--people" aria-labelledby="ppl-t"><div class="dialog__body" id="ppl-body"></div></dialog>`);
    document.body.append(dialog);
    dialog.addEventListener('click', onPanelClick);
    dialog.addEventListener('submit', onPanelSubmit);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    panel = { dialog, key };
  }
  panel.key = key;
  current.me = await thisLaptop().catch(() => null);
  paintPanel();
  if (!panel.dialog.open) panel.dialog.showModal();
}

function paintPanel() {
  const ov = current.ov;
  const people = ov?.people || [];
  const person = people.find((p) => p.key === panel.key) || people[0];
  const body = $('#ppl-body', panel.dialog);
  // Leave a form alone while the owner is typing in it.
  if (body.contains(document.activeElement) && document.activeElement.matches('input')) return;
  if (!person) {
    setHTML(body, html`<h2 class="dialog__title" id="ppl-t">People</h2><p class="muted">No laptop is paired yet. Pair one in Connections.</p>
      <div class="dialog__actions"><a class="btn btn--primary" href="#/connections" data-close>Pair a laptop</a><button type="button" class="btn btn--ghost" data-close>Close</button></div>`);
    return;
  }
  panel.key = person.key;
  const me = current.me;
  const lanes = ov?.lanes || {};
  setHTML(body, html`
    ${people.length > 1 ? html`<div class="ppl__tabs" role="group" aria-label="People">${people.map((p) => html`<button type="button" class="pchip" data-switch="${p.key}" aria-pressed="${p.key === person.key ? 'true' : 'false'}"><span class="dot ${p.online ? 'dot--live pchip__on' : 'dot--down pchip__off'}" aria-hidden="true"></span><span class="pchip__name">${p.name}</span></button>`)}</div>` : ''}
    <h2 class="dialog__title" id="ppl-t">${person.name}</h2>
    ${person.devices.map((d) => {
      const here = me && me.device_id === d.id;
      return html`<section class="pcard" aria-label="${d.label}">
        <div class="pcard__head"><b class="truncate">${d.label}</b>${here ? html`<span class="tag tag--live">This laptop</span>` : ''}${d.main ? html`<span class="tag">Main laptop</span>` : ''}
          <span class="pill ${d.online ? (d.paused ? 'pill--pause' : 'pill--live') : 'pill--down'}"><span class="dot ${d.online ? (d.paused ? 'dot--pause' : 'dot--live') : 'dot--down'}" aria-hidden="true"></span>${d.online ? (d.paused ? 'Paused' : 'Online') : 'Offline'}</span></div>
        <p class="meta">${d.online ? `Laptop connected. Checked in ${ago(d.last_seen_at, ov.now)}.` : d.last_seen_at ? `Laptop not connected. Last seen ${ago(d.last_seen_at, ov.now)}.` : 'Has not checked in yet.'} ${d.name && d.person ? `Named ${d.name}.` : ''}</p>
        ${d.can_stand_by ? '' : html`<p class="banner banner--wait">${icon('i-dot')}<span>This laptop has an older extension${d.version ? ` (${d.version})` : ''}. Update it to 0.6.0 so it can stand in for the others and open tabs from here.</span></p>`}
        <p class="field__hint">${d.main ? 'The main laptop. Its WhatsApp and TikTok accounts are the shop’s, and it answers whenever it is ready.' : html`Stands in when the main laptop is off. <button type="button" class="linkbtn" data-main="${d.id}" data-label="${d.label}">Make this the main laptop</button>`}</p>
        <ul class="plist">${CHANNELS.map((ch) => {
          const c = d.channels?.[ch] || {};
          const [text, pill, dot, does] = roleText(ov, d, ch);
          const account = c.account_shown || (c.state === 'ready' ? 'Account not known yet' : '');
          const useIt = (c.role === 'other_account' || c.role === 'unconfirmed') && c.account;
          const facts = [account, c.unread ? `${c.unread} unread` : '', does.replace(/\.$/, '')].filter(Boolean).join('. ');
          return html`<li>${chBadge(ch, true)}<span class="plist__name">${chName(ch)}</span>
            <span class="pill ${pill}">${dot ? html`<span class="dot ${dot}" aria-hidden="true"></span>` : ''}${text}</span>
            <span class="meta plist__meta">${facts}${useIt ? html` <button type="button" class="linkbtn" data-shop-account="${ch}" data-account="${c.account}" data-shown="${c.account_shown}">Use this one for the shop</button>` : ''}</span>
            <button type="button" class="tabdot tabdot--inline" data-open-on="${d.id}" data-ch="${ch}" aria-label="Open the ${chName(ch)} tab on ${d.label}" title="Open and pin the ${chName(ch)} tab on ${d.label}"></button></li>`;
        })}</ul>
        <details class="fold"><summary>Change the name</summary>
          <form class="stack fold__body" data-rename="${d.id}">
            <div class="grid grid--2">
              <div class="field"><label class="field__label" for="pn-${d.id}">Whose laptop</label><input class="input" id="pn-${d.id}" name="person" maxlength="40" value="${d.person || ''}" placeholder="Adrian" autocomplete="off"></div>
              <div class="field"><label class="field__label" for="dn-${d.id}">Laptop name</label><input class="input" id="dn-${d.id}" name="name" maxlength="60" value="${d.name || ''}" autocomplete="off"></div>
            </div>
            <div class="wrap"><button type="submit" class="btn btn--primary btn--sm">Save</button></div>
          </form></details>
      </section>`;
    })}
    <div class="stack"><h3 class="eyebrow">Who answers now</h3>
      <ul class="plist plist--lanes">${CHANNELS.map((ch) => {
        const l = lanes[ch];
        const who = !l?.leader ? 'Nobody yet' : l.handing_back ? `${l.leader.label}. Handing back to ${ov?.main?.label || 'the main laptop'}` : l.leader.online ? l.leader.label : `${l.leader.label}. Offline`;
        const shop = l?.account_shown ? `Shop account ${l.account_shown}` : 'Shop account not set yet';
        return html`<li>${chBadge(ch, true)}<span class="plist__name">${chName(ch)}</span><span class="meta">${who}. ${shop}${l?.account_src === 'owner' ? html` <button type="button" class="linkbtn" data-shop-reset="${ch}">Use the main laptop’s account</button>` : ''}</span></li>`;
      })}</ul>
      <p class="field__hint">${ov?.main ? `${ov.main.label} is the main laptop.` : ''} Another laptop on the shop’s account stands by. It takes over in about a minute and a half if the main laptop goes off or stops working, and hands back when the main laptop is ready again. A laptop on another account stays out.</p></div>
    <div class="dialog__actions"><a class="btn btn--ghost" href="#/connections" data-close>Pair another laptop</a><button type="button" class="btn btn--primary" data-close>Close</button></div>`);
}

async function onPanelClick(e) {
  const sw = e.target.closest('[data-switch]');
  if (sw) { panel.key = sw.dataset.switch; paintPanel(); return; }
  if (e.target.closest('[data-close]')) { panel.dialog.close(); return; }
  const open = e.target.closest('[data-open-on]');
  if (open) openTab(current.ov, open.dataset.ch, open.dataset.openOn, open);
  const main = e.target.closest('[data-main]');
  if (main) {
    const ok = await confirmDialog({
      title: `Make ${main.dataset.label} the main laptop?`,
      text: 'Its WhatsApp and TikTok accounts become the shop’s, unless you set one. It answers once it has been ready for 2 minutes. The others stand in when it is off.',
      confirm: 'Make it the main laptop',
    });
    if (!ok) return;
    try { await put('/api/people/main', { device_id: main.dataset.main }); toast(`${main.dataset.label} is the main laptop now.`); await current.refresh(); }
    catch (err) { toastError(err, 'Not changed. Try again.'); }
    return;
  }
  const reset = e.target.closest('[data-shop-reset]');
  if (reset) {
    const ch = reset.dataset.shopReset;
    try { await put(`/api/lanes/${encodeURIComponent(`${ch}:inbox`)}/account`, { account: '' }); toast(`${chName(ch)} uses the main laptop’s account again.`); await current.refresh(); }
    catch (err) { toastError(err, 'Not changed. Try again.'); }
    return;
  }
  const shop = e.target.closest('[data-shop-account]');
  if (shop) {
    const ch = shop.dataset.shopAccount;
    const ok = await confirmDialog({
      title: `Use ${shop.dataset.shown} for ${chName(ch)}?`,
      text: `The agent answers ${chName(ch)} from this account from now on. A laptop on the old account stops answering it. No laptop changes it back.`,
      confirm: 'Use this one',
    });
    if (!ok) return;
    try { await put(`/api/lanes/${encodeURIComponent(`${ch}:inbox`)}/account`, { account: shop.dataset.account }); toast(`${chName(ch)} now uses ${shop.dataset.shown}.`); await current.refresh(); }
    catch (err) { toastError(err, 'Not changed. Try again.'); }
  }
}

async function onPanelSubmit(e) {
  const f = e.target.closest('[data-rename]');
  if (!f) return;
  e.preventDefault();
  const body = { person: f.elements.namedItem('person').value.trim(), name: f.elements.namedItem('name').value.trim() };
  if (!body.name) { toast('Give the laptop a name.', { type: 'warn' }); return; }
  try {
    await patch(`/api/devices/${encodeURIComponent(f.dataset.rename)}`, body);
    toast('Saved.');
    f.closest('details').open = false;
    document.activeElement?.blur?.();
    await current.refresh();
  } catch (err) { toastError(err, 'Not saved. Try again.'); }
}

// ---- open a channel's tab on a laptop -------------------------------------------------------------------

/** Ask which laptop, when there is more than one to choose from. Resolves to a laptop or null. */
function chooseLaptop(list, ch) {
  return new Promise((resolve) => {
    const d = el(html`<dialog class="dialog" aria-labelledby="pick-t"><form method="dialog" class="dialog__body">
      <h2 class="dialog__title" id="pick-t">Open ${chName(ch)} on which laptop?</h2>
      <div class="stack">${list.map((x) => html`<button class="btn btn--block pick" value="${x.id}"><span class="dot ${x.online ? 'dot--live' : 'dot--down'}" aria-hidden="true"></span>${x.label}<span class="meta">${x.online ? 'Online' : 'Offline'}</span></button>`)}</div>
      <div class="dialog__actions"><button class="btn btn--ghost" value="">Cancel</button></div></form></dialog>`);
    document.body.append(d);
    d.addEventListener('close', () => { resolve(list.find((x) => x.id === d.returnValue) || null); d.remove(); });
    d.addEventListener('click', (e) => { if (e.target === d) d.close(''); });
    d.showModal();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The blue dot: open and pin a channel's tab. On this laptop (its extension answers here) at once. On
 * any other laptop through the server: it opens when that laptop next checks in, within about 20 s,
 * and the screen says so. `deviceId` picks the laptop; without it this laptop wins, else the one that
 * answers the channel, else the owner is asked.
 */
export async function openTab(ov, ch, deviceId = null, button = null) {
  const lane = `${ch}:inbox`;
  const laptops = allLaptops(ov);
  const me = await thisLaptop().catch(() => null);
  const here = me && laptops.some((d) => d.id === me.device_id) ? me : null;
  if (button) button.setAttribute('aria-busy', 'true');
  try {
    if (here && (!deviceId || deviceId === here.device_id)) {
      const r = await openHere(lane);
      if (r.ok) toast(`${chName(ch)} is open and pinned on this laptop.`);
      else toast(`Could not open ${chName(ch)} here. Click the ACX Agent icon in Chrome to check the extension.`, { type: 'error', ms: 7000 });
      return;
    }
    let target = deviceId ? laptops.find((d) => d.id === deviceId) : null;
    if (!target) {
      // One laptop, or only one of them online: that one. Else the owner picks.
      const online = laptops.filter((d) => d.online);
      if (!laptops.length) { toast('No laptop is paired yet. Pair one in Connections.', { type: 'warn' }); return; }
      target = laptops.length === 1 ? laptops[0] : online.length === 1 ? online[0]
        : await chooseLaptop([...laptops].sort((a, b) => Number(b.online) - Number(a.online)), ch);
      if (!target) return;
    }
    if (!target.can_stand_by) {
      toast(`${target.label} has an older extension. Update it to 0.6.0 to open tabs from here.`, { type: 'warn', ms: 7000 });
      return;
    }
    let cmd;
    try { cmd = (await post(`/api/devices/${encodeURIComponent(target.id)}/commands`, { type: 'open_tab', lane })).command; }
    catch (err) { toast(friendly(err, 'Could not send that. Try again.'), { type: 'error' }); return; }
    toast(target.online
      ? `It opens on ${target.label} in a few seconds.`
      : `${target.label} is offline. It opens there if it comes back in the next 2 minutes.`, { ms: 6000 });
    // Asked again every 3 s until the laptop says it did it (about 20 s), or the command is too old.
    for (let i = 0; i < 26; i++) {
      await sleep(3000);
      let st;
      try { st = await get(`/api/devices/${encodeURIComponent(target.id)}/commands/${encodeURIComponent(cmd.id)}`); } catch { continue; }
      if (st.state === 'done') { toast(`${chName(ch)} is open and pinned on ${target.label}.`); return; }
      if (st.state === 'failed') { toast(`${target.label} could not open ${chName(ch)}. Check the extension there.`, { type: 'error', ms: 7000 }); return; }
      if (st.state === 'expired') { toast(`${target.label} did not open it. Check that the laptop is on.`, { type: 'warn', ms: 7000 }); return; }
    }
  } finally {
    if (button) button.removeAttribute('aria-busy');
  }
}

