import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/lib/settings';
import { finalizeParts, sanitizeReply, violations, type StyleContext } from '../../src/brain/style';
import { profileTone } from '../../src/brain/tone';
import type { Channel, HistoryMessage, ToneProfile, VoiceSettings } from '../../src/types';

const msg = (body: string): HistoryMessage => ({ direction: 'in', author: 'customer', body, kind: 'text', ts: 0 });
const toneOf = (...bodies: string[]): ToneProfile => profileTone(bodies.map(msg));
const ctx = (tone: ToneProfile, voice: Partial<VoiceSettings> = {}, channel: Channel = 'whatsapp'): StyleContext => ({ voice: { ...DEFAULT_SETTINGS.voice, ...voice }, tone, channel });

const chill = toneOf('yoooo brooo', 'how long is delivery');
const plain = toneOf('Hello, could you tell me how long delivery takes? Thanks.');
const formal = toneOf('Dear ACX team, I would like to enquire about the warranty period for the 250W kit. Kind regards, Margaret');

describe('sanitizeReply: dashes', () => {
  const cases: [string, string][] = [
    ['Sure — delivery is 2–4 days', 'sure delivery is 2 to 4 days'],
    ['its in stock - ships tomorrow', 'its in stock ships tomorrow'],
    ['yeah the 72-volt battery fits', 'yeah the 72 volt battery fits'],
    ['its road-legal and plug-and-play', 'its road legal and plug and play'],
    ['the e-bike kit is £649', 'the ebike kit is £649'],
    ['prices are £500-£600', 'prices are £500 to £600'],
    ['delivery -- about 3 days', 'delivery about 3 days'],
    ['3-5 working days', '3 to 5 working days'],
  ];
  for (const [input, want] of cases) {
    it(`"${input}"`, () => {
      const out = sanitizeReply(input, ctx(chill));
      expect(out).toBe(want);
      expect(violations(out)).toEqual([]);
    });
  }

  it('never leaves a dash in any register', () => {
    const nasty = 'Well — here it is – the kit - which is plug-and-play — ships in 2-4 days; order ACX-2000 today!';
    for (const tone of [chill, plain, formal]) {
      const out = sanitizeReply(nasty, ctx(tone));
      expect(violations(out)).toEqual([]);
      expect(out).toContain('ACX-2000');
      expect(out).toContain('2 to 4 days');
    }
  });

  it('keeps links, emails, phone numbers, order numbers and prices intact', () => {
    const input = 'here you go https://acxebikes.com/products/acx-2000w-bundle or email help-desk@acx-ebikes.com or call +44 7700 900-123 about order #1042-2 for £1,299';
    const out = sanitizeReply(input, ctx(chill, { max_chars: 400 }));
    expect(out).toContain('https://acxebikes.com/products/acx-2000w-bundle');
    expect(out).toContain('help-desk@acx-ebikes.com');
    expect(out).toContain('+44 7700 900-123');
    expect(out).toContain('#1042-2');
    expect(out).toContain('£1,299');
    expect(violations(out)).toEqual([]);
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

  it('keeps needed commas for neutral customers but not the chatty ones', () => {
    expect(sanitizeReply('Hi, delivery takes 3 days, but it can be quicker.', ctx(plain))).toBe('Hi delivery takes 3 days but it can be quicker.');
    expect(sanitizeReply('If it is the 2000w, you need the 48v battery.', ctx(plain))).toBe('If it is the 2000w, you need the 48v battery.');
  });

  it('can strip every comma or leave them alone', () => {
    expect(sanitizeReply('motor, controller, display', ctx(chill, { commas: 'none' }))).toBe('motor controller display');
    expect(sanitizeReply('Hey bro, all good', ctx(chill, { commas: 'normal' }))).toBe('hey bro, all good');
  });
});

describe('sanitizeReply: sounding human', () => {
  it('removes assistant filler', () => {
    expect(sanitizeReply('Certainly! Delivery is 3 days. I hope this helps! Feel free to reach out if you have any other questions.', ctx(plain))).toBe('Delivery is 3 days.');
    expect(sanitizeReply('Great question! It does fit.', ctx(chill))).toBe('it does fit');
    expect(sanitizeReply('Thank you for reaching out. The kit is in stock.', ctx(plain))).toBe('The kit is in stock.');
    expect(sanitizeReply("I'd be happy to help with that. It ships tomorrow.", ctx(plain))).toBe('It ships tomorrow.');
  });

  it('strips markdown and lists', () => {
    expect(sanitizeReply('**Yes** it fits `26 inch` wheels', ctx(plain))).toBe('Yes it fits 26 inch wheels');
    const list = sanitizeReply('You get:\n- the motor\n- the controller\n- the display', ctx(plain));
    expect(list).toBe('You get. The motor. The controller.');
    expect(violations(list)).toEqual([]);
    expect(sanitizeReply('see [the kit](https://acxebikes.com/products/kit)', ctx(chill))).toBe('see the kit https://acxebikes.com/products/kit');
  });

  it('mirrors lower case and drops the final full stop for casual texters only', () => {
    expect(sanitizeReply('Yeah it does. Ships tomorrow.', ctx(chill))).toBe('yeah it does. ships tomorrow');
    expect(sanitizeReply('yeah it does. ships tomorrow', ctx(plain))).toBe('Yeah it does. Ships tomorrow');
    expect(sanitizeReply('It is in stock — ships tomorrow.', ctx(plain))).toBe('It is in stock, ships tomorrow.');
    expect(sanitizeReply('ACX kits fit most bikes. I can check yours', ctx(chill))).toBe('ACX kits fit most bikes. I can check yours');
  });

  it('calms exclamation marks, stretched letters and emoji', () => {
    expect(sanitizeReply('Yes!!! It is in stock!! Order now!', ctx(plain))).toBe('Yes! It is in stock. Order now.');
    expect(sanitizeReply('heyyyyyy brooooo', ctx(chill))).toBe('heyyy brooo');
    expect(sanitizeReply('heyyyyyy brooooo', ctx(chill, { mirror_level: 'light' }))).toBe('heyy broo');
    expect(sanitizeReply('sorted 🔥🔥🔥', ctx(chill))).toBe('sorted'); // customer used no emoji
    expect(sanitizeReply('sorted 🔥🔥🔥', ctx(toneOf('yo 🔥 is it in stock')))).toBe('sorted 🔥');
    expect(sanitizeReply('sorted 🔥', ctx(toneOf('yo 🔥'), { emojis: 'never' }))).toBe('sorted');
  });

  it('respects banned phrases from the owner', () => {
    expect(sanitizeReply('no worries at all, it ships tomorrow', ctx(chill, { banned_phrases: ['no worries at all'] }))).toBe('it ships tomorrow');
  });
});

describe('sanitizeReply: length', () => {
  it('keeps to the sentence and character budget', () => {
    const long = 'One. Two. Three. Four. Five.';
    expect(sanitizeReply(long, ctx(plain))).toBe('One. Two. Three.');
    const out = sanitizeReply('word '.repeat(120), ctx(plain));
    expect(out.length).toBeLessThanOrEqual(260);
    const withLink = sanitizeReply(`${'x'.repeat(40)} ${'y '.repeat(100)} https://acxebikes.com/products/a-very-long-link-that-should-never-be-cut-in-half`, ctx(plain));
    expect(/https:\/\/\S*$/.test(withLink) ? withLink.endsWith('cut-in-half') : true).toBe(true);
  });

  it('gives email more room and keeps paragraphs', () => {
    const email = finalizeParts(['Hi Pat,', 'The warranty is 12 months from delivery. It covers the motor, controller and battery.', 'Thanks'], ctx(formal, {}, 'gmail'));
    expect(email).toHaveLength(1);
    expect(email[0]).toBe('Hi Pat\n\nThe warranty is 12 months from delivery. It covers the motor, controller and battery.\n\nThanks');
  });
});

describe('finalizeParts', () => {
  it('drops empty and repeated parts and caps at three', () => {
    expect(finalizeParts(['hey', 'hey', '', 'Certainly!', 'a', 'b', 'c'], ctx(chill))).toEqual(['hey', 'a', 'b']);
  });
});
