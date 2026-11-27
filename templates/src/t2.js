// Template 2: Collect and Sell. A crystal meadow at sunrise: fill the giant backpack, carry it to the SELL pad, open the canyon gate.
(function () {
  const INK = '#1b1230';
  const AQUA = '#5fe1ff', LILAC = '#b79cff', PINK = '#ff8fc7', MINT = '#7df0b8', GOLD = '#ffd23f';

  /* ---------- small helpers used by the scenes below ---------- */
  // Body part in the same style as the kit's avatar.
  const part = (px, py, w, h, c, r = 4) => `<rect x="${px}" y="${py}" width="${w}" height="${h}" rx="${r}" fill="${c}" stroke="${INK}" stroke-width="3"/><rect x="${px + 3}" y="${py + 3}" width="${Math.max(0, w - 6)}" height="${Math.min(5, h / 4)}" rx="2" fill="#fff" opacity=".35"/>`;

  // One crystal spike with a light and a dark facet. (x, y) is the base centre.
  const spike = (x, y, w, h, color, rot = 0, sw = 3) => {
    const d = `M${-w / 2} 0L${-w * 0.62} ${-h * 0.5}L0 ${-h}L${w * 0.62} ${-h * 0.5}L${w / 2} 0z`;
    return `<g transform="translate(${x} ${y}) rotate(${rot})"><path d="${d}" fill="${color}"/>`
      + `<path d="M0 ${-h}L${-w * 0.62} ${-h * 0.5}L${-w / 2} 0h${w * 0.3}L${-w * 0.14} ${-h * 0.5}z" fill="#fff" opacity=".45"/>`
      + `<path d="M0 ${-h}L${w * 0.62} ${-h * 0.5}L${w / 2} 0h${-w * 0.22}L${w * 0.26} ${-h * 0.5}z" fill="${INK}" opacity=".16"/>`
      + `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${sw}" stroke-linejoin="round"/></g>`;
  };
  // A loose piece of crystal flying through the air.
  const bit = (x, y, s, color, rot = 0) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})"><path d="M0 -12L8 0L0 12L-8 0z" fill="${color}"/><path d="M0 -12L-8 0H0z" fill="#fff" opacity=".55"/><path d="M0 12L8 0H0z" fill="${INK}" opacity=".18"/><path d="M0 -12L8 0L0 12L-8 0z" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"/></g>`;
  // Kit crystal cluster with a soft glow so it reads as something worth collecting.
  const lode = (x, y, s, color, glow = 0.45) => `<ellipse cx="${x + 26 * s}" cy="${y + 4 * s}" rx="${46 * s}" ry="${7 * s}" fill="#0a3a2a" opacity=".16"/>` + K.glow(x, y - 30 * s, 62 * s, color, glow) + K.crystal(x, y, s, color);

  // The backpack, drawn behind the body. Local coordinates: feet at (0, 0).
  const pack = (full) => {
    const c = '#c8742e', dk = K.mix(c, -0.34), lt = K.mix(c, 0.32), belt = '#7d4215';
    return (full ? spike(-30, -125, 17, 27, LILAC, -20) + spike(31, -125, 17, 26, PINK, 22) + spike(-12, -128, 19, 36, AQUA, -7) + spike(13, -128, 18, 31, MINT, 10) : '')
      + `<path d="M-34 -130H34Q45 -130 47 -118L55 -60Q57 -34 34 -34H-34Q-57 -34 -55 -60L-47 -118Q-45 -130 -34 -130z" fill="${c}" stroke="${INK}" stroke-width="3.500" stroke-linejoin="round"/>`
      + `<path d="M40 -116L50 -60Q51 -43 37 -39" fill="none" stroke="${dk}" stroke-width="8" stroke-linecap="round" opacity=".7"/>`
      + `<path d="M-41 -112L-49 -62" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".38"/>`
      + `<path d="M-33 -120L-42 -38M33 -120L42 -38" stroke="${INK}" stroke-width="10" stroke-linecap="round"/><path d="M-33 -120L-42 -38M33 -120L42 -38" stroke="${belt}" stroke-width="5" stroke-linecap="round"/>`
      + `<rect x="-44" y="-92" width="11" height="10" rx="2.500" fill="${GOLD}" stroke="${INK}" stroke-width="2.200"/><rect x="33" y="-92" width="11" height="10" rx="2.500" fill="${GOLD}" stroke="${INK}" stroke-width="2.200"/>`
      + `<rect x="-43" y="-135" width="86" height="14" rx="7" fill="${lt}" stroke="${INK}" stroke-width="3"/><rect x="-37" y="-132" width="74" height="4" rx="2" fill="#fff" opacity=".45"/>`
      + `<rect x="-65" y="-84" width="16" height="32" rx="6" fill="${lt}" stroke="${INK}" stroke-width="3"/>`
      + `<rect x="49" y="-84" width="16" height="32" rx="6" fill="${dk}" stroke="${INK}" stroke-width="3"/>`
      + `<path d="M-30 -42h14M16 -42h14" stroke="${dk}" stroke-width="3" stroke-dasharray="4 4" stroke-linecap="round"/>`;
  };
  // The tool. (hx, hy) is the hand that grips it; rot tilts the handle.
  const pick = (hx, hy, rot) => `<g transform="translate(${hx} ${hy}) rotate(${rot})">`
    + `<rect x="-46" y="-4" width="62" height="8" rx="4" fill="#b9773f" stroke="${INK}" stroke-width="3"/><rect x="-30" y="-2" width="40" height="2.500" rx="1.200" fill="#fff" opacity=".35"/>`
    + `<path d="M-33 -31Q-80 0 -33 31Q-50 0 -33 -31z" fill="#dfe8fb" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`
    + `<path d="M-37 -24Q-66 -2 -44 22" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".95"/>`
    + `<rect x="-56" y="-8" width="15" height="16" rx="3" fill="#8ea2c9" stroke="${INK}" stroke-width="3"/>`
    + part(-6, -7.5, 12, 15, '#ffd9a8', 4) + `</g>`;
  // The player, mid-swing, with the overstuffed backpack. (x, y) is where the feet stand.
  const hero = (x, y, s) => {
    const skin = '#ffd9a8', shirt = '#ff5a4f', pants = '#2b2f55', hair = '#5b3a1e', strap = '#8a4a18';
    let g = `<ellipse cx="2" cy="1" rx="52" ry="9" fill="#000" opacity=".3"/>` + pack(true);
    g += `<g transform="rotate(9 -8 -34)">${part(-14, -36, 12, 36, pants)}</g><g transform="rotate(-9 8 -34)">${part(2, -36, 12, 36, pants)}</g>`;
    g += `<g transform="rotate(-52 24 -68)">${part(19, -72, 11, 32, skin)}</g>`;
    g += part(-19, -74, 38, 42, shirt, 5);
    g += `<rect x="-15" y="-73" width="6" height="40" rx="2" fill="${strap}" stroke="${INK}" stroke-width="2"/><rect x="9" y="-73" width="6" height="40" rx="2" fill="${strap}" stroke="${INK}" stroke-width="2"/>`;
    g += `<g transform="rotate(100 -24 -68)">${part(-30, -72, 11, 32, skin)}</g>` + pick(-51.5, -73.4, -12);
    g += part(-16, -105, 32, 31, skin, 8);
    g += `<path d="M-17 -93v-6a10 10 0 0 1 10-10h14a10 10 0 0 1 10 10v6h-7v-5h-20v5z" fill="${hair}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
    g += `<path d="M-18 -99a18 14 0 0 1 36 0z" fill="${GOLD}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/><rect x="-27" y="-102" width="21" height="6" rx="3" fill="${GOLD}" stroke="${INK}" stroke-width="3"/><circle cx="1" cy="-106" r="3.600" fill="#fff" stroke="${INK}" stroke-width="2"/>`;
    g += `<circle cx="-8" cy="-90" r="2.900" fill="${INK}"/><circle cx="5" cy="-90" r="2.900" fill="${INK}"/><path d="M-9 -84q7.500 9 15 0z" fill="#8a2238" stroke="${INK}" stroke-width="2.400" stroke-linejoin="round"/>`;
    return `<g transform="translate(${x} ${y}) scale(${s})">${g}</g>`;
  };

  // The same player seen from behind, arms up, backpack on show. Used in the moment scene.
  const heroBack = (x, y, s) => {
    const skin = '#ffd9a8', shirt = '#ff5a4f', pants = '#2b2f55', hair = '#5b3a1e';
    let g = `<ellipse cx="0" cy="0" rx="30" ry="7" fill="#000" opacity=".3"/>` + part(-14, -36, 12, 36, pants) + part(2, -36, 12, 36, pants);
    g += `<g transform="rotate(152 -24 -68)">${part(-30, -72, 11, 32, skin)}</g><g transform="rotate(-152 24 -68)">${part(19, -72, 11, 32, skin)}</g>` + part(-19, -74, 38, 42, shirt, 5);
    g += `<rect x="-23" y="-78" width="46" height="48" rx="10" fill="#c8742e" stroke="${INK}" stroke-width="3"/><path d="M-23 -60v-8a10 10 0 0 1 10-10h26a10 10 0 0 1 10 10v8z" fill="#e39b4d" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`
      + `<rect x="-5.500" y="-65" width="11" height="10" rx="2.500" fill="${GOLD}" stroke="${INK}" stroke-width="2.200"/><rect x="-15" y="-49" width="30" height="13" rx="4" fill="#a85e20" stroke="${INK}" stroke-width="2.400"/>`;
    g += part(-16, -105, 32, 31, hair, 8) + `<path d="M-16 -84h32v4a6 6 0 0 1-6 6h-20a6 6 0 0 1-6-6z" fill="${skin}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`
      + `<path d="M-18 -98a18 14 0 0 1 36 0z" fill="${GOLD}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
    return `<g transform="translate(${x} ${y}) scale(${s})">${g}</g>`;
  };
  // A row of chevrons painted flat on the ground, pointing from (x1, y1) to (x2, y2).
  const chevrons = (x1, y1, x2, y2, n, color = '#fff') => {
    const q = 0.56, a = Math.atan2((y2 - y1) / q, x2 - x1) * 180 / Math.PI, d = 'M-10 -15L7 0L-10 15';
    let s = `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="#fff36b" stroke-width="22" stroke-linecap="round" opacity=".3"/>`;
    for (let i = 0; i < n; i++) { const t = i / (n - 1), x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t; s += `<g transform="translate(${x} ${y}) scale(1 ${q}) rotate(${a})"><path d="${d}" fill="none" stroke="${INK}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${color}" stroke-width="6.500" stroke-linecap="round" stroke-linejoin="round"/></g>`; }
    return s;
  };

  // Distant mountain with a sunlit side and a snow cap.
  const peak = (x, y, w, h, c) => `<path d="M${x - w / 2} ${y}L${x} ${y - h}L${x + w / 2} ${y}z" fill="${c}"/><path d="M${x} ${y - h}L${x + w / 2} ${y}H${x + w * 0.1}z" fill="#0b3a5a" opacity=".12"/>`
    + `<path d="M${x} ${y - h}l${-w * 0.11} ${h * 0.24} ${w * 0.05} ${-h * 0.06} ${w * 0.05} ${h * 0.08} ${w * 0.06} ${-h * 0.09} ${w * 0.06} ${h * 0.07}z" fill="#fff" opacity=".85"/>`;
  const flower = (x, y, s, c) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M0 0v-9" stroke="#157a44" stroke-width="2.600" stroke-linecap="round"/><circle cx="-4.500" cy="-11" r="3.600" fill="${c}"/><circle cx="4.500" cy="-11" r="3.600" fill="${c}"/><circle cx="0" cy="-15.500" r="3.600" fill="${c}"/><circle cx="0" cy="-7" r="3.600" fill="${c}"/><circle cx="0" cy="-11.200" r="2.600" fill="#fff6c2"/></g>`;
  const tuft = (x, y, s, c = '#1c9a55') => `<path transform="translate(${x} ${y}) scale(${s})" d="M-10 0l3-11 3 8 4-15 3 14 3-9 4 13z" fill="${c}"/>`;
  // Flowers and grass scattered over the ground, smaller toward the horizon.
  const meadow = (seed, n, w, top, bottom) => { const r = K.rnd(seed), cols = ['#ffffff', '#ffe27a', '#ff9ecf', '#fff']; let s = ''; for (let i = 0; i < n; i++) { const t = Math.pow(r(), 1.25), y = top + (bottom - top) * t, x = r() * w, sc = 0.45 + 1.15 * t; s += r() < 0.55 ? tuft(x, y, sc) : flower(x, y, sc * 0.9, cols[Math.floor(r() * 4)]); } return s; };
  // Soft column of light rising from the ground.
  const beam = (x, yTop, yBot, w, color, op = 0.5) => { const id = K.id(); return `<defs><linearGradient id="${id}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${color}" stop-opacity="${op}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="M${x - w / 2} ${yBot}L${x - w * 0.38} ${yTop}H${x + w * 0.38}L${x + w / 2} ${yBot}z" fill="url(#${id})"/>`; };
  // A band of morning haze along the horizon, so far things sit back.
  const haze = (y, h, color, op, w = 960) => { const id = K.id(); return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0"/><stop offset=".5" stop-color="${color}" stop-opacity="${op}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><rect x="0" y="${y - h / 2}" width="${w}" height="${h}" fill="url(#${id})"/>`; };
  // Darker corners so the eye stays on the middle.
  const vignette = (w, h, op = 0.42) => { const id = K.id(); return `<defs><radialGradient id="${id}" cx=".5" cy=".56" r=".78"><stop offset=".56" stop-color="#06263a" stop-opacity="0"/><stop offset="1" stop-color="#06263a" stop-opacity="${op}"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#${id})"/>`; };

  (window.TEMPLATES = window.TEMPLATES || {})[2] = {
    n: 2,
    name: 'Collect and Sell',
    genre: 'Simulation · gathering',
    colors: ['#4ade9a', '#5fe1ff'],
    hook: 'Fill your backpack in the field, carry it to the sell pad for coins, upgrade your tool and bag, then open richer areas.',

    hud: {
      pills: [{ icon: 'coin', color: '#ffd166', value: '3.2K', plus: true }, { icon: 'gem', color: '#5fe1ff', value: '12', plus: true }],
      goal: { label: 'GOAL', text: 'Fill the bag 22/25', pct: 88 },
      next: { label: 'NEXT AREA', value: '5K coins' },
      buttons: [{ icon: 'cart', label: 'Shop', color: '#3aa0ff' }, { icon: 'up', label: 'Upgrade', color: '#ff9a3c' }, { icon: 'flag', label: 'Quests', color: '#b56bff' }, { icon: 'gift', label: 'Daily', color: '#2fe06a', dot: true }],
      action: 'COLLECT',
    },

    // Main game view, 960 x 540.
    scene: () => {
      const k = K, H = 252;
      let s = '';
      /* far: morning sky, sun, mountains */
      s += k.sky('#1297dc', '#d8fbd6')
        + k.rays(186, 150, 620, '#fff', { n: 22, op: 0.05, spin: 0.12 })
        + k.sun(186, 150, 25, '#fff3b0')
        + peak(116, H, 250, 124, '#8ad8dc') + peak(540, H, 300, 112, '#8ad8dc') + peak(742, H, 220, 86, '#94dde0')
        + peak(318, H, 210, 82, '#6fcbc6') + peak(668, H, 170, 62, '#6fcbc6')
        + k.cloud(432, 120, 0.6, 0.9) + k.cloud(108, 204, 0.5, 0.75)
        + k.hills(H, '#52bf9c', 11, 30) + k.hills(H + 2, '#3fb07c', 5, 16)
        + k.tree(122, H + 9, 0.42, { leaf: '#3cc07a' }) + k.tree(150, H + 13, 0.5, { leaf: '#34b46c' }) + k.tree(468, H + 8, 0.4, { leaf: '#3cc07a' }) + k.tree(500, H + 12, 0.48, { leaf: '#34b46c' }) + k.tree(566, H + 8, 0.36, { leaf: '#3cc07a' });
      /* ground */
      s += k.floor(H, '#9af2a6', '#12894a')
        + haze(H + 4, 96, '#f1fff0', 0.55)
        + k.glow(470, 366, 380, '#fff9c4', 0.26)
        // the worn trail: field, sell pad, canyon gate
        + `<path d="M250 440L440 398L575 356L668 332L770 326L874 288h10L776 340L668 352L580 380L450 432L280 492z" fill="#f6e7a6" opacity=".42" stroke="#f6e7a6" stroke-width="6" stroke-linejoin="round"/>`
        + meadow('meadow', 70, 960, H + 14, 540);

      /* far right: the next area, behind a locked gate */
      const cid = k.id();
      s += k.glow(904, 196, 150, '#ff9be6', 0.6)
        + spike(946, 178, 40, 80, PINK, 7) + spike(914, 180, 28, 54, '#ffd166', -9)
        + k.shadow(884, 294, 104, 9, 0.25)
        + k.box(902, 168, 90, 122, '#7a4fd0', { d: 14, sw: 3, shadow: false, studs: 2 })
        + k.box(816, 186, 124, 104, '#8f63e6', { d: 14, sw: 3, shadow: false, studs: 3 })
        + k.box(774, 246, 46, 44, '#a47cf0', { d: 12, sw: 3, shadow: false, studs: 1 })
        + k.crystal(797, 240, 0.34, '#ffd166')
        + `<defs><clipPath id="${cid}"><path d="M842 290V238a36 36 0 0 1 72 0V290z"/></clipPath></defs><g clip-path="url(#${cid})"><rect x="836" y="198" width="84" height="96" fill="#2c1263"/>${k.glow(878, 266, 62, '#ff8fe0', 1)}${k.crystal(859, 291, 0.46, PINK)}${k.crystal(898, 291, 0.5, '#ffd166')}<path d="M854 200V290M866 200V290M890 200V290M902 200V290M842 232H914" stroke="${INK}" stroke-width="3.500" opacity=".85"/></g>`
        + k.arch(878, 290, 72, 88, '#ffd166', null, { thick: 8 })
        + k.glow(878, 238, 30, '#fff3a8', 0.75) + k.lock(878, 240, 1.2)
        + `<rect x="850" y="261" width="56" height="23" rx="11.500" fill="${INK}" opacity=".86"/>` + k.coin(863, 272, 7.5) + k.text(889, 279, '5K', 18, { sw: 3 })
        + k.text(852, 154, 'AREA 2', 21, { fill: '#f6e3ff' });

      /* middle: more to collect */
      s += lode(436, 280, 0.4, AQUA) + lode(528, 292, 0.5, PINK) + lode(566, 276, 0.36, AQUA)
        + lode(132, 398, 0.66, LILAC) + lode(800, 388, 0.86, AQUA);

      /* middle: the sell pad, where another player is cashing in */
      s += k.glow(668, 318, 170, '#ffe27a', 0.6)
        + `<rect x="607" y="216" width="10" height="112" rx="3" fill="#9a6238" stroke="${INK}" stroke-width="3.500"/><rect x="719" y="216" width="10" height="112" rx="3" fill="#9a6238" stroke="${INK}" stroke-width="3.500"/>`
        + k.rays(668, 292, 150, '#fff', { n: 14, op: 0.1 })
        + k.box(590, 166, 156, 56, '#ff9d2e', { d: 10, r: 8, shadow: false })
        + k.coin(619, 194, 15) + k.text(688, 208, 'SELL', 39)
        + k.pad(668, 342, 92, GOLD, { h: 13 })
        + beam(668, 196, 344, 150, '#fff6b8', 0.5)
        + k.ring(668, 340, 62, 16, '#fff', 5, 0.85) + k.ring(668, 336, 106, 29, '#fff8c9', 4, 0.5) + k.ring(668, 331, 126, 35, '#fff', 3, 0.25)
        + k.avatar(668, 342, 0.95, { shirt: '#3aa0ff', pants: '#2b2f55', hair: '#2b2f55', hat: 'cap', hatColor: '#ffffff', pose: 'cheer', face: 'smile' })
        + k.coin(622, 290, 10) + k.coin(712, 280, 9) + k.coin(604, 258, 8) + k.coin(728, 312, 8) + k.coin(574, 232, 9)
        + k.coin(516, 240, 12) + k.pop(560, 252, '+250', 30, '#ffe27a', -6);

      /* the guide: bag is nearly full, walk it to the pad */
      s += k.pet(466, 320, 1.1, PINK, { glow: true })
        + chevrons(446, 405, 568, 365, 5);

      /* near centre: the player swinging at a crystal, backpack stuffed */
      s += lode(236, 431, 1.2, AQUA, 0.7)
        + `<path d="M231 356l5 15-7 11 6 15" fill="none" stroke="${INK}" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round" opacity=".7"/>`
        + k.shadow(392, 410, 80, 11, 0.14)
        + k.glow(345, 250, 120, '#fff6c2', 0.35)
        + hero(345, 404, 1.45)
        + k.burst(231, 350, 17, '#fff', { n: 8, inner: 0.42, sw: 2.5 })
        + `<path d="M243 338Q240 240 318 204" fill="none" stroke="#fff" stroke-width="4.500" stroke-dasharray="1 11" stroke-linecap="round" opacity=".95"/>`
        + bit(247, 272, 1.1, AQUA, 16) + bit(266, 236, 1, AQUA, -24) + bit(298, 213, 0.9, AQUA, 30)
        + bit(208, 374, 0.6, AQUA, -30) + bit(262, 364, 0.5, AQUA, 40)
        + k.pop(150, 336, '+1', 38, '#eaffff', -8) + k.pop(172, 276, '+1', 25, '#ffffff', 8)
        + k.text(345, 150, 'ALMOST FULL!', 22, { fill: '#fff3a8', rotate: -3 });

      /* near: foreground framing */
      s += lode(142, 552, 1.55, '#3ccdf5', 0.6) + k.bush(268, 506, 1, '#1fa351')
        + k.rock(680, 480, 0.8, '#8fb7a6') + lode(736, 538, 1.45, '#a184f7', 0.6) + k.bush(792, 464, 0.8, '#1fa351')
        + flower(232, 532, 1.5, '#fff') + flower(300, 528, 1.3, '#ff9ecf') + flower(664, 524, 1.5, '#ffe27a') + flower(806, 520, 1.3, '#fff');
      s += k.sparkles([[258, 388, 1.1], [330, 172, 1.1], [392, 192, 0.8], [118, 432, 0.9], [176, 478, 1.2], [760, 452, 1.1], [822, 344, 0.8], [640, 300, 0.9], [705, 250, 0.7], [932, 116, 0.9], [540, 262, 0.6], [958, 196, 0.7], [800, 222, 0.6]], '#fff')
        + vignette(960, 540);
      return s;
    },

    shop: {
      title: 'SHOP', currency: 'gem', currencyColor: '#5fe1ff', bg: '#0f5a4c',
      featured: { tag: 'BEST VALUE', name: 'Starter Pack', line: 'Bag +10, a pet and 500 coins', price: '49',
        art: () => K.burst(40, 40, 37, '#fff6c2', { sw: 0, n: 12, inner: 0.8 })
          + spike(27, 33, 12, 20, LILAC, -18, 2.4) + spike(53, 33, 12, 19, PINK, 18, 2.4) + spike(40, 31, 14, 26, AQUA, 0, 2.4)
          + `<path d="M24 28h32q7 0 8 7l3 23q1 12-10 12H23q-11 0-10-12l3-23q1-7 8-7z" fill="#c8742e" stroke="${INK}" stroke-width="2.800" stroke-linejoin="round"/>`
          + `<path d="M23 34h34" stroke="#84490f" stroke-width="4" stroke-linecap="round"/><path d="M21 40l-3 18" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".45"/>`
          + `<rect x="28" y="44" width="24" height="17" rx="5" fill="#e09a4f" stroke="${INK}" stroke-width="2.400"/><rect x="36" y="49" width="8" height="7" rx="2" fill="${GOLD}" stroke="${INK}" stroke-width="2"/>`
          + K.coin(65, 63, 9) + K.coin(13, 66, 7) },
      items: [
        { icon: 'bolt', color: '#ff9a3c', name: '2x Coins', line: 'Double every sale', price: '199' },
        { icon: 'bag', color: '#3aa0ff', name: 'Bigger Bag', line: 'Carry 25 more items', price: '149' },
        { icon: 'wand', color: '#b56bff', name: 'Auto-Sell', line: 'Sell from anywhere', price: '299' },
      ],
      caption: 'One starter offer, three permanent passes. Nothing random.',
    },

    // The moment players work toward, 480 x 270.
    moment: {
      title: 'NEW AREA OPENS',
      caption: 'The gate swings open on richer loot. A fresh goal every area.',
      svg: () => {
        const k = K, V = '#8f63e6', cid = k.id(), gid = k.id();
        let s = k.sky('#1297dc', '#d8fbd6', 480, 270)
          + k.hills(150, '#63c9bb', 4, 34, 480, 270)
          + k.floor(178, '#9af2a6', '#1c9a55', { w: 480, h: 270, rows: 5 })
          + `<path d="M196 180h88l56 90H140z" fill="#f6e7a6" opacity=".5"/>`;
        // what waits inside the gateway
        s += `<defs><clipPath id="${cid}"><rect x="140" y="60" width="200" height="120"/></clipPath><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b98cff"/><stop offset=".6" stop-color="#ffb3ec"/><stop offset="1" stop-color="#fff3b0"/></linearGradient></defs>`
          + `<g clip-path="url(#${cid})"><rect x="140" y="60" width="200" height="120" fill="url(#${gid})"/>`
          + k.hills(150, '#a06be6', 9, 30, 480, 270) + k.hills(162, '#c08cf5', 2, 14, 480, 270)
          + `<rect x="140" y="166" width="200" height="14" fill="#e7b8ff"/>`
          + k.glow(240, 150, 130, '#fff3a8', 1)
          + spike(240, 168, 26, 74, '#f3e6ff', 0, 3) + spike(214, 170, 18, 44, AQUA, -8, 3) + spike(266, 170, 18, 40, MINT, 9, 3)
          + lode(174, 180, 1.05, PINK, 0.6) + lode(308, 180, 1, '#ffd166', 0.6) + `</g>`;
        // the canyon wall and the open doors
        s += k.box(-30, 66, 170, 114, V, { d: 16, sw: 3.5, studs: 4, shadow: false })
          + k.box(340, 66, 170, 114, V, { d: 16, sw: 3.5, studs: 4, shadow: false })
          + k.box(112, 18, 256, 46, '#a47cf0', { d: 14, sw: 3.5, studs: 6, shadow: false })
          + `<path d="M140 68L96 82V206L140 180z" fill="#ffc94a" stroke="${INK}" stroke-width="3.500" stroke-linejoin="round"/><path d="M129 73V186M118 76V192M107 79V199M140 124L96 142" stroke="${INK}" stroke-width="3" opacity=".8"/>`
          + `<path d="M340 68L384 82V206L340 180z" fill="#e7a52e" stroke="${INK}" stroke-width="3.500" stroke-linejoin="round"/><path d="M351 73V186M362 76V192M373 79V199M340 124L384 142" stroke="${INK}" stroke-width="3" opacity=".8"/>`
          + k.rays(240, 140, 330, '#fff', { n: 16, op: 0.13 })
          + k.glow(240, 150, 110, '#fff3a8', 0.45);
        // the lock flies off
        s += `<path d="M376 62L402 44M384 76L412 58" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".85"/><g transform="rotate(30 428 36)">${k.lock(428, 36, 1.35)}</g>`;
        s += heroBack(240, 240, 1.02)
          + k.pet(160, 214, 0.95, PINK, { glow: true })
          + k.text(240, 53, 'NEW AREA!', 33, { fill: '#fff6c2' })
          + k.text(240, 264, 'RICHER LOOT INSIDE', 18)
          + k.sparkles([[58, 44, 1.2], [444, 118, 1], [184, 92, 0.9], [300, 86, 0.8], [70, 236, 1], [410, 236, 1.1], [240, 82, 0.7], [326, 150, 0.7], [156, 142, 0.6]], '#fff');
        return s;
      },
    },

    path: { label: 'Areas to open', steps: [
      { name: 'Gem Meadow', need: 'Start here', state: 'done' },
      { name: 'Violet Canyon', need: '5K coins', state: 'now' },
      { name: 'Frost Lake', need: '40K coins', state: 'locked' },
      { name: 'Ember Peak', need: '300K coins', state: 'locked' },
      { name: 'Star Island', need: '2M coins', state: 'locked' },
    ] },

    first60: [
      { t: '0-10s', text: 'An arrow points you at the first crystal.' },
      { t: '10-25s', text: 'Every swing drops one in the bag. It fills fast.' },
      { t: '25-45s', text: 'Bag full. A trail lights up to the sell pad.' },
      { t: '45-60s', text: 'Coins rain down. First tool upgrade bought.' },
    ],
    loop: ['Collect until the bag is full', 'Sell the bag for coins', 'Better tool, bigger bag', 'Open the next, richer area'],
    mechanic: 'What you collect and how you get it: dig, fish, vacuum, harvest or catch.',
    reskins: ['Fishing pier', 'Bug catcher', 'Candy harvest'],
    earns: ['Coin packs, starter pack at area 2', '2x coins and bigger-bag passes', 'Auto-sell: sell from anywhere'],
    keeps: ['Daily streak, day-7 tool skin', 'Quests: sell, fill, explore', 'A new area every update'],
    stats: { shared: '85%', days: '2', risk: 'Low' },
  };
})();
