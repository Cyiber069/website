// The vault drawn as a galaxy: each chapter is a star cluster, each note a star, each link a thread.
// Plain canvas, no libraries. Stars pulse when an agent reads that note.
(function () {
  const PALETTE = ['#f5b83d', '#6aa9ff', '#4ccb86', '#ff8fb1', '#4fd1c5', '#b79cff', '#ff9f6b', '#6be0ff', '#ffd166', '#9aa7b8', '#e08bff', '#8fe6b6'];
  function rng(seed) { let s = 0; for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) | 0; return () => { s = (s * 1664525 + 1013904223) | 0; return ((s >>> 0) % 100000) / 100000; }; }

  window.Galaxy = function (canvas, opts) {
    const ctx = canvas.getContext('2d');
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0, dpr = 1, nodes = [], edges = [], dust = [], byId = new Map(), chapters = [];
    let yaw = 0.6, pitch = 0.42, zoom = 1.45, selected = null, hover = null, pulses = [], raf = 0, dead = false, dim = null;
    const ptrs = new Map(); let moved = 0, pinch = 0, lastTouch = 0, down = [0, 0];

    function setData(g) {
      chapters = [...new Set(g.nodes.map(n => n.chapter))].sort();
      const centers = new Map();
      chapters.forEach((c, i) => {
        const a = i * 2.39996, r = chapters.length < 2 ? 0 : 95 + 230 * Math.sqrt((i + 0.5) / chapters.length), rand = rng(c);
        centers.set(c, { x: Math.cos(a) * r, y: (rand() - 0.5) * 70, z: Math.sin(a) * r, color: PALETTE[i % PALETTE.length] });
      });
      nodes = g.nodes.map(n => {
        const c = centers.get(n.chapter), rand = rng(n.id);
        let x = c.x, y = c.y, z = c.z;
        if (!n.isIndex) {
          const th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1), r = 34 + rand() * 46;
          x += r * Math.sin(ph) * Math.cos(th); y += r * Math.cos(ph) * 0.7; z += r * Math.sin(ph) * Math.sin(th);
        }
        return Object.assign({}, n, { x, y, z, color: c.color, size: n.isIndex ? 5.2 : 2.2 + Math.min(2.4, n.words / 260), tw: rand() * 6 });
      });
      byId = new Map(nodes.map(n => [n.id, n]));
      edges = g.edges.map(([a, b]) => [byId.get(a), byId.get(b)]).filter(e => e[0] && e[1]);
      const rand = rng('dust');
      dust = Array.from({ length: 700 }, () => {
        const a = rand() * Math.PI * 2, r = 30 + Math.pow(rand(), 0.6) * 520;
        return { x: Math.cos(a + r * 0.004) * r, y: (rand() - 0.5) * (60 + r * 0.12), z: Math.sin(a + r * 0.004) * r, s: 0.4 + rand() * 0.9, a: 0.15 + rand() * 0.45 };
      });
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
      const f = 760, k = f / (f + z + 420) * zoom * Math.min(W, H) / 560;
      return { sx: W / 2 + x * k, sy: H / 2 + y * k, k, z };
    }

    function frame(t) {
      if (dead) return;
      raf = requestAnimationFrame(frame);
      if (!W || !H) return;
      if (!still && !ptrs.size) yaw += 0.0007;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
      bg.addColorStop(0, '#141a24'); bg.addColorStop(1, '#0b0d10');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = '#cfd8e6';
      for (const d of dust) { const p = project(d); if (p.k <= 0) continue; ctx.globalAlpha = d.a * Math.min(1, p.k); ctx.fillRect(p.sx, p.sy, d.s * p.k + 0.3, d.s * p.k + 0.3); }
      ctx.globalAlpha = 1;

      for (const n of nodes) n.p = project(n);
      const sel = selected && byId.get(selected);
      ctx.lineWidth = 1;
      for (const [a, b] of edges) {
        const on = sel && (a === sel || b === sel);
        const off = dim && a.chapter !== dim && b.chapter !== dim;
        ctx.strokeStyle = on ? '#ffffff' : a.color;
        ctx.globalAlpha = on ? 0.75 : off ? 0.03 : 0.16;
        ctx.beginPath(); ctx.moveTo(a.p.sx, a.p.sy); ctx.lineTo(b.p.sx, b.p.sy); ctx.stroke();
      }
      ctx.globalAlpha = 1;

      const order = nodes.slice().sort((a, b) => b.p.z - a.p.z);
      for (const n of order) {
        const off = dim && n.chapter !== dim;
        const tw = still ? 1 : 0.85 + 0.15 * Math.sin(t / 700 + n.tw);
        const r = n.size * n.p.k * (n === sel ? 1.5 : 1);
        ctx.globalAlpha = off ? 0.15 : 0.22 * tw;
        ctx.fillStyle = n.color;
        ctx.beginPath(); ctx.arc(n.p.sx, n.p.sy, r * 3.2, 0, 7); ctx.fill();
        ctx.globalAlpha = off ? 0.3 : 1;
        ctx.fillStyle = n === sel || n === hover ? '#ffffff' : n.color;
        ctx.beginPath(); ctx.arc(n.p.sx, n.p.sy, Math.max(1.2, r), 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;

      for (const p of pulses) if (!p.t0) p.t0 = t;
      pulses = pulses.filter(p => t - p.t0 < 2600);
      for (const p of pulses) {
        const n = byId.get(p.id); if (!n) continue;
        const u = (t - p.t0) / 2600;
        ctx.strokeStyle = p.color || '#ffffff'; ctx.lineWidth = 2; ctx.globalAlpha = 1 - u;
        ctx.beginPath(); ctx.arc(n.p.sx, n.p.sy, 6 + u * 46, 0, 7); ctx.stroke();
        if (p.label) { ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = p.color || '#fff'; ctx.textAlign = 'center'; ctx.fillText(p.label, n.p.sx, n.p.sy - 16 - u * 20); }
      }
      ctx.globalAlpha = 1;

      ctx.textAlign = 'center';
      for (const n of order) {
        const show = n.isIndex || n === sel || n === hover || zoom > 1.9;
        if (!show || (dim && n.chapter !== dim && n !== sel)) continue;
        const big = n.isIndex || n === sel || n === hover;
        ctx.font = (big ? '600 12.5px ' : '11px ') + 'ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = big ? '#e9ecf1' : '#98a2b3';
        ctx.globalAlpha = Math.min(1, Math.max(0.35, n.p.k * 1.1));
        ctx.fillText(n.isIndex ? n.title : n.title.slice(0, 40), n.p.sx, n.p.sy + n.size * n.p.k * 3 + 13);
      }
      ctx.globalAlpha = 1;
    }

    function pick(x, y) {
      let best = null, bd = lastTouch ? 26 : 16;
      for (const n of nodes) { if (!n.p) continue; const d = Math.hypot(n.p.sx - x, n.p.sy - y); if (d < bd) { bd = d; best = n; } }
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
        if (pinch) zoom = Math.min(4, Math.max(0.5, zoom * d / pinch)); pinch = d; moved = 99; return;
      }
      const dx = x - prev[0], dy = y - prev[1]; moved += Math.abs(dx) + Math.abs(dy);
      yaw += dx * 0.006; pitch = Math.min(1.45, Math.max(-1.45, pitch + dy * 0.006));
    });
    const up = e => {
      if (!ptrs.has(e.pointerId)) return;
      const [x, y] = pos(e); ptrs.delete(e.pointerId); pinch = 0;
      if (moved < 99 && Math.hypot(x - down[0], y - down[1]) < (lastTouch ? 12 : 5) && e.type === 'pointerup') { const n = pick(x, y); selected = n ? n.id : null; opts.onSelect && opts.onSelect(n ? n.id : null); }
    };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', () => { hover = null; });
    canvas.addEventListener('wheel', e => { e.preventDefault(); zoom = Math.min(4, Math.max(0.5, zoom * (e.deltaY < 0 ? 1.1 : 0.9))); }, { passive: false });

    const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
    raf = requestAnimationFrame(frame);

    return {
      setData,
      select(id) { selected = id; },
      pulse(id, color, label) { if (byId.has(id)) pulses.push({ id, color, label, t0: 0 }); },
      focus(chapter) { dim = dim === chapter ? null : chapter; return dim; },
      chapters() { return chapters.map((c, i) => ({ id: c, color: PALETTE[i % PALETTE.length], name: (nodes.find(n => n.chapter === c) || {}).chapterName || c })); },
      destroy() { dead = true; cancelAnimationFrame(raf); ro.disconnect(); },
    };
  };
})();
