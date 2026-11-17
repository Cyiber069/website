// Draws every ACX Agent icon (dashboard PWA, favicon, Chrome extension) from one SVG.
// Run from the repo root: node docs/theme/make-icons.cjs
// The mark is the same as before (ACX, the signal line and the dot). Only the colour changed:
// a blue to violet gradient tile with a white mark. badge-96.png is a plain white shape for
// Android notifications, so it is not drawn here.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const font = fs.readFileSync(path.join(root, 'public/fonts/oswald-latin-wght-normal.woff2')).toString('base64');

// Colours: the brand gradient from public/css/acx.css, one step deeper so the white mark stays crisp.
const FROM = '#2F6BF5', MID = '#6457F0', TO = '#9545F2', MARK = '#FFFFFF';

// kind: 'rounded' (transparent corners), 'full' (square, the system rounds it), 'maskable' (square, mark inside the safe zone)
const ICONS = [
  ['public/icons/icon-512.png', 512, 'rounded'],
  ['public/icons/icon-192.png', 192, 'rounded'],
  ['public/icons/maskable-512.png', 512, 'maskable'],
  ['public/icons/apple-touch-icon.png', 180, 'full'],
  ['public/icons/favicon-32.png', 32, 'rounded'],
  ['extension/icons/icon128.png', 128, 'rounded'],
  ['extension/icons/icon48.png', 48, 'rounded'],
  ['extension/icons/icon16.png', 16, 'rounded'],
];

function svg(kind, m) {
  const radius = kind === 'rounded' ? 112 : 0;
  const scale = kind === 'maskable' ? 0.75 : 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${FROM}"/><stop offset="0.52" stop-color="${MID}"/><stop offset="1" stop-color="${TO}"/></linearGradient>
    <radialGradient id="shine" cx="0.2" cy="0" r="0.9"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.22"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
    <clipPath id="tile"><rect width="512" height="512" rx="${radius}"/></clipPath>
  </defs>
  <g clip-path="url(#tile)">
    <rect width="512" height="512" fill="url(#g)"/>
    <rect width="512" height="512" fill="url(#shine)"/>
  </g>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)" fill="${MARK}">
    <text x="${105 - m.left}" y="305" font-family="Oswald" font-weight="700" font-size="${m.size}" letter-spacing="${m.spacing}">ACX</text>
    <rect x="100" y="345" width="195" height="18" rx="9"/>
    <circle cx="393" cy="354" r="20"/>
  </g>
</svg>`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await page.setContent(`<style>@font-face{font-family:Oswald;font-weight:200 700;src:url(data:font/woff2;base64,${font}) format("woff2")}html,body{margin:0;background:transparent}svg{display:block}</style><div id="box"></div>`);
  await page.evaluate(() => document.fonts.load('700 100px Oswald'));
  // Fit the letters to the old mark: capitals 155 units tall, the word 305 units wide.
  const m = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = '700 1000px Oswald';
    const cap = c.measureText('X').actualBoundingBoxAscent / 1000;
    const size = 155 / cap;
    c.font = `700 ${size}px Oswald`;
    const w = c.measureText('ACX');
    const ink = w.actualBoundingBoxLeft + w.actualBoundingBoxRight;
    return { size, left: -w.actualBoundingBoxLeft, spacing: (305 - ink) / 2 };
  });
  for (const [file, size, kind] of ICONS) {
    await page.setViewportSize({ width: size, height: size });
    await page.evaluate(([markup, s]) => { const box = document.getElementById('box'); box.innerHTML = markup; const el = box.firstElementChild; el.setAttribute('width', s); el.setAttribute('height', s); }, [svg(kind, m), size]);
    await page.screenshot({ path: path.join(root, file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', file);
  }
  await browser.close();
})();
