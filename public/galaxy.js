// The library drawn as a glowing 3D brain: a bright core, one star cluster per topic, a star per note,
// a spark per rule, and signals that travel along the links. Plain canvas, no libraries.
// Stars flash and a signal shoots out from the core when an agent reads that note.
(function () {
  const PALETTE = ['#f5b83d', '#6aa9ff', '#4ccb86', '#ff8fb1', '#4fd1c5', '#b79cff', '#ff9f6b', '#6be0ff', '#ffd166', '#e08bff', '#8fe6b6', '#ff7a7a', '#9db4ff', '#f0e68c', '#7ef0d0', '#ffb3de'];
  function rng(seed) { let s = 7; for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) | 0; return () => { s = (s * 1664525 + 1013904223) | 0; return ((s >>> 0) % 100000) / 100000; }; }
  const sprites = new Map();
  function sprite(color) { // soft round glow, drawn once per colour and reused
    let c = sprites.get(color);
    if (!c) {
      c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.12, color); grad.addColorStop(0.4, color + '55'); grad.addColorStop(1, color + '00');
      g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
      sprites.set(color, c);
    }
    return c;
  }

  window.Galaxy = function (canvas, opts) {
    const ctx = canvas.getContext('2d');
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0, dpr = 1, nodes = [], edges = [], dust = [], hubs = [], signals = [], byId = new Map();
    let yaw = 0.5, pitch = 0.3, zoom = 1.3, selected = null, hover = null, pulses = [], raf = 0, dead = false, dim = null;
    const ptrs = new Map(); let moved = 0, pinch = 0, lastTouch = 0, down = [0, 0];
    const core = { x: 0, y: 0, z: 0 };

    function setData(g) {
      const chapters = [...new Set(g.nodes.map(n => n.chapter))].sort();
      const outer = chapters.filter(c => !g.nodes.some(n => n.chapter === c && n.core));
      const center = new Map();
      chapters.forEach((c, ci) => {
        const isCore = !outer.includes(c), list = isCore ? chapters.filter(x => !outer.includes(x)) : outer, i = list.indexOf(c);
        // spread the clusters evenly over a brain-shaped shell; the master documents sit close to the core
        const y = list.length < 2 ? 0 : 1 - 2 * (i + 0.5) / list.length, r = Math.sqrt(1 - y * y), a = i * 2.39996;
        const R = isCore ? [95, 70, 95] : [330, 210, 270];
        center.set(c, { x: Math.cos(a) * r * R[0], y: y * R[1], z: Math.sin(a) * r * R[2], color: PALETTE[ci % PALETTE.length] });
      });
      const place = (n, c, rmin, rmax, rand) => {
        const th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1), r = rmin + rand() * (rmax - rmin);
        return { x: c.x + r * Math.sin(ph) * Math.cos(th), y: c.y + r * Math.cos(ph) * 0.8, z: c.z + r * Math.sin(ph) * Math.sin(th) };
      };
      const made = new Map();
      const build = (n) => {
        if (made.has(n.id)) return made.get(n.id);
        const c = center.get(n.chapter), rand = rng(n.id);
        let pos;
        if (n.isIndex) pos = { x: c.x, y: c.y, z: c.z };
        else if (n.kind === 'idea') { const parent = g.nodes.find(m => m.id === n.parent); const pp = parent ? build(parent) : c; pos = place(n, pp, parent && parent.isIndex ? 26 : 12, parent && parent.isIndex ? 62 : 26, rand); }
        else pos = place(n, c, 44, 78, rand);
        const node = Object.assign({}, n, pos, { color: c.color, tw: rand() * 6,
          size: n.isIndex ? 7 : n.kind === 'idea' ? 1.7 : 3.2 + Math.min(2, (n.words || 0) / 320) });
        made.set(n.id, node); return node;
      };
      nodes = g.nodes.map(build);
      byId = new Map(nodes.map(n => [n.id, n]));
      hubs = nodes.filter(n => n.isIndex);
      for (const h of hubs) h.ideas = nodes.filter(n => n.chapter === h.chapter && n.kind === 'idea').length;
      edges = g.edges.map(([a, b]) => [byId.get(a), byId.get(b)]).filter(e => e[0] && e[1]).map(([a, b]) => ({ a, b, cross: a.chapter !== b.chapter }));
      for (const h of hubs) edges.push({ a: core, b: h, spine: true });
      const rand = rng('dust');
      dust = Array.from({ length: 900 }, () => {
        const th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1), r = 120 + Math.pow(rand(), 0.7) * 520;
        return { x: r * Math.sin(ph) * Math.cos(th), y: r * Math.cos(ph) * 0.62, z: r * Math.sin(ph) * Math.sin(th), s: 0.5 + rand() * 1.1, a: 0.12 + rand() * 0.4 };
      });
      signals = Array.from({ length: still ? 0 : Math.min(70, Math.ceil(edges.length / 5)) }, (_, i) => ({ e: Math.floor(rng('s' + i)() * edges.length), u: rng('u' + i)(), v: 0.004 + rng('v' + i)() * 0.006 }));
      if (selected && !byId.has(selected)) selected = null;
    }

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
    }
    function project(p) {
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const x = p.x * cy - p.z * sy, z0 = p.x * sy + p.z * cy;
      const y = p.y * cp - z0 * sp, z = p.y * sp + z0 * cp;
      const k = 900 / (900 + z + 520) * zoom * Math.min(W, H) / 560;
      return { sx: W / 2 + x * k, sy: H / 2 + y * k, k, z };
    }
    const fade = (z) => Math.max(0.25, Math.min(1, 1 - (z - 80) / 900)); // far things are dimmer, which gives the depth
    function glow(p, color, radius, alpha) {
      if (alpha <= 0.01 || radius < 0.3) return;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(sprite(color), p.sx - radius, p.sy - radius, radius * 2, radius * 2);
    }

    function frame(t) {
      if (dead) return;
      raf = requestAnimationFrame(frame);
      if (!W || !H) return;
      if (!still && !ptrs.size) yaw += 0.0009;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
      bg.addColorStop(0, '#171232'); bg.addColorStop(0.45, '#0d0f1e'); bg.addColorStop(1, '#07080c');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter'; // overlapping light adds up, which is what makes it glow

      ctx.fillStyle = '#cdd6ff';
      for (const d of dust) { const p = project(d); ctx.globalAlpha = d.a * fade(p.z); const s = d.s * p.k + 0.3; ctx.fillRect(p.sx, p.sy, s, s); }

      core.p = project(core);
      for (const n of nodes) n.p = project(n);
      const sel = selected && byId.get(selected);
      const off = (n) => dim && n.chapter && n.chapter !== dim;

      for (const h of hubs) glow(h.p, h.color, 150 * h.p.k, (off(h) ? 0.03 : 0.13) * fade(h.p.z)); // nebula behind each cluster

      for (const e of edges) {
        const on = sel && (e.a === sel || e.b === sel);
        const d = off(e.a) && off(e.b);
        ctx.strokeStyle = on ? '#ffffff' : (e.b.color || '#b79cff');
        ctx.lineWidth = on ? 1.4 : e.spine ? 1.1 : 0.7;
        ctx.globalAlpha = (on ? 0.85 : d ? 0.02 : e.spine ? 0.22 : e.cross ? 0.08 : 0.2) * fade((e.a.p.z + e.b.p.z) / 2);
        ctx.beginPath(); ctx.moveTo(e.a.p.sx, e.a.p.sy); ctx.lineTo(e.b.p.sx, e.b.p.sy); ctx.stroke();
      }

      for (const s of signals) { // light travelling along the links
        s.u += s.v; if (s.u > 1) { s.u = 0; s.e = Math.floor(Math.random() * edges.length); }
        const e = edges[s.e]; if (!e || (off(e.a) && off(e.b))) continue;
        const p = { sx: e.a.p.sx + (e.b.p.sx - e.a.p.sx) * s.u, sy: e.a.p.sy + (e.b.p.sy - e.a.p.sy) * s.u };
        glow(p, e.b.color || '#ffffff', 5 * Math.max(0.6, (e.a.p.k + e.b.p.k) / 2), 0.75 * Math.sin(Math.PI * s.u));
      }

      const beat = still ? 1 : 1 + 0.08 * Math.sin(t / 520);
      glow(core.p, '#b79cff', 120 * core.p.k * beat, 0.5); glow(core.p, '#6be0ff', 70 * core.p.k * beat, 0.45); glow(core.p, '#ffffff', 34 * core.p.k * beat, 0.9);
      ctx.strokeStyle = '#d6c8ff'; ctx.lineWidth = 1.2; // tilted ring around the core
      for (let r = 0; r < 2; r++) {
        ctx.globalAlpha = 0.35 - r * 0.15; ctx.beginPath();
        for (let i = 0; i <= 48; i++) { const a = i / 48 * Math.PI * 2 + t / 5000 * (r ? -1 : 1), R = 62 + r * 22; const p = project({ x: Math.cos(a) * R, y: Math.sin(a) * R * 0.28 * (r ? -1 : 1), z: Math.sin(a) * R }); i ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy); }
        ctx.stroke();
      }

      for (const n of nodes) {
        const tw = still ? 1 : 0.8 + 0.2 * Math.sin(t / 650 + n.tw), f = fade(n.p.z) * (off(n) ? 0.18 : 1);
        const hot = n === sel || n === hover;
        const r = n.size * n.p.k * (hot ? 1.7 : 1);
        glow(n.p, n.color, r * (n.kind === 'idea' ? 4 : 5.5), (n.kind === 'idea' ? 0.55 : 0.85) * tw * f);
        if (n.kind !== 'idea' || hot) glow(n.p, '#ffffff', r * 1.6, (hot ? 1 : 0.8) * f);
      }

      for (const p of pulses) if (!p.t0) p.t0 = t;
      pulses = pulses.filter(p => t - p.t0 < 3000);
      for (const p of pulses) {
        const n = byId.get(p.id); if (!n) continue;
        const u = (t - p.t0) / 3000, fly = Math.min(1, u / 0.3);
        if (fly < 1) glow({ sx: core.p.sx + (n.p.sx - core.p.sx) * fly, sy: core.p.sy + (n.p.sy - core.p.sy) * fly }, p.color || '#ffffff', 12, 1);
        else {
          const v = (u - 0.3) / 0.7;
          glow(n.p, p.color || '#ffffff', 16 + v * 60, 1 - v);
          ctx.strokeStyle = p.color || '#ffffff'; ctx.lineWidth = 2; ctx.globalAlpha = 1 - v;
          ctx.beginPath(); ctx.arc(n.p.sx, n.p.sy, 8 + v * 50, 0, 7); ctx.stroke();
        }
      }

      ctx.globalCompositeOperation = 'source-over'; ctx.textAlign = 'center';
      for (const p of pulses) { // who is reading
        const n = byId.get(p.id); if (!n || !p.label) continue;
        const u = (t - p.t0) / 3000; if (u < 0.3) continue;
        ctx.globalAlpha = 1 - (u - 0.3) / 0.7; ctx.font = '700 12.5px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = p.color || '#fff';
        ctx.fillText(p.label + ' is reading', n.p.sx, n.p.sy - 20 - u * 14);
      }
      const placed = [];
      const label = (n, big, force) => {
        const y = n.p.sy + n.size * n.p.k * 2.2 + 15;
        const w = Math.min(300, (n.kind === 'idea' ? 64 : Math.min(44, n.title.length)) * (big ? 7.2 : 6.2)), box = [n.p.sx - w / 2, y - 12, n.p.sx + w / 2, y + (n.isIndex && n.ideas ? 18 : 4)];
        if (!force && placed.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return; // never draw one label over another
        placed.push(box);
        ctx.globalAlpha = Math.min(1, fade(n.p.z) * (off(n) ? 0.25 : 1) + (big ? 0.3 : 0));
        ctx.font = (big ? '650 13px ' : '11.5px ') + 'ui-sans-serif, system-ui, sans-serif';
        ctx.lineWidth = 3; ctx.strokeStyle = '#07080ccc'; ctx.fillStyle = big ? '#f2f4f8' : '#aab3c5';
        const text = n.kind === 'idea' ? n.title.slice(0, 64) + (n.title.length > 64 ? '…' : '') : n.title.slice(0, 44);
        ctx.strokeText(text, n.p.sx, y); ctx.fillText(text, n.p.sx, y);
        if (n.isIndex && n.ideas) { ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = n.color; ctx.strokeText(n.ideas + ' ideas', n.p.sx, y + 14); ctx.fillText(n.ideas + ' ideas', n.p.sx, y + 14); }
      };
      if (sel) label(sel, true, true);
      if (hover && hover !== sel) label(hover, true, true);
      for (const h of hubs.slice().sort((a, b) => a.p.z - b.p.z)) if (h !== sel && h !== hover && !off(h)) label(h, true); // nearest first
      if (zoom > 1.9) for (const n of nodes) if (n.kind !== 'idea' && !n.isIndex && n !== sel && n !== hover && !off(n)) label(n, false);
      ctx.globalAlpha = 1;
    }

    function pick(x, y) {
      let best = null, bd = lastTouch ? 26 : 15;
      for (const n of nodes) { if (!n.p) continue; const d = Math.hypot(n.p.sx - x, n.p.sy - y) - (n.kind === 'idea' ? 0 : 4); if (d < bd) { bd = d; best = n; } }
      return best;
    }
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, pos(e)); moved = 0; down = pos(e); lastTouch = e.pointerType === 'touch'; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
    canvas.addEventListener('pointermove', e => {
      const [x, y] = pos(e);
      if (!ptrs.has(e.pointerId)) { hover = pick(x, y); canvas.style.cursor = hover ? 'pointer' : 'grab'; return; }
      const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, [x, y]);
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) zoom = Math.min(5, Math.max(0.45, zoom * d / pinch)); pinch = d; moved = 99; return;
      }
      const dx = x - prev[0], dy = y - prev[1]; moved += Math.abs(dx) + Math.abs(dy);
      yaw += dx * 0.006; pitch = Math.min(1.45, Math.max(-1.45, pitch + dy * 0.006));
    });
    const up = e => {
      if (!ptrs.has(e.pointerId)) return;
      const [x, y] = pos(e); ptrs.delete(e.pointerId); pinch = 0;
      if (moved < 99 && Math.hypot(x - down[0], y - down[1]) < (lastTouch ? 12 : 5) && e.type === 'pointerup') {
        const n = pick(x, y); selected = n ? n.id : null;
        opts.onSelect && opts.onSelect(n ? (n.kind === 'idea' ? n.parent : n.id) : null, n && n.kind === 'idea' ? n.index : null);
      }
    };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', () => { hover = null; });
    canvas.addEventListener('wheel', e => { e.preventDefault(); zoom = Math.min(5, Math.max(0.45, zoom * (e.deltaY < 0 ? 1.1 : 0.9))); }, { passive: false });

    const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
    raf = requestAnimationFrame(frame);

    return {
      setData,
      select(id) { selected = id; },
      pulse(id, color, label) { if (byId.has(id)) pulses.push({ id, color, label, t0: 0 }); },
      focus(chapter) { dim = dim === chapter ? null : chapter; return dim; },
      chapters() { return hubs.map(h => ({ id: h.chapter, color: h.color, name: h.chapterName || h.title, ideas: h.ideas })).sort((a, b) => a.name.localeCompare(b.name)); },
      destroy() { dead = true; cancelAnimationFrame(raf); ro.disconnect(); },
    };
  };
})();
