import { describe, expect, it } from 'vitest';
import { analyzeTone, collapseElongation, isSeriousTopic, mirrorPlan, profileTone } from '../../src/brain/tone';
import type { HistoryMessage, ToneProfile } from '../../src/types';
import vectors from './vectors/tone.vectors.json';

const t = (...bodies: string[]) => profileTone(bodies.map((body): HistoryMessage => ({ direction: 'in', author: 'customer', body, kind: 'text', ts: 0 })));

// Vectors from the voice research (research/voice.md section F). Each one is a short run of customer
// messages with the exact profile, prompt notes and mirror plan the reference implementation gives.
describe('tone vectors from the voice report', () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const messages = c.messages.map((m) => ({ body: m.body, kind: m.kind as HistoryMessage['kind'] }));
      const a = analyzeTone(messages);
      expect(a.profile).toEqual(c.expected);
      expect(a.notes).toEqual(c.notes);
      expect(mirrorPlan(a.profile, { max_chars: 260, emojis: 'mirror', mirror_level: 'match' })).toEqual(c.plan);
    });
  }
});

describe('profileTone', () => {
  it('reads a hyped casual opener', () => {
    const p = t('yoooo brooo');
    expect(p.register).toBe('hype');
    expect(p.greeting).toBe('yo');
    expect(p.address_terms).toContain('bro');
    expect(p.lowercase).toBe(true);
    expect(p.punctuation).toBe('none');
    expect(p.elongation).toBeGreaterThan(0.5);
  });

  it('reads plain casual texting', () => {
    const p = t('hi mate is the 2000w kit in stock', 'wanna order today tbh');
    expect(p.register).toBe('casual');
    expect(p.greeting).toBe('hi');
    expect(p.address_terms).toEqual(['mate']);
    expect(p.slang).toEqual(expect.arrayContaining(['wanna', 'tbh']));
    expect(p.mood).toBe('neutral');
  });

  it('reads a neutral customer', () => {
    const p = t('Hello, how long does delivery to Leeds take?');
    expect(p.register).toBe('neutral');
    expect(p.lowercase).toBe(false);
    expect(p.greeting).toBe('hello');
    expect(p.address_terms).toEqual([]);
  });

  it('reads a formal email', () => {
    const p = t('Dear Sir or Madam, I would like to enquire whether the 250W kit is legal for road use in the UK. Kind regards, Margaret Hughes');
    expect(p.register).toBe('formal');
    expect(p.greeting).toBe('dear');
  });

  it('spots anger, frustration, confusion and good moods', () => {
    expect(t('This is a JOKE. Absolute scam, I want my money back NOW!!!').mood).toBe('angry');
    expect(t('still waiting on my order, no reply from anyone').mood).toBe('frustrated');
    expect(t('im confused which battery do i need??').mood).toBe('confused');
    expect(t('thanks bro thats sick').mood).toBe('positive');
    expect(t('do you ship to france').mood).toBe('neutral');
  });

  it('counts emoji and guesses language only on clear evidence', () => {
    expect(t('yo 🔥🔥', 'is it fast 😅').emoji_rate).toBe(1.5);
    expect(t('hola buenas, cuanto cuesta el envio para España gracias').language).toBe('es');
    expect(t('bonjour, combien pour la livraison en France merci').language).toBe('fr');
    expect(t('hi how much is delivery').language).toBe('en');
  });

  it('only counts "man" and "g" as address terms when they address someone', () => {
    expect(t('is this for a man or a woman').address_terms).toEqual([]);
    expect(t('safe g').address_terms).toContain('g');
    expect(t('cheers man').address_terms).toContain('man');
  });

  it('ignores our own messages and non text', () => {
    const p = profileTone([
      { direction: 'out', author: 'agent', body: 'Dear customer, kind regards', kind: 'text', ts: 0 },
      { direction: 'in', author: 'customer', body: '', kind: 'voice', ts: 0 },
      { direction: 'in', author: 'customer', body: 'yo', kind: 'text', ts: 0 },
    ] as HistoryMessage[]);
    expect(p.greeting).toBe('yo');
    expect(p.register).not.toBe('formal');
  });

  it('handles an empty history', () => {
    const p = profileTone([]);
    expect(p.register).toBe('neutral');
    expect(p.language).toBe('en');
    expect(analyzeTone([]).notes).toEqual([]);
  });
});

describe('mirrorPlan', () => {
  const hype = t('yoooo brooo', 'how fast does the 5000w go 🔥🔥');

  it('mirrors a notch calmer for a hyped customer', () => {
    const plan = mirrorPlan(hype, { mirror_level: 'match', emojis: 'mirror', max_chars: 260 });
    // "yo" is answered with "hey": one notch calmer. Lower case is never mirrored, however the customer writes.
    expect(hype.lowercase).toBe(true);
    expect(plan).toMatchObject({ greeting: 'hey', address: 'bro', stretch_words: 1, lowercase: false, emoji_max: 1, exclamations_max: 2, end_with_full_stop: false, serious: false });
  });

  it('follows the owner settings', () => {
    expect(mirrorPlan(hype, { mirror_level: 'off' })).toMatchObject({ address: '', stretch_words: 0, lowercase: false });
    expect(mirrorPlan(hype, { mirror_level: 'light' })).toMatchObject({ address: 'bro', stretch_words: 0, lowercase: false });
    expect(mirrorPlan(hype, { emojis: 'never' }).emoji_max).toBe(0);
    expect(mirrorPlan(hype, { max_chars: 80 }).char_budget).toBeLessThanOrEqual(80);
  });

  it('never mirrors slang or stretching back at an upset or formal customer', () => {
    const angry: ToneProfile = { ...t('yo bro this is a joke, absolute scam, refund me now'), address_terms: ['bro'] };
    expect(angry.mood).toBe('angry');
    expect(mirrorPlan(angry)).toMatchObject({ address: '', stretch_words: 0, lowercase: false, emoji_max: 0, exclamations_max: 0 });
    const formal = t('Dear Sir or Madam, I would like to enquire about the warranty. Kind regards, Margaret');
    expect(mirrorPlan(formal)).toMatchObject({ greeting: 'Hello', address: '', end_with_full_stop: true, exclamations_max: 0 });
  });
});

describe('serious topics', () => {
  it('are spotted from the words alone', () => {
    for (const t of ['can i get a refund', 'i want to return the battery', 'the battery is getting very hot', 'is the 1000w road legal', 'it cut out and i came off', 'can my 12 year old ride it', 'how do i derestrict it']) expect(isSeriousTopic(t), t).toBe(true);
    for (const t of ['yo how fast is the 5000w', 'do u ship to ireland', 'whats the price', 'cheers bro']) expect(isSeriousTopic(t), t).toBe(false);
  });

  it('switch mirroring off even for a relaxed customer', () => {
    const casual = t('yoooo brooo', 'can i leave the 72v charging overnight');
    expect(mirrorPlan(casual, {}, false)).toMatchObject({ address: 'bro', lowercase: false });
    expect(mirrorPlan(casual, {}, true)).toMatchObject({ address: '', lowercase: false, stretch_words: 0, emoji_max: 0, exclamations_max: 0, serious: true });
    expect(mirrorPlan(casual, {}, true).char_budget).toBeGreaterThanOrEqual(160);
  });
});

describe('collapseElongation', () => {
  it('shrinks stretched words but leaves real double letters', () => {
    expect(collapseElongation('brooo')).toBe('bro');
    expect(collapseElongation('yooooo')).toBe('yo');
    expect(collapseElongation('cool')).toBe('cool');
    expect(collapseElongation('hello')).toBe('hello');
  });
});
