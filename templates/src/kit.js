// Shared drawing kit for the template previews. Every helper returns an SVG string.
// Coordinates are in the scene's own viewBox (main scene 960x540, "moment" scene 480x270).
// Style: chunky toy-brick world, thick dark outlines, lighter top faces, soft glows. All art here is original.
(function () {
  const K = window.K = {};
  const INK = K.INK = '#1b1230';
  const FONT = K.FONT = "'Fredoka', ui-rounded, system-ui, sans-serif";
  let uid = 0;
  K.id = () => 'k' + (++uid);
  const n1 = (v) => Math.round(v * 10) / 10;

  // Lighten (amt > 0) or darken (amt < 0) a #rrggbb colour. amt is -1..1.
  K.mix = (hex, amt) => {
    const h = hex.replace('#', ''), f = (i) => parseInt(h.slice(i, i + 2), 16);
    const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
    return '#' + [f(0), f(2), f(4)].map(c => Math.round(c + (t - c) * p).toString(16).padStart(2, '0')).join('');
  };
  const rnd = (seed) => { let s = 1; for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) | 0; return () => { s = (s * 1664525 + 1013904223) | 0; return ((s >>> 0) % 100000) / 100000; }; };
  K.rnd = rnd;

  /* ---------- backdrop ---------- */
  K.sky = (top, bottom, w = 960, h = 540) => { const id = K.id(); return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#${id})"/>`; };
  K.stars = (seed, n = 40, w = 960, h = 300) => { const r = rnd(seed); return Array.from({ length: n }, () => `<circle cx="${n1(r() * w)}" cy="${n1(r() * h)}" r="${n1(0.8 + r() * 2)}" fill="#fff" opacity="${n1(0.35 + r() * 0.6)}"/>`).join(''); };
  K.glow = (x, y, r, color, op = 0.8) => { const id = K.id(); return `<defs><radialGradient id="${id}"><stop offset="0" stop-color="#fff" stop-opacity="${op}"/><stop offset=".3" stop-color="${color}" stop-opacity="${n1(op * 0.6)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs><circle cx="${x}" cy="${y}" r="${r}" fill="url(#${id})"/>`; };
  K.sun = (x, y, r, color = '#ffe08a') => K.glow(x, y, r * 2.6, color, 0.55) + `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/><circle cx="${x - r * 0.25}" cy="${y - r * 0.25}" r="${r * 0.55}" fill="#fff" opacity=".35"/>`;
  K.cloud = (x, y, s = 1, op = 0.95) => `<g transform="translate(${x} ${y}) scale(${s})" opacity="${op}"><rect x="0" y="18" width="130" height="32" rx="16" fill="#dfe9ff"/><rect x="0" y="14" width="130" height="32" rx="16" fill="#fff"/><rect x="26" y="0" width="64" height="36" rx="18" fill="#fff"/><rect x="72" y="8" width="42" height="26" rx="13" fill="#fff"/></g>`;
  // Rolling silhouette from baseline y down to the bottom edge. Use 2-3 layers for depth.
  K.hills = (y, color, seed = 1, amp = 36, w = 960, h = 540) => { const r = rnd(seed), a = r() * 6, b = 0.006 + r() * 0.006, c = 0.015 + r() * 0.01; let d = `M0 ${h}L0 ${y}`; for (let x = 0; x <= w; x += 24) d += `L${x} ${n1(y - amp * (0.55 * Math.sin(a + x * b) + 0.45 * Math.sin(a * 2 + x * c)) - amp * 0.4)}`; return `<path d="${d}L${w} ${h}z" fill="${color}"/>`; };
  // Blocky skyline / distant towers silhouette.
  K.skyline = (y, color, seed = 1, w = 960, h = 540) => { const r = rnd(seed); let x = -10, out = ''; while (x < w) { const bw = 40 + r() * 70, bh = 30 + r() * 120; out += `<rect x="${n1(x)}" y="${n1(y - bh)}" width="${n1(bw)}" height="${n1(bh + h - y)}" fill="${color}"/>`; x += bw + 6 + r() * 26; } return out; };
  // Toy-brick floor in perspective: studs get bigger toward the camera.
  K.floor = (horizonY, top, bottom, o = {}) => {
    const w = o.w || 960, h = o.h || 540, id = K.id(), rows = o.rows || 7, stud = o.studColor || '#ffffff';
    let s = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect x="0" y="${horizonY}" width="${w}" height="${h - horizonY}" fill="url(#${id})"/>`;
    if (o.studs !== false) for (let i = 0; i < rows; i++) {
      const t = (i + 0.5) / rows, y = horizonY + (h - horizonY) * Math.pow(t, 1.5), sc = 0.32 + 0.9 * t, gap = 78 * sc, off = (i % 2) * gap / 2;
      for (let x = -gap + off; x < w + gap; x += gap) s += `<ellipse cx="${n1(x)}" cy="${n1(y + 3 * sc)}" rx="${n1(21 * sc)}" ry="${n1(7.5 * sc)}" fill="#000" opacity=".16"/><ellipse cx="${n1(x)}" cy="${n1(y)}" rx="${n1(21 * sc)}" ry="${n1(7.5 * sc)}" fill="${stud}" opacity="${n1(0.1 + 0.14 * t)}"/>`;
    }
    return s + `<rect x="0" y="${horizonY}" width="${w}" height="3" fill="#fff" opacity=".35"/>`;
  };

  /* ---------- solid shapes ---------- */
  // 3D brick. (x, y) is the top-left of the FRONT face; the top and right faces extend up-right by depth d.
  K.box = (x, y, w, h, color, o = {}) => {
    const d = o.d === undefined ? 16 : o.d, r = o.r === undefined ? 5 : o.r, sw = o.sw || 4, e = d * 0.55;
    let s = '';
    if (o.shadow !== false) s += `<ellipse cx="${x + w / 2 + d / 2}" cy="${y + h + 4}" rx="${w / 2 + d}" ry="${Math.max(5, w * 0.08)}" fill="#000" opacity=".22"/>`;
    s += `<path d="M${x} ${y}l${d} ${-e}h${w}l${-d} ${e}z" fill="${K.mix(color, 0.38)}" stroke="${INK}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    s += `<path d="M${x + w} ${y}l${d} ${-e}v${h}l${-d} ${e}z" fill="${K.mix(color, -0.3)}" stroke="${INK}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${color}" stroke="${INK}" stroke-width="${sw}"/>`;
    s += `<rect x="${x + 6}" y="${y + 6}" width="${Math.max(0, w - 12)}" height="${Math.min(9, h / 3)}" rx="4" fill="#fff" opacity=".45"/>`;
    for (let i = 0; i < (o.studs || 0); i++) { const cx = x + d / 2 + (w / (o.studs)) * (i + 0.5), cy = y - e / 2; s += `<ellipse cx="${n1(cx)}" cy="${n1(cy)}" rx="${n1(Math.min(11, w / o.studs / 3))}" ry="${n1(Math.min(4, e / 3))}" fill="${K.mix(color, 0.6)}" stroke="${INK}" stroke-width="2"/>`; }
    if (o.label) s += K.text(x + w / 2, y + h / 2 + (o.size || 22) * 0.36, o.label, o.size || 22, { fill: o.fill });
    return s;
  };
  // Round pad / button on the ground. (cx, cy) is the centre of the top face.
  K.pad = (cx, cy, rx, color, o = {}) => { const ry = o.ry || rx * 0.26, h = o.h === undefined ? 14 : o.h; return `<ellipse cx="${cx}" cy="${cy + h + 5}" rx="${rx * 1.08}" ry="${ry * 1.1}" fill="#000" opacity=".22"/><path d="M${cx - rx} ${cy}v${h}a${rx} ${ry} 0 0 0 ${rx * 2} 0v${-h}z" fill="${K.mix(color, -0.3)}" stroke="${INK}" stroke-width="4"/><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${color}" stroke="${INK}" stroke-width="4"/><ellipse cx="${cx}" cy="${cy - ry * 0.12}" rx="${rx * 0.76}" ry="${ry * 0.68}" fill="${K.mix(color, 0.45)}" opacity=".75"/>`; };
  K.shadow = (cx, cy, rx, ry = rx * 0.28, op = 0.28) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#000" opacity="${op}"/>`;
  K.ring = (cx, cy, rx, ry, color, sw = 5, op = 0.8) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${color}" stroke-width="${sw}" opacity="${op}"/>`;
  K.rays = (x, y, r, color = '#fff', o = {}) => { const n = o.n || 12, op = o.op || 0.16, spin = o.spin || 0; let s = ''; for (let i = 0; i < n; i++) { const a = spin + i * Math.PI * 2 / n, w = Math.PI / n * 0.55; s += `<path d="M${x} ${y}L${n1(x + r * Math.cos(a - w))} ${n1(y + r * Math.sin(a - w))}L${n1(x + r * Math.cos(a + w))} ${n1(y + r * Math.sin(a + w))}z" fill="${color}" opacity="${op}"/>`; } return s; };
  K.burst = (x, y, r, color, o = {}) => { const n = o.n || 14, inner = o.inner || 0.72; let d = ''; for (let i = 0; i < n * 2; i++) { const a = i * Math.PI / n, rr = i % 2 ? r * inner : r; d += (i ? 'L' : 'M') + n1(x + rr * Math.cos(a)) + ' ' + n1(y + rr * Math.sin(a)); } return `<path d="${d}z" fill="${color}" stroke="${INK}" stroke-width="${o.sw === undefined ? 4 : o.sw}" stroke-linejoin="round"/>`; };
  K.sparkle = (x, y, s = 1, color = '#fff') => `<path transform="translate(${x} ${y}) scale(${s})" d="M0-12Q1.500-1.500 12 0Q1.500 1.500 0 12Q-1.500 1.500-12 0Q-1.500-1.500 0-12z" fill="${color}"/>`;
  K.sparkles = (points, color = '#fff') => points.map(([x, y, s]) => K.sparkle(x, y, s || 1, color)).join('');

  /* ---------- text ---------- */
  K.text = (x, y, str, size = 24, o = {}) => `<text x="${x}" y="${y}" text-anchor="${o.anchor || 'middle'}" font-family="${FONT}" font-weight="700" font-size="${size}" fill="${o.fill || '#fff'}" stroke="${o.stroke || INK}" stroke-width="${o.sw === undefined ? Math.max(4, size * 0.22) : o.sw}" stroke-linejoin="round" paint-order="stroke"${o.rotate ? ` transform="rotate(${o.rotate} ${x} ${y})"` : ''}${o.op ? ` opacity="${o.op}"` : ''}>${str}</text>`;
  // Floating reward number, e.g. "+1".
  K.pop = (x, y, str, size = 30, color = '#fff3a8', rotate = -6) => K.glow(x, y - size * 0.3, size * 1.5, color, 0.35) + K.text(x, y, str, size, { fill: color, rotate });

  /* ---------- characters ---------- */
  // Blocky avatar. (x, y) is where the FEET stand; about 104 units tall at s = 1.
  // o: shirt, pants, skin, hair (colour), hat ('crown' | 'cap'), pose ('idle' | 'cheer' | 'run' | 'point'), face ('smile' | 'wow' | 'cool' | 'grit'), flip
  K.avatar = (x, y, s = 1, o = {}) => {
    const shirt = o.shirt || '#3aa0ff', pants = o.pants || '#2b2f55', skin = o.skin || '#ffd9a8', pose = o.pose || 'idle';
    const part = (px, py, w, h, c, r = 4) => `<rect x="${px}" y="${py}" width="${w}" height="${h}" rx="${r}" fill="${c}" stroke="${INK}" stroke-width="3"/><rect x="${px + 3}" y="${py + 3}" width="${Math.max(0, w - 6)}" height="${Math.min(5, h / 4)}" rx="2" fill="#fff" opacity=".35"/>`;
    const armL = { idle: 0, cheer: 155, run: 40, point: 0 }[pose], armR = { idle: 0, cheer: -155, run: -40, point: -95 }[pose];
    const legL = pose === 'run' ? 22 : 0, legR = pose === 'run' ? -22 : 0;
    let s2 = `<ellipse cx="0" cy="0" rx="27" ry="7" fill="#000" opacity=".28"/>`;
    s2 += `<g transform="rotate(${legL} -8 -34)">${part(-14, -36, 12, 36, pants)}</g><g transform="rotate(${legR} 8 -34)">${part(2, -36, 12, 36, pants)}</g>`;
    s2 += `<g transform="rotate(${armL} -24 -68)">${part(-30, -72, 11, 32, skin)}</g>`;
    s2 += part(-19, -74, 38, 42, shirt, 5);
    s2 += `<g transform="rotate(${armR} 24 -68)">${part(19, -72, 11, 32, skin)}</g>`;
    s2 += part(-16, -105, 32, 31, skin, 8);
    if (o.hair) s2 += `<path d="M-17 -93v-6a10 10 0 0 1 10-10h14a10 10 0 0 1 10 10v6h-7v-5h-20v5z" fill="${o.hair}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
    if (o.hat === 'crown') s2 += `<path d="M-15 -104l2-16 8 9 5-13 5 13 8-9 2 16z" fill="#ffd166" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
    if (o.hat === 'cap') s2 += `<path d="M-17 -98a17 13 0 0 1 34 0z" fill="${o.hatColor || '#ff5c7a'}" stroke="${INK}" stroke-width="3"/><rect x="6" y="-101" width="20" height="6" rx="3" fill="${o.hatColor || '#ff5c7a'}" stroke="${INK}" stroke-width="3"/>`;
    const face = o.face || 'smile';
    if (face === 'cool') s2 += `<rect x="-13" y="-95" width="26" height="8" rx="3" fill="${INK}"/><path d="M-6 -82q6 5 12 0" fill="none" stroke="${INK}" stroke-width="2.600" stroke-linecap="round"/>`;
    else s2 += `<circle cx="-6.500" cy="-91" r="2.800" fill="${INK}"/><circle cx="6.500" cy="-91" r="2.800" fill="${INK}"/>` + (face === 'wow' ? `<ellipse cx="0" cy="-81" rx="4" ry="5" fill="${INK}"/>` : face === 'grit' ? `<rect x="-6" y="-84" width="12" height="5" rx="2" fill="#fff" stroke="${INK}" stroke-width="2"/>` : `<path d="M-6 -83q6 6 12 0" fill="none" stroke="${INK}" stroke-width="2.600" stroke-linecap="round"/>`);
    return `<g transform="translate(${x} ${y}) scale(${o.flip ? -s : s} ${s})">${s2}</g>`;
  };
  // Small cube pet that floats beside the player. (x, y) is its centre.
  K.pet = (x, y, s = 1, color = '#ff9a5c', o = {}) => `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="30" rx="16" ry="4.500" fill="#000" opacity=".22"/><path d="M-15 -12l3-13 9 10zM15 -12l-3-13-9 10z" fill="${K.mix(color, -0.2)}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/><rect x="-17" y="-14" width="34" height="30" rx="8" fill="${color}" stroke="${INK}" stroke-width="3"/><rect x="-13" y="-10" width="26" height="6" rx="3" fill="#fff" opacity=".4"/><circle cx="-6.500" cy="1" r="3.200" fill="${INK}"/><circle cx="6.500" cy="1" r="3.200" fill="${INK}"/><circle cx="-5.500" cy="0" r="1.100" fill="#fff"/><circle cx="7.500" cy="0" r="1.100" fill="#fff"/><path d="M-3 8q3 3 6 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>${o.glow ? K.glow(0, 0, 44, color, 0.5) : ''}</g>`;

  /* ---------- pickups and props ---------- */
  K.coin = (x, y, r = 14, color = '#ffd166') => `<ellipse cx="${x}" cy="${y + r * 0.16}" rx="${r}" ry="${r}" fill="${K.mix(color, -0.35)}" stroke="${INK}" stroke-width="3"/><circle cx="${x}" cy="${y}" r="${r}" fill="${color}" stroke="${INK}" stroke-width="3"/><circle cx="${x}" cy="${y}" r="${r * 0.62}" fill="none" stroke="${K.mix(color, -0.25)}" stroke-width="${Math.max(1.5, r * 0.14)}"/><path d="M${x - r * 0.45} ${y - r * 0.5}q${r * 0.3} ${-r * 0.3} ${r * 0.7} ${-r * 0.1}" fill="none" stroke="#fff" stroke-width="${Math.max(1.5, r * 0.16)}" stroke-linecap="round" opacity=".8"/>`;
  K.gem = (x, y, s = 1, color = '#5fe1ff') => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-16 -6l8-12h16l8 12-16 22z" fill="${color}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/><path d="M-16 -6h32M-8 -18l8 12 8-12M0 -6v22" fill="none" stroke="${K.mix(color, -0.3)}" stroke-width="2"/><path d="M-11 -8l5-8h5l-4 8z" fill="#fff" opacity=".6"/></g>`;
  // Tall crystal cluster growing out of the ground; (x, y) is the base centre.
  K.crystal = (x, y, s = 1, color = '#b79cff') => `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="2" rx="34" ry="8" fill="#000" opacity=".22"/><path d="M-26 0l-6-22 10-16 10 16-4 22z" fill="${K.mix(color, -0.12)}" stroke="${INK}" stroke-width="3.500" stroke-linejoin="round"/><path d="M-10 0l-8-40 14-26 14 26-6 40z" fill="${color}" stroke="${INK}" stroke-width="3.500" stroke-linejoin="round"/><path d="M12 0l-2-18 10-14 9 14-5 18z" fill="${K.mix(color, 0.18)}" stroke="${INK}" stroke-width="3.500" stroke-linejoin="round"/><path d="M-4 -66l-6 26 6 36" fill="none" stroke="#fff" stroke-width="4" opacity=".5" stroke-linecap="round"/></g>`;
  K.tree = (x, y, s = 1, o = {}) => { const leaf = o.leaf || '#3fd16b'; return `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="2" rx="30" ry="7" fill="#000" opacity=".22"/><rect x="-8" y="-40" width="16" height="42" rx="3" fill="#8a5a3c" stroke="${INK}" stroke-width="3.500"/>${K.box(-34, -78, 60, 40, leaf, { d: 12, shadow: false, sw: 3.5 })}${K.box(-22, -108, 38, 30, K.mix(leaf, 0.15), { d: 10, shadow: false, sw: 3.5 })}</g>`; };
  K.rock = (x, y, s = 1, color = '#8f98b3') => `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="2" rx="30" ry="7" fill="#000" opacity=".22"/><path d="M-28 0l-4-16 12-16 22-4 20 12 6 24z" fill="${color}" stroke="${INK}" stroke-width="3.500" stroke-linejoin="round"/><path d="M-18 -28l18-4 14 8" fill="none" stroke="#fff" stroke-width="4" opacity=".45" stroke-linecap="round"/></g>`;
  K.bush = (x, y, s = 1, color = '#2fb85c') => `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="2" rx="34" ry="6" fill="#000" opacity=".2"/><path d="M-32 0a14 14 0 0 1 8-22 16 16 0 0 1 28-8 15 15 0 0 1 24 12 12 12 0 0 1 4 18z" fill="${color}" stroke="${INK}" stroke-width="3.500" stroke-linejoin="round"/><path d="M-18 -18q10-12 22-6" fill="none" stroke="#fff" stroke-width="4" opacity=".4" stroke-linecap="round"/></g>`;
  // Flag on a pole; (x, y) is the pole base.
  K.flag = (x, y, color = '#2fe06a', h = 50) => `<path d="M${x} ${y}v${-h}" stroke="${INK}" stroke-width="5" stroke-linecap="round"/><path d="M${x} ${y - h}h30l-9 10 9 10h-30z" fill="${color}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
  // Gate you walk through; (x, y) is the bottom centre. Label sits inside the arch.
  K.arch = (x, y, w, h, color, label, o = {}) => { const r = w / 2, t = o.thick || 14; return `<ellipse cx="${x}" cy="${y + 3}" rx="${r + 10}" ry="7" fill="#000" opacity=".22"/><path d="M${x - r} ${y}v${-(h - r)}a${r} ${r} 0 0 1 ${w} 0v${h - r}" fill="none" stroke="${INK}" stroke-width="${t + 7}" stroke-linecap="round"/><path d="M${x - r} ${y}v${-(h - r)}a${r} ${r} 0 0 1 ${w} 0v${h - r}" fill="none" stroke="${color}" stroke-width="${t}" stroke-linecap="round"/><path d="M${x - r} ${y - 4}v${-(h - r - 4)}a${r} ${r} 0 0 1 ${w * 0.5} ${-r}" fill="none" stroke="#fff" stroke-width="${t * 0.28}" stroke-linecap="round" opacity=".55"/>${o.fillGlow ? K.glow(x, y - h * 0.45, r * 1.2, color, 0.5) : ''}${label ? K.text(x, y - h * 0.34, label, o.size || 20) : ''}`; };
  // Signboard on a post; (x, y) is the post base.
  K.sign = (x, y, str, color = '#ffd166', o = {}) => { const w = o.w || Math.max(70, str.length * 15 + 26), h = o.h || 44, ph = o.post === undefined ? 34 : o.post; return `<rect x="${x - 6}" y="${y - ph}" width="12" height="${ph}" rx="3" fill="#8a5a3c" stroke="${INK}" stroke-width="3.500"/>${K.box(x - w / 2, y - ph - h, w, h, color, { d: 9, shadow: false })}${K.text(x, y - ph - h / 2 + (o.size || 22) * 0.36, str, o.size || 22)}`; };
  K.lock = (x, y, s = 1, color = '#ffd166') => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-8 -6v-7a8 8 0 0 1 16 0v7" fill="none" stroke="${INK}" stroke-width="7"/><path d="M-8 -6v-7a8 8 0 0 1 16 0v7" fill="none" stroke="#dfe3f5" stroke-width="3"/><rect x="-13" y="-7" width="26" height="21" rx="5" fill="${color}" stroke="${INK}" stroke-width="3"/><circle cx="0" cy="3" r="3.200" fill="${INK}"/></g>`;
  // In-world bar (boss health, progress above an object).
  K.bar = (x, y, w, h, pct, color = '#4ade9a') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${INK}" stroke="#fff" stroke-width="3"/><rect x="${x + 3}" y="${y + 3}" width="${Math.max(0, (w - 6) * pct / 100)}" height="${h - 6}" rx="${(h - 6) / 2}" fill="${color}"/>`;
  // Dashed guide arrow, the kind used to point a new player at the next thing to do.
  K.arrow = (x1, y1, x2, y2, color = '#fff', o = {}) => { const bend = o.bend === undefined ? -40 : o.bend, mx = (x1 + x2) / 2, my = (y1 + y2) / 2 + bend, a = Math.atan2(y2 - my, x2 - mx), hx = (t) => n1(x2 - 16 * Math.cos(a + t)), hy = (t) => n1(y2 - 16 * Math.sin(a + t)); return `<path d="M${x1} ${y1}Q${mx} ${my} ${x2} ${y2}" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round" stroke-dasharray="2 18"/><path d="M${x1} ${y1}Q${mx} ${my} ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="2 18"/><path d="M${hx(0.5)} ${hy(0.5)}L${x2} ${y2}L${hx(-0.5)} ${hy(-0.5)}" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M${hx(0.5)} ${hy(0.5)}L${x2} ${y2}L${hx(-0.5)} ${hy(-0.5)}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`; };
  // Rounded badge / card drawn in the world (rarity card, price tag).
  K.card = (x, y, w, h, color, o = {}) => `<rect x="${x + 4}" y="${y + 8}" width="${w}" height="${h}" rx="${o.r || 16}" fill="${INK}" opacity=".55"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r || 16}" fill="${color}" stroke="${INK}" stroke-width="5"/><rect x="${x + 9}" y="${y + 8}" width="${w - 18}" height="${Math.min(18, h * 0.24)}" rx="8" fill="#fff" opacity=".45"/>`;
})();
