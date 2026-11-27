// Template 3: Empire Tycoon. A donut factory on a blue brick plot under a golden morning sky:
// machines with levels feed a conveyor, cash piles up at the collector, and one glowing pad is ready to buy.
// Same data shape as every other template file. Scene helpers live inside this wrapper so they cannot clash with other files.
(function () {
  const k = K, INK = K.INK;
  const r1 = (v) => Math.round(v * 10) / 10;
  // Gradient helpers: each returns [fill value, <defs> string].
  const stopsOf = (stops) => stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a === undefined ? '' : ` stop-opacity="${a}"`}/>`).join('');
  const lin = (stops, x2 = 0, y2 = 1) => { const id = k.id(); return [`url(#${id})`, `<defs><linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stopsOf(stops)}</linearGradient></defs>`]; };
  const radial = (stops, cy = 0.5, r = 0.5) => { const id = k.id(); return [`url(#${id})`, `<defs><radialGradient id="${id}" cx="0.5" cy="${cy}" r="${r}">${stopsOf(stops)}</radialGradient></defs>`]; };
  const blur = (dev) => { const id = k.id(); return [`url(#${id})`, `<defs><filter id="${id}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${dev}"/></filter></defs>`]; };

  const CYAN = '#1fcfd6', ROSE = '#ff4f8b', GRAPE = '#a45cff', CASH = '#43d977', GOLD = '#ffc233', PAD = '#3ddc6a';

  /* ---------- the plot: a brick floor in perspective ---------- */
  // Lines that run away from the camera meet at (480, VY). xf is an x position measured on the plot's far edge (y = YF).
  const VY = -130, YF = 262, ROWS = [262, 291.5, 325.8, 366.2, 414.4, 473.1, 545.9];
  const rho = (y) => (y - VY) / (YF - VY);
  const px = (xf, y) => r1(480 + (xf - 480) * rho(y));
  const quad = (xa, xb, ya, yb) => `M${px(xa, ya)} ${ya}L${px(xb, ya)} ${ya}L${px(xb, yb)} ${yb}L${px(xa, yb)} ${yb}z`;
  const plot = () => {
    const [g, gD] = lin([[0, '#a3b6ff'], [0.3, '#7389f5'], [1, '#3243bd']]);
    let s = gD + `<path d="${quad(128, 832, 262, 546)}" fill="${g}"/>`;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 11; j++) {
      const xa = 128 + j * 64, ya = ROWS[i], yb = ROWS[i + 1], ym = (ya + yb) / 2, cx = px(xa + 32, ym), w = 64 * rho(ym);
      if ((i + j) % 2 === 0) s += `<path d="${quad(xa, xa + 64, ya, yb)}" fill="#fff" opacity=".1"/>`;
      s += `<ellipse cx="${cx}" cy="${r1(ym + w * 0.035)}" rx="${r1(w * 0.26)}" ry="${r1(w * 0.095)}" fill="#0d1560" opacity=".25"/><ellipse cx="${cx}" cy="${r1(ym)}" rx="${r1(w * 0.26)}" ry="${r1(w * 0.095)}" fill="#fff" opacity="${r1(0.12 + i * 0.02)}"/>`;
    }
    let grid = '';
    for (let j = 1; j < 11; j++) grid += `M${px(128 + j * 64, 262)} 262L${px(128 + j * 64, 546)} 546`;
    for (let i = 1; i < 6; i++) grid += `M${px(128, ROWS[i])} ${ROWS[i]}L${px(832, ROWS[i])} ${ROWS[i]}`;
    s += `<path d="${grid}" fill="none" stroke="#1c2b98" stroke-width="2" opacity=".42"/>`;
    // painted kerb around the plot
    s += `<path d="${quad(128, 832, 262, 546)}" fill="none" stroke="${INK}" stroke-width="9" stroke-linejoin="round"/><path d="${quad(128, 832, 262, 546)}" fill="none" stroke="#fff3c4" stroke-width="4.5" stroke-linejoin="round"/>`;
    return s;
  };
  // An empty square of plot, still to be bought: dashed outline on the floor.
  const slot = (xa, xb, ya, yb) => `<path d="${quad(xa, xb, ya, yb)}" fill="#fff" opacity=".14"/><path d="${quad(xa, xb, ya, yb)}" fill="none" stroke="${INK}" stroke-width="7.5" stroke-dasharray="14 11" stroke-linejoin="round" opacity=".45"/><path d="${quad(xa, xb, ya, yb)}" fill="none" stroke="#fff" stroke-width="3.5" stroke-dasharray="14 11" stroke-linejoin="round" opacity=".92"/>`;

  /* ---------- backdrop pieces ---------- */
  const cloud = (x, y, s, op = 1) => `<g transform="translate(${x} ${y}) scale(${s})" opacity="${op}"><rect x="0" y="19" width="130" height="30" rx="15" fill="#ffc79c"/><rect x="0" y="14" width="130" height="30" rx="15" fill="#fffaf0"/><rect x="26" y="0" width="64" height="36" rx="18" fill="#fffaf0"/><rect x="72" y="8" width="42" height="26" rx="13" fill="#fffaf0"/></g>`;
  // Row of city blocks; `win` adds lit windows.
  const city = (seed, base, color, win, hMin, hMax, W = 960, wMin = 34, wMax = 72) => {
    const r = k.rnd(seed); let x = -12, out = '';
    while (x < W + 12) {
      const bw = wMin + r() * (wMax - wMin), bh = hMin + r() * (hMax - hMin);
      out += `<rect x="${r1(x)}" y="${r1(base - bh)}" width="${r1(bw)}" height="${r1(bh + 4)}" fill="${color}"/>`;
      if (r() < 0.4) out += `<rect x="${r1(x + bw * 0.3)}" y="${r1(base - bh - 9)}" width="${r1(bw * 0.4)}" height="11" fill="${color}"/>`;
      if (win) for (let wy = base - bh + 8; wy < base - 9; wy += 11) for (let wx = x + 6; wx < x + bw - 9; wx += 10) if (r() < 0.55) out += `<rect x="${r1(wx)}" y="${r1(wy)}" width="5" height="6" rx="1" fill="${win}" opacity=".75"/>`;
      x += bw + 3 + r() * 14;
    }
    return out;
  };
  const puff = (x, y, r, op) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fffaf0" opacity="${op}"/>`;

  /* ---------- goods and money ---------- */
  // Donut lying on the belt. kind: 'raw' (pale dough), 'baked' (golden), 'iced' (pink).
  const donut = (x, y, s, kind = 'baked') => {
    const body = kind === 'raw' ? '#fff0d4' : '#eaa650', top = kind === 'iced' ? '#ff7ac0' : body;
    return `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="4" rx="12" ry="6.5" fill="${k.mix(body, -0.3)}" stroke="${INK}" stroke-width="2.6"/><ellipse cx="0" cy="0" rx="12" ry="6.5" fill="${top}" stroke="${INK}" stroke-width="2.6"/><ellipse cx="0" cy="0.3" rx="4" ry="2" fill="${k.mix(body, -0.5)}" stroke="${INK}" stroke-width="1.8"/><path d="M-8 -2.5q4 -3 9 -2.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".75"/></g>`;
  };
  // Donut seen from the front, with icing and sprinkles. The hole is a real hole.
  const bigDonut = (x, y, r, o = {}) => {
    const sw = o.sw || Math.max(2.4, r * 0.1), ri = r1(r * 0.3), ii = r1(r * 0.41), n = 44;
    let ic = '';
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2, rr = r * (0.83 + 0.07 * Math.sin(a * 7 + 0.6)); ic += (i ? 'L' : 'M') + r1(rr * Math.cos(a)) + ' ' + r1(rr * Math.sin(a)); }
    ic += `zM${-ii} 0a${ii} ${ii} 0 1 1 ${2 * ii} 0a${ii} ${ii} 0 1 1 ${-2 * ii} 0z`;
    const cols = ['#fff', '#ffe066', '#7de8ff', '#c9a0ff', '#fff', '#8dff9a'];
    let sp = '';
    for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2 + 0.3, rr = r * (0.56 + (i % 2) * 0.12), cx = r1(rr * Math.cos(a)), cy = r1(rr * Math.sin(a)); sp += `<rect x="${r1(cx - r * 0.1)}" y="${r1(cy - r * 0.04)}" width="${r1(r * 0.2)}" height="${r1(r * 0.08)}" rx="${r1(r * 0.04)}" fill="${cols[i % 6]}" transform="rotate(${i * 47} ${cx} ${cy})"/>`; }
    return `<g transform="translate(${x} ${y})${o.rot ? ` rotate(${o.rot})` : ''}"><path d="M${-r} 0a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0zM${-ri} 0a${ri} ${ri} 0 1 1 ${2 * ri} 0a${ri} ${ri} 0 1 1 ${-2 * ri} 0z" fill-rule="evenodd" fill="#e9a04a" stroke="${INK}" stroke-width="${sw}" stroke-linejoin="round"/><path d="${ic}" fill-rule="evenodd" fill="${o.icing || '#ff7ac0'}" stroke="${INK}" stroke-width="${r1(sw * 0.6)}" stroke-linejoin="round"/>${sp}<path d="M${r1(-r * 0.64)} ${r1(-r * 0.28)}A${r1(r * 0.7)} ${r1(r * 0.7)} 0 0 1 ${r1(-r * 0.12)} ${r1(-r * 0.69)}" fill="none" stroke="#fff" stroke-width="${r1(r * 0.09)}" stroke-linecap="round" opacity=".75"/></g>`;
  };
  // A banded bundle of banknotes. (x, y) is the top-left of its front face.
  const bundle = (x, y, w = 34, h = 12) => k.box(x, y, w, h, CASH, { d: 9, r: 2, sw: 2.6, shadow: false }) + `<rect x="${x + w / 2 - 4.5}" y="${y}" width="9" height="${h}" fill="#fff3c4" stroke="${INK}" stroke-width="2"/><path d="M${x + w / 2 - 4.5} ${y}l9 -5h9l-9 5z" fill="#fffbe8" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`;
  // A single banknote in the air.
  const bill = (x, y, rot = 0, s = 1) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})"><rect x="-11" y="-6.5" width="22" height="13" rx="2.5" fill="${CASH}" stroke="${INK}" stroke-width="2.4"/><circle r="3.4" fill="#1c9a4c"/><rect x="-8" y="-4.2" width="16" height="2.4" rx="1.2" fill="#fff" opacity=".55"/></g>`;
  // Level badge that floats above a machine. `up` adds a green "can upgrade" arrow.
  const lv = (x, y, n, up) => `<path d="M${x - 7} ${y + 9}h14l-7 10z" fill="${GOLD}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/><rect x="${x - 29}" y="${y - 13}" width="58" height="25" rx="12.5" fill="${GOLD}" stroke="${INK}" stroke-width="3"/><rect x="${x - 21}" y="${y - 9.5}" width="42" height="5" rx="2.5" fill="#fff" opacity=".55"/>` + k.text(x, y + 6, 'LV ' + n, 16, { sw: 3.5 })
    + (up ? `<circle cx="${x + 39}" cy="${y}" r="10.5" fill="#2fe06a" stroke="${INK}" stroke-width="3"/><path d="M${x + 39} ${y - 6}l6 6.5h-3.6v5h-4.8v-5h-3.6z" fill="#fff"/>` : '');

  /* ---------- machines. (x, y) is the bottom centre of the front face ---------- */
  // Dough mixer: hopper on top, window with a swirl, a nozzle that drops dough rings on the belt.
  const mixer = (x, y, s = 1, c = CYAN) => {
    let g = k.box(-43, -62, 86, 62, c, { d: 14, sw: 3.5 });
    g += `<path d="M-42 -114H56L37 -67H-23z" fill="#fff4dc" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/><path d="M-33 -108h17l6 35h-9z" fill="#fff" opacity=".65"/><path d="M45 -108l-13 35" stroke="#e3c08e" stroke-width="6" stroke-linecap="round" opacity=".7"/>`;
    g += `<path d="M-37 -114q3 -17 20 -15q9 -12 24 -5q14 -9 24 3q15 0 17 17z" fill="#ffe2b0" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/><path d="M-23 -124q8 -6 16 -2" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".75"/>`;
    g += `<rect x="-47" y="-120" width="108" height="10" rx="5" fill="${k.mix(c, 0.35)}" stroke="${INK}" stroke-width="3"/>`;
    g += `<circle cx="-13" cy="-33" r="18" fill="${k.mix(c, -0.5)}" stroke="${INK}" stroke-width="3.5"/><circle cx="-13" cy="-33" r="12.5" fill="#fff0d4"/><path d="M-21 -33a8 8 0 0 1 8 -8a6 6 0 0 1 6 6a4 4 0 0 1 -4 4" fill="none" stroke="#e2a45a" stroke-width="3" stroke-linecap="round"/><path d="M-25 -42a15 15 0 0 1 13 -7" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".8"/>`;
    g += `<circle cx="25" cy="-44" r="5" fill="#8dff9a" stroke="${INK}" stroke-width="2.5"/><circle cx="25" cy="-28" r="5" fill="#ffd166" stroke="${INK}" stroke-width="2.5"/>`;
    g += `<path d="M-26 -13h26l-5 13h-16z" fill="#aab3d8" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
    return `<g transform="translate(${x} ${y}) scale(${s})">${g}</g>`;
  };
  // Oven: the belt runs through it. Glowing window, knobs, chimney.
  const oven = (x, y, s = 1, c = ROSE) => {
    const [hot, hotD] = radial([[0, '#fff6b8'], [0.55, '#ffb347'], [1, '#d9480f']]);
    let g = hotD + k.box(-48, -100, 96, 100, c, { d: 14, sw: 3.5 });
    g += k.box(20, -134, 20, 30, '#6a72a8', { d: 8, sw: 3, shadow: false });
    g += `<rect x="-40" y="-91" width="80" height="18" rx="6" fill="${k.mix(c, -0.34)}" stroke="${INK}" stroke-width="3"/>` + [-28, -12, 4].map(cx => `<circle cx="${cx}" cy="-82" r="4.6" fill="#fff1d2" stroke="${INK}" stroke-width="2.2"/><path d="M${cx} -82v-3.4" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`).join('') + `<circle cx="27" cy="-82" r="4.6" fill="#8dff9a" stroke="${INK}" stroke-width="2.2"/>`;
    g += `<rect x="-38" y="-66" width="76" height="45" rx="10" fill="${hot}" stroke="${INK}" stroke-width="3.5"/>` + donut(-17, -41, 1, 'baked') + donut(16, -41, 1, 'baked') + `<path d="M-31 -60h14l-16 22z" fill="#fff" opacity=".4"/>`;
    g += `<rect x="-30" y="-15" width="60" height="7" rx="3.5" fill="#fff1d2" stroke="${INK}" stroke-width="2.5"/>`;
    g += `<path d="M48 -39l14 -7.7v27l-14 7.7z" fill="#5a1630" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>`;
    return `<g transform="translate(${x} ${y}) scale(${s})">${g}</g>`;
  };
  // The machine that is not bought yet, shown as a see-through outline above its buy pad.
  const ghost = (x, y, s = 1) => {
    const lines = `<path d="M-44 0v-60l14 -7.7h88v60l-14 7.7z"/><path d="M-44 -60h88v60M44 -60l14 -7.7"/><path d="M-20 -66v-34a10 10 0 0 1 10 -10h34a10 10 0 0 1 10 10v34"/>`;
    let g = `<path d="M-44 -60l14 -7.7h88l-14 7.7z" fill="#fff" opacity=".55"/><path d="M44 -60l14 -7.7v60l-14 7.7z" fill="#3ddc6a" opacity=".45"/><rect x="-44" y="-60" width="88" height="60" rx="5" fill="#8dffb0" opacity=".5"/>`;
    g += `<path d="M-20 -66v-34a10 10 0 0 1 10 -10h34a10 10 0 0 1 10 10v34z" fill="#6ff0a0" opacity=".55"/><path d="M-13 -102v28" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".7"/>`;
    g += `<g opacity=".8">${bigDonut(7, -88, 13, { sw: 2.4 })}</g>`;
    for (let yy = -54; yy < -4; yy += 8) g += `<path d="M-40 ${yy}h80" stroke="#fff" stroke-width="1.5" opacity=".35"/>`;
    g += `<g fill="none" stroke="${INK}" stroke-width="6.5" stroke-dasharray="9 7" stroke-linejoin="round" stroke-linecap="round" opacity=".5">${lines}</g><g fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="9 7" stroke-linejoin="round" stroke-linecap="round">${lines}</g>`;
    return `<g transform="translate(${x} ${y}) scale(${s})">${g}</g>`;
  };
  // Collector at the end of the belt: goods go in the side, cash comes out the front.
  const collector = (x, y, s = 1, c = GRAPE) => {
    let g = `<path d="M-63 -54L-43 -63V-7L-63 -12z" fill="${k.mix(c, -0.45)}" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>`;
    g += k.box(-43, -96, 86, 96, c, { d: 14, sw: 3.5 });
    g += `<rect x="-33" y="-86" width="66" height="36" rx="9" fill="#0f3a2d" stroke="${INK}" stroke-width="3.5"/><path d="M-26 -80h20l-12 12z" fill="#fff" opacity=".18"/>` + k.text(0, -58, '$', 27, { fill: '#8dffa0', sw: 0 });
    g += `<path d="M-20 -62h8M12 -62h8M-20 -72h5M15 -72h5" stroke="#8dffa0" stroke-width="3" stroke-linecap="round" opacity=".7"/>`;
    g += `<rect x="-34" y="-40" width="68" height="27" rx="7" fill="${k.mix(c, -0.5)}" stroke="${INK}" stroke-width="3"/>` + bill(-13, -24, -9, 0.95) + bill(11, -27, 8, 0.95);
    g += `<rect x="-2" y="-112" width="20" height="10" rx="3" fill="${k.mix(c, 0.3)}" stroke="${INK}" stroke-width="3"/>` + k.coin(8, -124, 14);
    return `<g transform="translate(${x} ${y}) scale(${s})">${g}</g>`;
  };
  // Conveyor belt from x1 to x2. yb / yf: back and front edge of the moving top; yh: bottom of the frame.
  const belt = (x1, x2, yb = 296, yf = 316, yh = 330) => {
    let s = `<rect x="${x1 - 2}" y="${yh - 3}" width="${x2 - x1 + 10}" height="11" rx="5.5" fill="#000" opacity=".28"/>`;
    for (let x = x1 + 30; x < x2 - 10; x += 92) s += `<rect x="${x}" y="${yh - 2}" width="9" height="8" rx="2" fill="#5a6196" stroke="${INK}" stroke-width="2.5"/>`;
    s += `<path d="M${x1} ${yf}L${x1 + 9} ${yb}H${x2}V${yf}z" fill="#353a63" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/>`;
    for (let x = x1 + 24; x < x2 - 12; x += 25) s += `<path d="M${x} ${yb + 4.5}l6 ${(yf - yb) / 2 - 4.5}l-6 ${(yf - yb) / 2 - 4.5}" fill="none" stroke="#636ba6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    s += `<rect x="${x1}" y="${yf}" width="${x2 - x1}" height="${yh - yf}" rx="4" fill="#dfe5fb" stroke="${INK}" stroke-width="3.5"/><rect x="${x1 + 5}" y="${yf + 2.6}" width="${x2 - x1 - 10}" height="3" rx="1.5" fill="#fff" opacity=".8"/>`;
    for (let x = x1 + 13; x < x2 - 6; x += 23) s += `<circle cx="${x}" cy="${(yf + yh) / 2 + 1.5}" r="3" fill="#7d86b5"/>`;
    return s;
  };
  // Pink box of donuts, for the foreground. (x, y) is the top-left of the front face.
  const crate = (x, y, w, h, c, d = 18) => k.box(x, y, w, h, c, { d, sw: 4 }) + `<rect x="${x + w * 0.42}" y="${y}" width="${w * 0.16}" height="${h}" fill="#fff7e0" stroke="${INK}" stroke-width="3"/><path d="M${x + w * 0.42} ${y}l${d} ${-d * 0.55}h${w * 0.16}l${-d} ${d * 0.55}z" fill="#fffdf2" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
  const cone = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="2" rx="24" ry="6" fill="#000" opacity=".25"/><rect x="-20" y="-7" width="40" height="9" rx="3" fill="#ff7a3c" stroke="${INK}" stroke-width="3.5"/><path d="M-12 -7L-4 -46h8L12 -7z" fill="#ff7a3c" stroke="${INK}" stroke-width="3.5" stroke-linejoin="round"/><path d="M-9 -21h18l-2.5 -11h-13z" fill="#fff7e0" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/></g>`;

  // Chevron painted on the floor, pointing right.
  const chev = (x, y, op = 1) => `<g transform="translate(${x} ${y}) scale(1 .7)" opacity="${op}"><path d="M-6 -11L6 0L-6 11" fill="none" stroke="${INK}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/><path d="M-6 -11L6 0L-6 11" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/></g>`;

  /* ---------- the main game view, 960 x 540 ---------- */
  const scene = () => {
    const H = 228, PX = 606, PY = 386;   // horizon; centre of the buy pad
    let s = '';

    // --- far: golden morning sky, city, a rival's finished empire ---
    const [sky, skyD] = lin([[0, '#ff8450'], [0.42, '#ffae52'], [0.78, '#ffd880'], [1, '#fff4c6']]);
    s += skyD + `<rect width="960" height="${H + 6}" fill="${sky}"/>`;
    s += k.glow(470, H + 4, 430, '#fff8d8', 0.85) + k.rays(470, H + 4, 680, '#fff', { n: 22, op: 0.08, spin: 0.1 });
    s += cloud(254, 124, 0.46, 0.9) + cloud(650, 112, 0.5, 0.85) + cloud(104, 192, 0.36, 0.7);
    s += city('far', H + 2, '#ffbe74', null, 46, 118) + city('near', H + 2, '#f58c60', '#fff3b8', 24, 84);
    // the rival next door, already three floors up
    s += k.box(842, 196, 84, 42, '#e268b6', { d: 12, sw: 3, shadow: false, studs: 3 }) + k.box(854, 160, 56, 36, '#f08fca', { d: 10, sw: 3, shadow: false, studs: 2 }) + k.box(866, 132, 30, 28, '#ffb3dc', { d: 8, sw: 3, shadow: false });
    s += [852, 872, 892].map(x => `<rect x="${x}" y="212" width="12" height="14" rx="2" fill="#fff3b8" stroke="${INK}" stroke-width="2"/>`).join('') + [864, 884].map(x => `<rect x="${x}" y="172" width="11" height="12" rx="2" fill="#fff3b8" stroke="${INK}" stroke-width="2"/>`).join('');
    s += k.flag(884, 128, '#ffd166', 20) + k.avatar(922, 190, 0.3, { shirt: '#3aa0ff', pose: 'cheer', hair: '#2b1b12' });
    const [haze, hazeD] = lin([[0, '#ffe9b0', 0], [1, '#ffe9b0', 0.55]]);
    s += hazeD + `<rect x="0" y="${H - 64}" width="960" height="66" fill="${haze}"/>`;

    // --- ground outside the plot: a sandy street ---
    s += k.floor(H, '#ffd899', '#bf6a3c', { rows: 7 });
    s += `<rect x="0" y="239" width="960" height="12" fill="#c98152" opacity=".75"/><path d="M0 245h960" stroke="#fff3c4" stroke-width="2" stroke-dasharray="14 12" opacity=".8"/>`;
    s += k.tree(852, 262, 0.3, { leaf: '#34d399' }) + k.tree(940, 268, 0.34, { leaf: '#34d399' });

    // --- the plot ---
    s += plot();
    s += k.glow(520, 372, 330, '#cfdcff', 0.4);
    // empty squares still to buy
    s += slot(228, 340, 366.2, 414.4) + k.lock(190, 391, 0.85) + k.text(234, 399, '$6K', 18, { fill: '#eef2ff' });
    s += slot(604, 704, 420, 470) + k.lock(716, 445, 0.9) + k.text(764, 453, '$15K', 19, { fill: '#eef2ff' });

    // --- the shop sign at the back of the plot ---
    s += `<rect x="495" y="184" width="10" height="80" rx="3" fill="#6a72a8" stroke="${INK}" stroke-width="3"/>` + k.glow(500, 156, 72, '#fff8d8', 0.8) + bigDonut(500, 156, 33);

    // --- the production line: mixer, oven, the empty slot, collector ---
    s += mixer(182, 298, 0.92) + lv(188, 152, 3, true);
    s += k.glow(PX, 246, 104, '#5df07a', 0.55) + ghost(PX, 298);
    s += belt(126, 712);
    // dough drops from the mixer, rides the belt, comes out of the oven golden
    s += `<path d="M170 280v8" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".8"/>` + donut(170, 297, 0.95, 'raw') + donut(212, 305, 1, 'raw') + donut(240, 305, 1, 'raw');
    s += [384, 492, 526, 574, 624, 672].map(x => donut(x, 305, 1, 'baked')).join('');
    s += oven(302, 332) + collector(752, 332);
    s += k.glow(372, 304, 30, '#ffb347', 0.6) + k.glow(302, 352, 60, '#ffb347', 0.35);
    s += puff(342, 188, 9, 0.85) + puff(351, 170, 12, 0.6) + puff(344, 148, 10, 0.4) + lv(276, 207, 2);
    s += k.text(PX, 174, 'ICING MACHINE', 15, { fill: '#eaffea' }) + k.text(PX, 278, '+$80/s', 18, { fill: '#eaffee' });
    // cash coming out of the collector
    s += k.text(752, 186, '+$120/s', 21, { fill: '#8dffa0' });
    s += k.pop(708, 154, '+$12', 19, '#fff3a8', -8) + k.pop(812, 150, '+$12', 14, '#ffffff', 8);
    s += k.coin(822, 236, 8) + k.coin(832, 286, 9) + bill(826, 262, 24, 0.9);
    // the cash pile
    s += k.glow(778, 368, 96, '#fff3a8', 0.55) + k.shadow(780, 402, 76, 9, 0.3);
    s += bundle(712, 384, 40, 14) + bundle(754, 384, 40, 14) + bundle(796, 384, 40, 14) + bundle(733, 368, 40, 14) + bundle(775, 368, 40, 14) + bundle(754, 352, 40, 14);
    s += k.coin(704, 399, 8) + k.coin(853, 399, 8) + k.coin(722, 372, 7);
    // a friend drops by to look at the pile
    s += k.avatar(886, 398, 0.9, { shirt: '#ff5fae', pants: '#2b2f55', skin: '#c98d5e', hair: '#2b1b12', pose: 'point', face: 'wow', flip: true });

    // --- the buy pad: the one thing to do ---
    const [beam, beamD] = lin([[0, '#b8ffc9', 0], [0.45, '#b8ffc9', 0.12], [1, '#b8ffc9', 0.5]]), [soft, softD] = blur(7);
    s += k.glow(PX, PY + 2, 156, '#6dff8f', 0.75);
    s += beamD + softD + `<path d="M${PX - 62} ${PY}L${PX - 40} 300h80l22 ${PY - 300}z" fill="${beam}" filter="${soft}"/>`;
    s += k.ring(PX, PY + 3, 102, 27, '#fff', 4, 0.6) + k.ring(PX, PY + 3, 126, 33, '#fff', 3, 0.32);
    s += k.pad(PX, PY, 78, PAD, { h: 9, ry: 20 });
    s += `<ellipse cx="${PX}" cy="${PY - 1}" rx="52" ry="13" fill="#fff" opacity=".5"/>` + k.ring(PX, PY - 1, 63, 15.5, '#fff', 3.5, 0.9);
    s += `<g transform="translate(${PX} ${PY - 1}) scale(1 .27)"><path d="M-9 -30h18v21h21v18h-21v21h-18v-21h-21v-18h21z" fill="#fff" stroke="#128a3c" stroke-width="5" stroke-linejoin="round"/></g>`;
    // floating price tag
    s += `<path d="M${PX - 11} 351h22l-11 13z" fill="#22c55e" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>` + k.card(PX - 66, 316, 132, 38, '#22c55e', { r: 13 }) + bill(PX - 45, 336, -8, 1) + k.text(PX + 14, 344.5, '$2,500', 24);

    // --- the player runs for the pad, pet in tow ---
    s += k.pet(330, 388, 0.95, '#ff9a4a', { glow: true });
    s += `<path d="M366 368h16M352 386h24M364 404h16" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".75"/>`;
    s += `<g transform="rotate(7 424 410)">${k.avatar(424, 410, 1.5, { shirt: '#ffd23f', pants: '#2b2f55', hair: '#5b3a1e', hat: 'cap', hatColor: '#ff4f5e', pose: 'run', face: 'smile' })}</g>`;
    s += chev(484, 403, 0.7) + chev(501, 402, 0.85) + chev(518, 401, 1);
    s += k.sparkles([[538, 246, 0.8], [672, 230, 0.7], [530, 372, 0.7], [690, 362, 0.9], [742, 342, 0.7], [836, 366, 0.8], [150, 196, 0.6], [452, 122, 0.7], [548, 130, 0.5], [800, 338, 0.5]], '#fff');

    // --- near: boxes of donuts close to the camera ---
    s += crate(128, 494, 98, 52, '#ff7ac0', 20) + bigDonut(149, 521, 11, { sw: 2.4 }) + crate(142, 450, 72, 40, '#ffd166', 16) + cone(272, 528, 1.25);
    s += bigDonut(692, 498, 19, { rot: -8 }) + bigDonut(724, 494, 19, { icing: '#fff3c4', rot: 10 }) + bigDonut(756, 498, 19, { rot: 4 }) + k.box(664, 506, 110, 42, '#d98a4a', { d: 18, sw: 4 });

    // --- soft dark corners pull the eye to the pad ---
    const [vig, vigD] = radial([[0.56, '#2a0f4f', 0], [1, '#2a0f4f', 0.5]], 0.56, 0.78);
    s += vigD + `<rect width="960" height="540" fill="${vig}"/>`;
    return s;
  };

  /* ---------- the moment players work toward, 480 x 270 ---------- */
  const moment = () => {
    const [bg, bgD] = lin([[0, '#ff7c4c'], [0.5, '#ffb452'], [1, '#fff0b8']]);
    let s = bgD + `<rect width="480" height="270" fill="${bg}"/>`;
    s += k.rays(258, 112, 460, '#fff', { n: 18, op: 0.16 }) + k.glow(258, 106, 240, '#fff6c8', 0.95);
    s += city('m1', 186, '#ffbc72', null, 26, 70, 480, 22, 46);
    s += k.floor(184, '#a3b6ff', '#3243bd', { w: 480, h: 270, rows: 4 });
    s += k.glow(256, 214, 200, '#dfe8ff', 0.5);
    // the finished factory: three floors, every pad filled
    s += k.box(138, 156, 228, 56, ROSE, { d: 16, sw: 3.5, studs: 6 });
    s += [152, 186, 292, 326].map(x => `<rect x="${x}" y="168" width="26" height="22" rx="4" fill="#fff3b8" stroke="${INK}" stroke-width="2.5"/><path d="M${x + 4} 172h8l-9 10z" fill="#fff" opacity=".7"/>`).join('');
    s += `<path d="M230 212v-24a22 22 0 0 1 44 0v24z" fill="#5a1630" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` + k.glow(252, 204, 26, '#ffb347', 0.8);
    s += k.box(172, 120, 160, 36, CYAN, { d: 14, sw: 3.5, studs: 4, shadow: false });
    s += [184, 214, 244, 274, 304].map(x => `<rect x="${x}" y="130" width="18" height="16" rx="3" fill="#fff3b8" stroke="${INK}" stroke-width="2.5"/>`).join('');
    s += k.box(208, 92, 88, 28, GRAPE, { d: 12, sw: 3.5, studs: 2, shadow: false });
    s += `<rect x="222" y="100" width="60" height="12" rx="6" fill="#fff3b8" stroke="${INK}" stroke-width="2.5"/>`;
    s += k.box(146, 124, 16, 26, '#6a72a8', { d: 7, sw: 3, shadow: false }) + puff(158, 112, 8, 0.85) + puff(164, 96, 10, 0.55) + puff(158, 78, 8, 0.35);
    s += k.box(344, 126, 16, 26, '#6a72a8', { d: 7, sw: 3, shadow: false }) + puff(356, 114, 8, 0.85) + puff(364, 98, 10, 0.55) + puff(358, 80, 8, 0.35);
    s += k.glow(259, 68, 56, '#fff8d8', 0.95) + bigDonut(259, 69, 21);
    // a belt carries finished donuts out of the door to the cash heap
    s += belt(272, 392, 212, 221, 229) + [294, 324, 354].map(x => donut(x, 215, 0.8, 'iced')).join('');
    s += k.glow(426, 216, 72, '#fff3a8', 0.65) + k.shadow(428, 244, 46, 6, 0.3) + bundle(392, 231, 30, 11) + bundle(424, 231, 30, 11) + bundle(408, 220, 30, 11) + k.coin(386, 245, 7) + k.coin(468, 244, 7) + k.coin(452, 222, 6);
    s += k.text(430, 190, '+$25K/s', 19, { fill: '#8dffa0', rotate: -5 });
    // cash in the air
    s += [[40, 76, -20], [118, 104, 16], [24, 132, 30], [142, 62, -32], [436, 80, 22], [398, 126, -18], [456, 142, -28], [350, 58, 30]].map(([x, y, r]) => `<path d="M${x} ${y - 20}v10" stroke="#fff" stroke-width="2.5" stroke-linecap="round" opacity=".7"/>` + bill(x, y, r, 0.95)).join('');
    s += k.coin(64, 116, 6) + k.coin(414, 156, 6) + k.coin(462, 104, 6) + k.coin(186, 84, 6) + k.coin(322, 98, 6) + k.coin(92, 62, 6);
    // the owner and pet out front
    s += k.pet(34, 218, 0.85, '#ff9a4a', { glow: true });
    s += k.avatar(92, 248, 0.95, { shirt: '#ffd23f', pants: '#2b2f55', hair: '#5b3a1e', hat: 'crown', pose: 'cheer', face: 'cool' });
    s += `<path d="M146 240h214l-13 13 13 13h-214l13 -13z" fill="#ff6fb5" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/><path d="M166 245h174" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".45"/>`;
    s += k.text(253, 260, 'IT RUNS ITSELF', 19);
    s += k.text(240, 40, 'FULLY BUILT!', 35, { fill: '#fff6c2' });
    s += k.sparkles([[40, 40, 1.1], [444, 38, 1.1], [136, 132, 0.7], [392, 66, 0.7], [16, 176, 0.7], [470, 200, 0.6], [404, 210, 0.6], [300, 60, 0.5], [218, 62, 0.5]], '#fff');
    return s;
  };

  (window.TEMPLATES = window.TEMPLATES || {})[3] = {
    n: 3,
    name: 'Empire Tycoon',
    genre: 'Simulation · tycoon',
    colors: ['#ffb938', '#ff6fb5'],
    hook: 'Step on glowing pads to build machines that earn cash every second, upgrade them, fill your plot, then rebirth.',

    // One story: $2,650 in hand, the glowing pad costs $2,500. The factory earns $120 a second, the Icing Machine adds $80, the goal is $200.
    hud: {
      pills: [{ icon: 'cash', color: '#5df07a', value: '$2,650' }, { icon: 'gem', color: '#ff7ac8', value: '25', plus: true }],
      goal: { label: 'GOAL', text: 'Earn $200 a second', pct: 60 },
      next: { label: 'NEXT PAD', value: '$2,500' },
      buttons: [{ icon: 'cart', label: 'Shop', color: '#3aa0ff' }, { icon: 'up', label: 'Upgrade', color: '#ff8a3c' }, { icon: 'loop', label: 'Rebirth', color: '#b56bff' }, { icon: 'gift', label: 'Daily', color: '#2fe06a', dot: true }],
      action: 'BUILD!',
    },

    scene,

    shop: {
      title: 'SHOP', currency: 'gem', currencyColor: '#ff7ac8', bg: '#1d2a7a',
      featured: { tag: 'STARTER', name: 'Starter Pack', line: 'Gold machine skin and $5,000 cash', price: '120',
        art: () => K.burst(40, 40, 38, '#fff6c2', { sw: 0, n: 14, inner: 0.8 })
          + `<g transform="translate(30 73) scale(.5)">${mixer(0, 0, 1, GOLD)}</g>`
          + bundle(40, 61, 26, 10) + bundle(44, 51, 26, 10)
          + K.sparkle(11, 22, 0.6) + K.sparkle(69, 26, 0.55) },
      items: [
        { icon: 'bolt', color: '#ff9a3c', name: '2x Cash', line: 'Double cash forever', price: '400' },
        { icon: 'wand', color: '#b56bff', name: 'Auto-Collect', line: 'Collects cash for you', price: '300' },
        { icon: 'clock', color: '#3aa0ff', name: 'Cash Boost', line: '2x cash for 15 minutes', price: '40' },
      ],
      caption: 'Starter pack, two passes, a timed boost. Nothing random. No offers before machine 3.',
    },

    moment: {
      title: 'THE FULL EMPIRE',
      caption: 'Every pad filled, cash pouring in. Then rebirth and rebuild with x2 cash.',
      svg: moment,
    },

    path: { label: 'Your empire, pad by pad', steps: [
      { name: 'Dough Mixer', need: 'Free', state: 'done' },
      { name: 'Oven', need: '$400', state: 'done' },
      { name: 'Icing Machine', need: '$2,500', state: 'now' },
      { name: 'Second Floor', need: '$40K', state: 'locked' },
      { name: 'Rebirth', need: '$1M', state: 'locked' },
    ] },

    first60: [
      { t: '0-10s', text: 'You land on your own empty plot. One pad glows.' },
      { t: '10-25s', text: 'Step on it. A free Dough Mixer starts earning.' },
      { t: '25-45s', text: 'Cash piles up at the collector. Grab it.' },
      { t: '45-60s', text: 'The Oven pad lights up: $400 to save for.' },
    ],
    loop: ['Step on a glowing buy pad', 'Machines earn cash every second', 'Level up machines, add more', 'Fill the plot, then rebirth'],
    mechanic: 'The business you run. Its machines, goods and prices are one list to fill in.',
    reskins: ['Barber shop', 'Zoo park', 'Theme park'],
    earns: ['2x cash boost for 15 minutes', 'Starter pack with a machine skin', '2x cash and auto-collect passes'],
    keeps: ['Cash waiting when you come back', 'Daily streak and build quests', 'A new machine tier every update'],
    stats: { shared: '75%', days: '2.5', risk: 'Medium' },
  };
})();
