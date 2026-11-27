// Template 4: Roll for Rarity. A roll pad on a star deck in deep space.
// Same data shape as every other template file. Scene helpers live inside this wrapper so they cannot clash with other files.
(function () {
  const k = K, INK = K.INK;
  const r1 = (v) => Math.round(v * 10) / 10;
  // Gradient and blur helpers: each returns [fill or filter value, <defs> string].
  const stopsOf = (stops) => stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a === undefined ? '' : ` stop-opacity="${a}"`}/>`).join('');
  const lin = (stops, x2 = 0, y2 = 1) => { const id = k.id(); return [`url(#${id})`, `<defs><linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stopsOf(stops)}</linearGradient></defs>`]; };
  const radial = (stops, cx = 0.5, cy = 0.5, r = 0.5) => { const id = k.id(); return [`url(#${id})`, `<defs><radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}">${stopsOf(stops)}</radialGradient></defs>`]; };
  const blur = (dev) => { const id = k.id(); return [`url(#${id})`, `<defs><filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${dev}"/></filter></defs>`]; };

  // The rarity ladder. Every roll result in the art shows its name together with these odds.
  const RAR = [
    { name: 'COMMON', odds: '1 in 2', c: '#9aa7c7' },
    { name: 'RARE', odds: '1 in 10', c: '#3fb4ff' },
    { name: 'EPIC', odds: '1 in 100', c: '#b56bff' },
    { name: 'LEGENDARY', odds: '1 in 1,000', c: '#ff5fae' },
    { name: 'MYTHIC', odds: '1 in 5,000', c: '#ffc93c' },
  ];
  const GOLD_AURA = ['#ff4fa8', '#ffb938', '#fff4b8'], BLUE_AURA = ['#3f6bff', '#3fc0ff', '#e6fbff'], VIOLET_AURA = ['#6a35e8', '#b56bff', '#f1e4ff'];

  /* ---------- small pieces of scenery ---------- */
  const star = (x, y, R, r, n = 5, rot = -Math.PI / 2) => { let d = ''; for (let i = 0; i < n * 2; i++) { const a = rot + i * Math.PI / n, rr = i % 2 ? r : R; d += (i ? 'L' : 'M') + r1(x + rr * Math.cos(a)) + ' ' + r1(y + rr * Math.sin(a)); } return d + 'z'; };
  // One tongue of flame standing on y = 0, tip at (x + lean, -h).
  const tongue = (x, w, h, lean) => `<path d="M${x - w} 0C${r1(x - w * 1.25)} ${r1(-h * 0.34)} ${r1(x - w * 0.5 + lean)} ${r1(-h * 0.62)} ${x + lean} ${-h}C${r1(x + w * 0.38 + lean * 0.4)} ${r1(-h * 0.62)} ${r1(x + w * 1.25)} ${r1(-h * 0.34)} ${x + w} 0z"/>`;
  const FLAME = [[-112, 26, 96, -26], [-84, 30, 150, -20], [-48, 32, 180, -10], [0, 40, 198, 2], [50, 32, 184, 10], [86, 30, 156, 20], [114, 26, 100, 26]];
  const flames = (sx, sy, base = true) => `<g transform="scale(${sx} ${sy})">${FLAME.map(f => tongue(...f)).join('')}${base ? '<ellipse cx="0" cy="-40" rx="128" ry="42"/>' : ''}</g>`;
  // The aura a player wears: layers of flame rising from the feet at (x, y), hot colour at the tips, fading out at the feet. Drawn behind the avatar.
  const aura = (x, y, sx, sy, [c1, c2, c3], soft) => {
    const fade = (c, lift) => lin([[0, c], [0.8, k.mix(c, lift)], [1, k.mix(c, lift), 0]]);
    const [g0, d0] = fade(c1, 0), [g1, d1] = fade(c1, 0.28), [g2, d2] = fade(c2, 0.4), [g3, d3] = fade(c3, 0.6);
    return d0 + d1 + d2 + d3 + `<g transform="translate(${x} ${y}) scale(${sx} ${sy})"><g fill="${g0}" opacity=".55" filter="${soft}">${flames(1.17, 1.1)}</g>`
      + `<g fill="${g1}" opacity=".93">${flames(1, 1)}</g><g fill="${g2}">${flames(-0.77, 0.8)}</g><g fill="${g3}">${flames(0.5, 0.58)}</g></g>`;
  };
  // A little flame badge standing for one aura in the index.
  const glyph = (cx, cy, sc) => { const t = tongue(-36, 30, 118, -12) + tongue(36, 30, 128, 12) + tongue(0, 40, 190, 4); return `<g transform="translate(${cx} ${cy}) scale(${sc})"><g fill="none" stroke="${INK}" stroke-width="${r1(5 / sc)}" stroke-linejoin="round">${t}</g><g fill="#fff">${t}</g></g>`; };
  // A roll pad far away, with someone's aura burning on it.
  const farPad = (x, y, c) => `<ellipse cx="${x}" cy="${y}" rx="20" ry="4.500" fill="#2c2f8f" stroke="${INK}" stroke-width="2"/><ellipse cx="${x}" cy="${y - 1.5}" rx="13" ry="2.500" fill="#8fe9ff"/>` + k.glow(x, y - 8, 15, c, 0.8) + `<g transform="translate(${x} ${y - 2}) scale(0.065 0.09)" fill="${k.mix(c, 0.2)}">${flames(1, 1)}</g>`;
  // Half of a glowing hoop; draw the back half before the player and the front half after.
  const hoop = (cx, cy, rx, ry, rot, front, color, op = 1) => `<g transform="rotate(${rot} ${cx} ${cy})" opacity="${op}"><path d="M${cx - rx} ${cy}A${rx} ${ry} 0 0 ${front ? 0 : 1} ${cx + rx} ${cy}" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round" opacity=".45"/><path d="M${cx - rx} ${cy}A${rx} ${ry} 0 0 ${front ? 0 : 1} ${cx + rx} ${cy}" fill="none" stroke="#fff" stroke-width="4.500" stroke-linecap="round"/></g>`;
  // The card that pops up over a player after a roll: rarity name on top, odds in the dark pill under it.
  const resultCard = (cx, cy, w, h, rot, r, o = {}) => {
    const [g, gD] = lin([[0, k.mix(r.c, 0.6)], [0.5, r.c], [1, k.mix(r.c, -0.2)]]);
    const x = cx - w / 2, y = cy - h / 2, ns = o.name || h * 0.49, os = o.odds || h * 0.245, pw = o.pillW || w * 0.56, ph = os * 1.42, py = y + h - ph - h * 0.085, rx = h * 0.2, cid = k.id();
    return gD + `<g transform="rotate(${rot} ${cx} ${cy})"><rect x="${x + 4}" y="${y + h * 0.09}" width="${w}" height="${h}" rx="${rx}" fill="${INK}" opacity=".5"/>`
      + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${g}" stroke="${INK}" stroke-width="${o.sw || 5}"/>`
      + `<defs><clipPath id="${cid}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/></clipPath></defs><g clip-path="url(#${cid})" fill="#fff" opacity=".3"><path d="M${r1(x + w * 0.7)} ${y}h${r1(w * 0.1)}l${r1(-h * 0.55)} ${h}h${r1(-w * 0.1)}z"/><path d="M${r1(x + w * 0.84)} ${y}h${r1(w * 0.035)}l${r1(-h * 0.55)} ${h}h${r1(-w * 0.035)}z"/></g>`
      + `<rect x="${x + h * 0.07}" y="${y + h * 0.07}" width="${w - h * 0.14}" height="${h * 0.86}" rx="${rx * 0.75}" fill="none" stroke="#fff" stroke-width="${h * 0.028}" opacity=".6"/>`
      + `<rect x="${x + h * 0.15}" y="${y + h * 0.12}" width="${w - h * 0.3}" height="${h * 0.14}" rx="${h * 0.07}" fill="#fff" opacity=".5"/>`
      + k.text(cx, y + h * 0.5, r.name, ns)
      + `<rect x="${cx - pw / 2}" y="${r1(py)}" width="${pw}" height="${r1(ph)}" rx="${r1(ph / 2)}" fill="${INK}"/>`
      + k.text(cx, r1(py + ph * 0.74), r.odds, os, { fill: '#fff6c2', sw: 0 }) + `</g>`;
  };
  // Floating rock with a lit top; `top` is drawn standing on it.
  const island = (x, y, s, top = '') => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-44 0h88l-12 12-12 4-6 22-13-14-16-3-9-13-14-2z" fill="#2c2f8f" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/><path d="M-24 5l9 10M14 5l-5 13" stroke="#171a5e" stroke-width="3" stroke-linecap="round" fill="none"/><rect x="-48" y="-9" width="96" height="13" rx="6.5" fill="#6fd8ff" stroke="${INK}" stroke-width="3"/><rect x="-40" y="-6" width="54" height="4" rx="2" fill="#fff" opacity=".6"/>${top}</g>`;
  // Small planet with a ring, lit from the upper left.
  const ringed = (x, y, r, rot) => {
    const [f, fD] = radial([[0, '#ffd6f2'], [0.5, '#c873f0'], [1, '#4a2390']], 0.34, 0.3, 0.75);
    const half = (front) => `<path d="M${x - r * 1.9} ${y}A${r * 1.9} ${r * 0.42} 0 0 ${front ? 0 : 1} ${x + r * 1.9} ${y}" fill="none" stroke="#ffe9a8" stroke-width="${r1(r * 0.2)}" stroke-linecap="round" opacity=".9"/><path d="M${x - r * 1.48} ${y}A${r * 1.48} ${r * 0.31} 0 0 ${front ? 0 : 1} ${x + r * 1.48} ${y}" fill="none" stroke="#b79cff" stroke-width="${r1(r * 0.13)}" opacity=".85"/>`;
    return fD + k.glow(x, y, r * 2.4, '#c873f0', 0.4) + `<g transform="rotate(${rot} ${x} ${y})">${half(false)}<circle cx="${x}" cy="${y}" r="${r}" fill="${f}" stroke="${INK}" stroke-width="3"/><path d="M${x - r * 0.78} ${y - r * 0.3}q${r * 0.8} ${-r * 0.32} ${r * 1.56} ${r * 0.08}" stroke="#fff" stroke-width="${r1(r * 0.12)}" opacity=".35" fill="none" stroke-linecap="round"/>${half(true)}</g>`;
  };
  // A chunky die with white pips, tumbled by `rot` degrees.
  const PIPS = { 3: [[0.26, 0.26], [0.5, 0.5], [0.74, 0.74]], 5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]] };
  const die = (x, y, sz, color, rot, n) => {
    const d = sz * 0.34, e = d * 0.55;
    return `<g transform="rotate(${rot} ${x + sz / 2} ${y + sz / 2})">` + k.box(x, y, sz, sz, color, { d, r: sz * 0.17 })
      + PIPS[n].map(([u, v]) => `<circle cx="${r1(x + u * sz)}" cy="${r1(y + v * sz)}" r="${r1(sz * 0.088)}" fill="#fff" stroke="${INK}" stroke-width="2.500"/>`).join('')
      + `<ellipse cx="${r1(x + sz / 2 + d / 2)}" cy="${r1(y - e / 2)}" rx="${r1(sz * 0.1)}" ry="${r1(sz * 0.045)}" fill="#fff" stroke="${INK}" stroke-width="2.200"/>`
      + `<ellipse cx="${r1(x + sz + d / 2)}" cy="${r1(y + sz * 0.22 - e / 2)}" rx="${r1(sz * 0.045)}" ry="${r1(sz * 0.085)}" fill="#fff" stroke="${INK}" stroke-width="2.200"/><ellipse cx="${r1(x + sz + d / 2)}" cy="${r1(y + sz * 0.7 - e / 2)}" rx="${r1(sz * 0.045)}" ry="${r1(sz * 0.085)}" fill="#fff" stroke="${INK}" stroke-width="2.200"/></g>`;
  };
  // A tiny index card: one more aura flying off to the index counter.
  const mini = (x, y, sc, rot, c = '#ffc93c') => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${sc})"><rect x="-10" y="-13" width="20" height="26" rx="5" fill="${c}" stroke="${INK}" stroke-width="3"/><path d="${star(0, 0, 6.5, 2.9)}" fill="#fff" stroke="${INK}" stroke-width="1.600" stroke-linejoin="round"/></g>`;
  const confetti = (pts) => pts.map(([x, y, rot, c, w = 9, h = 5]) => `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="1.500" fill="${c}" stroke="${INK}" stroke-width="1.500" transform="rotate(${rot} ${x} ${y})"/>`).join('');
  const mote = (x, y, r = 2.4, c = '#fff1b0') => k.glow(x, y, r * 5, c, 0.7) + `<circle cx="${x}" cy="${y}" r="${r}" fill="#fffbe6"/>`;

  /* ---------- the main game view, 960 x 540 ---------- */
  const scene = () => {
    const PX = 480, PY = 388, FY = PY - 14;   // centre of the roll pad's base, and where the player's feet stand
    let s = '';
    const [b4, b4D] = blur(4), [b9, b9D] = blur(9), [b30, b30D] = blur(30);
    s += b4D + b9D + b30D;

    // --- far: deep space, nebula, planets ---
    const [sky, skyD] = lin([[0, '#04051a'], [0.4, '#0c1045'], [0.75, '#252486'], [1, '#3a58cc']]);
    s += skyD + `<rect width="960" height="302" fill="${sky}"/>`;
    s += `<g filter="${b30}"><ellipse cx="200" cy="210" rx="220" ry="64" fill="#a23fe0" opacity=".6"/><ellipse cx="60" cy="140" rx="130" ry="60" fill="#e0559f" opacity=".32"/><ellipse cx="430" cy="266" rx="270" ry="44" fill="#2fc0ee" opacity=".55"/><ellipse cx="660" cy="140" rx="150" ry="56" fill="#5b3fd6" opacity=".5"/></g>`;
    s += k.stars('roll-far', 90, 960, 292);
    s += k.sparkles([[128, 246, 0.5], [338, 150, 0.5], [704, 122, 0.55], [918, 108, 0.45], [282, 196, 0.35]], '#fff');
    // a giant planet rising behind the deck, right
    const GX = 836, GY = 380, GR = 244, clip = k.id();
    const [gp, gpD] = radial([[0, '#7fa2ff'], [0.42, '#3a4cc4'], [1, '#12164f']], 0.28, 0.16, 0.85);
    s += gpD + `<circle cx="${GX}" cy="${GY}" r="${GR + 6}" fill="none" stroke="#6fd8ff" stroke-width="18" opacity=".55" filter="${b9}"/>`;
    s += `<defs><clipPath id="${clip}"><circle cx="${GX}" cy="${GY}" r="${GR}"/></clipPath></defs><circle cx="${GX}" cy="${GY}" r="${GR}" fill="${gp}"/>`;
    s += `<g clip-path="url(#${clip})" transform="rotate(-9 ${GX} ${GY})">` + [[-214, 10, '#b4d0ff', 0.3], [-192, 6, '#0b0e40', 0.3], [-170, 14, '#b4d0ff', 0.22], [-142, 8, '#0b0e40', 0.3], [-118, 18, '#b4d0ff', 0.16], [-86, 8, '#0b0e40', 0.26]].map(([dy, h, c, o]) => `<rect x="${GX - GR}" y="${GY + dy}" width="${GR * 2}" height="${h}" rx="${h / 2}" fill="${c}" opacity="${o}"/>`).join('') + `<ellipse cx="${GX + 86}" cy="${GY - 150}" rx="27" ry="9" fill="#d6e6ff" opacity=".3"/></g>`;
    s += `<path d="M${GX - GR} ${GY}A${GR} ${GR} 0 0 1 ${GX} ${GY - GR}" fill="none" stroke="#d6f8ff" stroke-width="3.500" opacity=".9"/>`;
    // a small ringed planet, a comet, a floating rock and two far-off roll pads
    s += ringed(166, 154, 28, -18);
    const [tail, tailD] = lin([[0, '#8fe9ff', 0], [1, '#fff', 0.95]], 1, 1);
    s += tailD + `<path d="M236 124L299 147L295 155z" fill="${tail}"/>` + k.glow(297, 151, 16, '#8fe9ff', 0.9) + `<circle cx="297" cy="151" r="4" fill="#fff"/>`;
    s += island(908, 228, 0.42, k.crystal(0, -8, 0.6, '#b79cff'));
    s += farPad(126, 287, '#ff5fae') + farPad(930, 286, '#5fe1ff');

    // --- ground: the star deck, a toy-brick floor floating in space ---
    s += k.floor(296, '#5670f2', '#131046', { rows: 8, studColor: '#bfe9ff' });
    const [edge, edgeD] = lin([[0, '#8fe9ff', 0.7], [1, '#8fe9ff', 0]]);
    s += edgeD + `<rect x="0" y="296" width="960" height="64" fill="${edge}"/>`;
    s += `<g transform="translate(${PX} ${PY + 8}) scale(1 0.3)">${k.glow(0, 0, 350, '#ffd166', 0.8)}</g>`;
    // the flash of the reveal, behind everything that stands on the deck
    s += k.rays(PX, 164, 260, '#fff3c4', { n: 18, op: 0.08, spin: 0.1 }) + k.glow(PX, 164, 230, '#ffd166', 0.55);

    // --- middle: another player who rolled a Rare, on their own pad ---
    const LX = 206, LY = 338;
    s += `<g transform="translate(${LX} ${LY + 6}) scale(1 0.3)">${k.glow(0, 0, 130, '#3fb4ff', 0.75)}</g>`;
    s += k.crystal(134, 378, 0.5, '#7fe8ff');
    s += k.pad(LX, LY + 3, 62, '#3b46c9', { h: 7 }) + k.pad(LX, LY - 2, 47, '#7fdcff', { h: 5 });
    s += aura(LX, LY - 3, 0.3, 0.45, BLUE_AURA, b4);
    s += k.avatar(LX, LY - 3, 0.72, { shirt: '#ffd166', pants: '#2b2f55', skin: '#c98d5e', hair: '#2b1b12', pose: 'cheer', face: 'smile' });
    s += resultCard(LX, 227, 110, 50, 4, RAR[1], { name: 20, odds: 12, pillW: 70, sw: 4 });
    s += k.pet(146, 314, 0.5, '#7dff8a');

    // --- middle right: a player pointing at the big roll, and the odds ladder ---
    s += aura(658, 342, 0.25, 0.4, VIOLET_AURA, b4);
    s += k.avatar(658, 344, 0.64, { shirt: '#ff8a4c', pants: '#2b2f55', skin: '#ffd9a8', hair: '#7a3b1e', pose: 'point', face: 'wow', flip: true });
    const TX = 778, TB = 398, BH = 44, TT = TB - BH * 5;
    s += k.crystal(886, 394, 0.55, '#7fe8ff') + k.rock(694, 406, 0.34, '#4a4fc0');
    s += k.shadow(TX + 6, TB + 4, 100, 12, 0.3) + k.glow(TX, TT + BH / 2, 120, RAR[4].c, 0.75);
    RAR.forEach((r, i) => {
      const w = 152 - i * 8, x = TX - w / 2, y = TB - BH * (i + 1);
      s += k.box(x, y, w, BH, r.c, { d: 10, shadow: false });
      s += k.text(TX, y + 20, r.name, 15.5, { sw: 3.5 }) + k.text(TX, y + 37, r.odds, 12.5, { fill: '#fff6c2', sw: 3 });
    });
    s += `<rect x="${TX - 54}" y="${TT - 40}" width="108" height="25" rx="12.500" fill="${INK}" stroke="#fff" stroke-width="2.500"/>` + k.text(TX, TT - 22.500, 'YOUR ODDS', 14, { sw: 0 });
    s += `<path d="M${TX - 82} ${TT + 10}l16 12-16 12z" fill="#fff" stroke="${INK}" stroke-width="3.500" stroke-linejoin="round"/>`;
    s += k.sparkles([[TX + 72, TT + 2, 0.7], [TX - 70, TT - 14, 0.5]], '#fff');

    // --- the roll pad: the one thing to do ---
    for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8 + 0.2; s += `<path d="M${r1(PX + 176 * Math.cos(a))} ${r1(PY + 6 + 42 * Math.sin(a))}L${r1(PX + 236 * Math.cos(a))} ${r1(PY + 6 + 57 * Math.sin(a))}" stroke="#fff3c4" stroke-width="4.500" stroke-linecap="round" opacity=".28"/>`; }
    s += k.ring(PX, PY + 6, 186, 45, '#fff', 4, 0.55) + k.ring(PX, PY + 6, 250, 61, '#ffe9a8', 3, 0.22);
    s += k.pad(PX, PY, 152, '#4a3fd0', { h: 14, ry: 36 });
    for (let i = 0; i < 20; i++) {
      const a = i * Math.PI / 10 + 0.157, lx = r1(PX + 136 * Math.cos(a)), ly = r1(PY + 32 * Math.sin(a)), c = RAR[i % 5].c;
      s += k.glow(lx, ly, 12, c, 0.8) + `<ellipse cx="${lx}" cy="${ly}" rx="6.500" ry="3.600" fill="${k.mix(c, 0.25)}" stroke="${INK}" stroke-width="2"/>`;
    }
    s += k.pad(PX, PY - 12, 116, '#6fe3ff', { h: 12, ry: 28 });
    s += `<path d="${star(0, 0, 80, 36)}" fill="#fff" opacity=".8" transform="translate(${PX} ${FY}) scale(1 0.26)"/>` + k.ring(PX, FY, 98, 23, '#fff', 4, 0.85);
    // light pouring down on the winner
    const [beam, beamD] = lin([[0, '#fff3c4', 0], [0.5, '#fff3c4', 0.2], [1, '#fffbe8', 0.45]]);
    s += beamD + `<path d="M392 ${PY - 12}L438 96h84l46 ${PY - 108}z" fill="${beam}" filter="${b9}"/>`;
    // the aura the player now wears
    s += k.glow(PX, 296, 185, '#ffb938', 0.7);
    s += aura(PX, FY - 2, 0.86, 0.9, GOLD_AURA, b4);
    s += hoop(PX, 328, 94, 21, -12, false, '#ffd166') + hoop(PX, 296, 78, 17, 14, false, '#ffd166', 0.75);
    s += k.avatar(PX, FY, 1.4, { shirt: '#6c4dff', pants: '#23264a', hair: '#3a2416', pose: 'cheer', face: 'wow' });
    s += hoop(PX, 328, 94, 21, -12, true, '#ffd166') + hoop(PX, 296, 78, 17, 14, true, '#ffd166', 0.75);
    s += [[572, 308, 11], [404, 277, 9.5], [388, 348, 8]].map(([x, y, R]) => k.glow(x, y, R * 2.6, '#fff4b8', 0.8) + `<path d="${star(x, y, R, R * 0.45)}" fill="#fff4b8" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`).join('');
    const [streak, streakD] = lin([[0, '#fff', 0.95], [1, '#fff', 0]]);
    s += streakD + [[420, 246, 30], [538, 240, 32], [372, 262, 24], [590, 300, 24]].map(([x, y, h]) => `<rect x="${x}" y="${y}" width="5" height="${h}" rx="2.500" fill="${streak}"/>`).join('');
    s += mote(400, 306, 2.6) + mote(566, 262, 2.4) + mote(596, 348, 2.2) + mote(366, 356, 2);
    s += k.pet(324, 320, 1, '#b79cff', { glow: true });

    // --- the reveal: rarity name with its odds ---
    s += resultCard(PX, 164, 312, 86, -2.5, RAR[4], { name: 44, odds: 22 });
    s += k.burst(326, 207, 27, '#ff4f6d', { n: 12, inner: 0.78 }) + k.text(326, 213, 'NEW!', 15.5, { rotate: -12, sw: 4 });
    s += k.sparkles([[334, 128, 1.1], [632, 196, 1], [612, 122, 0.7]], '#fff');

    // --- reward feedback: one more aura flies off to the index counter ---
    s += `<path d="M640 240Q698 196 668 114" fill="none" stroke="#fff3c4" stroke-width="5" stroke-linecap="round" stroke-dasharray="1 13" opacity=".75"/>`;
    s += mini(650, 232, 1.05, -14) + mini(676, 196, 0.86, 8) + mini(682, 160, 0.7, 16) + mini(673, 127, 0.56, 6);
    s += k.pop(588, 254, '+1 INDEX', 20, '#8dff9a', 6);
    s += confetti([[292, 250, 20, '#5fe1ff'], [300, 292, -30, '#ffc93c'], [612, 286, -24, '#5fe1ff'], [290, 166, -18, '#ff5fae'], [352, 232, 50, '#ffc93c'], [356, 352, 14, '#b56bff'], [618, 330, -40, '#fff']]);
    s += k.sparkles([[352, 300, 0.9], [606, 350, 0.9], [330, 380, 0.8], [634, 386, 0.7], [446, 232, 0.7], [516, 228, 0.6]], '#fff');
    s += mote(150, 406) + mote(262, 420, 2, '#8fe9ff') + mote(700, 432, 2.2, '#8fe9ff') + mote(866, 344, 2) + mote(128, 262, 1.8, '#8fe9ff') + mote(920, 262, 1.8);

    // --- near: lucky dice and crystals close to the camera ---
    s += k.rock(40, 540, 1.5, '#2c2f8f') + die(118, 470, 62, '#b79cff', -10, 5) + die(214, 496, 42, '#5fe1ff', 13, 3);
    s += k.glow(286, 520, 60, '#5fe1ff', 0.5) + k.crystal(288, 540, 0.9, '#5fe1ff');
    s += k.glow(716, 492, 70, '#b79cff', 0.55) + k.crystal(716, 532, 1.3, '#b79cff') + k.rock(786, 536, 1.3, '#2c2f8f') + k.rock(664, 546, 0.9, '#3a3fa8');

    // --- soft dark corners pull the eye to the roll ---
    const [vig, vigD] = radial([[0.55, '#050418', 0], [1, '#050418', 0.6]], 0.5, 0.55, 0.78);
    s += vigD + `<rect width="960" height="540" fill="${vig}"/>`;
    return s;
  };

  /* ---------- the moment players work toward, 480 x 270 ---------- */
  const moment = () => {
    const [bg, bgD] = lin([[0, '#060828'], [0.5, '#221f86'], [1, '#3f6fd8']]);
    const [b3, b3D] = blur(3), [b16, b16D] = blur(16);
    let s = bgD + b3D + b16D + `<rect width="480" height="270" fill="${bg}"/>`;
    s += `<g filter="${b16}"><ellipse cx="90" cy="120" rx="120" ry="44" fill="#a23fe0" opacity=".55"/><ellipse cx="400" cy="150" rx="120" ry="40" fill="#2fc0ee" opacity=".5"/></g>` + k.stars('page', 40, 480, 200);
    s += k.rays(240, 124, 420, '#fff', { n: 18, op: 0.11 }) + k.glow(240, 124, 230, '#b79cff', 0.95);
    s += k.floor(212, '#5670f2', '#131046', { w: 480, h: 270, rows: 3, studColor: '#bfe9ff' });
    // the pad the index page floats above, with its light cone
    const [cone, coneD] = lin([[0, '#bff3ff', 0], [1, '#bff3ff', 0.6]]);
    s += k.glow(240, 222, 130, '#5fe1ff', 0.7) + k.ring(240, 224, 98, 20, '#fff', 2.5, 0.5) + k.ring(240, 224, 122, 25, '#bff3ff', 2, 0.28) + k.pad(240, 220, 72, '#6fe3ff', { h: 7, ry: 15 });
    s += coneD + `<path d="M150 180h180l-44 40h-92z" fill="${cone}" filter="${b3}"/>`;
    const [rise, riseD] = lin([[0, '#fff', 0.95], [1, '#fff', 0]]);
    s += riseD + [[204, 194, 20], [226, 188, 26], [258, 190, 24], [278, 196, 18]].map(([x, y, h]) => `<rect x="${x}" y="${y}" width="3.500" height="${h}" rx="1.750" fill="${rise}"/>`).join('');
    // the full index page: 12 of 12 auras found
    const cells = [0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 4];
    const [hd, hdD] = lin([[0, '#b79cff'], [1, '#5fe1ff']], 1, 0);
    s += hdD + `<g transform="rotate(-3 240 122)"><rect x="135" y="66" width="214" height="124" rx="14" fill="${INK}" opacity=".5"/><rect x="131" y="60" width="214" height="124" rx="14" fill="#1b2068" stroke="${INK}" stroke-width="4"/>`;
    s += `<rect x="137" y="66" width="202" height="23" rx="9" fill="${hd}" stroke="${INK}" stroke-width="2.500"/>` + k.text(146, 83, 'STAR PAGE', 13, { anchor: 'start', sw: 3 }) + k.text(331, 83, '12 / 12', 13, { anchor: 'end', sw: 3, fill: '#d9ffe0' });
    s += k.glow(322.5, 144, 44, '#ffc93c', 0.95);
    cells.forEach((ri, i) => {
      const cx = 157.5 + (i % 6) * 33, cy = 110 + Math.floor(i / 6) * 34, c = RAR[ri].c;
      s += `<rect x="${cx - 14}" y="${cy - 14.5}" width="28" height="29" rx="7" fill="${c}" stroke="${INK}" stroke-width="2.500"/><rect x="${cx - 10}" y="${cy - 11}" width="20" height="5" rx="2.500" fill="#fff" opacity=".45"/>`;
      s += glyph(cx, cy + 10.5, 0.1);
    });
    s += `<rect x="143" y="164" width="190" height="11" rx="5.500" fill="${INK}" stroke="#fff" stroke-width="2"/><rect x="146" y="167" width="184" height="5" rx="2.500" fill="#4ade9a"/></g>`;
    // the rarest one shines, and the page is ticked off
    s += k.sparkles([[338, 124, 0.9], [302, 160, 0.6]], '#fff');
    s += `<circle cx="352" cy="66" r="18" fill="#2fe06a" stroke="${INK}" stroke-width="4"/><path d="M343 66l6 7 12-14" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
    // the player, luckier for good
    s += aura(66, 240, 0.4, 0.58, GOLD_AURA, b3);
    s += k.avatar(66, 240, 1, { shirt: '#6c4dff', pants: '#23264a', hair: '#3a2416', hat: 'crown', pose: 'cheer', face: 'cool' });
    s += k.pet(424, 222, 0.9, '#b79cff', { glow: true });
    s += k.text(412, 124, '+10%', 40, { fill: '#8dff9a', rotate: 8 }) + k.text(408, 152, 'LUCK', 23, { rotate: 8 });
    s += `<path d="M126 238h228l-13 14 13 14h-228l13-14z" fill="#7a5cff" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/><path d="M144 243h192" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".45"/>`;
    s += k.text(240, 260, 'KEPT FOREVER', 19);
    s += k.text(240, 44, 'PAGE COMPLETE!', 36, { fill: '#fff6c2' });
    s += confetti([[40, 96, 20, '#5fe1ff'], [100, 70, -30, '#ffc93c'], [112, 150, 50, '#fff'], [22, 150, -15, '#ff5fae'], [440, 84, -24, '#ffc93c'], [380, 70, 36, '#5fe1ff'], [456, 176, 14, '#fff'], [372, 196, -50, '#8dff9a'], [118, 200, 28, '#ffc93c']]);
    s += k.sparkles([[30, 52, 1.1], [452, 46, 1.1], [116, 110, 0.7], [458, 176, 0.7], [18, 200, 0.7]], '#fff');
    return s;
  };

  (window.TEMPLATES = window.TEMPLATES || {})[4] = {
    n: 4,
    name: 'Roll for Rarity',
    genre: 'Simulation · luck',
    colors: ['#b79cff', '#5fe1ff'],
    hook: 'Press roll for an aura with its odds on show, wear your rarest, raise your luck and fill the index. Rolls are earned by playing.',

    // One story: luck x1.5, 9 of 12 auras found on the Star page (step 2 on the strip); filling it pays +10% luck.
    hud: {
      pills: [{ icon: 'star', color: '#b56bff', value: 'Luck x1.5' }, { icon: 'coin', color: '#ffd166', value: '412', plus: true }],
      goal: { label: 'STAR PAGE', text: 'Auras found 9 / 12', pct: 75 },
      next: { label: 'PAGE REWARD', value: '+10% Luck' },
      buttons: [{ icon: 'book', label: 'Index', color: '#ff9a5c' }, { icon: 'cart', label: 'Shop', color: '#3aa0ff' }, { icon: 'up', label: 'Luck', color: '#b56bff' }, { icon: 'gift', label: 'Daily', color: '#2fe06a', dot: true }],
      action: 'ROLL!',
    },

    scene,

    shop: {
      title: 'SHOP', currency: 'coin', currencyColor: '#ffd166', bg: '#141a5c',
      featured: { tag: 'FEATURED', name: 'Starter Pack', line: 'Comet aura and fast rolls for one hour', price: '49',
        art: () => K.burst(40, 40, 38, '#fff6c2', { sw: 0, n: 14, inner: 0.8 })
          + `<g transform="translate(40 47) scale(.2 .21)" stroke="#1b1230" stroke-width="13" stroke-linejoin="round"><g fill="#3f8bff">${flames(1, 1)}</g></g>`
          + `<g transform="translate(40 47) scale(.2 .21)"><g fill="#3fc0ff">${flames(0.92, 0.92)}</g><g fill="#e6fbff">${flames(0.56, 0.6)}</g></g>`
          + K.box(15, 46, 44, 25, '#ff5fae', { d: 8, shadow: false, sw: 3 })
          + `<rect x="32" y="46" width="10" height="25" fill="#ffd166" stroke="#1b1230" stroke-width="2.500"/>`
          + `<circle cx="64" cy="18" r="13" fill="#ff9a3c" stroke="#1b1230" stroke-width="3"/><path d="M66 9l-8 10h5l-2 8 8-11h-5z" fill="#fff" stroke="#1b1230" stroke-width="1.500" stroke-linejoin="round"/>`
          + K.sparkle(12, 22, 0.6) + K.sparkle(70, 62, 0.5) },
      items: [
        { icon: 'bolt', color: '#ff9a3c', name: 'Fast Roll', line: 'Roll twice as fast', price: '199' },
        { icon: 'loop', color: '#3aa0ff', name: 'Auto Roll', line: 'Rolls for you', price: '149' },
        { icon: 'star', color: '#b56bff', name: 'Luck x2 Boost', line: 'Mythic 1 in 2,500', price: '60' },
      ],
      caption: 'One featured pack, three clear items, coin prices. The 10-minute luck boost shows its odds.',
    },

    moment: {
      title: 'PAGE COMPLETE',
      caption: 'Find all 12 auras on a page and your luck goes up for good.',
      svg: moment,
    },

    path: { label: 'Index pages to fill', steps: [
      { name: 'Moon page', need: '12 of 12 found', state: 'done' },
      { name: 'Star page', need: '9 of 12 found', state: 'now' },
      { name: 'Storm page', need: 'Fill Star page', state: 'locked' },
      { name: 'Void page', need: 'Fill Storm page', state: 'locked' },
      { name: 'Secret page', need: 'Fill Void page', state: 'locked' },
    ] },

    first60: [
      { t: '0-10s', text: 'Land on the roll pad. An arrow points at ROLL.' },
      { t: '10-25s', text: 'Each roll shows an aura, its rarity and its odds.' },
      { t: '25-45s', text: 'Equip your best aura. It glows around you.' },
      { t: '45-60s', text: 'The index opens: 3 of 12 found on page 1.' },
    ],
    loop: ['Press roll', 'An aura with shown odds', 'Luck and roll speed', 'Fill every index page'],
    mechanic: 'What a roll gives: auras, pets, titles, weapons. Odds always shown, as Roblox requires.',
    reskins: ['Pet hatchery', 'Sword forge', 'Title wheel'],
    earns: ['One extra index page', 'Starter pack, after page 1', 'Fast roll, auto roll, luck boost'],
    keeps: ['One free luck boost every day', 'Index pages to complete', 'A new aura set every week'],
    stats: { shared: '80%', days: '2', risk: 'Medium' },
  };
})();
