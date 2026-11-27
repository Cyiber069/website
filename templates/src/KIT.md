# How to write a template file

One file per template: `templates/src/tN.js`. It fills `window.TEMPLATES[N]` with data and two SVG scenes. The frame (`frame.js`, `frame.css`) draws the card, the HUD, the shop screen and every text section from that data. `t1.js` is the working reference: copy its shape exactly.

Render and check with:

```
node templates/render.js N zones
```

It writes into `templates/out/`:
- `template-N.png`: the whole card (1200 x 2700).
- `template-N-scene.png`: the main game view, close up.
- `template-N-zones.png`: the same view with the HUD's reserved areas marked red.
- `template-N-minis.png`: the shop screen and the "moment" scene, close up.
- `template-N-lower.png`: the lower half of the card, close up.

It also prints text that does not fit its box. Shorten that text until the list is empty.

## The card, top to bottom

| Part | Comes from | Notes |
|---|---|---|
| Badge, genre, title, hook | `n`, `genre`, `name`, `hook` | Hook: two lines at most, about 120 characters. |
| Main game view with HUD | `scene()` plus `hud` | Scene is SVG, viewBox 960 x 540. |
| Shop screen | `shop` | Drawn by the frame. You supply names, one-line effects, prices, and a small featured picture. |
| Moment scene | `moment.svg()` | SVG, viewBox 480 x 270. The exciting thing players work toward. |
| Progress strip | `path` | Exactly 5 steps: `state` is `done`, `now` or `locked`. |
| The first 60 seconds | `first60` | Exactly 4 steps. About 45 characters each. |
| Core loop | `loop` | Exactly 4 strings: do, earn, upgrade, repeat. About 30 characters each. |
| The one thing that changes | `mechanic`, `reskins` | Mechanic: two lines at most. Three reskin ideas, about 14 characters each. |
| How it earns | `earns` | Exactly 3 strings, in order low, mid, premium price. About 30 characters each. |
| Brings players back | `keeps` | Exactly 3 strings. About 30 characters each. |
| Stats | `stats` | `shared`, `days`, `risk`. |

## HUD data

```js
hud: {
  pills: [{ icon, color, value, plus }],   // 2 pills. icon: 'coin' | 'gem' | 'cash' | any ICON name. plus: true only for a currency the player can buy.
  goal: { label, text, pct },               // top centre. label is small caps, e.g. 'GOAL'. Keep text under 20 characters.
  next: { label, value },                   // top right, the next reward. Value under 12 characters.
  buttons: [{ icon, label, color, dot }],   // exactly 4 left-side buttons. dot: true shows a red notice dot.
  action: 'TAP!',                           // the big thumb button, 1 or 2 short words.
}
```

ICON names: cart, star, gift, loop, book, bolt, bag, flag, paw, trophy, crown, shield, heart, clock, users, wand, pick, gear, dice, up, check, lock.

## Reserved areas of the main scene

The HUD covers these rectangles of the 960 x 540 scene (x, y, width, height). Sky, ground and background may run under them; characters, labels, signs and anything the viewer must read may not.

- Top left pills: 0, 0, 250, 118
- Top centre goal: 286, 0, 388, 104
- Top right next reward: 748, 0, 212, 92
- Left buttons: 0, 138, 104, 322
- Action button: 316, 424, 328, 116
- Roblox jump button: 826, 414, 134, 126

That leaves a clear stage of roughly x 110 to 820, y 110 to 420, plus the strip under the top-right box.

## Drawing kit (`kit.js`, global `K`)

Every helper returns an SVG string; join them with `+`. Later strings draw on top of earlier ones, so go back to front: sky, far background, ground, far objects, near objects, characters, effects, text.

Backdrop
- `K.sky(top, bottom, w = 960, h = 540)`: gradient sky.
- `K.stars(seed, n, w, h)`, `K.sun(x, y, r, color)`, `K.cloud(x, y, scale, opacity)`.
- `K.hills(baselineY, color, seed, amplitude)`: rolling silhouette. Layer two or three in different shades for depth.
- `K.skyline(baselineY, color, seed)`: blocky distant towers.
- `K.floor(horizonY, top, bottom, { rows, studColor, studs })`: toy-brick floor in perspective.

Solid shapes
- `K.box(x, y, w, h, color, { d, r, studs, label, size, shadow })`: 3D brick. (x, y) is the top-left of the front face; depth `d` extends up and right.
- `K.pad(cx, cy, rx, color, { h, ry })`: round pad or platform lying on the ground.
- `K.card(x, y, w, h, color)`: rounded badge or card.
- `K.shadow(cx, cy, rx)`, `K.ring(cx, cy, rx, ry, color, strokeWidth, opacity)`.
- `K.rays(x, y, r, color, { n, op, spin })`, `K.burst(x, y, r, color, { n, inner })`, `K.glow(x, y, r, color, opacity)`.
- `K.sparkle(x, y, scale, color)`, `K.sparkles([[x, y, scale], ...], color)`.

Text
- `K.text(x, y, string, size, { fill, anchor, rotate, sw })`: chunky outlined game text.
- `K.pop(x, y, string, size, color, rotate)`: floating reward number such as "+1".

Characters
- `K.avatar(x, y, scale, { shirt, pants, skin, hair, hat, hatColor, pose, face, flip })`: (x, y) is where the feet stand. pose: idle, cheer, run, point. face: smile, wow, cool, grit. hat: crown, cap.
- `K.pet(x, y, scale, color, { glow })`: small cube pet; (x, y) is its centre.

Props
- `K.coin(x, y, r, color)`, `K.gem(x, y, scale, color)`, `K.crystal(x, y, scale, color)` (base centre).
- `K.tree`, `K.rock`, `K.bush` (x, y, scale, color or `{ leaf }`): base centre.
- `K.flag(x, y, color, height)`, `K.arch(x, y, w, h, color, label, { size, thick, fillGlow })` (bottom centre), `K.sign(x, y, string, color, { w, size, post })` (post base).
- `K.lock(x, y, scale)`, `K.bar(x, y, w, h, pct, color)`, `K.arrow(x1, y1, x2, y2, color, { bend })`.
- `K.mix(hex, amount)`: lighten (positive) or darken (negative) a colour. `K.rnd(seed)`: repeatable random numbers. `K.INK`: the outline colour.

You may write raw SVG and your own helper functions inside your file. Use `K.INK` outlines about 3 to 5 wide, a lighter top and a darker side on solid objects, and `font-family="${K.FONT}"` for any text you write by hand.

## What makes a scene good

- One focal point: the player doing the core action, large and near the centre.
- Three depth layers: far background, mid-ground things to walk to, near foreground details.
- Life: a pet, another player, reward numbers flying off, sparkles, a glow on the thing to do next.
- Readable at a glance: someone who has never seen it should know what to do in two seconds.
- Objects stand on the ground with a shadow; nothing floats unless it is meant to.

## Rules

- Original art only. No real game names, characters, logos or brands.
- No invented statistics. Keep the `stats` values you were given; they are labelled as estimates on the card.
- Shop prices are in the game's own currency. Never show Robux prices.
- Anything random that can be bought must show its odds. No fake urgency, no countdown pressure, no pay-to-skip as the main income.
- Edit only your own `tN.js`.
