// Phone normalising for checkout numbers. Shoppers type their number on the shipping address in
// whatever national format they are used to, so we rebuild the international form (E.164) from
// the address country. No library: a dial code table plus trunk prefix and length rules.

/** ISO 3166 alpha-2 country code to international dial code (digits only). */
export const DIAL_CODES: Record<string, string> = {
  AC: '247', AD: '376', AE: '971', AF: '93', AG: '1', AI: '1', AL: '355', AM: '374', AO: '244', AR: '54',
  AS: '1', AT: '43', AU: '61', AW: '297', AX: '358', AZ: '994', BA: '387', BB: '1', BD: '880', BE: '32',
  BF: '226', BG: '359', BH: '973', BI: '257', BJ: '229', BL: '590', BM: '1', BN: '673', BO: '591', BQ: '599',
  BR: '55', BS: '1', BT: '975', BW: '267', BY: '375', BZ: '501', CA: '1', CC: '61', CD: '243', CF: '236',
  CG: '242', CH: '41', CI: '225', CK: '682', CL: '56', CM: '237', CN: '86', CO: '57', CR: '506', CU: '53',
  CV: '238', CW: '599', CX: '61', CY: '357', CZ: '420', DE: '49', DJ: '253', DK: '45', DM: '1', DO: '1',
  DZ: '213', EC: '593', EE: '372', EG: '20', EH: '212', ER: '291', ES: '34', ET: '251', FI: '358', FJ: '679',
  FK: '500', FM: '691', FO: '298', FR: '33', GA: '241', GB: '44', GD: '1', GE: '995', GF: '594', GG: '44',
  GH: '233', GI: '350', GL: '299', GM: '220', GN: '224', GP: '590', GQ: '240', GR: '30', GT: '502', GU: '1',
  GW: '245', GY: '592', HK: '852', HN: '504', HR: '385', HT: '509', HU: '36', ID: '62', IE: '353', IL: '972',
  IM: '44', IN: '91', IO: '246', IQ: '964', IR: '98', IS: '354', IT: '39', JE: '44', JM: '1', JO: '962',
  JP: '81', KE: '254', KG: '996', KH: '855', KI: '686', KM: '269', KN: '1', KP: '850', KR: '82', KW: '965',
  KY: '1', KZ: '7', LA: '856', LB: '961', LC: '1', LI: '423', LK: '94', LR: '231', LS: '266', LT: '370',
  LU: '352', LV: '371', LY: '218', MA: '212', MC: '377', MD: '373', ME: '382', MF: '590', MG: '261', MH: '692',
  MK: '389', ML: '223', MM: '95', MN: '976', MO: '853', MP: '1', MQ: '596', MR: '222', MS: '1', MT: '356',
  MU: '230', MV: '960', MW: '265', MX: '52', MY: '60', MZ: '258', NA: '264', NC: '687', NE: '227', NF: '672',
  NG: '234', NI: '505', NL: '31', NO: '47', NP: '977', NR: '674', NU: '683', NZ: '64', OM: '968', PA: '507',
  PE: '51', PF: '689', PG: '675', PH: '63', PK: '92', PL: '48', PM: '508', PR: '1', PS: '970', PT: '351',
  PW: '680', PY: '595', QA: '974', RE: '262', RO: '40', RS: '381', RU: '7', RW: '250', SA: '966', SB: '677',
  SC: '248', SD: '249', SE: '46', SG: '65', SH: '290', SI: '386', SJ: '47', SK: '421', SL: '232', SM: '378',
  SN: '221', SO: '252', SR: '597', SS: '211', ST: '239', SV: '503', SX: '1', SY: '963', SZ: '268', TA: '290',
  TC: '1', TD: '235', TG: '228', TH: '66', TJ: '992', TK: '690', TL: '670', TM: '993', TN: '216', TO: '676',
  TR: '90', TT: '1', TV: '688', TW: '886', TZ: '255', UA: '380', UG: '256', US: '1', UY: '598', UZ: '998',
  VA: '39', VC: '1', VE: '58', VG: '1', VI: '1', VN: '84', VU: '678', WF: '681', WS: '685', XK: '383',
  YE: '967', YT: '262', ZA: '27', ZM: '260', ZW: '263',
};

/** Every dial code in use, for splitting an international number into country code and the rest. */
const ALL_CODES = new Set(Object.values(DIAL_CODES));

/**
 * Dial codes where a leading 0 is part of the number itself and must be kept
 * (Italy and friends, Ivory Coast, Congo). Everywhere else a single leading 0 is the trunk prefix.
 */
const KEEP_ZERO = new Set(['39', '378', '225', '242']);

/** Trunk prefixes that are not a plain 0, tried longest first. */
const TRUNKS: Record<string, string[]> = {
  '1': ['1'],          // North America: "1 (626) ..." is the country code typed without a plus
  '7': ['8'],          // Russia, Kazakhstan: 8 912 ...
  '375': ['80'],       // Belarus
  '36': ['06'],        // Hungary
  '370': ['8', '0'],   // Lithuania (old and new)
  '993': ['8'],        // Turkmenistan
};

interface LengthRule { min: number; max: number; check?: (national: string) => boolean }

/** Length of the national number (after the dial code, without trunk prefix) for the countries we expect. */
const RULES: Record<string, LengthRule> = {
  '1': { min: 10, max: 10, check: (n) => /^[2-9]\d{2}[2-9]\d{6}$/.test(n) },
  '7': { min: 10, max: 10 },
  '20': { min: 8, max: 10 },
  '27': { min: 9, max: 9 },
  '30': { min: 10, max: 10 },
  '31': { min: 9, max: 9 },
  '32': { min: 8, max: 9 },
  '33': { min: 9, max: 9 },
  '34': { min: 9, max: 9 },
  '36': { min: 8, max: 9 },
  '39': { min: 6, max: 11 },
  '40': { min: 9, max: 9 },
  '41': { min: 9, max: 9 },
  '43': { min: 7, max: 13 },
  // UK mobiles (07...) are always ten digits after the 0. Landlines are nine or ten.
  '44': { min: 9, max: 10, check: (n) => !n.startsWith('7') || n.length === 10 },
  '45': { min: 8, max: 8 },
  '46': { min: 7, max: 10 },
  '47': { min: 8, max: 8 },
  '48': { min: 9, max: 9 },
  '49': { min: 6, max: 12 },
  '52': { min: 10, max: 10 },
  '55': { min: 10, max: 11 },
  '60': { min: 8, max: 10 },
  '61': { min: 9, max: 9 },
  '62': { min: 8, max: 12 },
  '63': { min: 8, max: 10 },
  '64': { min: 8, max: 10 },
  '65': { min: 8, max: 8 },
  '66': { min: 8, max: 9 },
  '81': { min: 9, max: 10 },
  '82': { min: 8, max: 11 },
  '84': { min: 9, max: 10 },
  '86': { min: 10, max: 11 },
  '90': { min: 10, max: 10 },
  '91': { min: 10, max: 10 },
  '92': { min: 9, max: 10 },
  '212': { min: 9, max: 9 },
  '233': { min: 9, max: 9 },
  '234': { min: 8, max: 10 },
  '254': { min: 9, max: 10 },
  '351': { min: 9, max: 9 },
  '352': { min: 6, max: 11 },
  '353': { min: 7, max: 9 },
  '354': { min: 7, max: 9 },
  '356': { min: 8, max: 8 },
  '357': { min: 8, max: 8 },
  '358': { min: 6, max: 11 },
  '359': { min: 7, max: 9 },
  '370': { min: 8, max: 8 },
  '371': { min: 8, max: 8 },
  '372': { min: 7, max: 8 },
  '380': { min: 9, max: 9 },
  '385': { min: 8, max: 9 },
  '386': { min: 8, max: 8 },
  '420': { min: 9, max: 9 },
  '421': { min: 9, max: 9 },
  '852': { min: 8, max: 8 },
  '880': { min: 8, max: 10 },
  '966': { min: 9, max: 9 },
  '971': { min: 8, max: 9 },
  '972': { min: 8, max: 9 },
};

/** Fallback for countries without a specific rule: anything E.164 allows. */
const ANY_RULE: LengthRule = { min: 4, max: 13 };

function validNational(code: string, national: string): boolean {
  if (!/^\d+$/.test(national)) return false;
  const rule = RULES[code] ?? ANY_RULE;
  if (national.length < rule.min || national.length > rule.max) return false;
  const total = code.length + national.length;
  if (total < 7 || total > 15) return false;
  if (/^(\d)\1+$/.test(national)) return false; // 0000000000 and the like
  if (national.startsWith('0') && !KEEP_ZERO.has(code)) return false;
  return rule.check ? rule.check(national) : true;
}

/** Remove the trunk prefix people dial inside the country ("07700..." becomes "7700..."). */
function stripTrunk(code: string, digits: string): string {
  for (const trunk of TRUNKS[code] ?? []) {
    if (digits.startsWith(trunk) && validNational(code, digits.slice(trunk.length))) return digits.slice(trunk.length);
  }
  if (digits.startsWith('0') && !KEEP_ZERO.has(code) && code !== '1') return digits.slice(1);
  return digits;
}

/** Split digits that start with a country code. Dial codes are prefix free, so the first hit is the only one. */
function splitInternational(digits: string): { code: string; rest: string } | null {
  for (let len = 1; len <= 3; len++) {
    const code = digits.slice(0, len);
    if (ALL_CODES.has(code)) return { code, rest: digits.slice(len) };
  }
  return null;
}

function fromInternational(digits: string): string | null {
  const split = splitInternational(digits);
  if (!split) return null;
  // "+44 (0)7700 900123": the bracketed trunk zero is dropped when written internationally.
  const national = validNational(split.code, split.rest) ? split.rest : stripTrunk(split.code, split.rest);
  return validNational(split.code, national) ? `+${split.code}${national}` : null;
}

const isoOf = (v: string | null | undefined): string => {
  const iso = (v ?? '').trim().toUpperCase();
  return iso === 'UK' ? 'GB' : iso;
};

/**
 * Turn whatever the shopper typed into E.164 ("+447700900123"), or null when it is not a usable number.
 *
 * @param raw        the number as typed, any punctuation
 * @param countryIso country of the address the number came from (ISO alpha-2), may be missing
 * @param defaultIso the store's home country, used when the address has no country
 */
export function toE164(raw: string | null | undefined, countryIso: string | null | undefined, defaultIso: string): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;
  // Drop an extension ("x12", "ext. 12") and the "(0)" people put after the country code.
  text = text.replace(/\s*(?:ext\.?|x)\s*\d+\s*$/i, '').replace(/\(0\)/g, '');
  // Letters mean it is not a phone number (Shopify's own samples include "555-555-SHIP").
  if (/[a-z]/i.test(text)) return null;
  const plus = text.startsWith('+');
  const digits = text.replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 17) return null;

  // Already international: the address country does not matter (a +44 number on a Polish address stays +44).
  if (plus) return fromInternational(digits);
  if (digits.startsWith('00')) return fromInternational(digits.slice(2));

  const code = DIAL_CODES[isoOf(countryIso)] ?? DIAL_CODES[isoOf(defaultIso)];
  if (!code) return null;

  // National format, with or without the trunk prefix.
  const national = stripTrunk(code, digits);
  if (validNational(code, national)) return `+${code}${national}`;

  // The country code typed without a plus ("447700900123"). Checked second so a real national
  // number that happens to begin with the same digits wins.
  if (digits.startsWith(code)) {
    const rest = stripTrunk(code, digits.slice(code.length));
    if (validNational(code, rest)) return `+${code}${rest}`;
  }
  return null;
}

/** For API output: keep the country code area hidden and only the last three digits readable. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 3) return '•••';
  return `${phone.startsWith('+') ? '+' : ''}${'•'.repeat(digits.length - 3)}${digits.slice(-3)}`;
}
