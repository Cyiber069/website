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

import { withoutConversions } from '../../src/brain/rules';
describe('a converted price is not an invented figure', () => {
  const rates = { EUR: 1.19, USD: 1.27 };
  it('lets "£719 (about €856)" through when £719 is in the knowledge', () => {
    expect(withoutConversions(['856'], 'The 25Ah is £719 (about €856)', 'ACX 3000w bundle 29 / Sw900 / 25ah | £719.00', rates)).toEqual([]);
  });
  it('still flags a number that is no conversion, or a £ price that is not in the knowledge', () => {
    expect(withoutConversions(['999'], 'The 25Ah is £719 (about €999)', '£719.00', rates)).toEqual(['999']);
    expect(withoutConversions(['856'], 'It is £720 (about €856)', '£719.00', rates)).toEqual(['856']);
    expect(withoutConversions(['856'], 'about €856', '£719.00', null)).toEqual(['856']);
  });
});

import { wordsOf } from '../../src/brain/prompt';
describe("TikTok's placeholder is not the customer's words", () => {
  it('strips it', () => {
    expect(wordsOf({ direction: 'in', author: 'customer', body: "This message type isn't supported. Download TikTok app to view this message.", kind: 'text', ts: 0 } as any)).toBe('');
    expect(wordsOf({ direction: 'in', author: 'customer', body: '[this message type is not supported]', kind: 'other', ts: 0 } as any)).toBe('');
    expect(wordsOf({ direction: 'in', author: 'customer', body: 'how fast is the 2000w', kind: 'text', ts: 0 } as any)).toBe('how fast is the 2000w');
  });
});

import { localise } from '../../src/brain/currency';
describe('prices and speeds for a customer abroad, filled in by code', () => {
  const rates = { EUR: 1.19, USD: 1.27, CHF: 1.1 };
  it('adds the euro price and km/h for an Irish number', () => {
    expect(localise('Our best bundle is the 5000W, around 50 to 60+ mph, from £819, and it ships fast.', '+353871234567', rates))
      .toBe('Our best bundle is the 5000W, around 50 to 60+ mph (80 to 97+ km/h), from £819 (about €975), and it ships fast.');
    expect(localise('The 2000W does around 32 to 38 mph.', '+4915238452770', rates)).toContain('32 to 38 mph (51 to 61 km/h)');
  });
  it('leaves what is already there, links, UK numbers and unknown numbers alone', () => {
    const done = 'From £819 (about €975), around 80 to 97+ km/h (50 to 60+ mph). https://acxebikes.com/products/acx-5000w-bundle';
    expect(localise(done, '+353871234567', rates)).toBe(done);
    expect(localise('It is £819 or €975 at checkout', '+353871234567', rates)).toBe('It is £819 or €975 at checkout');
    expect(localise('From £819, around 50 mph', '+447700900111', rates)).toBe('From £819, around 50 mph');
    expect(localise('From £819, around 50 mph', null, rates)).toBe('From £819, around 50 mph');
  });
  it('gives dollars but keeps mph for a US number, and Swiss francs with km/h', () => {
    expect(localise('From £595, around 32 to 38 mph', '+12025550123', rates)).toBe('From £595 (about $756), around 32 to 38 mph');
    expect(localise('From £819', '+41791234567', rates)).toBe('From £819 (about CHF 901)');
  });
});
