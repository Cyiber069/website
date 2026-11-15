// More (phone): the screens that do not fit in the tab bar.
import { $, html, icon, setHTML } from '../ui.js';

const LINKS = [
  ['knowledge', 'i-knowledge', 'Knowledge', 'What the agent knows. Upload files and answer its questions.'],
  ['voice', 'i-voice', 'Voice', 'How it writes, and a place to try it out.'],
  ['discounts', 'i-tag', 'Discount codes', 'Codes for creators and sponsors, sent in their chat.'],
  ['connections', 'i-plug', 'Connections', 'Laptop, AI brain, Shopify, notifications, password.'],
  ['health', 'i-health', 'Health', 'Is everything working, and what went wrong if not.'],
];

export default {
  title: 'More',
  focus: true,
  mount(view, ctx) {
    setHTML(view, html`
      <nav aria-label="More screens"><ul class="menu">${LINKS.map(([id, ic, t, d]) => html`<li><a class="menu__item" href="#/${id}">${icon(ic, 'menu__icon')}<span class="menu__body"><b>${t}</b><span>${d}</span></span>${icon('i-chev', 'step__chev')}</a></li>`)}</ul></nav>
      <section class="card stack">
        <label class="switch switch--row"><input type="checkbox" role="switch" id="more-agent"><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label"><span id="more-agent-l">Agent</span><span class="switch__hint" id="more-agent-h">Checking</span></span></label>
        <div class="wrap"><button type="button" class="btn btn--danger" id="more-panic">${icon('i-stop')}Stop everything</button><span class="top__spacer"></span><button type="button" class="btn btn--ghost" id="more-out">Sign out</button></div>
      </section>`);
    const sw = $('#more-agent', view);
    const paint = (ov) => {
      if (!ov) return;
      sw.checked = Boolean(ov.agent.enabled);
      $('#more-agent-l', view).textContent = ov.agent.enabled ? 'Agent on' : 'Agent off';
      $('#more-agent-h', view).textContent = ov.agent.enabled ? 'Replies on its own' : 'Nothing is sent';
    };
    sw.addEventListener('change', () => ctx.setAgent(sw.checked));
    $('#more-panic', view).addEventListener('click', () => ctx.panic());
    $('#more-out', view).addEventListener('click', () => ctx.signOut());
    ctx.onOverview(paint); paint(ctx.overview);
    return {};
  },
};
