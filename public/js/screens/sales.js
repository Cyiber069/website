// Sales: how chats turn into orders. The funnel for 7 and 30 days, the hot leads to look at now,
// the one follow up the agent sends, and how it sells. Loaded once and on Refresh, not every 15
// seconds: the counts read a lot of rows and the free plan allows 5 million a day.
import { get, put } from '../api.js';
import { $, html, icon, setHTML, chBadge, toast, toastError, unavailable, skeletonCards, segmented, switchRow, busy, num, timeTag, refreshTimes } from '../ui.js';

const STYLES = [
  ['friendly', 'Friendly', 'Helps them choose, then sends the link when they are ready.'],
  ['relaxed', 'Relaxed', 'Answers first. Only recommends when they ask what to get.'],
  ['keen', 'Keen', 'Always ends with the product link and a next step once it knows what fits.'],
];
const HOURS = [[12, '12 hours'], [20, '20 hours'], [24, '24 hours'], [48, '2 days']];
const STAGE = { ready: ['Ready to buy', 'tag--live'], interested: ['Interested', 'tag--wait'] };

const pounds = (n) => Number(n || 0).toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: Number(n) % 1 ? 2 : 0 });
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function funnelCard(f) {
  const steps = [
    ['Chats', f.chats, 'Customers who messaged'],
    ['Interested', f.interested, 'Asked about a product'],
    ['Ready to buy', f.ready, 'Asked how to order'],
    ['Bought', f.bought, 'Ordered after the agent chatted with them'],
  ];
  const top = Math.max(1, f.chats);
  return html`<section class="card stack" aria-labelledby="fn-${f.days}">
    <div class="card__head"><h2 class="eyebrow" id="fn-${f.days}">Last ${f.days} days</h2><span class="meta">Sales from chats <b class="num">${pounds(f.revenue)}</b></span></div>
    <div class="stack">${steps.map(([label, n, hint], i) => html`<div class="meter">
      <p class="meter__label"><b class="num">${num(n)}</b> ${label}${i > 0 && steps[i - 1][1] ? html` <span class="meta num">${pct(n, steps[i - 1][1])}% of the step before</span>` : ''}</p>
      <div class="progress meter__bar" role="img" aria-label="${label}: ${n}"><i style="--p:${Math.min(1, n / top).toFixed(4)}"></i></div>
      <p class="meta">${hint}</p>
    </div>`)}</div>
  </section>`;
}

function leadRow(l) {
  const [label, cls] = STAGE[l.stage] || STAGE.interested;
  const followed = l.followup_status === 'queued' ? 'Followed up' : l.followup_status === 'draft' ? 'Follow up waiting for your OK' : '';
  return html`<li><a class="conv" href="#/inbox/${l.conversation_id}">
    ${chBadge(l.channel, true)}
    <span class="conv__main">
      <span class="conv__top"><b class="truncate">${l.customer}</b><span class="meta">${timeTag(l.stage_at, 'short')}</span></span>
      <span class="wrap"><span class="tag ${cls}">${label}</span>${l.product ? html`<span class="meta truncate">${l.product}</span>` : ''}${followed ? html`<span class="tag">${followed}</span>` : ''}</span>
      <span class="conv__preview truncate">${l.last_direction === 'out' ? html`<span class="conv__you">Sent: </span>` : ''}${l.last_message || 'No messages yet'}</span>
    </span>
  </a></li>`;
}

function followCard(list) {
  const [w7, w30] = list;
  return html`<section class="grid grid--3" aria-label="Follow ups">
    <article class="stat"><h2 class="stat__label">Follow ups sent, 7 days</h2><p class="stat__value num">${num(w7?.sent)}</p></article>
    <article class="stat"><h2 class="stat__label">Sent, 30 days</h2><p class="stat__value num">${num(w30?.sent)}</p></article>
    <article class="stat"><h2 class="stat__label">They replied</h2><p class="stat__value num">${num(w30?.replies)}</p></article>
  </section>
  ${w30?.waiting ? html`<p class="meta">${num(w30.waiting)} waiting to send or for your OK.</p>` : ''}`;
}

function settingsCard(s) {
  const style = STYLES.find((x) => x[0] === s.style) || STYLES[0];
  const hours = HOURS.some(([h]) => h === s.follow_up_hours) ? HOURS : [...HOURS, [s.follow_up_hours, `${s.follow_up_hours} hours`]].sort((a, b) => a[0] - b[0]);
  return html`<section class="card stack" aria-labelledby="sl-set-h">
    <div class="card__head"><div><h2 class="eyebrow" id="sl-set-h">How it sells</h2><p class="meta" id="sl-style-say">${style[2]}</p></div></div>
    <form class="stack form" id="sl-set" novalidate>
      ${segmented({ legend: 'Sales style', name: 'style', value: s.style, options: STYLES.map(([v, t]) => [v, t]) })}
      ${switchRow({ name: 'follow_ups', checked: s.follow_ups, label: 'Follow up once', hint: 'If someone was sent a product and went quiet, the agent checks in one time. Never twice.' })}
      ${segmented({ legend: 'Wait before the follow up', name: 'follow_up_hours', value: s.follow_up_hours, options: hours })}
      <p class="field__hint">Only sent between 10am and 8pm UK time. Never to anyone who bought, said stop, or a chat you took over. On WhatsApp only while the chat is still open for replies.</p>
      <div class="wrap"><button type="submit" class="btn btn--primary">${icon('i-check')}Save</button></div>
    </form>
  </section>`;
}

export default {
  title: 'Sales',
  mount(view) {
    let data = null;
    let error = null;
    setHTML(view, skeletonCards(3));

    function paint() {
      if (!data) { setHTML(view, unavailable('Sales', error)); return; }
      const leads = data.leads || [];
      const [f7, f30] = data.funnel || [];
      setHTML(view, html`
        <section class="card stack" aria-labelledby="sl-leads-h">
          <div class="card__head"><div><h2 class="eyebrow" id="sl-leads-h">Hot leads</h2><p class="meta">Interested or ready in the last 3 days. Tap one to open the chat.</p></div>
            <button type="button" class="btn btn--ghost btn--sm" data-action="refresh">Refresh</button></div>
          ${leads.length ? html`<ul class="convs" id="sl-leads">${leads.map(leadRow)}</ul>`
            : html`<p class="voice muted pad">No hot leads right now. When someone asks about a kit they show up here.</p>`}
        </section>
        <div class="grid grid--2">${f7 ? funnelCard(f7) : ''}${f30 ? funnelCard(f30) : ''}</div>
        ${followCard(data.followups || [])}
        ${settingsCard(data.settings || { follow_ups: true, follow_up_hours: 20, style: 'friendly' })}`);
      refreshTimes(view);
    }

    async function load() {
      try { data = await get('/api/sales'); error = null; }
      catch (err) { if (err.name === 'AuthError') return; error = err; }
      paint();
    }

    view.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      if (b.dataset.action === 'refresh' || b.dataset.action === 'retry') busy(b, load);
    });
    view.addEventListener('change', (e) => {
      if (e.target.name === 'style') {
        const s = STYLES.find((x) => x[0] === e.target.value);
        const say = $('#sl-style-say', view);
        if (s && say) say.textContent = s[2];
      }
    });
    view.addEventListener('submit', async (e) => {
      if (e.target.id !== 'sl-set') return;
      e.preventDefault();
      const f = e.target;
      const btn = f.querySelector('[type="submit"]');
      const body = {
        style: f.querySelector('[name="style"]:checked')?.value || 'friendly',
        follow_ups: f.querySelector('[name="follow_ups"]').checked,
        follow_up_hours: Number(f.querySelector('[name="follow_up_hours"]:checked')?.value || 20),
      };
      await busy(btn, async () => {
        try {
          const res = await put('/api/sales/settings', body);
          if (data) data.settings = res.settings;
          toast(body.follow_ups ? 'Saved. Follow ups are on.' : 'Saved. Follow ups are off.');
        } catch (err) { toastError(err, 'Could not save. Check your connection and try again.'); }
      });
    });
    load();
    return {};
  },
};
