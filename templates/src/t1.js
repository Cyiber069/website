// Template 1: Tap Simulator. Reference example of the data format every template file follows.
(window.TEMPLATES = window.TEMPLATES || {})[1] = {
  n: 1,
  name: 'Tap Simulator',
  genre: 'Simulation · incremental',
  colors: ['#ff6fb5', '#ffb938'],
  hook: 'Tap to grow a number, spend it to open the next zone, then rebirth for a permanent boost. The fastest genre to reskin.',

  hud: {
    pills: [{ icon: 'coin', color: '#ffd166', value: '1.2K', plus: true }, { icon: 'gem', color: '#5fe1ff', value: '14', plus: true }],
    goal: { label: 'GOAL', text: 'Reach 2,000 power', pct: 62 },
    next: { label: 'NEXT ZONE', value: '1K power' },
    buttons: [{ icon: 'cart', label: 'Shop', color: '#3aa0ff' }, { icon: 'loop', label: 'Rebirth', color: '#b56bff' }, { icon: 'paw', label: 'Pets', color: '#ff9a5c' }, { icon: 'gift', label: 'Daily', color: '#2fe06a', dot: true }],
    action: 'TAP!',
  },

  // Main game view, 960 x 540. Keep important art out of the HUD's reserved areas (see KIT.md).
  scene: () => {
    const k = K;
    return k.sky('#24105a', '#ff86c8')
      + k.stars('tap', 46, 960, 230)
      + k.sun(705, 262, 44, '#ffe3a1')
      + k.skyline(300, '#5b2fb0', 7)
      + k.hills(300, '#7a45d6', 3, 26)
      + k.floor(300, '#b98cff', '#5b2ec4')
      // zone gates receding into the distance
      + k.arch(852, 318, 50, 70, '#ff6fb5', '2M', { size: 15, thick: 10 }) + k.lock(852, 262, 0.75)
      + k.arch(772, 330, 62, 86, '#ffd166', '50K', { size: 17, thick: 12 }) + k.lock(772, 262, 0.85)
      + k.arch(672, 348, 80, 112, '#5fe1ff', '1K', { size: 22, fillGlow: true })
      + k.text(672, 222, 'ZONE 2', 17, { fill: '#bff3ff' })
      // the training pad
      + k.glow(430, 330, 210, '#ffd166', 0.75)
      + k.rays(430, 330, 250, '#fff', { n: 14, op: 0.07 })
      + k.pad(430, 400, 158, '#ffd166', { h: 18 })
      + k.ring(430, 396, 112, 30, '#fff', 5, 0.75) + k.ring(430, 392, 140, 37, '#fff', 4, 0.4) + k.ring(430, 388, 170, 45, '#fff', 3, 0.2)
      + k.avatar(430, 398, 1.6, { shirt: '#ff5fae', pants: '#2b2f55', hair: '#5b3a1e', pose: 'cheer', face: 'wow' })
      + k.pet(565, 318, 1.25, '#ff9a5c', { glow: true })
      // rewards flying off
      + k.pop(305, 262, '+1', 44) + k.pop(560, 212, '+1', 36, '#fff3a8', 7) + k.pop(338, 196, '+1', 26, '#ffffff', -10) + k.pop(600, 276, '+1', 24, '#ffffff', 6)
      + k.coin(276, 172, 13) + k.coin(300, 214, 10) + k.coin(262, 136, 9)
      + k.sparkles([[352, 318, 1.2], [520, 370, 0.9], [478, 190, 1.1], [384, 236, 0.7], [612, 330, 0.8], [250, 300, 0.8]], '#fff')
      + k.bush(190, 420, 1.1, '#7f4ee6') + k.rock(748, 452, 1.1, '#8a63e0');
  },

  shop: {
    title: 'SHOP', currency: 'gem', currencyColor: '#5fe1ff', bg: '#3a1d7a',
    featured: { tag: 'BEST VALUE', name: 'Starter Pack', line: 'A pet and 2x power for one hour', price: '49',
      art: () => K.burst(40, 40, 36, '#fff6c2', { sw: 0, n: 12, inner: 0.8 }) + `<g transform="translate(40 46) scale(1.25)">${K.box(-18, -8, 34, 24, '#ff5fae', { d: 7, shadow: false, sw: 3 })}</g>` + `<rect x="36" y="26" width="8" height="42" fill="#ffd166" stroke="#1b1230" stroke-width="2.500"/>` + K.coin(62, 60, 9) + K.coin(16, 62, 7) },
    items: [
      { icon: 'bolt', color: '#ff9a5c', name: '2x Power', line: 'Permanent pass', price: '199' },
      { icon: 'wand', color: '#b56bff', name: 'Auto Tap', line: 'Keeps tapping for you', price: '149' },
      { icon: 'paw', color: '#3aa0ff', name: 'Pet Slot', line: 'Equip one more pet', price: '60' },
    ],
    caption: 'One featured offer, three clear items, green buy buttons.',
  },

  // The moment players work toward, 480 x 270.
  moment: {
    title: 'REBIRTH',
    caption: 'Power resets, a permanent x2 stays. The long game.',
    svg: () => {
      const k = K;
      return k.sky('#5a1fb8', '#ff6fb5', 480, 270) + k.rays(240, 150, 330, '#fff', { n: 16, op: 0.13 }) + k.glow(240, 150, 190, '#ffd166', 0.9)
        + k.burst(240, 150, 104, '#ffd166', { n: 18, inner: 0.84 })
        + k.avatar(240, 214, 1.25, { shirt: '#ff5fae', hat: 'crown', pose: 'cheer', face: 'cool' })
        + k.text(240, 52, 'REBIRTH!', 40, { fill: '#fff6c2' })
        + k.text(104, 150, 'x2', 44, { fill: '#8dff9a', rotate: -10 }) + k.text(376, 150, 'x2', 44, { fill: '#8dff9a', rotate: 10 })
        + k.text(240, 252, 'FOREVER', 24)
        + k.sparkles([[60, 70, 1.3], [420, 64, 1.1], [398, 216, 0.9], [78, 214, 1], [330, 96, 0.7], [150, 98, 0.8]], '#fff');
    },
  },

  path: { label: 'Zones to unlock', steps: [
    { name: 'Meadow', need: 'Start here', state: 'done' },
    { name: 'Crystal Cave', need: '1K power', state: 'now' },
    { name: 'Lava Peak', need: '50K power', state: 'locked' },
    { name: 'Sky Temple', need: '2M power', state: 'locked' },
    { name: 'Rebirth', need: '10M power', state: 'locked' },
  ] },

  first60: [
    { t: '0-10s', text: 'Spawn on the pad. An arrow points at TAP.' },
    { t: '10-25s', text: 'The number climbs. First upgrade bought.' },
    { t: '25-45s', text: 'First pet hatches and follows you.' },
    { t: '45-60s', text: 'The gate to zone 2 opens.' },
  ],
  loop: ['Tap the pad', 'Power per tap', 'Multipliers and pets', 'Next zone, then rebirth'],
  mechanic: 'The twist on the tap: tap to a beat, hold to charge, or spend your power in a duel.',
  reskins: ['Aura trainer', 'Muscle gym', 'Wizard school'],
  earns: ['Coin packs, extra pet slot', 'Starter pack after zone 1', '2x power and auto-tap passes'],
  keeps: ['Day-7 reward shown on day 1', 'Daily quests on the tap loop', 'A new zone every update'],
  stats: { shared: '90%', days: '1.5', risk: 'Low' },
};
