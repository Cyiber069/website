import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/lib/settings';
import { numbersPreserved, sanitizeParts, styleViolations, type SanitizeOptions } from '../../src/brain/sanitize';
import { finalizeParts, lengthLimits, sanitizeDetailed, sanitizeReply, violations, type StyleContext } from '../../src/brain/style';
import { analyzeTone, isSeriousTopic, profileTone } from '../../src/brain/tone';
import type { Channel, HistoryMessage, ToneProfile, VoiceSettings } from '../../src/types';
import examples from './vectors/examples.json';
import vectors from './vectors/sanitize.vectors.json';

const msg = (body: string): HistoryMessage => ({ direction: 'in', author: 'customer', body, kind: 'text', ts: 0 });
const toneOf = (...bodies: string[]): ToneProfile => profileTone(bodies.map(msg));
const ctx = (tone: ToneProfile, voice: Partial<VoiceSettings> = {}, channel: Channel = 'whatsapp'): StyleContext => ({ voice: { ...DEFAULT_SETTINGS.voice, ...voice }, tone, channel });

const chill = toneOf('yoooo brooo', 'how long is delivery');
const plain = toneOf('Hello, could you tell me how long delivery takes? Thanks.');
const formal = toneOf('Dear ACX team, I would like to enquire about the warranty period for the 250W kit. Kind regards, Margaret');

type Vector = { name: string; input: string[]; tone: string; opts: Partial<SanitizeOptions>; expected: string[]; flags: { blocked?: string; overflow?: boolean; empty?: boolean; regen?: string[] } };
const tones = vectors.tones as unknown as Record<string, Partial<ToneProfile>>;
const cases = vectors.cases as unknown as Vector[];

// ---- the vectors from the voice report (research/voice.md section E) ----------------------------------
// Each one is a model output with the exact text the reference sanitizer turns it into.

describe('sanitizer vectors from the voice report', () => {
  for (const c of cases) {
    it(c.name, () => {
      const r = sanitizeParts(c.input, { tone: tones[c.tone]!, ...c.opts });
      expect(r.parts).toEqual(c.expected);
      expect(r.flags.blocked ?? undefined).toBe(c.flags.blocked);
      expect(r.flags.overflow).toBe(!!c.flags.overflow);
      expect(r.flags.empty).toBe(!!c.flags.empty);
      expect(r.flags.regen).toEqual(c.flags.regen ?? []);
    });
  }
});

describe('hard guarantees', () => {
  it('hold for every vector under every tone, comma setting and channel, and a second pass changes nothing', () => {
    let runs = 0;
    for (const c of cases) for (const tone of Object.values(tones)) for (const commas of ['none', 'light', 'normal'] as const) for (const channel of ['whatsapp', 'gmail'] as const) {
      const opts = { ...c.opts, tone, commas, channel, max_chars: c.opts.max_chars ?? (channel === 'gmail' ? 600 : 260) };
      const r = sanitizeParts(c.input, opts);
      const label = `${c.name} [${tone.register}/${tone.mood}/${commas}/${channel}] -> ${JSON.stringify(r.parts)}`;
      expect(r.violations.filter((v) => v !== 'claims_human'), label).toEqual([]);
      // No dash outside a protected token, no markdown, no list, checked again from the outside.
      for (const p of r.parts) expect(styleViolations([p], { channel: 'gmail', protect: c.opts.protect }).filter((v) => v !== 'claims_human'), label).toEqual([]);
      // Prices, watts, volts and days never change.
      expect(numbersPreserved(c.input, r.parts), label).toBe(true);
      expect(r.parts.join(' ').length, label).toBeLessThanOrEqual(opts.max_chars);
      expect(r.parts.length, label).toBeLessThanOrEqual(channel === 'gmail' ? 1 : 3);
      expect(sanitizeParts(r.parts, opts).parts, `not stable: ${label}`).toEqual(r.parts);
      runs++;
    }
    expect(runs).toBeGreaterThan(500);
  });

  it('never leaves a dash in any register', () => {
    const nasty = 'Well — here it is – the kit - which is plug-and-play — ships in 2-4 days; order ACX-2000 today!';
    for (const tone of [chill, plain, formal]) {
      const out = sanitizeReply(nasty, ctx(tone));
      expect(violations(out)).toEqual([]);
      expect(out).not.toMatch(/[‐-―−;]/);
      expect(out.replace('ACX-2000', '')).not.toContain('-');
      expect(out).toContain('ACX-2000');
      expect(out).toContain('2 to 4 days');
    }
  });

  it('keeps links, emails, phone numbers, order numbers and prices byte for byte', () => {
    const input = 'here you go https://acxebikes.com/products/acx-2000w-bundle or email help-desk@acx-ebikes.com or call +44 7700 900-123 about order #1042-2 for £1,299';
    const out = sanitizeReply(input, ctx(chill, { max_chars: 400 }));
    for (const keep of ['https://acxebikes.com/products/acx-2000w-bundle', 'help-desk@acx-ebikes.com', '+44 7700 900-123', '#1042-2', '£1,299']) expect(out).toContain(keep);
    expect(violations(out)).toEqual([]);
  });

  it('reports what a dirty text breaks', () => {
    expect(violations('fine as it is')).toEqual([]);
    expect(violations('2-4 days')).toContain('hyphen_outside_protected_span');
    expect(violations('wait — what')).toContain('dash_char');
    expect(violations('**bold**')).toContain('markdown');
    expect(violations('- one\n- two')).toContain('hyphen_outside_protected_span');
    expect(violations('• one\n• two')).toContain('list_marker');
    expect(violations('this; that')).toContain('semicolon');
    expect(violations('see https://acxebikes.com/a-b-c and order #10-2 or ACX-72V-40AH')).toEqual([]);
    expect(styleViolations(['a', 'b', 'c', 'd'], { channel: 'whatsapp' })).toContain('too_many_parts');
  });
});

// ---- golden replies: good writing must pass through untouched --------------------------------------

describe('golden replies from the voice report', () => {
  type Golden = { id: string; label: string; channel: Channel; customer: { body: string; kind: string }[]; parts: string[]; flags?: { asked_if_bot?: boolean } };
  for (const e of (examples.golden as unknown as Golden[]).filter((g) => g.parts.length)) {
    it(`${e.id} ${e.label} is left exactly as written`, () => {
      const a = analyzeTone(e.customer.map((m) => ({ body: m.body, kind: m.kind as HistoryMessage['kind'] })));
      const gmail = e.channel === 'gmail';
      const r = sanitizeParts(e.parts, {
        tone: a.profile, channel: e.channel, customer_emojis: a.emojis, asked_if_bot: !!e.flags?.asked_if_bot,
        serious: isSeriousTopic(e.customer.map((m) => m.body).join(' ')), max_chars: gmail ? 600 : 260, max_sentences: gmail ? 6 : 3,
      });
      expect(r.parts).toEqual(e.parts);
      expect(r.violations).toEqual([]);
      expect(r.flags).toMatchObject({ blocked: null, overflow: false, regen: [] });
    });
  }

  for (const b of examples.bot_lines) {
    it(`the honest bot answer survives (${b.register})`, () => {
      const r = sanitizeParts(b.parts, { tone: profileTone([{ body: b.asked }]), asked_if_bot: true });
      expect(r.parts).toEqual(b.parts);
      expect(r.flags.blocked).toBeNull();
    });
  }

  for (const n of examples.negative.filter((x) => x.caught !== 'prompt')) {
    it(`${n.id} machine sounding text is ${n.caught === 'block' ? 'blocked' : n.caught === 'flag' ? 'flagged' : 'rewritten'}`, () => {
      const r = sanitizeParts(n.bad, { tone: { register: 'neutral', mood: 'neutral' } });
      if (n.caught === 'block') expect(r.flags.blocked).toBe('claims_human');
      if (n.caught === 'flag') expect(r.flags.regen.length).toBeGreaterThan(0);
      if (n.caught === 'sanitizer') expect(r.parts).not.toEqual(n.bad);
      for (const p of r.parts) expect(violations(p)).toEqual([]);
    });
  }
});

// ---- the adapter the rest of the backend uses --------------------------------------------------------

describe('sanitizeReply: dashes', () => {
  const cases2: [string, string][] = [
    ['Sure — delivery is 2–4 days', 'sure delivery is 2 to 4 days'],
    ['yeah the 72-volt battery fits', 'yeah the 72 volt battery fits'],
    ['its road-legal and plug-and-play', 'its road legal and plug and play'],
    ['the e-bike kit is £649', 'the ebike kit is £649'],
    ['prices are £500-£600', 'prices are £500 to £600'],
    ['3-5 working days', '3 to 5 working days'],
    ['delivery -- about 3 days', 'delivery about 3 days'],
  ];
  for (const [input, want] of cases2) {
    it(`"${input}"`, () => {
      const out = sanitizeReply(input, ctx(chill));
      expect(out).toBe(want);
      expect(violations(out)).toEqual([]);
    });
  }

  it('turns a dash between two full thoughts into two sentences', () => {
    expect(sanitizeReply('its in stock right now - we can ship it tomorrow', ctx(chill))).toBe('its in stock right now. we can ship it tomorrow');
  });
});

describe('sanitizeReply: commas', () => {
  it('drops conversational commas for casual customers', () => {
    expect(sanitizeReply('Hey bro, delivery is 3 days', ctx(chill))).toBe('hey bro delivery is 3 days');
    expect(sanitizeReply('yeah, it fits most bikes', ctx(chill))).toBe('yeah it fits most bikes');
    expect(sanitizeReply('no worries mate, its sorted', ctx(chill))).toBe('no worries mate its sorted');
    expect(sanitizeReply('its in stock, and ships tomorrow', ctx(chill))).toBe('its in stock and ships tomorrow');
    expect(sanitizeReply('if its the 2000w, you need the 48v battery', ctx(chill))).toBe('if its the 2000w you need the 48v battery');
  });

  it('keeps real lists and numbers', () => {
    expect(sanitizeReply('comes with the motor, controller, display and throttle', ctx(chill))).toBe('comes with the motor, controller, display and throttle');
    expect(sanitizeReply('that one is £1,299', ctx(chill))).toBe('that one is £1,299');
  });

  it('can strip every comma or leave them alone', () => {
    expect(sanitizeReply('motor, controller, display', ctx(chill, { commas: 'none' }))).toBe('motor controller display');
    expect(sanitizeReply('Hey bro, all good', ctx(chill, { commas: 'normal' }))).toBe('hey bro, all good');
  });
});

describe('sanitizeReply: machine habits', () => {
  it('removes assistant filler and keeps the answer', () => {
    expect(sanitizeReply('Great question! Delivery is 3 days. I hope this helps! Feel free to reach out if you have any other questions.', ctx(plain))).toBe('Delivery is 3 days');
    expect(sanitizeReply('Certainly! The kit is in stock.', ctx(plain))).toBe('The kit is in stock');
    expect(sanitizeReply('Thank you for reaching out. Please note that delivery is 3 days.', ctx(plain))).toBe('Delivery is 3 days');
    expect(sanitizeReply('I hope this helps!', ctx(plain))).toBe('');
  });

  it('removes phrases the owner banned', () => {
    expect(sanitizeReply('no worries, it ships tomorrow', ctx(chill, { banned_phrases: ['no worries'] }))).toBe('it ships tomorrow');
    expect(sanitizeReply('Awesome! It ships tomorrow', ctx(plain, { banned_phrases: ['awesome'] }))).toBe('It ships tomorrow');
  });

  it('strips markdown and turns lists into a sentence', () => {
    expect(sanitizeReply('**Yes** it is `in stock` and [here](https://acxebikes.com/x-y) it is', ctx(plain, { max_chars: 400 }))).toBe('Yes it is in stock and here https://acxebikes.com/x-y it is');
    expect(sanitizeReply('You get:\n- the motor\n- the controller\n- the display', ctx(plain))).toBe('You get the motor, the controller and the display');
    expect(sanitizeReply('# Heading\n\n1. First do this\n2. Then do that', ctx(plain))).not.toMatch(/[#*]|\d\.\s/);
  });
});

describe('sanitizeReply: mirroring', () => {
  it('writes lower case with no final full stop for a casual texter', () => {
    expect(sanitizeReply('Yeah it does. Ships tomorrow.', ctx(chill))).toBe('yeah it does. ships tomorrow');
    expect(sanitizeReply('I think so. I will check.', ctx(chill))).toBe('i think so. i will check');
  });

  it('keeps capitals for a neutral customer, and full stops for a formal one', () => {
    expect(sanitizeReply('Yes it does. It ships tomorrow.', ctx(plain))).toBe('Yes it does. It ships tomorrow');
    expect(sanitizeReply('Yes, it does. It ships tomorrow.', ctx(formal))).toBe('Yes, it does. It ships tomorrow.');
  });

  it('does not mirror when the owner switched it off', () => {
    expect(sanitizeReply('Heyyyy broooo it ships tomorrow!!', ctx(chill, { mirror_level: 'off' }))).toBe('Hey bro it ships tomorrow!');
  });

  it('calms exclamation marks and stretched letters, a notch below the customer', () => {
    const hype = toneOf('yoooo brooo thats sickkk!!! 🔥🔥', 'need it nowww');
    expect(hype.register).toBe('hype');
    const out = sanitizeReply('yoooooo broooooo!!!! its in stock!!!! ships tomorrow!!!!', ctx(hype));
    expect(out).not.toMatch(/(\p{L})\1{2,}/u);
    expect((out.match(/!/g) ?? []).length).toBeLessThanOrEqual(2);
    expect(sanitizeReply('Yes!!! It is in stock!!! Order now!!!', ctx(plain))).toBe('Yes! It is in stock. Order now');
    expect(sanitizeReply('Yes!!! It is in stock!', ctx(formal))).not.toContain('!');
  });

  it('mirrors emoji only as far as the customer and the owner allow', () => {
    const emojiFan: StyleContext = { ...ctx(toneOf('yo 🔥🔥', 'is it fast 🔥')), customer_emojis: ['🔥'] };
    expect(sanitizeReply('yeah its rapid 🔥🔥🔥🔥', emojiFan).match(/🔥/g)).toHaveLength(2);
    expect(sanitizeReply('yeah its rapid 🔥', { ...emojiFan, voice: { ...emojiFan.voice, emojis: 'never' } })).toBe('yeah its rapid');
    expect(sanitizeReply('It ships tomorrow 🔥', ctx(plain))).toBe('It ships tomorrow');
    // Checklist style emoji never go out, whoever uses them.
    expect(sanitizeReply('✅ in stock 🚀', emojiFan)).toBe('in stock');
  });

  it('stays plain for an upset customer or a serious topic', () => {
    const angry = toneOf('yo bro this is a joke, absolute scam, refund me now');
    expect(sanitizeReply('Sorryyyy bro!!! We will sort it 🔥', ctx(angry))).toBe('Sorry bro. We will sort it');
    const serious: StyleContext = { ...ctx(chill), serious: true };
    expect(sanitizeReply('Yeah you can return it within 14 days.', serious)).toBe('Yeah you can return it within 14 days');
  });
});

describe('length limits', () => {
  it('keeps to the sentence and character budget, dropping filler before facts', () => {
    const long = 'Delivery is 2 to 4 days in the UK. That is nice and quick for most people. It is free on every order. We ship every weekday morning. You get tracking by email.';
    const r = sanitizeDetailed([long], ctx(plain, { max_sentences: 2, max_chars: 120 }));
    expect(r.parts.join(' ').length).toBeLessThanOrEqual(120);
    expect(r.parts.join(' ')).toContain('2 to 4 days');
    expect(r.flags.overflow).toBe(true);
    expect(r.flags.dropped.length).toBeGreaterThan(0);
  });

  it('cuts one endless sentence at a word, never through a link', () => {
    const out = sanitizeReply(`${'really '.repeat(60)}long https://acxebikes.com/products/acx-2000w-bundle`, ctx(plain, { max_chars: 100 }));
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('really')).toBe(true);
    const link = sanitizeReply(`see https://acxebikes.com/products/acx-2000w-bundle-with-a-very-long-name-indeed ${'and more words '.repeat(10)}`, ctx(plain, { max_chars: 90 }));
    expect(link.length).toBeLessThanOrEqual(90);
    // The link is either whole or gone, never cut in half.
    expect(link.includes('https://') ? link : 'https://acxebikes.com/products/acx-2000w-bundle-with-a-very-long-name-indeed').toContain('acx-2000w-bundle-with-a-very-long-name-indeed');
  });

  it('gives email more room and keeps its paragraphs', () => {
    expect(lengthLimits(DEFAULT_SETTINGS.voice, 'whatsapp')).toEqual({ max_chars: 260, max_sentences: 3 });
    expect(lengthLimits(DEFAULT_SETTINGS.voice, 'gmail')).toEqual({ max_chars: 600, max_sentences: 6 });
    const email = 'Good afternoon Margaret\n\nYes, the 250W kit fits a 700c wheel. Please choose the 700c option at checkout so the rim size matches.\n\nKind regards\nACX Ebikes';
    expect(sanitizeReply(email, ctx(formal, {}, 'gmail'))).toBe(email);
    expect(sanitizeReply('line one\nline two', ctx(plain))).not.toContain('\n');
  });
});

describe('finalizeParts', () => {
  it('cleans every part, drops empties and repeats', () => {
    expect(finalizeParts(['Hey bro,', '', 'I hope this helps!', 'Delivery is 2-4 days.', 'Delivery is 2-4 days.'], ctx(chill))).toEqual(['hey bro', 'delivery is 2 to 4 days']);
    expect(finalizeParts([], ctx(chill))).toEqual([]);
    expect(finalizeParts(['   '], ctx(chill))).toEqual([]);
  });

  it('never sends more than three chat messages, folding the rest into the last', () => {
    const out = finalizeParts(['hey', 'its in stock', 'ships tomorrow', 'arrives friday', 'tracked'], ctx(chill, { max_sentences: 8 }));
    expect(out).toHaveLength(3);
    expect(out.join(' ')).toContain('tracked');
  });

  it('sends one message on email', () => {
    const out = finalizeParts(['Hello Margaret', 'Delivery takes 2-4 working days.', 'Kind regards\nACX Ebikes'], ctx(formal, {}, 'gmail'));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('2 to 4 working days');
    expect(out[0]).toContain('\n\n');
    expect(violations(out[0]!)).toEqual([]);
  });

  it('leaves the test mode replies readable', () => {
    expect(finalizeParts(['mock reply to: yo how long is delivery'], ctx(chill))).toEqual(['mock reply to: yo how long is delivery']);
    expect(finalizeParts(['polished: fits any 135mm dropout'], ctx(chill))).toEqual(['polished: fits any 135mm dropout']);
    const dashes = finalizeParts(['Sure — delivery is 2-4 days, and it is free - no worries!'], ctx(plain));
    expect(dashes).toHaveLength(1);
    expect(dashes[0]).toContain('2 to 4 days');
    expect(violations(dashes[0]!)).toEqual([]);
  });
});
