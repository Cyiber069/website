// Turns what a customer typed into a safe FTS5 MATCH string. Pure functions, no database.
//
// Raw text can never be passed to MATCH: quotes, hyphens, colons, brackets and words like AND or
// NEAR are query syntax there and would throw. Every term is therefore reduced to letters and
// digits, wrapped in double quotes and joined with OR. The string is always bound as a parameter.

// Words that say nothing about the topic. Greetings and filler are here too because customers open
// with them ("yo bro quick question").
const STOP = new Set((
  'a an the and or but if so of to in on at by for from with about into over than then that this these those is are was were be been being am ' +
  'do does did doing done have has had having i me my mine we us our you your yours he him his she her it its they them their what which who ' +
  'whom when where why how can could would should will shall may might must not no nor yes yeah yep ok okay please pls thanks thank cheers hi ' +
  'hey hello yo hiya bro bruv mate man fam boss pal guys just really very also too some any all more most much many get got getting go going ' +
  'want wanna need know tell say said like there here out up down off again still only one ones as im ive id ill dont doesnt cant wont isnt ' +
  'u ur r lol btw tbh ngl quick question wondering looking'
).split(' '));

// Customers and the shop often use different words for the same thing. Each group is searched together.
const SYNONYM_GROUPS: string[][] = [
  ['delivery', 'deliver', 'delivered', 'shipping', 'ship', 'ships', 'shipped', 'dispatch', 'dispatched', 'postage', 'arrive', 'arrives', 'courier'],
  ['return', 'returns', 'refund', 'refunds', 'refunded', 'exchange'],
  ['price', 'prices', 'cost', 'costs', 'pricing'],
  ['warranty', 'guarantee', 'faulty', 'fault'],
  ['legal', 'road', 'law', 'licence', 'license'],
  ['fit', 'fits', 'fitting', 'compatible', 'install', 'installation'],
  ['pay', 'payment', 'klarna', 'instalments', 'installments', 'finance'],
  ['track', 'tracking', 'tracked'],
  ['speed', 'mph', 'fast', 'faster'],
  ['range', 'miles', 'mileage'],
  ['charge', 'charger', 'charging'],
  ['waterproof', 'rain', 'wet', 'water'],
  ['discount', 'code', 'sale', 'offer'],
  ['stock', 'available', 'availability'],
  ['cancel', 'cancellation', 'change'],
  ['contact', 'email', 'phone', 'whatsapp'],
];
const SYNONYMS = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) for (const word of group) SYNONYMS.set(word, group);

// Phrases whose meaning sits in stop words.
const PHRASES: [RegExp, string[]][] = [
  [/\bhow much\b/, ['price', 'cost']],
  [/\bhow long\b/, ['days', 'weeks', 'time']],
  [/\bhow fast\b/, ['speed', 'mph']],
  [/\bhow far\b/, ['range', 'miles']],
  [/\bsend (it )?back\b/, ['return', 'refund']],
  [/\bwhere('?s| is) my\b/, ['tracking', 'order']],
];

const UNITS: Record<string, string> = { w: 'w', watt: 'w', watts: 'w', v: 'v', volt: 'v', volts: 'v', ah: 'ah', mph: 'mph', mm: 'mm' };

/** Search terms for a piece of customer text: lower case, no stop words, most specific first, with synonyms. */
export function searchTerms(text: string, maxTerms = 32): string[] {
  const lower = text.toLowerCase().replace(/[’']/g, '');
  const raw = lower.match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms: string[] = [];
  const add = (t: string) => { if (t && !terms.includes(t)) terms.push(t); };

  // "2000 w", "2000 watt" and "2000w" all become "2000w", which is how the catalogue writes it.
  for (let i = 0; i < raw.length; i++) {
    const word = raw[i]!;
    const next = raw[i + 1];
    if (/^\d+$/.test(word) && next && UNITS[next]) { add(word + UNITS[next]); i++; continue; }
    const glued = /^(\d+)(watts?|volts?)$/.exec(word);
    if (glued) { add(glued[1]! + UNITS[glued[2]!]!); continue; }
    if (STOP.has(word)) continue;
    if (word.length < 2 && !/\d/.test(word)) continue;
    add(word);
  }
  for (const [re, extra] of PHRASES) if (re.test(lower)) extra.forEach(add);

  const own = terms.slice(0, maxTerms);
  const out = [...own];
  for (const t of own) for (const s of SYNONYMS.get(t) ?? []) if (!out.includes(s)) out.push(s);
  return out.slice(0, maxTerms * 2);
}

/** A MATCH string that is safe to bind, or '' when the text holds nothing to search for. */
export function buildFtsQuery(text: string): string {
  return searchTerms(text).map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
