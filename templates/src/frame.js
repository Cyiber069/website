// Builds one preview card per entry in window.TEMPLATES (filled by t1.js ... t6.js).
// The frame owns the layout, the HUD, the shop screen and all text sections. A template file supplies data plus two SVG scenes.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const W = (d) => `<svg viewBox="0 0 30 30">${d}</svg>`;
  // Icons for HUD buttons and shop items. Simple original shapes, white on a coloured tile.
  const ICON = window.ICON = {
    cart: '<path d="M4 6h3l3 13h13l3-9H9" fill="none" stroke="#fff" stroke-width="3.400" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="25" r="2.600" fill="#fff"/><circle cx="22" cy="25" r="2.600" fill="#fff"/>',
    star: '<path d="M15 3l3.700 7.600 8.300 1.200-6 5.900 1.400 8.300L15 22l-7.400 4 1.400-8.300-6-5.900 8.300-1.200z" fill="#fff"/>',
    gift: '<rect x="4" y="13" width="22" height="13" rx="2.500" fill="#fff"/><rect x="2" y="8" width="26" height="6" rx="2.500" fill="#fff"/><rect x="13" y="8" width="4" height="18" fill="#0004"/><path d="M15 8c-6-7-10 0-4 0M15 8c6-7 10 0 4 0" fill="none" stroke="#fff" stroke-width="2.600" stroke-linecap="round"/>',
    loop: '<path d="M24 12a9.500 9.500 0 1 0 1 8" fill="none" stroke="#fff" stroke-width="3.600" stroke-linecap="round"/><path d="M26 5v8h-8" fill="none" stroke="#fff" stroke-width="3.600" stroke-linecap="round" stroke-linejoin="round"/>',
    book: '<path d="M4 6h9a3 3 0 0 1 3 3v16a3 3 0 0 0-3-2H4zM26 6h-9a3 3 0 0 0-3 3v16a3 3 0 0 1 3-2h9z" fill="#fff"/>',
    bolt: '<path d="M17 2L6 17h7l-2 11 12-16h-7z" fill="#fff"/>',
    bag: '<rect x="6" y="10" width="18" height="17" rx="5" fill="#fff"/><path d="M10 10a5 5 0 0 1 10 0" fill="none" stroke="#fff" stroke-width="3.400"/>',
    flag: '<path d="M7 3v24" stroke="#fff" stroke-width="3.600" stroke-linecap="round"/><path d="M7 5h17l-5 6 5 6H7z" fill="#fff"/>',
    paw: '<ellipse cx="15" cy="20" rx="7" ry="5.500" fill="#fff"/><circle cx="7" cy="13" r="3" fill="#fff"/><circle cx="12.500" cy="8" r="3" fill="#fff"/><circle cx="18" cy="8" r="3" fill="#fff"/><circle cx="23" cy="13" r="3" fill="#fff"/>',
    trophy: '<path d="M9 4h12v8a6 6 0 0 1-12 0z" fill="#fff"/><path d="M9 6H4a5 5 0 0 0 5 6M21 6h5a5 5 0 0 1-5 6" fill="none" stroke="#fff" stroke-width="2.800"/><rect x="13" y="17" width="4" height="5" fill="#fff"/><rect x="8" y="22" width="14" height="4" rx="2" fill="#fff"/>',
    crown: '<path d="M4 23l-1-14 7 6 5-10 5 10 7-6-1 14z" fill="#fff"/>',
    shield: '<path d="M15 3l10 4v8c0 6-4 10-10 12C9 25 5 21 5 15V7z" fill="#fff"/>',
    heart: '<path d="M15 26C4 18 3 11 7 7.500c3.500-3 6.500-1 8 1.500 1.500-2.500 4.500-4.500 8-1.500 4 3.500 3 10.500-8 18.500z" fill="#fff"/>',
    clock: '<circle cx="15" cy="15" r="11" fill="none" stroke="#fff" stroke-width="3.400"/><path d="M15 9v6l4 3" fill="none" stroke="#fff" stroke-width="3.400" stroke-linecap="round" stroke-linejoin="round"/>',
    users: '<circle cx="11" cy="10" r="4.500" fill="#fff"/><path d="M3 25c0-5 3.500-8 8-8s8 3 8 8z" fill="#fff"/><circle cx="21" cy="11" r="3.500" fill="#fff"/><path d="M20 17c4 0 7 3 7 8h-6" fill="#fff"/>',
    wand: '<path d="M5 25L19 11" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M22 3l1.500 4 4 1.500-4 1.500L22 14l-1.500-4-4-1.500 4-1.500z" fill="#fff"/>',
    pick: '<path d="M6 25L18 13" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M10 6c7-3 14 2 15 10-3-5-8-8-15-10z" fill="#fff"/>',
    gear: '<circle cx="15" cy="15" r="5" fill="none" stroke="#fff" stroke-width="4"/><path d="M15 3v4M15 23v4M3 15h4M23 15h4M6.500 6.500l3 3M20.500 20.500l3 3M23.500 6.500l-3 3M9.500 20.500l-3 3" stroke="#fff" stroke-width="3.400" stroke-linecap="round"/>',
    dice: '<rect x="4" y="4" width="22" height="22" rx="5" fill="#fff"/><circle cx="10" cy="10" r="2.200" fill="#0007"/><circle cx="20" cy="20" r="2.200" fill="#0007"/><circle cx="15" cy="15" r="2.200" fill="#0007"/><circle cx="20" cy="10" r="2.200" fill="#0007"/><circle cx="10" cy="20" r="2.200" fill="#0007"/>',
    up: '<path d="M15 4l10 11h-6v11h-8V15H5z" fill="#fff"/>',
    check: '<path d="M6 16l6 6 12-14" fill="none" stroke="#fff" stroke-width="4.500" stroke-linecap="round" stroke-linejoin="round"/>',
    lock: '<path d="M10 13V9a5 5 0 0 1 10 0v4" fill="none" stroke="#8f95ba" stroke-width="3.400"/><rect x="6" y="13" width="18" height="13" rx="4" fill="#8f95ba"/>',
  };
  // Currency icons used in pills and price buttons.
  const CUR = {
    coin: (c = '#ffd166') => `<svg class="ico" viewBox="0 0 30 30"><circle cx="15" cy="16.500" r="12" fill="${K.mix(c, -0.35)}" stroke="#1b1230" stroke-width="3"/><circle cx="15" cy="14.500" r="12" fill="${c}" stroke="#1b1230" stroke-width="3"/><circle cx="15" cy="14.500" r="7.500" fill="none" stroke="${K.mix(c, -0.25)}" stroke-width="2.200"/><path d="M9 9q4-4 9-2" fill="none" stroke="#fff" stroke-width="2.400" stroke-linecap="round" opacity=".85"/></svg>`,
    gem: (c = '#5fe1ff') => `<svg class="ico" viewBox="0 0 30 30"><path d="M3 12l6-8h12l6 8-12 15z" fill="${c}" stroke="#1b1230" stroke-width="3" stroke-linejoin="round"/><path d="M3 12h24M9 4l6 8 6-8M15 12v15" fill="none" stroke="${K.mix(c, -0.3)}" stroke-width="1.800"/><path d="M7 11l4-5h4l-3 5z" fill="#fff" opacity=".65"/></svg>`,
    cash: (c = '#7dff8a') => `<svg class="ico" viewBox="0 0 30 30"><rect x="2" y="8" width="26" height="16" rx="4" fill="${c}" stroke="#1b1230" stroke-width="3"/><circle cx="15" cy="16" r="4.500" fill="${K.mix(c, -0.3)}"/><rect x="5" y="11" width="20" height="3" rx="1.500" fill="#fff" opacity=".5"/></svg>`,
    icon: (c, name) => `<svg class="ico" viewBox="0 0 30 30"><rect x="2" y="2" width="26" height="26" rx="9" fill="${c}" stroke="#1b1230" stroke-width="3"/><g transform="translate(5 5) scale(.667)">${ICON[name] || ''}</g></svg>`,
  };
  const cur = (p) => p.icon === 'gem' ? CUR.gem(p.color) : p.icon === 'cash' ? CUR.cash(p.color) : p.icon === 'coin' || !p.icon ? CUR.coin(p.color) : CUR.icon(p.color || '#b79cff', p.icon);

  function hud(t) {
    const h = t.hud;
    return `<div class="hud">
      <div class="pills">${h.pills.map(p => `<div class="pill">${cur(p)}<span class="t">${esc(p.value)}</span>${p.plus ? '<span class="plus">+</span>' : '<span class="gap"></span>'}</div>`).join('')}</div>
      <div class="goal"><small>${esc(h.goal.label || 'GOAL')}</small><b class="t t4">${esc(h.goal.text)}</b><div class="bar"><i style="width:${h.goal.pct}%"></i></div></div>
      <div class="next"><small>${esc(h.next.label)}</small><b class="t t4">${esc(h.next.value)}</b></div>
      <div class="side">${h.buttons.map(b => `<div class="sb" style="background:linear-gradient(${K.mix(b.color, 0.2)},${b.color} 45%,${K.mix(b.color, -0.32)})">${W(ICON[b.icon])}<span class="t t4">${esc(b.label)}</span>${b.dot ? '<i class="dot"></i>' : ''}</div>`).join('')}</div>
      <div class="act"><span class="t">${esc(h.action)}</span></div>
      <div class="zone">Roblox<br>jump</div>
      ${window.SHOW_ZONES ? RESERVED.map(([x, y, w, hh]) => `<i class="reserved" style="left:${x}px;top:${y}px;width:${w}px;height:${hh}px"></i>`).join('') : ''}
    </div>`;
  }
  // Areas of the 960x540 scene that the HUD covers. Keep the scene's important art out of these.
  const RESERVED = window.RESERVED = [[0, 0, 250, 118], [286, 0, 388, 104], [748, 0, 212, 92], [0, 138, 104, 322], [316, 424, 328, 116], [826, 414, 134, 126]];

  function shop(t) {
    const s = t.shop, price = (p) => `<div class="buy">${cur({ icon: s.currency || 'coin', color: s.currencyColor })}<span class="t t4" style="-webkit-text-stroke-width:3px">${esc(p)}</span></div>`;
    return `<div class="shop" style="--shopbg:${s.bg || '#241a52'}"><div class="panel">
      <div class="title"><span class="t t4">${esc(s.title || 'SHOP')}</span></div><div class="x"><span class="t t4" style="-webkit-text-stroke-width:3px">×</span></div>
      <div class="feat"><i class="tagx">${esc(s.featured.tag)}</i>
        <svg class="art" viewBox="0 0 80 80">${s.featured.art()}</svg><b class="t t4">${esc(s.featured.name)}</b><span>${esc(s.featured.line)}</span>${price(s.featured.price)}</div>
      <div class="items">${s.items.map(i => `<div class="it"><div class="ic" style="background:linear-gradient(${K.mix(i.color, 0.2)},${K.mix(i.color, -0.25)})">${W(ICON[i.icon])}</div><div><b class="t t4" style="-webkit-text-stroke-width:3px">${esc(i.name)}</b><span>${esc(i.line)}</span></div>${price(i.price)}</div>`).join('')}</div>
    </div></div>`;
  }

  function card(t) {
    return `<section class="card" id="t${t.n}" style="--c:${t.colors[0]};--c2:${t.colors[1]}">
      <div class="tag"><span class="badge fr">TEMPLATE ${t.n}</span><span class="genre">${esc(t.genre)}</span><span class="v2 fr">UPGRADED</span></div>
      <h1 class="fr" data-fit="title">${esc(t.name)}</h1>
      <p class="hook" data-fit="hook">${esc(t.hook)}</p>
      <div class="phone"><div class="stage"><svg class="scene" viewBox="0 0 960 540" preserveAspectRatio="xMidYMid slice">${t.scene()}</svg>${hud(t)}</div></div>
      <div class="minis">
        <div class="mini"><div class="frame"><div class="stage2">${shop(t)}</div></div><div class="cap" data-fit="shop caption"><b>THE SHOP</b>${esc(t.shop.caption)}</div></div>
        <div class="mini"><div class="frame"><div class="stage2"><svg viewBox="0 0 480 270" preserveAspectRatio="xMidYMid slice">${t.moment.svg()}</svg></div></div><div class="cap" data-fit="moment caption"><b>${esc(t.moment.title)}</b>${esc(t.moment.caption)}</div></div>
      </div>
      <div class="sec"><h3>${esc(t.path.label)}</h3><div class="path">${t.path.steps.map((s, i) => `<div class="node ${s.state}"><div class="dot">${s.state === 'done' ? W(ICON.check) : s.state === 'locked' ? W(ICON.lock) : i + 1}</div><b data-fit="path name ${i + 1}">${esc(s.name)}</b><span data-fit="path need ${i + 1}">${esc(s.need)}</span></div>`).join('')}</div></div>
      <div class="sec"><h3>The first 60 seconds</h3><div class="first">${t.first60.map((f, i) => `<div data-fit="first60 step ${i + 1}"><b>${esc(f.t)}</b><span>${esc(f.text)}</span></div>`).join('')}</div></div>
      <div class="sec"><h3>Core loop</h3><div class="loop">${['Do', 'Earn', 'Upgrade', 'Repeat'].map((k, i) => `<div><b>${k}</b><span data-fit="loop ${k}">${esc(t.loop[i])}</span></div>`).join('')}</div></div>
      <div class="sec"><h3>The one thing that changes per game</h3><div class="slot" data-fit="mechanic">${esc(t.mechanic)}</div>
        <div class="chips" data-fit="reskin chips"><small>Could become</small>${t.reskins.map(r => `<span>${esc(r)}</span>`).join('')}</div></div>
      <div class="sec cols">
        <div class="col"><h3>How it earns</h3><div class="rows">${t.earns.map((e, i) => `<div data-fit="earns ${i + 1}"><i class="tier ${['low', 'mid', ''][i]}">${['Low', 'Mid', 'Premium'][i]}</i>${esc(e)}</div>`).join('')}</div></div>
        <div class="col"><h3>Brings players back</h3><div class="rows">${t.keeps.map((e, i) => `<div data-fit="keeps ${i + 1}"><i class="bul"></i>${esc(e)}</div>`).join('')}</div></div>
      </div>
      <div class="sec"><div class="stats"><div><b>${esc(t.stats.shared)}</b><span>shared code</span></div><div><b>${esc(t.stats.days)}</b><span>days to first build</span></div><div><b>${esc(t.stats.risk)}</b><span>build risk</span></div></div></div>
      <p class="built" data-fit="built-in line"><b>Built in:</b> saving · currency · shop and passes · rebirth · daily rewards · quests · server-checked actions</p>
      <p class="foot">Concept preview drawn for approval, not a running game. Code share and build days are estimates, not measured.</p>
    </section>`;
  }

  const only = new URLSearchParams(location.search).get('t');
  window.SHOW_ZONES = new URLSearchParams(location.search).get('zones') === '1';
  const list = Object.values(window.TEMPLATES || {}).sort((a, b) => a.n - b.n).filter(t => !only || String(t.n) === only);
  const errors = [];
  document.body.innerHTML = list.map(t => { try { return card(t); } catch (e) { errors.push(`Template ${t.n}: ${e.message}`); return `<section class="card" id="t${t.n}"><pre style="font-size:30px;color:#ff8a9c;white-space:pre-wrap">Template ${t.n} failed to draw:\n${esc(e.stack || e.message)}</pre></section>`; } }).join('');
  window.FRAME_ERRORS = errors;
  // Text that does not fit its box. The render script prints these so they can be shortened.
  window.checkFit = () => [...document.querySelectorAll('[data-fit]')].filter(el => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)
    .map(el => `${el.closest('.card').id}: "${el.dataset.fit}" is too long (${el.textContent.trim().slice(0, 50)})`)
    .concat([...document.querySelectorAll('.card')].filter(c => c.scrollHeight > c.clientHeight + 1).map(c => `${c.id}: the card's content is taller than the card`));
})();
