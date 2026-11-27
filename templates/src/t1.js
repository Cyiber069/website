// Template 1: Tap Simulator. A glowing tap pad on a plaza at sunset.
// Same data shape as every other template file. Scene helpers live inside this wrapper so they cannot clash with other files.
(function () {
  const k = K, INK = K.INK;
  const r1 = (v) => Math.round(v * 10) / 10;
  // Gradient helpers: each returns [fill value, <defs> string].
  const stopsOf = (stops) => stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a === undefined ? '' : ` stop-opacity="${a}"`}/>`).join('');
  const lin = (stops, x2 = 0, y2 = 1) => { const id = k.id(); return [`url(#${id})`, `<defs><linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stopsOf(stops)}</linearGradient></defs>`]; };
  const radial = (stops, cy = 0.5, r = 0.5) => { const id = k.id(); return [`url(#${id})`, `<defs><radialGradient id="${id}" cx="0.5" cy="${cy}" r="${r}">${stopsOf(stops)}</radialGradient></defs>`]; };

  /* ---------- small pieces of scenery ---------- */
  // Flat sunset cloud, lit gold from underneath.
  const band = (x, y, s, op) => `<g transform="translate(${x} ${y}) scale(${s})" opacity="${op}"><rect x="22" y="0" width="108" height="16" rx="8" fill="#ffc2d8"/><rect x="0" y="11" width="172" height="15" rx="7.5" fill="#ff9fc6"/><rect x="48" y="22" width="150" height="11" rx="5.5" fill="#ff86b4"/><rect x="12" y="23" width="96" height="4" rx="2" fill="#ffeab8"/><rect x="64" y="31" width="112" height="3" rx="1.5" fill="#ffeab8"/></g>`;
  const bird = (x, y, s) => `<path transform="translate(${x} ${y}) scale(${s})" d="M-10 2q5-9 10 0q5-9 10 0" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity=".75"/>`;
  // Floating rock island; `top` is drawn standing on it.
  const island = (x, y, s, top = '') => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-46 0h92l-16 14-10 2-8 20-12-14-14-2-10-12-14-2z" fill="#8a45b5" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/><path d="M-28 5l11 10M10 5l-4 15" stroke="#5f2a8f" stroke-width="3" stroke-linecap="round" fill="none"/><rect x="-50" y="-9" width="100" height="13" rx="6.5" fill="#ffa3cc" stroke="${INK}" stroke-width="3"/><rect x="-42" y="-6" width="58" height="4" rx="2" fill="#fff" opacity=".55"/>${top}</g>`;
  const temple = `<rect x="-31" y="-17" width="62" height="9" rx="2" fill="#fff1d2" stroke="${INK}" stroke-width="3"/>` + [-25, -11, 3, 17].map(cx => `<rect x="${cx}" y="-41" width="8" height="24" fill="#fff1d2" stroke="${INK}" stroke-width="2.500"/>`).join('') + `<path d="M-36-41h72l-36-21z" fill="#ffd166" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
  // Distant volcano silhouette with a lit crater: the Lava Peak zone on the horizon.
  const volcano = (x, y) => k.glow(x, y - 60, 50, '#ff9a3c', 0.8) + `<path d="M${x - 100} ${y + 8}L${x - 20} ${y - 60}l8 5 9-6 8 6 9-5L${x + 76} ${y + 8}z" fill="#b34f9b"/><path d="M${x - 11} ${y - 55}l-7 24 8 12M${x + 7} ${y - 56}l6 19" stroke="#ffb14a" stroke-width="2.800" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="${x + 4}" cy="${y - 76}" r="8" fill="#ffc2d8" opacity=".55"/><circle cx="${x + 15}" cy="${y - 90}" r="6" fill="#ffc2d8" opacity=".4"/>`;
  // The opening of a gate, filled (portal glow when open, dark when locked).
  const gateFill = (x, y, w, h, fill, op) => { const r = w / 2; return `<path d="M${x - r} ${y}v${-(h - r)}a${r} ${r} 0 0 1 ${w} 0v${h - r}z" fill="${fill}" opacity="${op}"/>`; };
  const bolt = (x, y, s, color = '#ffd166') => `<path transform="translate(${x} ${y}) scale(${s})" d="M3-12L-8 2h7l-3 11L9-3H2z" fill="${color}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
  // Petal drifting on the breeze.
  const petal = (x, y, rot, s = 1, c = '#ffb3d6') => `<path transform="translate(${x} ${y}) rotate(${rot}) scale(${s})" d="M0-7C6-4 6 4 0 7C-5 3-5-3 0-7z" fill="${c}" stroke="${INK}" stroke-width="1.800" stroke-linejoin="round"/>`;
  // Soft blur for beams of light.
  const blur = (dev) => { const id = k.id(); return [`url(#${id})`, `<defs><filter id="${id}" x="-40%" y="-20%" width="180%" height="140%"><feGaussianBlur stdDeviation="${dev}"/></filter></defs>`]; };
  // Half of a glowing hoop of energy; draw the back half before the player and the front half after.
  const hoop = (cx, cy, rx, ry, rot, front, color, op = 1) => `<g transform="rotate(${rot} ${cx} ${cy})" opacity="${op}"><path d="M${cx - rx} ${cy}A${rx} ${ry} 0 0 ${front ? 0 : 1} ${cx + rx} ${cy}" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round" opacity=".45"/><path d="M${cx - rx} ${cy}A${rx} ${ry} 0 0 ${front ? 0 : 1} ${cx + rx} ${cy}" fill="none" stroke="#fff" stroke-width="4.500" stroke-linecap="round"/></g>`;
  const firefly = (x, y, r = 2.4) => k.glow(x, y, r * 5, '#ffe9a8', 0.7) + `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff8d8"/>`;
  const flower = (x, y, s, c) => `<g transform="translate(${x} ${y}) scale(${s})"><circle cx="0" cy="-5" r="4" fill="${c}" stroke="${INK}" stroke-width="2"/><circle cx="5" cy="0" r="4" fill="${c}" stroke="${INK}" stroke-width="2"/><circle cx="0" cy="5" r="4" fill="${c}" stroke="${INK}" stroke-width="2"/><circle cx="-5" cy="0" r="4" fill="${c}" stroke="${INK}" stroke-width="2"/><circle cx="0" cy="0" r="3.200" fill="#fff3a8" stroke="${INK}" stroke-width="2"/></g>`;
  const confetti = (pts) => pts.map(([x, y, rot, c, w = 9, h = 5]) => `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="1.500" fill="${c}" stroke="${INK}" stroke-width="1.500" transform="rotate(${rot} ${x} ${y})"/>`).join('');

  /* ---------- the main game view, 960 x 540 ---------- */
  const scene = () => {
    const PX = 480, PY = 376;   // centre of the tap pad's base
    let s = '';

    // --- far: sunset sky, sun, clouds, floating islands, horizon ---
    const [sky, skyD] = lin([[0, '#1d0e4a'], [0.3, '#56208f'], [0.56, '#c23b95'], [0.78, '#ff7c8b'], [1, '#ffcc7a']]);
    s += skyD + `<rect width="960" height="312" fill="${sky}"/>` + k.stars('dusk', 46, 960, 150);
    s += k.glow(PX, 292, 390, '#ffc47c', 0.6) + k.rays(PX, 292, 640, '#fff3c4', { n: 22, op: 0.06, spin: 0.07 });
    const [sun, sunD] = lin([[0, '#fff2a0'], [0.42, '#ffd45a'], [1, '#ff8a5e']]);
    s += sunD + `<circle cx="${PX}" cy="292" r="154" fill="#ffe9a8" opacity=".25"/><circle cx="${PX}" cy="292" r="138" fill="${sun}"/>`;
    s += band(104, 198, 1.05, 0.8) + band(250, 148, 0.62, 0.5) + band(634, 236, 0.8, 0.7) + band(772, 196, 0.55, 0.5);
    s += bird(652, 150, 1) + bird(686, 134, 0.75) + bird(628, 170, 0.65);
    s += k.glow(872, 150, 70, '#fff3c4', 0.5) + island(872, 168, 0.92, temple) + `<g opacity=".9">${k.cloud(806, 176, 0.36, 0.9)}${k.cloud(894, 184, 0.3, 0.8)}</g>`;
    s += island(166, 182, 0.5, k.tree(4, -8, 0.5, { leaf: '#ff86bd' }));
    s += volcano(912, 292);
    s += k.hills(294, '#b14b9c', 5, 26) + k.hills(304, '#7d3398', 12, 15);
    const [haze, hazeD] = lin([[0, '#ffd9a0', 0], [1, '#ffd9a0', 0.5]]);
    s += hazeD + `<rect x="0" y="252" width="960" height="42" fill="${haze}"/>`;

    // --- ground: toy-brick plaza, violet with the last pink light along the horizon ---
    s += k.floor(292, '#b780ff', '#3b1c9c', { rows: 8 });
    const [warm, warmD] = lin([[0, '#ff9cc6', 0.85], [1, '#ff9cc6', 0]]);
    s += warmD + `<rect x="0" y="292" width="960" height="84" fill="${warm}"/>`;
    s += `<ellipse cx="${PX}" cy="308" rx="330" ry="15" fill="#fff0c0" opacity=".4"/>` + k.rays(PX, 292, 700, '#ffe2b0', { n: 22, op: 0.05, spin: 0.07 });
    // the road that leaves the pad and runs through the three zone gates, with a dotted guide arrow
    s += `<path d="M540 372L704 338L806 320L874 310L912 297L920 297L900 312L858 324L778 344L622 404L540 404z" fill="#fff0d2" opacity=".42"/><path d="M560 368L704 338L806 320L874 310L912 297M920 297L900 312L858 324L778 344L622 404" fill="none" stroke="#fff8e4" stroke-width="3" opacity=".75" stroke-linejoin="round"/>`;
    s += k.arrow(634, 398, 708, 359, '#fff6c2', { bend: 5 });

    // --- middle: scenery, another player, the gates ---
    s += k.tree(132, 316, 0.52, { leaf: '#ff7fb6' }) + k.tree(286, 305, 0.34, { leaf: '#ff9ac6' });
    // another player tapping on their own pad
    s += k.glow(204, 322, 78, '#b79cff', 0.5) + k.pad(204, 328, 62, '#ff5fae', { h: 6 }) + k.pad(204, 323, 49, '#ffd166', { h: 5 }) + k.ring(204, 327, 80, 21, '#fff', 2.5, 0.45);
    s += k.avatar(204, 323, 0.72, { shirt: '#3aa0ff', pants: '#2b2f55', skin: '#c98d5e', hair: '#2b1b12', hat: 'cap', hatColor: '#ffd166', pose: 'cheer', face: 'smile' });
    s += k.pet(258, 304, 0.6, '#7dff8a') + k.pop(160, 248, '+1', 19, '#ffffff', -8) + k.pop(244, 236, '+1', 15, '#fff3a8', 8);
    // gates, far to near
    s += gateFill(892, 311, 44, 62, INK, 0.4) + k.arch(892, 311, 44, 62, '#c9a6ff', '2M', { size: 13, thick: 8 }) + k.lock(892, 271, 0.58);
    s += gateFill(832, 322, 60, 86, INK, 0.4) + k.arch(832, 322, 60, 86, '#ff8a3c', '50K', { size: 16, thick: 11 }) + k.lock(832, 266, 0.8);
    const [portal, portalD] = lin([[0, '#ffffff', 0.9], [0.55, '#8ff0ff', 0.75], [1, '#5fe1ff', 0.35]]);
    s += `<ellipse cx="736" cy="350" rx="74" ry="13" fill="#8ff0ff" opacity=".45"/>` + k.glow(736, 290, 96, '#5fe1ff', 0.6) + portalD + gateFill(736, 340, 88, 124, portal, 1);
    s += k.arch(736, 340, 88, 124, '#5fe1ff', '', { thick: 15 });
    s += k.crystal(792, 345, 0.42, '#7fe8ff') + k.crystal(680, 346, 0.34, '#7fe8ff');
    s += bolt(714, 286, 0.95) + k.text(744, 295, '1K', 25) + k.bar(704, 305, 64, 12, 62, '#ffd166');
    s += k.text(736, 204, 'ZONE 2', 19, { fill: '#c8f6ff' }) + k.sparkles([[700, 250, 0.7], [770, 268, 0.55], [752, 322, 0.5]], '#fff');

    // --- the tap pad: the one thing to do ---
    s += k.glow(PX, PY, 270, '#ffd166', 0.7);
    s += k.ring(PX, PY + 4, 180, 44, '#fff', 4.5, 0.65) + k.ring(PX, PY + 4, 210, 52, '#fff', 3.5, 0.38) + k.ring(PX, PY + 4, 242, 60, '#fff', 2.5, 0.2);
    s += k.pad(PX, PY, 150, '#ff5fae', { h: 14, ry: 36 });
    for (let i = 0; i < 18; i++) {
      const a = i * Math.PI * 2 / 18 + 0.175, lx = r1(PX + 134 * Math.cos(a)), ly = r1(PY + 32 * Math.sin(a)), on = i % 2 === 0;
      s += (on ? k.glow(lx, ly, 13, '#fff3a8', 0.85) : '') + `<ellipse cx="${lx}" cy="${ly}" rx="6" ry="3.400" fill="${on ? '#fff8d0' : '#8f4be8'}" stroke="${INK}" stroke-width="2"/>`;
    }
    s += k.pad(PX, PY - 12, 118, '#ffd166', { h: 12, ry: 29 });
    s += `<ellipse cx="${PX}" cy="${PY - 14}" rx="74" ry="18" fill="#fff" opacity=".6"/>` + k.ring(PX, PY - 14, 96, 23, '#fff', 4, 0.85);
    // pets hover on either side of the pad
    s += k.pet(316, 322, 1, '#6fd6ff', { glow: true }) + k.pet(650, 316, 1.2, '#ff9a5c', { glow: true });
    // soft column of light, rising streaks and rings: power pouring up out of the pad
    const [beam, beamD] = lin([[0, '#fff3c4', 0], [0.5, '#fff3c4', 0.3], [1, '#fffbe8', 0.6]]), [soft, softD] = blur(9);
    s += beamD + softD + `<path d="M394 ${PY - 12}L438 124h84l44 ${PY - 136}z" fill="${beam}" filter="${soft}"/>`;
    const [streak, streakD] = lin([[0, '#fff', 0.95], [1, '#fff', 0]]);
    s += streakD + [[418, 218, 38], [542, 200, 36]].map(([x, y, h]) => `<rect x="${x}" y="${y}" width="5" height="${h}" rx="2.500" fill="${streak}"/>`).join('');
    s += hoop(PX, 338, 98, 22, 0, false, '#ff8ad0') + hoop(PX, 306, 82, 17, 0, false, '#ff8ad0', 0.6);
    s += k.avatar(PX, PY - 12, 1.75, { shirt: '#ff4fa8', pants: '#2b2f55', hair: '#5b3a1e', pose: 'cheer', face: 'wow' });
    s += hoop(PX, 338, 98, 22, 0, true, '#ff8ad0') + hoop(PX, 306, 82, 17, 0, true, '#ff8ad0', 0.6);

    // --- reward feedback ---
    s += k.pop(606, 218, '+1', 46, '#ffffff', 8) + k.pop(364, 214, '+1', 37, '#fff3a8', -9) + k.pop(540, 152, '+1', 28, '#fff3a8', 8) + k.pop(440, 158, '+1', 23, '#ffffff', -7);
    s += k.pop(684, 262, '+1', 19, '#ffffff', 7);
    // coins fly off toward the counter in the corner
    s += `<path d="M352 300Q312 196 262 138" fill="none" stroke="#fff3c4" stroke-width="5" stroke-linecap="round" stroke-dasharray="1 13" opacity=".7"/>`;
    s += k.coin(338, 264, 15) + k.coin(306, 214, 12) + k.coin(280, 170, 10) + k.coin(258, 134, 8);
    s += k.sparkles([[392, 318, 1.1], [574, 336, 0.9], [330, 368, 0.8], [628, 372, 0.7], [498, 132, 0.8], [300, 248, 0.7], [640, 262, 0.6]], '#fff');
    s += firefly(150, 392) + firefly(262, 410, 2) + firefly(700, 420, 2.2) + firefly(820, 372, 2) + firefly(608, 430, 1.8) + firefly(128, 232, 1.8) + firefly(900, 236, 1.8);

    // petals drifting off the trees
    s += petal(150, 376, 30) + petal(300, 392, 60, 1.1) + petal(176, 428, -20, 1.2) + petal(852, 388, -50, 1.1) + petal(792, 232, 20, 0.8) + petal(338, 150, -30, 0.8) + petal(778, 428, -25, 1.1);

    // --- near: plants and crystals close to the camera ---
    s += k.bush(52, 536, 1.7, '#4a2390') + k.bush(196, 522, 1.9, '#5b2aa6') + flower(160, 484, 1.5, '#ff7fc4') + flower(228, 478, 1.3, '#ffd166') + flower(204, 506, 1.1, '#ff7fc4');
    s += k.rock(280, 532, 1.2, '#6a3fb5');
    s += k.glow(718, 492, 70, '#ff7fc8', 0.55) + k.crystal(718, 530, 1.3, '#ff7fc8') + k.rock(784, 534, 1.3, '#6a3fb5') + k.bush(676, 546, 1, '#4a2390');

    // --- soft dark corners pull the eye to the pad ---
    const [vig, vigD] = radial([[0.55, '#12082e', 0], [1, '#12082e', 0.55]], 0.55, 0.78);
    s += vigD + `<rect width="960" height="540" fill="${vig}"/>`;
    return s;
  };

  /* ---------- the moment players work toward, 480 x 270 ---------- */
  const moment = () => {
    const [bg, bgD] = lin([[0, '#1f0f52'], [0.45, '#7d27a6'], [0.8, '#ff5f9e'], [1, '#ffb85c']]);
    let s = bgD + `<rect width="480" height="270" fill="${bg}"/>` + k.stars('rebirth', 30, 480, 110);
    s += k.rays(240, 150, 400, '#fff', { n: 18, op: 0.13 }) + k.glow(240, 150, 225, '#ffd166', 0.95);
    s += `<circle cx="240" cy="150" r="124" fill="none" stroke="#fff" stroke-width="3" opacity=".4"/><circle cx="240" cy="150" r="142" fill="none" stroke="#fff" stroke-width="2" opacity=".2"/>`;
    s += k.burst(240, 150, 102, '#ffd166', { n: 20, inner: 0.8 }) + `<circle cx="240" cy="150" r="74" fill="#ffe7a0"/><circle cx="240" cy="150" r="54" fill="#fff8d8" opacity=".85"/>`;
    // plaza floor
    s += k.floor(206, '#c58bff', '#44209f', { w: 480, h: 270, rows: 4 });
    const [warm, warmD] = lin([[0, '#ffb0cf', 0.8], [1, '#ffb0cf', 0]]);
    s += warmD + `<rect x="0" y="206" width="480" height="40" fill="${warm}"/>`;
    // beam of light landing on the pad
    const [beam, beamD] = lin([[0, '#fff', 0], [0.4, '#fff8d8', 0.5], [1, '#fff', 0.85]]), [soft, softD] = blur(6);
    s += beamD + softD + `<path d="M184 228L214 0h52l30 228z" fill="${beam}" filter="${soft}"/>`;
    s += k.glow(240, 230, 150, '#ffd166', 0.7) + k.ring(240, 232, 116, 25, '#fff', 3, 0.55) + k.ring(240, 232, 140, 30, '#fff', 2, 0.28);
    s += k.pad(240, 228, 88, '#ffd166', { h: 9, ry: 19 }) + k.ring(240, 227, 62, 13, '#fff', 3.5, 0.9);
    const [streak, streakD] = lin([[0, '#fff', 0.95], [1, '#fff', 0]]);
    s += streakD + [[180, 150, 40], [192, 104, 28], [296, 142, 44], [284, 96, 26]].map(([x, y, h]) => `<rect x="${x}" y="${y}" width="4" height="${h}" rx="2" fill="${streak}"/>`).join('');
    s += hoop(240, 200, 70, 15, 0, false, '#ff8ad0');
    s += k.avatar(240, 226, 1.2, { shirt: '#ff4fa8', pants: '#2b2f55', hair: '#5b3a1e', hat: 'crown', pose: 'cheer', face: 'cool' });
    s += hoop(240, 200, 70, 15, 0, true, '#ff8ad0');
    s += k.pet(54, 212, 0.95, '#ff9a5c', { glow: true }) + k.pet(426, 212, 0.95, '#6fd6ff', { glow: true });
    s += k.text(88, 158, 'x2', 54, { fill: '#8dff9a', rotate: -10 }) + k.text(392, 158, 'x2', 54, { fill: '#8dff9a', rotate: 10 });
    s += `<path d="M118 237h244l-13 14 13 14h-244l13-14z" fill="#ff4fa8" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/><path d="M136 242h208" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".45"/>`;
    s += k.text(240, 259, 'POWER FOREVER', 19);
    s += k.text(240, 48, 'REBIRTH!', 42, { fill: '#fff6c2' });
    s += confetti([[60, 96, 20, '#5fe1ff'], [104, 72, -30, '#ffd166'], [140, 106, 50, '#fff'], [30, 146, -15, '#ff6fb5'], [420, 100, -24, '#ffd166'], [378, 74, 36, '#5fe1ff'], [450, 148, 14, '#fff'], [342, 108, -50, '#8dff9a'], [132, 190, 28, '#ffd166'], [350, 192, -22, '#5fe1ff']]);
    s += k.sparkles([[52, 54, 1.2], [430, 50, 1.1], [150, 138, 0.7], [334, 140, 0.7], [20, 188, 0.7], [462, 184, 0.7]], '#fff');
    return s;
  };

  (window.TEMPLATES = window.TEMPLATES || {})[1] = {
    n: 1,
    name: 'Tap Simulator',
    genre: 'Simulation · incremental',
    colors: ['#ff6fb5', '#ffb938'],
    hook: 'Tap the glowing pad to grow your power, open new zones with it, then rebirth for a boost that lasts forever.',

    // One story: 620 power now, 1,000 opens the Crystal Cave gate, which is step 2 on the progress strip.
    hud: {
      pills: [{ icon: 'bolt', color: '#ff5fae', value: '620' }, { icon: 'coin', color: '#ffd166', value: '85', plus: true }],
      goal: { label: 'GOAL', text: 'Reach 1,000 power', pct: 62 },
      next: { label: 'NEXT ZONE', value: 'Crystal Cave' },
      buttons: [{ icon: 'cart', label: 'Shop', color: '#3aa0ff' }, { icon: 'loop', label: 'Rebirth', color: '#b56bff' }, { icon: 'paw', label: 'Pets', color: '#ff9a5c' }, { icon: 'gift', label: 'Daily', color: '#2fe06a', dot: true }],
      action: 'TAP!',
    },

    scene,

    shop: {
      title: 'SHOP', currency: 'coin', currencyColor: '#ffd166', bg: '#3a1d7a',
      featured: { tag: 'FEATURED', name: 'Starter Pack', line: 'A pet and 2x power for one hour', price: '49',
        art: () => K.burst(40, 40, 38, '#fff6c2', { sw: 0, n: 14, inner: 0.8 })
          + `<g transform="translate(40 30) scale(.78)">${K.pet(0, 0, 1, '#ff9a5c')}</g>`
          + K.box(15, 44, 44, 26, '#ff4fa8', { d: 8, shadow: false, sw: 3 })
          + `<rect x="32" y="44" width="10" height="26" fill="#ffd166" stroke="#1b1230" stroke-width="2.500"/>`
          + `<circle cx="63" cy="19" r="13" fill="#3ddc6a" stroke="#1b1230" stroke-width="3"/>` + K.text(63, 24, '2x', 14, { sw: 3.5 })
          + K.sparkle(12, 20, 0.6) + K.sparkle(70, 62, 0.5) },
      items: [
        { icon: 'bolt', color: '#ff9a5c', name: '2x Power', line: 'Stays forever', price: '199' },
        { icon: 'wand', color: '#b56bff', name: 'Auto Tap', line: 'Taps for you', price: '149' },
        { icon: 'paw', color: '#3aa0ff', name: 'Pet Slot', line: 'Equip one more pet', price: '60' },
      ],
      caption: 'One featured pack, three clear items, coin prices. No pop-up offers until zone 1 is done.',
    },

    moment: {
      title: 'REBIRTH',
      caption: 'Power resets to zero, a x2 boost stays forever. The long game.',
      svg: moment,
    },

    path: { label: 'Zones to unlock', steps: [
      { name: 'Sunset Plaza', need: 'Start here', state: 'done' },
      { name: 'Crystal Cave', need: '1K power', state: 'now' },
      { name: 'Lava Peak', need: '50K power', state: 'locked' },
      { name: 'Sky Temple', need: '2M power', state: 'locked' },
      { name: 'Rebirth', need: '10M power', state: 'locked' },
    ] },

    first60: [
      { t: '0-10s', text: 'Land on the pad. An arrow points at TAP.' },
      { t: '10-25s', text: 'Each tap adds power. The number climbs.' },
      { t: '25-45s', text: 'A free first pet joins and follows you.' },
      { t: '45-60s', text: 'Zone 2 gate lights up. 1,000 power opens it.' },
    ],
    loop: ['Tap the glowing pad', 'Power on every tap', 'Pets and multipliers', 'Next zone, then rebirth'],
    mechanic: 'The twist on the tap: tap to a beat, hold to charge, or spend your power in a duel.',
    reskins: ['Aura trainer', 'Muscle gym', 'Wizard school'],
    earns: ['Coin packs, extra pet slot', 'Starter pack after zone 1', '2x power and auto-tap passes'],
    keeps: ['Day-7 reward shown on day 1', 'Daily quests on the tap loop', 'A new zone every update'],
    stats: { shared: '90%', days: '1.5', risk: 'Low' },
  };
})();
