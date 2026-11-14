// Voice: how the agent writes, and a playground to try it without sending anything.
import { get, post, put } from '../api.js';
import { $, html, raw, icon, setHTML, toast, toastError, friendly, unavailable, skeletonCards, segmented, field, switchRow, busy, CHANNELS, chName } from '../ui.js';

const REGISTER = { hype: 'Hyped', casual: 'Casual', neutral: 'Neutral', formal: 'Formal' };
const MOOD = { positive: 'Happy', neutral: 'Calm', confused: 'Confused', frustrated: 'Frustrated', angry: 'Angry' };

export default {
  title: 'Voice',
  mount(view, ctx) {
    let voice = null;
    const chat = [];        // { direction, body } sent to the server
    let thinking = false;

    setHTML(view, html`<div class="two">
      <section id="style">${skeletonCards(2)}</section>
      <section class="card play" aria-labelledby="play-h">
        <div class="card__head"><div><h2 class="eyebrow" id="play-h">Try it out</h2><p class="meta">Type like a customer. Nothing here is sent to anyone.</p></div>
          <button type="button" class="btn btn--ghost btn--sm" data-action="reset">Start again</button></div>
        <div class="field play__channel"><label class="field__label" for="play-ch">Pretend it is on</label><select class="input" id="play-ch">${CHANNELS.map((c) => html`<option value="${c}">${chName(c)}</option>`)}</select></div>
        <div class="thread play__thread" id="play-thread" role="log" aria-live="polite" aria-label="Test chat"></div>
        <form class="composer" id="play-form" novalidate>
          <label class="sr-only" for="play-in">Type as a customer</label>
          <textarea class="input" id="play-in" rows="1" placeholder="yo how long is delivery"></textarea>
          <button class="btn btn--primary" type="submit">${icon('i-send')}<span class="composer__label">Ask the agent</span></button>
        </form>
      </section>
    </div>`);

    const styleEl = $('#style', view);
    const threadEl = $('#play-thread', view);

    function paintStyle(err) {
      if (!voice) { setHTML(styleEl, unavailable('The style settings', err)); return; }
      setHTML(styleEl, html`<form class="card stack form" id="voice-form" novalidate>
        <div><h2 class="eyebrow">How the agent writes</h2><p class="meta">It should sound like someone at the shop texting, never like a robot.</p></div>
        ${segmented({ legend: 'Copy the customer\'s style', name: 'mirror_level', value: voice.mirror_level, options: [['match', 'Match them'], ['light', 'A little'], ['off', 'Do not copy']] })}
        <p class="field__hint">Match them: "yoooo brooo" gets "hey broo" back. Formal customers always get plain polite replies.</p>
        <div class="field"><label class="field__label" for="v-chars">Longest reply: <span class="num" id="v-chars-out">${voice.max_chars}</span> letters</label>
          <input type="range" class="range" id="v-chars" name="max_chars" min="80" max="600" step="20" value="${voice.max_chars}"><p class="field__hint">A normal text message is about 160 letters.</p></div>
        ${segmented({ legend: 'Most sentences in one reply', name: 'max_sentences', value: voice.max_sentences, options: [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']] })}
        ${segmented({ legend: 'Commas', name: 'commas', value: voice.commas, options: [['none', 'Almost none'], ['light', 'Only when needed'], ['normal', 'Normal']] })}
        ${segmented({ legend: 'Emoji', name: 'emojis', value: voice.emojis, options: [['mirror', 'Only if they do'], ['sometimes', 'Sometimes'], ['never', 'Never']] })}
        ${field({ label: 'Your own rules', name: 'extra_rules', value: voice.extra_rules, textarea: true, rows: 3, placeholder: 'For example: never promise a delivery date', hint: 'Plain words. One rule per line.' })}
        ${field({ label: 'Words and phrases it must never use', name: 'banned_phrases', value: (voice.banned_phrases || []).join('\n'), textarea: true, rows: 3, placeholder: 'One per line', hint: 'For example: valued customer' })}
        ${segmented({ legend: 'When a customer asks "are you a bot?"', name: 'bot_question_policy', value: voice.bot_question_policy, options: [['honest_short', 'Answer honestly in one line'], ['escalate', 'Ask me first']] })}
        ${switchRow({ name: 'holding_reply', checked: voice.holding_reply, label: 'Send a "let me check" line', hint: 'So the customer is not left on read while a question waits for you' })}
        <p class="form-error" role="alert" hidden></p>
        <div class="actionbar"><span class="meta" id="voice-state">No changes</span><span class="top__spacer"></span><button type="submit" class="btn btn--primary" disabled>Save style</button></div>
      </form>`);
    }

    async function loadStyle() {
      try { voice = (await get('/api/settings')).settings.voice; paintStyle(); }
      catch (err) { if (err.name === 'AuthError') return; paintStyle(err); }
    }

    function markDirty() {
      const btn = $('#voice-form [type=submit]', view); if (!btn) return;
      btn.disabled = false; $('#voice-state', view).textContent = 'Not saved yet';
    }

    function paintChat() {
      if (!chat.length && !thinking) {
        setHTML(threadEl, html`<div class="play__empty"><p class="voice muted">Ask something a customer would ask. You will see the reply, the mood it picked up, and whether it would have asked you first.</p>
          <div class="wrap">${['yoooo brooo how fast does it go', 'Good afternoon, what is your returns policy?', 'are you a bot'].map((t) => html`<button type="button" class="chip" data-try="${t}">${t}</button>`)}</div></div>`);
        return;
      }
      setHTML(threadEl, html`${chat.map((m) => m.direction === 'in'
        ? html`<div class="msg msg--customer"><span class="msg__by">Customer (you)</span><div class="bubble">${m.body}</div></div>`
        : m.error ? html`<div class="msg msg--note"><div class="bubble">${m.error}</div></div>`
        : html`${m.parts.map((p, i) => html`<div class="msg msg--agent">${i === 0 ? html`<span class="msg__by">${m.escalated ? 'Holding line' : 'Agent would send'}</span>` : ''}<div class="bubble">${p}</div></div>`)}
          <div class="verdict">
            ${m.escalated ? html`<p class="banner banner--wait">${icon('i-urgent')}<span><b>It would ask you first.</b> ${m.reason || 'It was not sure enough to answer alone.'}${m.parts.length ? '' : ' The customer gets no reply until you answer.'}</span></p>` : m.ignored ? html`<p class="banner">${icon('i-dot')}<span><b>It would not reply.</b> ${m.note || 'Nothing here needs an answer.'}</span></p>` : ''}
            <div class="wrap">
              ${m.tone ? html`<span class="tag">Sounds ${(REGISTER[m.tone.register] || 'neutral').toLowerCase()}</span><span class="tag">Mood: ${(MOOD[m.tone.mood] || 'calm').toLowerCase()}</span>` : ''}
              ${m.confidence != null ? html`<span class="tag">${Math.round(m.confidence * 100)}% sure</span>` : ''}
              ${m.escalated ? html`<span class="tag tag--wait">Goes to Urgent</span>` : m.ignored ? '' : html`<span class="tag tag--live">Sends on its own</span>`}
              ${m.flags?.asked_if_bot ? html`<span class="tag">Asked if it is a bot</span>` : ''}${m.flags?.opt_out ? html`<span class="tag tag--down">Asked to stop</span>` : ''}
            </div>
            ${m.refs?.length ? html`<p class="meta">Used from Knowledge: ${m.refs.map((r, i) => html`${i ? ', ' : ''}<a href="#/knowledge/${r.id}">${r.title}</a>`)}</p>` : m.escalated || m.ignored ? '' : html`<p class="meta">Did not need anything from Knowledge.</p>`}
          </div>`)}
        ${thinking ? html`<div class="msg msg--agent"><span class="msg__by">Agent</span><div class="bubble"><span class="typing" role="img" aria-label="Thinking"><i></i><i></i><i></i></span></div></div>` : ''}`);
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    async function ask(text) {
      if (thinking || !text) return;
      chat.push({ direction: 'in', body: text });
      thinking = true; paintChat();
      try {
        const messages = chat.filter((m) => !m.error).flatMap((m) => m.direction === 'in' ? [{ direction: 'in', body: m.body }] : m.parts.map((p) => ({ direction: 'out', body: p })));
        const res = await post('/api/playground', { messages, channel: $('#play-ch', view).value });
        const d = res.decision || {};
        chat.push({ direction: 'out', parts: d.parts || [], escalated: d.action === 'escalate', ignored: d.action === 'ignore' || d.action === 'none', reason: d.escalate?.reason, note: d.note, tone: d.tone, confidence: d.confidence, flags: d.flags, refs: res.kb_refs });
      } catch (err) {
        if (err.name === 'AuthError') return;
        chat.push({ direction: 'out', error: err.unavailable ? 'The playground is not available yet. Try again a little later.' : friendly(err, 'The agent did not answer. Try again.') });
      }
      thinking = false; paintChat();
    }

    view.addEventListener('input', (e) => {
      if (e.target.id === 'v-chars') $('#v-chars-out', view).textContent = e.target.value;
      if (e.target.closest('#voice-form')) markDirty();
      if (e.target.id === 'play-in') { e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight + 2) + 'px'; }
    });
    view.addEventListener('change', (e) => { if (e.target.closest('#voice-form')) markDirty(); });
    view.addEventListener('keydown', (e) => { if (e.target.id === 'play-in' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#play-form', view).requestSubmit(); } });
    view.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (e.target.id === 'play-form') {
        const box = $('#play-in', view); const text = box.value.trim();
        box.value = ''; box.style.height = 'auto'; box.dataset.dirty = '0';
        return ask(text);
      }
      if (e.target.id === 'voice-form') {
        const f = e.target; const errBox = f.querySelector('.form-error');
        const body = {
          mirror_level: f.elements.mirror_level.value, max_chars: Number(f.elements.max_chars.value), max_sentences: Number(f.elements.max_sentences.value),
          commas: f.elements.commas.value, emojis: f.elements.emojis.value, extra_rules: f.elements.extra_rules.value.trim(),
          banned_phrases: f.elements.banned_phrases.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 60),
          bot_question_policy: f.elements.bot_question_policy.value, holding_reply: f.elements.holding_reply.checked,
        };
        const btn = f.querySelector('[type=submit]');
        await busy(btn, async () => {
          try {
            const res = await put('/api/settings/voice', body);
            voice = res.voice || { ...voice, ...body };
            errBox.hidden = true; btn.disabled = true; $('#voice-state', view).textContent = 'Saved';
            for (const i of f.querySelectorAll('[data-dirty]')) i.dataset.dirty = '0';
            toast('Style saved. Try it in the playground.');
          } catch (err) { errBox.textContent = friendly(err, 'Not saved. Try again.'); errBox.hidden = false; }
        });
      }
    });
    view.addEventListener('click', (e) => {
      const t = e.target.closest('[data-try]');
      if (t) return ask(t.dataset.try);
      const b = e.target.closest('[data-action]'); if (!b) return;
      if (b.dataset.action === 'retry') return loadStyle();
      if (b.dataset.action === 'reset') { chat.length = 0; thinking = false; paintChat(); $('#play-in', view).focus(); }
    });

    paintChat();
    loadStyle();
    return {};
  },
};
