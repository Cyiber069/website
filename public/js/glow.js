// "Night Ride, lights on": the small bits of motion glow.css cannot do alone. Looks only: it reads the
// page and sets classes and CSS variables, and never changes what the dashboard does.
//   * a light that follows the pointer over cards (--mx, --my)
//   * the page rises in when the screen changes (#view.is-entering)
//   * a number bumps when its value changes (.stat__value.is-bump)
const still = matchMedia('(prefers-reduced-motion: reduce)');

// ---- pointer light ----------------------------------------------------------------------------------
let frame = 0;
addEventListener('pointermove', (e) => {
  if (frame || e.pointerType === 'touch') return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const card = e.target instanceof Element ? e.target.closest('.stat, .chcard, .card') : null;
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
    card.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
  });
}, { passive: true });

// ---- screen entrance --------------------------------------------------------------------------------
let leaving = 0;
function enter() {
  const view = document.getElementById('view');
  if (!view || still.matches) return;
  view.classList.remove('is-entering');
  void view.offsetWidth; // restart the animation
  view.classList.add('is-entering');
  clearTimeout(leaving);
  leaving = setTimeout(() => view.classList.remove('is-entering'), 900);
}
addEventListener('hashchange', enter);

// ---- numbers that changed ---------------------------------------------------------------------------
const seen = new Map();
function numbers() {
  for (const stat of document.querySelectorAll('.stat')) {
    const value = stat.querySelector('.stat__value');
    const label = stat.querySelector('.stat__label')?.textContent?.trim();
    if (!value || !label) continue;
    const text = value.textContent.trim();
    const before = seen.get(label);
    seen.set(label, text);
    if (before === undefined || before === text || still.matches) continue;
    value.classList.remove('is-bump');
    void value.offsetWidth;
    value.classList.add('is-bump');
    value.addEventListener('animationend', () => value.classList.remove('is-bump'), { once: true });
  }
}

let queued = false;
let entered = false;
new MutationObserver(() => {
  if (!entered && document.getElementById('view')?.firstElementChild) { entered = true; enter(); }
  if (queued) return;
  queued = true;
  setTimeout(() => { queued = false; numbers(); }, 120);
}).observe(document.body, { childList: true, subtree: true, characterData: true });
