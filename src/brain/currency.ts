// Currencies: which one a customer most likely pays in (from their phone number), and today's rates from
// pounds, fetched once a day from the European Central Bank's reference rates (api.frankfurter.app, no key).
// The brain gets a ready made table of the playbook's starting prices in that currency, so it never does
// the sums itself and the figure check finds every converted price in its sources.
import type { Env } from '../types';
import { cachedState, setState } from '../lib/settings';

export interface FxRates { date: string; fetched_at: number; rates: Record<string, number> }

interface Country { country: string; currency: string; symbol: string }

const EUR = (country: string): Country => ({ country, currency: 'EUR', symbol: '€' });
// Longest prefix wins. +1 is the US and Canada; the US is far more likely for this shop.
const PREFIXES: [string, Country][] = [
  ['44', { country: 'the UK', currency: 'GBP', symbol: '£' }],
  ['353', EUR('Ireland')], ['49', EUR('Germany')], ['33', EUR('France')], ['34', EUR('Spain')], ['39', EUR('Italy')],
  ['31', EUR('the Netherlands')], ['32', EUR('Belgium')], ['351', EUR('Portugal')], ['43', EUR('Austria')], ['30', EUR('Greece')],
  ['358', EUR('Finland')], ['372', EUR('Estonia')], ['371', EUR('Latvia')], ['370', EUR('Lithuania')], ['386', EUR('Slovenia')],
  ['421', EUR('Slovakia')], ['357', EUR('Cyprus')], ['356', EUR('Malta')], ['352', EUR('Luxembourg')], ['385', EUR('Croatia')],
  ['1', { country: 'the US or Canada', currency: 'USD', symbol: '$' }],
  ['41', { country: 'Switzerland', currency: 'CHF', symbol: 'CHF ' }],
  ['47', { country: 'Norway', currency: 'NOK', symbol: 'NOK ' }],
  ['46', { country: 'Sweden', currency: 'SEK', symbol: 'SEK ' }],
  ['45', { country: 'Denmark', currency: 'DKK', symbol: 'DKK ' }],
  ['48', { country: 'Poland', currency: 'PLN', symbol: 'PLN ' }],
  ['420', { country: 'Czechia', currency: 'CZK', symbol: 'CZK ' }],
  ['36', { country: 'Hungary', currency: 'HUF', symbol: 'HUF ' }],
  ['40', { country: 'Romania', currency: 'RON', symbol: 'RON ' }],
  ['359', { country: 'Bulgaria', currency: 'BGN', symbol: 'BGN ' }],
  ['354', { country: 'Iceland', currency: 'ISK', symbol: 'ISK ' }],
  ['61', { country: 'Australia', currency: 'AUD', symbol: 'A$' }],
  ['64', { country: 'New Zealand', currency: 'NZD', symbol: 'NZ$' }],
  ['27', { country: 'South Africa', currency: 'ZAR', symbol: 'R' }],
  ['65', { country: 'Singapore', currency: 'SGD', symbol: 'S$' }],
  ['852', { country: 'Hong Kong', currency: 'HKD', symbol: 'HK$' }],
  ['81', { country: 'Japan', currency: 'JPY', symbol: '¥' }],
  ['82', { country: 'South Korea', currency: 'KRW', symbol: 'KRW ' }],
  ['60', { country: 'Malaysia', currency: 'MYR', symbol: 'RM' }],
  ['972', { country: 'Israel', currency: 'ILS', symbol: 'ILS ' }],
  ['91', { country: 'India', currency: 'INR', symbol: 'INR ' }],
  ['971', { country: 'the UAE', currency: 'AED', symbol: 'AED ' }],
  ['966', { country: 'Saudi Arabia', currency: 'SAR', symbol: 'SAR ' }],
];

/** The customer's likely country and currency from an international phone number, or null. */
export function countryFromPhone(phone: string | null | undefined): Country | null {
  const raw = String(phone ?? '').trim();
  const digits = raw.replace(/^(?:\+|00)/, '').replace(/\D/g, '');
  // Contacts keep E.164 numbers with a +. A bare number is only trusted when it is long enough to carry a country code.
  if (!/^(?:\+|00)/.test(raw) && digits.length < 11) return null;
  let best: Country | null = null;
  let len = 0;
  for (const [p, c] of PREFIXES) if (digits.startsWith(p) && p.length > len) { best = c; len = p.length; }
  return best;
}

/** The playbook's starting prices in pounds: [name, price]. */
export function playbookPrices(text: string): [string, number][] {
  const out: [string, number][] = [];
  for (const m of text.matchAll(/^\| ([^|]+?) \| £(\d+(?:\.\d+)?)/gm)) out.push([m[1]!.trim(), Number(m[2])]);
  return out;
}

const round = (n: number): string => {
  const r = n >= 1000 ? Math.round(n / 5) * 5 : Math.round(n);
  return r.toLocaleString('en-GB');
};

/**
 * The note for the brain: the customer's likely currency and a table of starting prices in it, plus euro
 * and dollar tables, so a conversion is always copied, never worked out. Empty when no rates are stored.
 */
export function currencyNote(phone: string | null | undefined, fx: FxRates | null, prices: [string, number][]): string {
  if (!fx) return '';
  const who = countryFromPhone(phone);
  const lines: string[] = [];
  const table = (code: string, symbol: string): string | null => {
    const rate = fx.rates[code];
    if (!rate || !prices.length) return null;
    return `${code} (£1 = ${symbol.trim()}${rate.toFixed(2)}): ${prices.map(([name, gbp]) => `${name} £${gbp} = about ${symbol}${round(gbp * rate)}`).join('; ')}`;
  };
  if (who && who.currency !== 'GBP') {
    const t = table(who.currency, who.symbol);
    lines.push(`The customer's phone number is from ${who.country}, so they most likely pay in ${who.currency}. Whenever you state a price, give it in pounds with the amount in ${who.currency} next to it, copied from the table below (for a price that is not in the table, multiply the pound price by the rate and round to a whole number), for example "£819 (about ${t ? `${who.symbol}${round(819 * fx.rates[who.currency]!)}` : 'the same in their currency'})", and say checkout shows the exact price in their currency. When you mention delivery, give the time and cost for ${who.country}, not for the UK.`);
    if (t) lines.push(t);
  } else if (who) {
    lines.push('The customer\'s phone number is from the UK: give prices in pounds unless they ask for another currency.');
  }
  for (const [code, symbol] of [['EUR', '€'], ['USD', '$']] as const) if (code !== who?.currency) { const t = table(code, symbol); if (t) lines.push(t); }
  lines.push(`Exchange rates of ${fx.date} (European Central Bank). Converted prices are always "about": checkout shows the exact price in the customer's currency. For any other currency say checkout shows the exact price in their currency.`);
  return lines.join('\n');
}

export async function storedRates(db: D1Database): Promise<FxRates | null> {
  const fx = await cachedState<FxRates | null>(db, 'fx_rates', null);
  return fx && typeof fx === 'object' && fx.rates ? fx : null;
}

const DAY = 86_400_000;
let lastTry = 0;   // per isolate: a failing fetch is tried at most once an hour

/** Once a day (cron): today's rates from pounds. Never throws; old rates stay when the fetch fails. */
export async function refreshRates(env: Env, now: number): Promise<boolean> {
  if (env.ACX_TEST_MODE === '1') return false;
  const fx = await storedRates(env.DB);
  if (fx && now - fx.fetched_at < DAY) return false;
  if (now - lastTry < DAY / 24) return false;
  lastTry = now;
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=GBP', { headers: { accept: 'application/json' } });
    if (!res.ok) return false;
    const body = (await res.json()) as { date?: string; rates?: Record<string, number> };
    if (!body.rates || typeof body.rates.EUR !== 'number') return false;
    await setState(env.DB, 'fx_rates', { date: String(body.date ?? ''), fetched_at: now, rates: body.rates } satisfies FxRates);
    return true;
  } catch {
    return false;
  }
}

/** Countries that think in mph. Everyone else gets km/h next to a speed. */
const MPH_CURRENCIES = new Set(['GBP', 'USD']);

/**
 * The model is told to give a price in the customer's currency and a speed in km/h, and mostly does. This
 * makes sure: a "£819" with no amount in their currency after it becomes "£819 (about €975)", and for a
 * customer outside the UK and the US "32 to 38 mph" becomes "32 to 38 mph (51 to 61 km/h)". Links are left
 * alone. Nothing changes for a UK number, an unknown number, or when no rates are stored.
 */
export function localise(text: string, phone: string | null | undefined, rates: Record<string, number> | null | undefined): string {
  const who = countryFromPhone(phone);
  if (!who || who.currency === 'GBP') return text;
  const rate = rates?.[who.currency];
  let out = text;
  if (rate) {
    let done = 0;
    out = out.replace(/£\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d\d)?)(\s*\((?:about|around|approx)[^)]*\))?/g, (m, n: string, already: string | undefined, at: number) => {
      // Not inside a link, not when an amount in another currency already follows, and at most three per message.
      if (already || done >= 3 || /https?:\/\/\S*$/.test(out.slice(0, at))) return m;
      if (new RegExp(`^.{0,24}(?:${who.symbol.trim().replace(/[$]/g, '\\$&')}|${who.currency})\\s?\\d`, 'i').test(out.slice(at + m.length))) return m;
      done++;
      return `${m} (about ${who.symbol}${round(Number(n.replace(/,/g, '')) * rate)})`;
    });
  }
  if (!MPH_CURRENCIES.has(who.currency) && !/km\/?h/i.test(out)) {
    const kmh = (v: string) => String(Math.round(Number(v) * 1.609));
    out = out.replace(/\b(\d{2})( to (\d{2}))?(\+)?\s?mph\b/g, (m, a: string, _r, b: string | undefined, plus: string | undefined) => `${m} (${kmh(a)}${b ? ` to ${kmh(b)}` : ''}${plus ?? ''} km/h)`);
  }
  return out;
}
