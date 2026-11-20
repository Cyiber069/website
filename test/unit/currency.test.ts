import { describe, expect, it } from 'vitest';
import { countryFromPhone, currencyNote, playbookPrices, type FxRates } from '../../src/brain/currency';
import { readFileSync } from 'node:fs';
import { unsupportedNumbers } from '../../src/brain/prompt';

const playbook = readFileSync(new URL('../../seed/knowledge/reply-playbook.md', import.meta.url), 'utf8');
const prices = playbookPrices(playbook);

const fx: FxRates = { date: '2026-11-20', fetched_at: 0, rates: { EUR: 1.17, USD: 1.27, CHF: 1.12 } };

describe('currency from the phone number', () => {
  it('reads the country code', () => {
    expect(countryFromPhone('+353871234567')?.currency).toBe('EUR');
    expect(countryFromPhone('+4915238452770')?.currency).toBe('EUR');
    expect(countryFromPhone('+447501483801')?.currency).toBe('GBP');
    expect(countryFromPhone('+12025550123')?.currency).toBe('USD');
    expect(countryFromPhone('+41791234567')?.currency).toBe('CHF');
    expect(countryFromPhone('0035387123456')?.currency).toBe('EUR');
    expect(countryFromPhone(null)).toBeNull();
    expect(countryFromPhone('07501483801')).toBeNull();
  });
});

describe('the currency note', () => {
  it('reads the playbook prices', () => {
    expect(prices).toContainEqual(['5000W bundle', 819]);
    expect(prices.length).toBeGreaterThan(10);
  });

  it('gives an Irish customer euro prices to copy, and they pass the figure check', () => {
    const note = currencyNote('+353871234567', fx, prices);
    expect(note).toMatch(/Ireland/);
    expect(note).toMatch(/5000W bundle £819 = about €958/);
    expect(unsupportedNumbers('Our best bundle is the 5000W bundle, £819 (about €958)', note)).toEqual([]);
    expect(note).not.toMatch(/[—–]/);
  });

  it('keeps a UK customer in pounds and still lists euros and dollars', () => {
    const note = currencyNote('+447501483801', fx, prices);
    expect(note).toMatch(/from the UK/);
    expect(note).toMatch(/EUR \(£1 = €1\.17\)/);
    expect(note).toMatch(/USD/);
  });

  it('says nothing without rates', () => {
    expect(currencyNote('+353871234567', null, prices)).toBe('');
  });
});
