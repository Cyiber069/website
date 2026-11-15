// Connections: the laptop, the AI brain, Shopify, phone notifications, channel modes, pacing, password.
import { api, get, post, put, del } from '../api.js';
import { $, html, raw, icon, setHTML, toast, toastError, friendly, unavailable, skeletonCards, switchRow, segmented, field, busy, ago, copyText, confirmDialog, chBadge, chName, CHANNELS, plural } from '../ui.js';
import { pushState, enablePush, disablePush } from '../push.js';

const MODE_HINT = { auto: 'Replies on its own', review: 'Writes a draft and waits for your OK in Urgent', off: 'Does not read or reply' };
const copyRow = (label, value, id) => html`<div class="field"><span class="field__label">${label}</span><div class="copy"><code class="copy__text break" id="${id}">${value}</code><button type="button" class="btn btn--sm" data-copy="${id}">${icon('i-copy')}Copy</button></div></div>`;
const savedTag = (s, yes = 'Saved', no = 'Not added yet') => s?.saved ? html`<span class="tag tag--live">${yes}${s.hint ? ` (ends ${String(s.hint).replace(/^\.+/, '')})` : ''}</span>` : html`<span class="tag tag--wait">${no}</span>`;

export default {
  title: 'Connections',
  focus: true,
  mount(view, ctx) {
    let devices = null, devicesErr = null;
    let pair = null;
    let conn = null, connErr = null;
    let settings = null, settingsErr = null;
    let push = { supported: false, permission: 'default', subscribed: false };
    let brainTest = null, shopTest = null;
    let pairTimer = null;
    let laptopSig = '';

    setHTML(view, html`
      <nav class="chips jump" aria-label="Jump to">${[['laptop', 'Laptop'], ['brain', 'AI brain'], ['shopify', 'Shopify'], ['notify', 'Notifications'], ['channels', 'Channels'], ['pacing', 'Pacing'], ['account', 'Password']].map(([id, t]) => html`<a class="chip" href="#sec-${id}" data-jump>${t}</a>`)}</nav>
      <section class="card stack" id="sec-laptop" aria-labelledby="h-laptop">${skeletonCards(1)}</section>
      <section class="card stack" id="sec-brain" aria-labelledby="h-brain">${skeletonCards(1)}</section>
      <section class="card stack" id="sec-shopify" aria-labelledby="h-shopify">${skeletonCards(1)}</section>
      <section class="card stack" id="sec-notify" aria-labelledby="h-notify">${skeletonCards(1)}</section>
      <section class="card stack" id="sec-channels" aria-labelledby="h-channels">${skeletonCards(1)}</section>
      <section class="card stack" id="sec-pacing" aria-labelledby="h-pacing">${skeletonCards(1)}</section>
      <section class="card stack" id="sec-account" aria-labelledby="h-account"></section>`);

    const head = (id, ic, title, sub, right = '') => html`<div class="card__head sec__head"><div class="row">${icon(ic, 'sec__icon')}<div><h2 class="sec__title" id="h-${id}">${title}</h2><p class="meta">${sub}</p></div></div>${right}</div>`;

    // ---- Laptop ---------------------------------------------------------------------------------------
    function paintLaptop() {
      const box = $('#sec-laptop', view);
      const list = devices || [];
      const online = list.some((d) => d.online);
      setHTML(box, html`
        ${head('laptop', 'i-laptop', 'This laptop', 'The agent works through Chrome on your laptop. Leave it open and plugged in.', devices ? html`<span class="pill ${online ? 'pill--live' : list.length ? 'pill--down' : 'pill--wait'}"><span class="dot ${online ? 'dot--live' : list.length ? 'dot--down' : 'dot--wait'}" aria-hidden="true"></span>${online ? 'Online' : list.length ? 'Offline' : 'Not paired'}</span>` : '')}
        ${devicesErr && !devices ? unavailable('The laptop list', devicesErr) : ''}
        ${list.length ? html`<ul class="rows">${list.map((d) => html`<li class="rowline"><span class="row"><b class="truncate">${d.name || 'Laptop'}</b><span class="tag ${d.online ? 'tag--live' : 'tag--down'}">${d.online ? 'Online' : 'Offline'}</span></span><span class="meta">${d.last_seen_at ? `Last checked in ${ago(d.last_seen_at)}` : 'Has not checked in yet'}</span><button type="button" class="btn btn--ghost btn--sm" data-action="unpair" data-id="${d.id}" data-name="${d.name || 'this laptop'}">Remove</button></li>`)}</ul>` : ''}
        ${pair ? html`<div class="pairbox stack">
            ${copyRow('Pairing line', pair.pairing_string, 'pair-line')}
            <p class="meta" id="pair-left"></p>
            <ol class="howto">
              <li>On the laptop, open Chrome and go to <code>chrome://extensions</code>.</li>
              <li>Switch on <b>Developer mode</b> (top right), press <b>Load unpacked</b> and choose the <b>extension</b> folder you were given.</li>
              <li>Click the ACX Agent icon in the Chrome toolbar.</li>
              <li>Paste the pairing line and press <b>Connect</b>.</li>
              <li>Open WhatsApp Web, Gmail and TikTok in tabs and leave them signed in.</li>
            </ol></div>`
          : html`<div><button type="button" class="btn ${list.length ? '' : 'btn--primary'}" data-action="pair">${list.length ? 'Pair another laptop' : 'Pair this laptop'}</button></div>
            ${list.length ? '' : html`<p class="field__hint">You get a one time line to paste into the ACX Agent extension. It works for 15 minutes.</p>`}`}`);
      paintPairLeft();
    }
    function paintPairLeft() {
      const n = $('#pair-left', view); if (!n || !pair) return;
      const left = pair.expires_at - Date.now();
      if (left <= 0) { pair = null; paintLaptop(); return; }
      n.textContent = `Works for another ${Math.max(1, Math.ceil(left / 60000))} min, one time only. This page notices when the laptop connects.`;
    }
    async function loadDevices() {
      const had = (devices || []).length;
      try { devices = (await get('/api/devices')).devices || []; devicesErr = null; }
      catch (err) { if (err.name === 'AuthError') return; devicesErr = err; }
      if (pair && devices && devices.length > had) { pair = null; toast('Laptop paired. The agent can see your chats now.'); ctx.refreshOverview(); }
      const sig = JSON.stringify([devices?.map((d) => [d.id, d.online, d.name]), Boolean(pair), Boolean(devicesErr)]);
      if (sig !== laptopSig) { laptopSig = sig; paintLaptop(); }
    }

    // ---- Brain ----------------------------------------------------------------------------------------
    function paintBrain() {
      const box = $('#sec-brain', view);
      if (!conn) { setHTML(box, html`${head('brain', 'i-brain', 'AI brain', 'What the agent thinks with.')}${unavailable('The AI brain settings', connErr)}`); return; }
      const b = conn.brain || {};
      const models = b.models?.length ? b.models : [{ id: b.model, label: b.model, note: '' }];
      setHTML(box, html`
        ${head('brain', 'i-brain', 'AI brain', 'The agent thinks with Claude. You pay Anthropic for what it uses.', savedTag(b.claude_key, 'Key saved', 'No key yet'))}
        <form class="stack form" id="brain-form" novalidate>
          ${field({ label: b.claude_key?.saved ? 'Replace the Claude API key' : 'Claude API key', name: 'anthropic_api_key', type: 'password', placeholder: 'sk-ant-...', attrs: 'autocomplete="off" spellcheck="false"', hint: 'Get one at console.anthropic.com under API keys. It is stored on the server and never shown again.' })}
          <div class="field"><label class="field__label" for="brain-model">Model</label>
            <select class="input" id="brain-model" name="model">${models.map((m) => html`<option value="${m.id}" ${m.id === b.model ? raw('selected') : ''}>${m.label}</option>`)}</select>
            <p class="field__hint" id="model-note">${models.find((m) => m.id === b.model)?.note || ''}</p></div>
          ${segmented({ legend: 'How hard it thinks', name: 'effort', value: b.effort || 'low', options: [['low', 'Quick'], ['medium', 'Balanced'], ['high', 'Careful']] })}
          <p class="field__hint">Quick is right for most chats. Careful is slower and costs more.</p>
          ${!b.claude_key?.saved && b.workers_ai?.available ? html`<p class="banner banner--info">${icon('i-dot')}<span>Until you add a key the agent uses a free backup brain. It works, but Claude writes much better replies.</span></p>` : ''}
          <p class="form-error" role="alert" hidden></p>
          <div class="wrap"><button type="submit" class="btn btn--primary">Save brain settings</button><button type="button" class="btn" data-action="brain-test">Test it</button></div>
          <div id="brain-test" aria-live="polite">${brainTest ? testResult(brainTest, brainTest.ok ? `Working. It answered in ${(brainTest.ms / 1000).toFixed(1)} seconds${brainTest.sample ? `: "${brainTest.sample}"` : '.'}` : null) : ''}</div>
        </form>`);
    }
    const testResult = (r, okText) => html`<p class="banner ${r.ok ? 'banner--ok' : 'banner--down'}">${icon(r.ok ? 'i-check' : 'i-stop')}<span>${r.ok ? okText : html`<b>Not working.</b> ${r.error || 'No reason was given. Check the details above and try again.'}`}</span></p>`;

    // ---- Shopify ---------------------------------------------------------------------------------------
    function paintShopify() {
      const box = $('#sec-shopify', view);
      if (!conn) { setHTML(box, html`${head('shopify', 'i-shop', 'AcxEbikes Shopify', 'Lets the agent see who left a checkout.')}${unavailable('The Shopify connection', connErr)}`); return; }
      const s = conn.shopify || {};
      const connected = s.mode && s.mode !== 'none';
      setHTML(box, html`
        ${head('shopify', 'i-shop', 'AcxEbikes Shopify', 'Lets the agent see who left a checkout. Pick one of the two ways.', html`<span class="pill ${connected ? 'pill--live' : 'pill--wait'}"><span class="dot ${connected ? '' : 'dot--wait'}" aria-hidden="true"></span>${s.mode === 'api' ? 'Connected' : s.mode === 'webhook' ? 'Connected by webhook' : 'Not connected'}</span>`)}
        <form class="stack form" id="shop-form" novalidate>
          ${field({ label: 'Store address', name: 'myshopify_domain', value: s.myshopify_domain || '', placeholder: 'your-store.myshopify.com', attrs: 'autocomplete="off" spellcheck="false" inputmode="url"', hint: 'The address that ends in myshopify.com. Find it in Shopify under Settings, Domains.' })}
          <details class="fold fold--in" ${s.mode !== 'webhook' ? raw('open') : ''}><summary><span><b>Way 1: connect an app</b> <span class="meta">best, the agent checks Shopify itself</span></span>${savedTag(s.api, 'Saved', 'Not set')}</summary>
            <div class="stack fold__body">
              <ol class="howto"><li>In Shopify open <b>Settings</b>, then <b>Apps and sales channels</b>, then <b>Develop apps</b>.</li><li>Create an app and give it permission to read orders and checkouts.</li><li>Install it, then paste either the client ID and secret, or the admin token, below.</li></ol>
              <div class="grid grid--2">${field({ label: 'Client ID', name: 'client_id', attrs: 'autocomplete="off" spellcheck="false"', placeholder: s.api?.client_id_saved ? 'Saved. Paste to replace' : '' })}${field({ label: 'Client secret', name: 'client_secret', type: 'password', attrs: 'autocomplete="off"', placeholder: s.api?.kind === 'app' ? 'Saved. Paste to replace' : '' })}</div>
              ${field({ label: 'Or an admin API token', name: 'admin_token', type: 'password', attrs: 'autocomplete="off"', placeholder: s.api?.kind === 'admin_token' ? 'Saved. Paste to replace' : 'shpat_...', hint: 'Use this instead of the ID and secret if your app shows a token.' })}
            </div></details>
          <details class="fold fold--in" ${s.mode === 'webhook' ? raw('open') : ''}><summary><span><b>Way 2: webhooks only</b> <span class="meta">simpler, Shopify tells the agent</span></span>${s.webhook?.secret_saved ? html`<span class="tag tag--live">Saved</span>` : html`<span class="tag tag--wait">Not set</span>`}</summary>
            <div class="stack fold__body">
              <ol class="howto"><li>In Shopify open <b>Settings</b>, then <b>Notifications</b>, then <b>Webhooks</b>.</li><li>Create one webhook each for <b>Checkout creation</b>, <b>Checkout update</b> and <b>Order creation</b>. Format JSON.</li><li>Paste this address into each one.</li></ol>
              ${copyRow('Webhook address', s.webhook?.url || `${location.origin}/api/hooks/shopify`, 'hook-url')}
              ${field({ label: 'Webhook signing secret', name: 'webhook_secret', type: 'password', attrs: 'autocomplete="off"', placeholder: s.webhook?.secret_saved ? 'Saved. Paste to replace' : '', hint: 'Shopify shows it at the bottom of the Webhooks page. It proves the messages really come from your store.' })}
              <p class="meta">${s.webhook?.last_received_at ? `Last heard from Shopify ${ago(s.webhook.last_received_at)}.` : 'Nothing has arrived from Shopify yet.'}</p>
            </div></details>
          <p class="form-error" role="alert" hidden></p>
          <div class="wrap"><button type="submit" class="btn btn--primary">Save Shopify details</button><button type="button" class="btn" data-action="shop-test">Test it</button>${connected ? html`<button type="button" class="btn btn--ghost" data-action="shop-off">Disconnect</button>` : ''}</div>
          <div id="shop-test" aria-live="polite">${shopTest ? testResult(shopTest, `Working.${shopTest.shop_name ? ` Connected to ${shopTest.shop_name}.` : ''}${shopTest.checkouts != null ? ` ${plural(shopTest.checkouts, 'open checkout')} found.` : ''}${shopTest.last_received_at ? ` Last heard from Shopify ${ago(shopTest.last_received_at)}.` : ''}`) : ''}</div>
        </form>`);
    }

    // ---- Notifications ---------------------------------------------------------------------------------
    function paintNotify() {
      const box = $('#sec-notify', view);
      const a = settings?.alerts;
      const key = conn?.push?.public_key;
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
      const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
      let pushBlock;
      if (!conn) pushBlock = unavailable('Phone notifications', connErr);
      else if (!push.supported) pushBlock = html`<p class="banner banner--info">${icon('i-bell')}<span>${ios && !standalone ? html`<b>On iPhone, add this app to your home screen first.</b> Tap Share, then "Add to Home Screen", open it from there and come back to this page.` : 'This browser cannot show notifications. Open ACX Agent in Chrome or Safari on your phone.'}</span></p>`;
      else if (push.permission === 'denied') pushBlock = html`<p class="banner banner--down">${icon('i-bell')}<span><b>Notifications are blocked for this site.</b> Open your browser settings for this site, allow notifications, then reload this page.</span></p>`;
      else if (!key) pushBlock = html`<p class="banner banner--info">${icon('i-bell')}<span>Notifications are not ready on the server yet. Try again a little later.</span></p>`;
      else pushBlock = html`
        ${switchRow({ checked: push.subscribed, label: 'Notify this device', hint: push.subscribed ? 'You get a ping when a customer needs you' : 'Switch on, then press Allow when your phone asks', action: 'push-toggle' })}
        <div class="wrap"><button type="button" class="btn" data-action="push-test" ${push.subscribed || conn.push?.subscriptions ? '' : raw('disabled')}>Send a test</button><span class="meta">${plural(conn.push?.subscriptions || 0, 'device')} switched on in total.</span></div>`;
      setHTML(box, html`
        ${head('notify', 'i-bell', 'Phone notifications', 'A ping when a customer is waiting on you or the laptop goes quiet.')}
        ${pushBlock}
        ${a ? html`<form class="stack form" id="alerts-form" novalidate>
          <h3 class="eyebrow">Alert settings</h3>
          ${switchRow({ name: 'push', checked: a.push, label: 'Send alerts', hint: 'Master switch for every device' })}
          ${field({ label: 'Also WhatsApp me on this number', name: 'whatsapp_number', value: a.whatsapp_number || '', type: 'tel', placeholder: '+447700900123', attrs: 'autocomplete="tel" inputmode="tel"', hint: 'Optional. Your personal number, with the country code. Leave empty to switch this off.' })}
          ${field({ label: 'Tell me when the laptop has been offline for (minutes)', name: 'offline_minutes', type: 'number', value: a.offline_minutes, attrs: 'min="2" max="240" inputmode="numeric"' })}
          <p class="form-error" role="alert" hidden></p>
          <div><button type="submit" class="btn" disabled>Save alert settings</button></div>
        </form>` : settingsErr ? unavailable('Alert settings', settingsErr) : ''}`);
    }

    // ---- Channels + pacing -------------------------------------------------------------------------------
    function paintChannels() {
      const box = $('#sec-channels', view);
      if (!settings) { setHTML(box, html`${head('channels', 'i-inbox', 'Channels', 'How much freedom the agent has on each one.')}${settingsErr ? unavailable('Channel settings', settingsErr) : skeletonCards(1)}`); return; }
      setHTML(box, html`
        ${head('channels', 'i-inbox', 'Channels', 'How much freedom the agent has on each one. Saves as you tap.')}
        ${CHANNELS.map((c) => { const mode = settings.channels?.[c]?.mode || 'off'; return html`<div class="chmode">${chBadge(c)}
          ${segmented({ legend: html`<span class="sr-only">${chName(c)} mode</span>`, name: `mode-${c}`, value: mode, action: `mode:${c}`, options: [['auto', 'Auto'], ['review', 'Ask me first'], ['off', 'Off']] })}
          <p class="field__hint" id="mode-hint-${c}">${MODE_HINT[mode]}</p></div>`; })}
        <form class="stack form" id="gmail-form" novalidate>
          ${field({ label: 'Gmail inbox the agent uses', name: 'gmail_account', type: 'email', value: settings.gmail?.account || '', placeholder: 'shop@gmail.com', attrs: 'autocomplete="off" spellcheck="false" inputmode="email"', hint: 'Sign in to this address in Chrome on the laptop. The agent opens this inbox and never replies from any other. Leave empty to use the first account in Chrome.' })}
          <p class="form-error" role="alert" hidden></p>
          <div><button type="submit" class="btn" disabled>Save Gmail inbox</button></div>
        </form>`);
    }
    function paintPacing() {
      const box = $('#sec-pacing', view);
      if (!settings) { setHTML(box, html`${head('pacing', 'i-live', 'Pacing', 'How fast the agent replies.')}${settingsErr ? unavailable('Pacing settings', settingsErr) : skeletonCards(1)}`); return; }
      const p = settings.pacing || {};
      const n = (label, name, min, max, hint) => field({ label, name, type: 'number', value: p[name], attrs: `min="${min}" max="${max}" inputmode="numeric" required`, hint });
      setHTML(box, html`
        ${head('pacing', 'i-live', 'Pacing', 'How fast the agent replies. Slower looks more human.')}
        <form class="stack form" id="pacing-form" novalidate>
          <div class="grid grid--2">
            ${n('Wait for the customer to finish (seconds)', 'settle_seconds', 0, 120, 'People send a few messages in a row. The agent waits for a pause.')}
            ${n('Typing speed (letters a second)', 'typing_cps', 2, 40, 'About 11 is a fast human.')}
            ${n('Shortest wait before replying (seconds)', 'min_reply_delay_s', 0, 300)}
            ${n('Longest wait before replying (seconds)', 'max_reply_delay_s', 0, 600)}
            ${n('Most replies to one person in an hour', 'max_auto_replies_per_thread_per_hour', 1, 60, 'Stops the agent going round in circles.')}
            ${n('Stay out after I reply myself (minutes)', 'human_takeover_minutes', 0, 1440, 'When you type in a chat on the laptop, the agent leaves it alone for this long.')}
            ${n('Ignore messages older than (hours)', 'ignore_older_than_hours', 1, 720, 'Old unread messages are kept but never answered.')}
          </div>
          <p class="form-error" role="alert" hidden></p>
          <div><button type="submit" class="btn" disabled>Save pacing</button></div>
        </form>`);
    }
    function paintAccount() {
      setHTML($('#sec-account', view), html`
        ${head('account', 'i-lock', 'Password', 'One password for your phone and your laptop.')}
        <form class="stack form" id="pw-form" novalidate>
          <div class="grid grid--2">
            ${field({ label: 'Current password', name: 'current', type: 'password', attrs: 'autocomplete="current-password" required' })}
            ${field({ label: 'New password', name: 'next', type: 'password', attrs: 'autocomplete="new-password" minlength="8" required', hint: 'At least 8 characters.' })}
          </div>
          <p class="form-error" role="alert" hidden></p>
          <div class="wrap"><button type="submit" class="btn">Change password</button><span class="top__spacer"></span><button type="button" class="btn btn--ghost" data-action="signout">Sign out</button></div>
        </form>`);
    }

    async function loadConn() {
      try { conn = await get('/api/connections'); connErr = null; }
      catch (err) { if (err.name === 'AuthError') return; connErr = err; }
      push = await pushState();
      paintBrain(); paintShopify(); paintNotify();
    }
    async function loadSettings() {
      try { settings = (await get('/api/settings')).settings; settingsErr = null; }
      catch (err) { if (err.name === 'AuthError') return; settingsErr = err; }
      paintChannels(); paintPacing(); paintNotify();
    }
    const formError = (f, msg) => { const e = f.querySelector('.form-error'); e.textContent = msg || ''; e.hidden = !msg; };
    const clean = (f) => { for (const i of f.querySelectorAll('[data-dirty]')) i.dataset.dirty = '0'; };

    view.addEventListener('input', (e) => { const f = e.target.closest('#alerts-form, #pacing-form, #gmail-form'); if (f) f.querySelector('[type=submit]').disabled = false; });
    view.addEventListener('change', async (e) => {
      if (e.target.id === 'brain-model') { $('#model-note', view).textContent = conn?.brain?.models?.find((m) => m.id === e.target.value)?.note || ''; return; }
      const f = e.target.closest('#alerts-form, #pacing-form'); if (f) f.querySelector('[type=submit]').disabled = false;
      const holder = e.target.closest('[data-change]');
      if (!holder) return;
      const action = holder.dataset.change;
      if (action.startsWith('mode:')) {
        const ch = action.slice(5); const mode = e.target.value; const before = settings.channels[ch].mode;
        settings.channels[ch] = { mode }; $(`#mode-hint-${ch}`, view).textContent = MODE_HINT[mode];
        try { await put('/api/settings/channels', { [ch]: { mode } }); toast(`${chName(ch)}: ${MODE_HINT[mode].toLowerCase()}.`); ctx.refreshOverview(); }
        catch (err) { settings.channels[ch] = { mode: before }; paintChannels(); toastError(err, 'Could not change that. Try again.'); }
        return;
      }
      if (action === 'push-toggle') {
        const want = e.target.checked; e.target.disabled = true;
        try {
          if (want) { await enablePush(conn.push.public_key); toast('Notifications are on for this device.'); }
          else { await disablePush(); toast('Notifications are off for this device.', { type: 'warn' }); }
        } catch (err) {
          if (err.name === 'AuthError') return;
          toast(err.userMessage || friendly(err, 'Could not change notifications. Try again.'), { type: 'error', ms: 7000 });
        }
        await loadConn(); ctx.refreshOverview();
      }
    });
    view.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target; const btn = f.querySelector('[type=submit]');
      if (f.id === 'brain-form') {
        const key = f.elements.anthropic_api_key.value.trim();
        if (key && !key.startsWith('sk-ant-')) { formError(f, 'That does not look like a Claude key. They start with sk-ant-. Copy it again from console.anthropic.com.'); f.elements.anthropic_api_key.focus(); return; }
        formError(f);
        return busy(btn, async () => {
          try {
            const body = { model: f.elements.model.value, effort: f.elements.effort.value };
            if (key) body.anthropic_api_key = key;
            conn = { ...conn, ...(await put('/api/connections/brain', body)) }; brainTest = null; clean(f);
            toast(key ? 'Key saved. Press Test it to check it works.' : 'Brain settings saved.');
            paintBrain(); ctx.refreshOverview();
          } catch (err) { formError(f, friendly(err, 'Not saved. Try again.')); }
        });
      }
      if (f.id === 'shop-form') {
        const body = {};
        for (const k of ['myshopify_domain', 'client_id', 'client_secret', 'admin_token', 'webhook_secret']) { const v = f.elements[k].value.trim(); if (v) body[k] = v; }
        if (body.myshopify_domain === conn.shopify?.myshopify_domain) delete body.myshopify_domain;
        if (!Object.keys(body).length) { formError(f, 'Nothing new to save. Paste a key, token or secret first.'); return; }
        if (body.client_id && !body.client_secret && conn.shopify?.api?.kind !== 'app') { formError(f, 'Paste the client secret as well. The ID does not work on its own.'); f.elements.client_secret.focus(); return; }
        formError(f);
        return busy(btn, async () => {
          try { conn = { ...conn, ...(await put('/api/connections/shopify', body)) }; shopTest = null; clean(f); toast('Shopify details saved. Press Test it to check.'); paintShopify(); ctx.refreshOverview(); }
          catch (err) { formError(f, friendly(err, 'Not saved. Try again.')); }
        });
      }
      if (f.id === 'gmail-form') {
        const account = f.elements.gmail_account.value.trim().toLowerCase();
        if (account && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) { formError(f, 'That does not look like an email address.'); f.elements.gmail_account.focus(); return; }
        formError(f);
        return busy(btn, async () => {
          try { const r = await put('/api/settings/gmail', { account }); settings.gmail = r.gmail || { account }; clean(f); btn.disabled = true; toast(account ? `Gmail will use ${account}.` : 'Gmail will use the first account in Chrome.'); }
          catch (err) { formError(f, friendly(err, 'Not saved. Try again.')); }
        });
      }
      if (f.id === 'alerts-form') {
        const num = f.elements.whatsapp_number.value.replace(/[\s()-]/g, '');
        if (num && !/^\+\d{8,15}$/.test(num)) { formError(f, 'Write the number with a plus and the country code, like +447700900123.'); f.elements.whatsapp_number.focus(); return; }
        const mins = Number(f.elements.offline_minutes.value);
        if (!(mins >= 2 && mins <= 240)) { formError(f, 'Offline minutes should be between 2 and 240.'); return; }
        formError(f);
        return busy(btn, async () => {
          try { const r = await put('/api/settings/alerts', { push: f.elements.push.checked, whatsapp_number: num, offline_minutes: Math.round(mins) }); settings.alerts = r.alerts || settings.alerts; clean(f); btn.disabled = true; toast('Alert settings saved.'); }
          catch (err) { formError(f, friendly(err, 'Not saved. Try again.')); }
        });
      }
      if (f.id === 'pacing-form') {
        const body = {};
        for (const i of f.querySelectorAll('input[type=number]')) {
          const v = Number(i.value);
          if (i.value === '' || !Number.isFinite(v) || v < Number(i.min) || v > Number(i.max)) { formError(f, `"${i.labels[0].textContent}" should be between ${i.min} and ${i.max}.`); i.focus(); return; }
          body[i.name] = Math.round(v);
        }
        if (body.max_reply_delay_s < body.min_reply_delay_s) { formError(f, 'The longest wait should be the same as or more than the shortest wait.'); return; }
        formError(f);
        return busy(btn, async () => {
          try { const r = await put('/api/settings/pacing', body); settings.pacing = r.pacing || body; clean(f); btn.disabled = true; toast('Pacing saved.'); }
          catch (err) { formError(f, friendly(err, 'Not saved. Try again.')); }
        });
      }
      if (f.id === 'pw-form') {
        const current = f.elements.current.value, next = f.elements.next.value;
        if (!current) { formError(f, 'Type your current password.'); f.elements.current.focus(); return; }
        if (next.length < 8) { formError(f, 'The new password is too short. Use at least 8 characters.'); f.elements.next.focus(); return; }
        formError(f);
        return busy(btn, async () => {
          try { await api('/api/password', { body: { current, next }, quiet401: true }); f.reset(); toast('Password changed.'); }
          catch (err) { formError(f, err.code === 'wrong_password' || err.status === 401 ? 'The current password is not right. Try again.' : friendly(err, 'Not changed. Try again.')); }
        });
      }
    });
    view.addEventListener('click', async (e) => {
      const jump = e.target.closest('[data-jump]');
      if (jump) { e.preventDefault(); const t = view.querySelector(jump.getAttribute('href')); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); const h = t.querySelector('h2'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } } return; }
      const c = e.target.closest('[data-copy]');
      if (c) return copyText($('#' + c.dataset.copy, view).textContent, 'Copied. Paste it where it is needed.');
      const b = e.target.closest('[data-action]'); if (!b) return;
      const action = b.dataset.action;
      if (action === 'retry') { loadDevices(); loadConn(); loadSettings(); return; }
      if (action === 'signout') return ctx.signOut();
      if (action === 'pair') {
        return busy(b, async () => {
          try { pair = await post('/api/devices/pair-code'); laptopSig = ''; paintLaptop(); $('#sec-laptop [data-copy]', view)?.focus(); }
          catch (err) { toastError(err, 'Could not make a pairing line. Try again.'); }
        });
      }
      if (action === 'unpair') {
        if (!(await confirmDialog({ title: `Remove ${b.dataset.name}?`, text: 'The agent stops working through that laptop straight away. You can pair it again later.', confirm: 'Remove', danger: true }))) return;
        try { await del(`/api/devices/${encodeURIComponent(b.dataset.id)}`); toast('Laptop removed.', { type: 'warn' }); await loadDevices(); ctx.refreshOverview(); }
        catch (err) { toastError(err, 'Could not remove it. Try again.'); }
        return;
      }
      if (action === 'brain-test') {
        return busy(b, async () => {
          b.textContent = 'Testing';
          try { brainTest = await post('/api/connections/brain/test'); }
          catch (err) { if (err.name === 'AuthError') return; brainTest = { ok: false, error: friendly(err, 'The test did not run. Try again.') }; }
          paintBrain();
        });
      }
      if (action === 'shop-test') {
        return busy(b, async () => {
          b.textContent = 'Testing';
          try { shopTest = await post('/api/connections/shopify/test'); }
          catch (err) { if (err.name === 'AuthError') return; shopTest = { ok: false, error: friendly(err, 'The test did not run. Try again.') }; }
          paintShopify();
        });
      }
      if (action === 'shop-off') {
        if (!(await confirmDialog({ title: 'Disconnect Shopify?', text: 'The saved keys are deleted. Checkout reminders stop finding new people until you connect again.', confirm: 'Disconnect', danger: true }))) return;
        try { conn = { ...conn, ...(await del('/api/connections/shopify')) }; shopTest = null; toast('Shopify disconnected.', { type: 'warn' }); paintShopify(); ctx.refreshOverview(); }
        catch (err) { toastError(err, 'Could not disconnect. Try again.'); }
        return;
      }
      if (action === 'push-test') {
        return busy(b, async () => {
          try { const r = await post('/api/push/test'); r.ok ? toast('Test sent. It should arrive in a few seconds.') : toast(r.error || 'The test could not be delivered. Switch notifications off and on again.', { type: 'error', ms: 7000 }); }
          catch (err) { toastError(err, 'The test was not sent. Try again.'); }
        });
      }
    });

    paintLaptop(); paintAccount();
    loadDevices(); loadConn(); loadSettings();
    pairTimer = setInterval(paintPairLeft, 15000);
    return {
      tick: async () => { if (pair || !devices) await loadDevices(); },
      destroy() { clearInterval(pairTimer); },
    };
  },
};
