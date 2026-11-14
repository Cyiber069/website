// Cheap, deterministic read of how a customer writes. The profile is fed to the model so it can
// mirror the customer, and to the sanitizer so the final text matches (lower case, no full stop, ...).
import type { HistoryMessage, ToneProfile } from '../types';

const GREETINGS = [
  'good morning', 'good afternoon', 'good evening', 'dear', 'hello', 'hiya', 'heya', 'hey', 'hi', 'yo', 'sup', 'wagwan', 'wassup',
  'whatsup', 'alright', 'oi', 'ello', 'morning', 'evening', 'afternoon', 'greetings', 'hola', 'salut', 'bonjour', 'hallo', 'ciao',
];

const ADDRESS = ['bro', 'bruv', 'bruh', 'brother', 'mate', 'man', 'fam', 'boss', 'lad', 'pal', 'buddy', 'bud', 'dude', 'chief', 'g', 'geezer', 'sir', 'madam', 'guys', 'team', 'my guy'];

const SLANG = [
  'innit', 'wagwan', 'safe', 'sound', 'cheers', 'ta', 'peng', 'mint', 'buzzing', 'gassed', 'bare', 'proper', 'mad', 'sick', 'fire', 'lit',
  'ngl', 'tbh', 'idk', 'imo', 'rn', 'wanna', 'gonna', 'gotta', 'u', 'ur', 'r', 'pls', 'plz', 'thx', 'ty', 'cba', 'defo', 'legit', 'lol',
  'lmao', 'bet', 'nah', 'yh', 'yea', 'ye', 'yeh', 'aight', 'ight', 'cuz', 'cos', 'tho', 'dunno', 'wot', 'wat', 'yup', 'yep', 'fr', 'asap', 'btw', 'omg',
];

const FORMAL_CUES = [
  /\bdear\b/i, /\bkind regards\b/i, /\bbest regards\b/i, /\bregards\b/i, /\byours (sincerely|faithfully)\b/i, /\bi would like to\b/i,
  /\bcould you please\b/i, /\bi am writing\b/i, /\benquir/i, /\bplease advise\b/i, /\bthank you for your\b/i, /\bto whom it may concern\b/i,
  /\bi wish to\b/i, /\bat your earliest convenience\b/i,
];

const ANGRY_CUES = [
  /\bscam(mers?|med)?\b/i, /\bjoke\b/i, /\bridiculous\b/i, /\bdisgust/i, /\buseless\b/i, /\bterrible\b/i, /\bworst\b/i, /\bappalling\b/i,
  /\bunacceptable\b/i, /\brip(ped)? ?off\b/i, /\btrading standards\b/i, /\bcharge ?back\b/i, /\bsolicitor\b/i, /\bsue\b/i, /\bfraud/i,
  /\bwtf\b/i, /\bf+u+c+k/i, /\bshit\b/i, /\bbollocks\b/i, /\bpiss(ed)? (off|take)\b/i, /\brefund (me )?now\b/i, /\breport(ing)? you\b/i, /\bliars?\b/i,
];

const FRUSTRATED_CUES = [
  /\bstill (waiting|not|no|nothing|havent|haven't)\b/i, /\bno (reply|response|answer)\b/i, /\bwhere('?s| is) my\b/i, /\bnot (happy|impressed|working)\b/i,
  /\b(days|weeks) (ago|now)\b/i, /\bagain\b.*\?/i, /\bhello\?+/i, /\banyone there\b/i, /\bdoesn'?t work\b/i, /\bbroken\b/i, /\bfaulty\b/i, /\bdisappointed\b/i,
  /\bbeen waiting\b/i, /\bnever (arrived|came|received)\b/i, /\bthird time\b/i, /\bignor(ed|ing)\b/i,
];

const CONFUSED_CUES = [
  /\bconfus/i, /\bdon'?t (understand|get it|know how)\b/i, /\bnot sure (how|what|which|if)\b/i, /\bwhat do you mean\b/i, /\bhow do (i|you|we)\b/i,
  /\bwhich one\b/i, /\bno idea\b/i, /\bcan you explain\b/i, /\bhelp me understand\b/i, /\bi'?m lost\b/i,
];

const POSITIVE_CUES = [
  /\bthanks?\b/i, /\bthank you\b/i, /\bcheers\b/i, /\blove\b/i, /\bgreat\b/i, /\bamazing\b/i, /\bawesome\b/i, /\bperfect\b/i, /\bbrilliant\b/i,
  /\bsick\b/i, /\bbuzzing\b/i, /\blegend\b/i, /\bnice one\b/i, /\bappreciate\b/i, /\bcan'?t wait\b/i, /\bexcited\b/i,
];

const LANG_WORDS: Record<string, string[]> = {
  es: ['hola', 'gracias', 'cuanto', 'cuánto', 'envio', 'envío', 'precio', 'tienen', 'quiero', 'puedo', 'para', 'buenas', 'necesito', 'cuando', 'está'],
  fr: ['bonjour', 'merci', 'combien', 'livraison', 'prix', 'avez', 'voudrais', 'pour', 'est-ce', 'salut', 'pouvez', 'quand', 'avec', "j'ai"],
  de: ['hallo', 'danke', 'wieviel', 'versand', 'preis', 'haben', 'möchte', 'kann', 'bitte', 'lieferung', 'wann', 'nicht', 'und', 'ich'],
  it: ['ciao', 'grazie', 'quanto', 'spedizione', 'prezzo', 'avete', 'vorrei', 'posso', 'buongiorno', 'quando', 'sono', 'per'],
  nl: ['hallo', 'bedankt', 'hoeveel', 'verzending', 'prijs', 'hebben', 'graag', 'kan', 'wanneer', 'niet', 'een', 'het'],
  pt: ['olá', 'obrigado', 'obrigada', 'quanto', 'envio', 'preço', 'tem', 'quero', 'posso', 'quando', 'não', 'para'],
  pl: ['cześć', 'dziękuję', 'ile', 'wysyłka', 'cena', 'czy', 'chciałbym', 'mogę', 'kiedy', 'jest', 'nie', 'dzień'],
  sv: ['hej', 'tack', 'hur', 'frakt', 'pris', 'har', 'skulle', 'kan', 'när', 'inte', 'och', 'jag'],
};

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const ELONGATED_RE = /([a-z])\1{2,}/i;
const WORD_RE = /[\p{L}\p{N}'\u2019]+/gu;

/** "brooo" -> "bro", "yooo" -> "yo", "heyyy" -> "hey". Keeps genuine double letters ("cool" stays "cool"). */
export function collapseElongation(word: string): string {
  return word.replace(/(\p{L})\1{2,}/giu, '$1');
}

function baseWord(word: string): string {
  const w = word.toLowerCase().replace(/[\u2019']/g, '');
  const collapsed = collapseElongation(w);
  // "broo" (two o's) is still an elongated "bro": try trimming one repeated final letter.
  if (collapsed.length > 2 && collapsed[collapsed.length - 1] === collapsed[collapsed.length - 2]) {
    const trimmed = collapsed.slice(0, -1);
    if (ADDRESS.includes(trimmed) || GREETINGS.includes(trimmed)) return trimmed;
  }
  return collapsed;
}

export function profileTone(history: HistoryMessage[]): ToneProfile {
  const mine = history.filter((m) => m.direction === 'in' && m.kind === 'text' && m.body.trim()).slice(-6);
  const texts = mine.map((m) => m.body.trim());
  const joined = texts.join('\n');
  const words = joined.match(WORD_RE) ?? [];
  const lowerWords = words.map((w) => w.toLowerCase());
  const bases = lowerWords.map(baseWord);

  // Greeting: look at the start of the first and of the latest message.
  let greeting = '';
  for (const t of [texts[0], texts[texts.length - 1]]) {
    if (!t || greeting) continue;
    const head = t.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const two = head.split(' ').slice(0, 2).map(baseWord).join(' ');
    const one = baseWord(head.split(' ')[0] ?? '');
    if (GREETINGS.includes(two)) greeting = two;
    else if (GREETINGS.includes(one)) greeting = one;
  }

  const address = [...new Set(bases.filter((b) => ADDRESS.includes(b) && b !== 'man' && b !== 'g' && b !== 'team' && b !== 'guys'))];
  if (/\bmy guy\b/i.test(joined)) address.push('my guy');
  // "man" and "g" are only address terms at the edges of a message ("thanks man", "safe g").
  for (const t of texts) {
    const m = /(?:^|\s)(man|g)[\s!.?]*$/i.exec(t);
    if (m && !address.includes(m[1]!.toLowerCase())) address.push(m[1]!.toLowerCase());
  }

  const elongatedCount = words.filter((w) => ELONGATED_RE.test(w) && !/^\d+$/.test(w) && !/^(www|xxx|mmm)$/i.test(w)).length;
  const elongation = words.length ? Math.min(1, elongatedCount / words.length) : 0;
  const emojiCount = (joined.match(EMOJI_RE) ?? []).length;
  const emoji_rate = texts.length ? Math.round((emojiCount / texts.length) * 100) / 100 : 0;

  // Capitalisation: do sentences start with a capital, and is "I" capitalised?
  const starts = texts.flatMap((t) => t.split(/(?<=[.!?])\s+|\n+/)).map((s) => s.trim()).filter((s) => /^\p{L}/u.test(s));
  const lowerStarts = starts.filter((s) => /^\p{Ll}/u.test(s)).length;
  const lowercase = starts.length > 0 && lowerStarts / starts.length >= 0.6;

  const endsWithStop = texts.filter((t) => /[.!?]$/.test(t)).length;
  const commas = (joined.match(/,/g) ?? []).length;
  const punctuation: ToneProfile['punctuation'] =
    texts.length === 0 ? 'light'
      : endsWithStop === 0 && commas === 0 ? 'none'
        : endsWithStop >= Math.ceil(texts.length * 0.7) && (commas > 0 || joined.length > 120) ? 'full'
          : 'light';

  const avg_chars = texts.length ? Math.round(joined.replace(/\n/g, '').length / texts.length) : 0;
  const slang = [...new Set(bases.filter((b) => SLANG.includes(b)))];

  // Language: only switch away from English on clear evidence.
  let language = 'en';
  let best = 0;
  for (const [code, list] of Object.entries(LANG_WORDS)) {
    const hitCount = lowerWords.filter((w) => list.includes(w)).length;
    if (hitCount > best) { best = hitCount; language = code; }
  }
  if (best < 2 || best / Math.max(1, words.length) < 0.12) language = 'en';

  const hasAny = (list: RegExp[]) => list.some((re) => re.test(joined));
  const capsWords = words.filter((w) => w.length >= 4 && w === w.toUpperCase() && /\p{L}/u.test(w)).length;
  const shouting = capsWords >= 3 || /!{3,}/.test(joined);
  const angryHits = ANGRY_CUES.filter((re) => re.test(joined)).length;
  let mood: ToneProfile['mood'] = 'neutral';
  if (angryHits >= 1 && (shouting || angryHits >= 2 || hasAny(FRUSTRATED_CUES))) mood = 'angry';
  else if (angryHits >= 1 || hasAny(FRUSTRATED_CUES) || (shouting && !hasAny(POSITIVE_CUES))) mood = 'frustrated';
  else if (hasAny(CONFUSED_CUES) || /\?{2,}/.test(joined)) mood = 'confused';
  else if (hasAny(POSITIVE_CUES) || emojiCount > 0) mood = 'positive';

  const formalHits = FORMAL_CUES.filter((re) => re.test(joined)).length;
  const casualAddress = address.filter((a) => a !== 'sir' && a !== 'madam').length;
  const casualSignals = slang.length + casualAddress + (lowercase ? 1 : 0) + (punctuation === 'none' ? 1 : 0) + (['yo', 'sup', 'wagwan', 'wassup', 'oi', 'heya', 'hiya'].includes(greeting) ? 1 : 0);
  let register: ToneProfile['register'] = 'neutral';
  if (formalHits >= 1 && casualSignals <= 1) register = 'formal';
  else if (elongation >= 0.12 || (elongatedCount >= 1 && (casualAddress > 0 || emojiCount > 0 || /!/.test(joined)))) register = 'hype';
  else if (casualSignals >= 2) register = 'casual';
  else if (!lowercase && punctuation === 'full' && avg_chars > 140 && casualSignals === 0) register = 'formal';

  return {
    register, mood, greeting, address_terms: address.slice(0, 3), elongation: Math.round(elongation * 100) / 100, emoji_rate,
    lowercase, punctuation, avg_chars, language, slang: slang.slice(0, 6),
  };
}
