import { describe, expect, it } from 'vitest';
import { collapseElongation, profileTone } from '../../src/brain/tone';
import type { HistoryMessage } from '../../src/types';

const t = (...bodies: string[]) => profileTone(bodies.map((body): HistoryMessage => ({ direction: 'in', author: 'customer', body, kind: 'text', ts: 0 })));

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

  it('only counts "man" and "g" as address terms at the end of a message', () => {
    expect(t('is this for a man or a woman').address_terms).toEqual([]);
    expect(t('safe g').address_terms).toContain('g');
    expect(t('cheers man').address_terms).toContain('man');
  });

  it('ignores our own messages and non text', () => {
    const p = profileTone([
      { direction: 'out', author: 'agent', body: 'Dear customer, kind regards', kind: 'text', ts: 0 },
      { direction: 'in', author: 'customer', body: '', kind: 'voice', ts: 0 },
      { direction: 'in', author: 'customer', body: 'yo', kind: 'text', ts: 0 },
    ]);
    expect(p.greeting).toBe('yo');
    expect(p.register).not.toBe('formal');
  });

  it('handles an empty history', () => {
    const p = profileTone([]);
    expect(p.register).toBe('neutral');
    expect(p.language).toBe('en');
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
