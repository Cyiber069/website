// Cheap, deterministic read of how a customer writes. The profile is fed to the model so it can
// mirror the customer, and to the sanitizer so the final text matches (lower case, no full stop, ...).
//
// Ported from the reference in the voice research (research/voice.md section F, voice_ref/tone.mjs).
// The test vectors in test/unit/vectors/tone.vectors.json were generated from that reference: keep the
// two in step. Non ASCII characters are written as \u{...} escapes on purpose so the source stays reviewable.
import type { MessageKind, ToneProfile, VoiceSettings } from '../types';

/** What profileTone needs from a message. HistoryMessage fits; tests may pass just a body. */
export interface ToneMessage { body: string; kind?: MessageKind; direction?: 'in' | 'out' }

export interface ToneSignals {
  formal: number; casual: number; hype: number;
  mood: { angry: number; frustrated: number; confused: number; positive: number };
  shouting: boolean; profanity: number; sign_off: boolean; stretched: string[]; max_run: number;
}

/** The profile plus what it was worked out from. */
export interface ToneAnalysis {
  profile: ToneProfile;
  signals: ToneSignals | null;
  /** Short plain sentences for the prompt, for example "customer is writing in capitals". */
  notes: string[];
  /** Emoji the customer used, most recent window, unique. */
  emojis: string[];
}

/** What a reply may do with a profile. Fills the tone block of the prompt and steers the sanitizer. */
export interface MirrorPlan {
  /** Say this once, only in the first reply of a conversation. '' means no greeting. */
  greeting: string;
  /** At most once per reply. '' means use none. */
  address: string;
  /** How many words may carry one extra letter (broo, heyy). */
  stretch_words: number;
  lowercase: boolean;
  emoji_max: number;
  exclamations_max: number;
  slang_ok: string[];
  char_budget: number;
  end_with_full_stop: boolean;
}

type MoodKey = 'angry' | 'frustrated' | 'confused' | 'positive';
const MOOD_KEYS: MoodKey[] = ['angry', 'frustrated', 'confused', 'positive'];

const EMOJI = /(?:\p{Extended_Pictographic}(?:\u{FE0F}|\u{200D}\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*|[\u{1F1E6}-\u{1F1FF}]{2})/gu;
const URLISH = /\bhttps?:\/\/\S+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b(?:[a-z0-9-]+\.)+(?:co\.uk|com|uk|net|org|io)\S*/gi;
const RECENCY = [1, 0.6, 0.4, 0.3, 0.2, 0.2];          // newest message first
const WINDOW = 6;

// ---- lexicons (lower case, matched on normalised text) -----------------------------------------
const GREETINGS: [RegExp, string | null, 'formal' | 'neutral' | 'casual'][] = [                                     // [pattern, token returned, class]
  [/^(?:to whom it may concern|dear (?:sir|madam|sirs|team|acx)\b[^,\n]*|dear\b)/, 'dear', 'formal'],
  [/^good (morning|afternoon|evening|day)\b/, null, 'formal'],
  [/^(?:hello|hi|hey) there\b/, null, 'neutral'],
  [/^(?:as+a?lam[ou]? ?a?l[ae]i?kum|salaa?m)\b/, 'salam', 'neutral'],
  [/^(?:wa+g+wa+n+|wag1|wagwarn|what'?s good|wha gwan)\b/, 'wagwan', 'casual'],
  [/^(?:wass+up+|what'?s up+|whats up+|sup+|wassap)\b/, 'sup', 'casual'],
  [/^(?:ey up|ayup|ay up)\b/, 'ey up', 'casual'],
  [/^(?:you alright|u alright|alright|alri+ght|aight|ite)\b/, 'alright', 'casual'],
  [/^(?:morning|afternoon|evening)\b/, null, 'neutral'],
  [/^(?:yo+|yoo+o*)\b/, 'yo', 'casual'], [/^(?:oi+|oii+)\b/, 'oi', 'casual'], [/^(?:ay+|ayy+|ey+)\b/, 'ay', 'casual'],
  [/^(?:he+y+a+|hi+ya+)\b/, 'hiya', 'casual'], [/^(?:he+y+)\b/, 'hey', 'casual'],
  [/^(?:hello+|helloo+|hallo|ello)\b/, 'hello', 'neutral'], [/^(?:hi+)\b/, 'hi', 'neutral'],
  [/^(?:hola|bonjour|ciao|salut|merhaba|namaste|czesc|witam|buna|ola)\b/, null, 'neutral'],
  [/^(?:safe|easy|sound)\b(?=\s+(?:bro|bruv|mate|man|g|fam|lad)\b|\s*$)/, null, 'casual'],
];
const ADDRESS: Record<string, string> = {                                       // variant -> token returned
  bro: 'bro', broo: 'bro', brother: 'bro', bruva: 'bro', bruvva: 'bro', brudda: 'bro', bruh: 'bruh', bruv: 'bruv', bruvv: 'bruv', mate: 'mate', matey: 'mate', man: 'man', mann: 'man', maan: 'man',
  pal: 'pal', bud: 'bud', buddy: 'buddy', fam: 'fam', g: 'g', lad: 'lad', lads: 'lads', boss: 'boss', bossman: 'boss', chief: 'chief', dude: 'dude', guys: 'guys', geezer: 'geezer', cuz: 'cuz',
  blud: 'blud', akh: 'akh', akhi: 'akh', legend: 'legend', king: 'king', sir: 'sir', madam: 'madam', hun: 'hun', hunny: 'hun', babe: 'babe', love: 'love', darling: 'darling', duck: 'duck', pet: 'pet',
  'my man': 'my man', 'my guy': 'my guy', 'my g': 'g', 'big man': 'big man', 'boss man': 'boss', 'our kid': 'our kid', 'my friend': 'my friend',
};
const ADDR_AMBIGUOUS = new Set(['man', 'g', 'love', 'pet', 'boss', 'king', 'legend', 'duck', 'guys', 'lads', 'lad', 'sir', 'madam', 'chief']);
const ADDR_LEADERS = /(?:^|[.!?,]\s*)(?:thanks|thank you|cheers|ta|nice one|safe|please|pls|sorry|yeah|yes|yep|no|nah|ok|okay|sound|sweet|lovely|perfect|wow|haha|lol|yo|hey|hi|hiya|hello|oi|alright|morning|afternoon|evening|sup|wagwan|easy|listen|look|honestly|come on|trust me)\s+$/;
const DETERMINERS = /\b(?:my|a|an|the|his|her|your|our|their|this|that|one|another|some|any|old|young|good|best|new)\s+$/;

export const SLANG = ['u', 'ur', 'r', 'pls', 'plz', 'thx', 'ty', 'tysm', 'tbh', 'tbf', 'idk', 'imo', 'ngl', 'rn', 'atm', 'asap', 'btw', 'lol', 'lmao', 'lmfao', 'haha', 'omg', 'wtf', 'ffs', 'nvm', 'np', 'yh', 'yeh', 'yea', 'yeah', 'yep', 'nah', 'nope', 'cba', 'wanna', 'gonna', 'gotta', 'gimme', 'lemme', 'dunno', 'innit', 'init', 'aint', "ain't", 'tho', 'cos', 'coz', 'cuz', 'bc', 'wat', 'wot', 'ya', 'cheers', 'ta', 'defo', 'deffo', 'probs', 'obvs', 'soz', 'sorta', 'kinda', 'abit', 'alot', 'bout', 'msg', 'dm', 'legit', 'lowkey', 'highkey', 'fr', 'frfr',
  'bro', 'bruv', 'bruh', 'fam', 'mandem', 'blud', 'wagwan', 'safe', 'sick', 'peng', 'peak', 'bare', 'gassed', 'buzzing', 'mint', 'sound', 'sorted', 'calm', 'wavey', 'lit', 'fire', 'mad', 'mental', 'nuts', 'insane', 'beast', 'rapid', 'nippy', 'banging', 'bangin', 'class', 'quality', 'lush', 'belter', 'decent', 'proper', 'dodgy', 'knackered', 'skint', 'quid', 'fiver', 'tenner', 'grand', 'reckon', 'sus', 'bait', 'vexed', 'rinse', 'rinsed', 'clapped', 'peak', 'dead', 'ting', 'ends', 'yute', 'allow', 'say less', 'no cap', 'cap', 'bet', 'slaps', 'goated', 'w', 'l',
  'derestrict', 'derestricted', 'unrestricted', 'wheelie', 'wheelies', 'surron', 'talaria', 'rips', 'shifts', 'pulls', 'flies', 'send it', 'sends', 'ped', 'peds'];
const SLANG_MULTI = SLANG.filter((s) => s.includes(' '));
const SLANG_SET = new Set(SLANG.filter((s) => !s.includes(' ')));
const SLANG_WEAK = new Set(['yeah', 'yep', 'cheers', 'ta', 'haha', 'sound', 'proper', 'class', 'quality', 'decent', 'mad', 'dead', 'allow', 'cap', 'bet', 'w', 'l', 'r', 'grand', 'safe', 'calm', 'fire', 'peak', 'bare', 'ends', 'sorted', 'reckon', 'mint', 'nuts', 'rapid', 'flies', 'pulls', 'shifts', 'sends', 'asap', 'btw', 'atm', 'ya', 'sick']);
const NO_APOSTROPHE = new Set(['dont', 'cant', 'im', 'ive', 'whats', 'thats', 'wont', 'isnt', 'doesnt', 'youre', 'hows', 'wheres', 'didnt', 'havent', 'hasnt', 'wouldnt', 'couldnt', 'shouldnt', 'arent', 'theres', 'hes', 'shes', 'theyre', 'wasnt', 'id', 'itll']);
const HYPE_WORDS = /\b(?:sick|insane|mental|beast|rapid|crazy|fire|lit|lets go+|let'?s go+|buzzing|gassed|can'?t wait|omg|ye+s+s+|mad|wild|unreal|nuts|goated|slaps)\b/g;
const PROFANITY = /\b(?:f+u+c+k+\w*|f\*+k?\w*|fk|fkn|fkin|effing|sh[i1]+t+\w*|sh\*t|bollocks|bastards?|twats?|dickheads?|wankers?|pricks?|arse(?:d|hole)?|piss(?:ed|ing|take)?|crap|bloody|damn|hell|bs|bullshit|wtf|ffs)\b/g;
const ACRONYMS = new Set(['UK', 'ACX', 'DPD', 'DHL', 'UPS', 'BMS', 'LCD', 'PAS', 'VAT', 'EU', 'USA', 'OK', 'ASAP', 'LOL', 'OMG', 'WTF', 'FFS', 'PM', 'AM', 'MPH', 'KMH', 'USB', 'LED', 'QR', 'PDF', 'DM', 'TBH', 'IDK', 'BTW', 'NGL', 'LMAO', 'AH', 'KW', 'MOT', 'DVLA', 'EAPC', 'RRP', 'PS', 'FYI', 'NI', 'ROI']);

const MOOD: Record<MoodKey, [RegExp, number][]> = {
  angry: [
    [/\b(?:scam(?:mers?|med|ming)?|fraud(?:sters?)?|rip(?:ped)?[ -]?off|robbed|conned|con artists?|thie(?:f|ves)|cowboys|liars?|lied to|lying)\b/g, 3],
    [/\b(?:(?:absolute|complete|total|what a|is a|a) joke|disgrace(?:ful)?|disgusting|appalling|shocking|useless|pathetic|shambles|unacceptable|outrageous|rubbish service|worst)\b/g, 3],
    [/\b(?:fuming|livid|furious|sick of|had enough|done with you|never again|avoid(?: this| these)?)\b/g, 3],
    [/\b(?:trading standards|charge ?back|paypal (?:claim|dispute|case)|dispute (?:it|this|the)|small claims|solicitor|lawyer|legal action|take you to court|report(?:ing)? (?:you|this)|trustpilot|bad review|1 star|one star|ombudsman)\b/g, 3],
    [/\b(?:want my money back|give me my money|refund (?:me )?(?:now|today|immediately)|money back now)\b/g, 3],
    [/\b(?:taking the piss|piss ?take|f+u+c+k+ ?(?:you|off|this|sake)|f+u+c+k+ing (?:useless|joke|ridiculous)|bullshit|wtf|ffs)\b/g, 2],
  ],
  frustrated: [
    [/\b(?:still (?:waiting|not|no|haven'?t|hasn'?t|nothing|broken)|no (?:reply|response|answer|update|one)|nobody|not replying|ignor(?:ed|ing)|been waiting|getting nowhere|chasing|chased)\b/g, 2],
    [/\b(?:(?:second|third|fourth|2nd|3rd|4th) time|yet again|once again|asked (?:twice|again|already)|how much longer|how long (?:do i have to|am i supposed|is (?:it|this) going to|have i got to)|any ?(?:update|news)|where(?:'?s| is) my|wheres my)\b/g, 2],
    [/\b(?:ridiculous|annoy(?:ing|ed)|fed up|not happy|unhappy|disappoint(?:ed|ing)|let down|poor service|come on|seriously|joking)\b/g, 2],
    [/\b(?:\d+ (?:days?|weeks?) (?:now|ago|late|and)|over (?:a|\d+) (?:weeks?|days?|months?)|(?:a|two|three|2|3) weeks?)\b/g, 1],
    [/\b(?:hasn'?t (?:arrived|come|turned up)|not (?:arrived|turned up|received|here)|never (?:arrived|came|got)|late|delayed|wrong (?:item|one|kit|battery|part)|missing|damaged)\b/g, 1],
    [/\b(?:fault(?:y)?|broken|broke|(?:doesn'?t|does not|won'?t|not|stopped) (?:work(?:ing)?|charg(?:e|ing)|turn(?:ing)? on|switch(?:ing)? on|spin(?:ning)?)|dead|cut(?:s|ting)? out|error|keeps? (?:cutting|turning|dying))\b/g, 1],
    [/\?{2,}|\?!|!\?|hello\?/g, 1],
  ],
  confused: [
    [/\b(?:confus(?:ed|ing)|(?:don'?t|dont|do not|didn'?t) (?:understand|get it|get this|know (?:what|which|how|if))|not sure|unsure|no idea|no clue|lost|clueless|dunno (?:what|which|how|if))\b/g, 2],
    [/\b(?:which (?:one|kit|battery|motor|size|controller|charger)|what(?:'?s| is) the diff\w*|difference between|what do(?:es)? (?:that|it|this|you) mean|what(?:'?s| is) (?:a|an|the) \w+(?: \w+)?\?)/g, 2],
    [/\b(?:how do (?:i|you|u)|how does|do i need|will (?:it|this|that) fit|is (?:it|this) compatible|compatible with|help me (?:choose|pick|decide)|what do i need|where do i (?:start|begin))\b/g, 1],
    [/\b(?:new to (?:this|ebikes|e-bikes|all this)|first (?:time|ebike|e-bike|build|kit)|noob|newbie|beginner|never (?:done|built|fitted)|not (?:very )?(?:technical|techy|tech savvy)|explain)\b/g, 1],
  ],
  positive: [
    [/\b(?:thanks?(?: you| so much| a lot)?|thx|ty|cheers|appreciate(?:d)?|legend|life ?saver|star|top man|nice one|well done)\b/g, 1],
    [/\b(?:love (?:it|this|that|the|my)|loving|amazing|awesome|brilliant|perfect|great|fantastic|excellent|lovely|chuffed|happy with|made up|impressed)\b/g, 2],
    [/\b(?:sick(?! of)|mint|buzzing|gassed|class|quality|sweet|insane|beast|unreal|can'?t wait|excited|hyped|lets go+|let'?s go+|goated|slaps)\b/g, 2],
    [/[\u{1F60D}\u{1F525}\u{1F64C}\u{1F601}\u{1F44D}\u{2764}\u{1F602}\u{1F929}\u{1F4AA}\u{1F44C}\u{1F64F}\u{1F60A}\u{1F923}\u{1F60E}\u{1F973}\u{1F499}]/gu, 1],
  ],
};
const FORMAL_PHRASES = /\b(?:could you (?:please|kindly)|would it be possible|i would like to|i am writing|please could you|please advise|i wish to|i would be grateful|i would appreciate|enquir(?:e|y|ing)|inquir(?:e|y|ing)|with regards? to|in regards? to|regarding|further to|i look forward|at your earliest convenience|please find|could you confirm|may i ask|i have recently|i recently purchased|purchased)\b/g;
const SIGN_OFF = /(?:^|\n|[.!?]\s*)(?:kind regards|best regards|warm regards|regards|best wishes|yours sincerely|yours faithfully|many thanks|thank you in advance|thanks in advance|thanking you|with thanks|sincerely)\b[,.]?(?:\s*\n?\s*[A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,2})?\s*$/i;
const OLDER = /\b(?:i(?:'m| am) \d{2}\b|(?:aged?|turned) (?:6|7|8)\d\b|retired|pensioner|at my age|my (?:grand(?:son|daughter|kids|children)|son|daughter) (?:bought|ordered|set|helped|says|told|fitted)|not (?:very )?(?:good|great|clever) with (?:computers|technology|phones|these things)|not (?:very )?(?:technical|techy|tech savvy)|telephone|e-mail)\b/i;
const L2 = /\b(?:please kindly|kindly (?:tell|send|inform|advise|let)|dear (?:sir|friend)|hello dear|my friend|how much (?:cost|price|is cost)|what price|is possible|i (?:want|need) (?:know|buy|ask)|can (?:send|ship|deliver) to my country|you have (?:it|this|stock)\?|do the needful|revert back|i am (?:wanting|having|interesting|interested for)|sorry (?:for )?my english|english is not)\b/i;
const LANG_WORDS: Record<string, RegExp> = {                                    // matched on text folded to plain ASCII letters
  pl: /\b(?:czy|jest|nie|prosze|dzien|dobry|ile|kosztuje|dziekuje|chce|moge|witam|czesc|zamowienie|wysylka|macie|mozna)\b/g,
  ro: /\b(?:este|sunt|buna|ziua|multumesc|cat|costa|vreau|comanda|livrare|aveti|pentru|salut)\b/g,
  es: /\b(?:hola|gracias|cuanto|cuesta|quiero|tienen|tiene|envio|pedido|por favor|buenos|buenas|puedo|para|necesito)\b/g,
  pt: /\b(?:ola|obrigado|obrigada|quanto|custa|quero|voces|envio|pedido|por favor|bom dia|boa tarde|preciso|tem)\b/g,
  fr: /\b(?:bonjour|merci|combien|coute|je veux|je voudrais|avez|livraison|commande|s'il vous|est ce|pour|salut|svp)\b/g,
  de: /\b(?:hallo|danke|wie viel|kostet|ich|mochte|haben sie|versand|bestellung|bitte|guten|nicht|und|fur)\b/g,
  it: /\b(?:ciao|grazie|quanto|costa|vorrei|avete|spedizione|ordine|per favore|buongiorno|buonasera|posso|sono)\b/g,
  tr: /\b(?:merhaba|tesekkur|ne kadar|fiyat|istiyorum|var mi|kargo|siparis|lutfen|selam)\b/g,
  nl: /\b(?:hallo|dank|hoeveel|kost|ik wil|heeft u|verzending|bestelling|alstublieft|goedemorgen|niet|voor)\b/g,
};
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/\u{0142}/gu, 'l').replace(/\u{00DF}/gu, 'ss').replace(/\u{0131}/gu, 'i').normalize('NFC');
const EN_WORDS = /\b(?:the|is|are|you|your|do|does|have|has|what|how|much|can|i|my|it|this|that|for|with|and|to|of|in|on|please|thanks|hi|hello|order|delivery|when|where|will|kit|battery)\b/g;
const SCRIPTS: [RegExp, string][] = [[/[\u{0600}-\u{06FF}]/u, 'ar'], [/[\u{0400}-\u{04FF}]/u, 'ru'], [/[\u{0900}-\u{097F}]/u, 'hi'], [/[\u{0A00}-\u{0A7F}]/u, 'pa'], [/[\u{0980}-\u{09FF}]/u, 'bn'], [/[\u{4E00}-\u{9FFF}]/u, 'zh'], [/[\u{3040}-\u{30FF}]/u, 'ja'], [/[\u{AC00}-\u{D7AF}]/u, 'ko'], [/[\u{0370}-\u{03FF}]/u, 'el'], [/[\u{0590}-\u{05FF}]/u, 'he'], [/[\u{0E00}-\u{0E7F}]/u, 'th']];

// ---- helpers -----------------------------------------------------------------------------------
const count = (s: string, re: RegExp): number => (s.match(re) || []).length;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const destretch = (w: string): string => w.replace(/(\p{L})\1{2,}/giu, '$1');
const RUN2 = new Set(['yoo', 'broo', 'heyy', 'hii', 'soo', 'noo', 'yess', 'matee', 'bruvv', 'pleasee', 'thankss', 'ayy', 'okk', 'maan', 'mann', 'yeahh', 'nahh', 'sickk', 'nicee', 'helloo', 'yepp', 'wayy', 'ohh', 'ahh']);
function isStretched(w: string): boolean { const l = w.toLowerCase(); return /(\p{L})\1{2,}/u.test(l) ? !/^(?:www|ii+|xx+|mm+|hm+|zz+)$/.test(l) : RUN2.has(l); }
function baseWord(w: string): string { const l = w.toLowerCase(); if (RUN2.has(l)) return l.slice(0, -1); const d = destretch(l); return d; }

/** Full analysis of the customer's last few text messages. Our own messages and non text messages are ignored. */
export function analyzeTone(messagesIn: readonly ToneMessage[]): ToneAnalysis {
  const texts = (messagesIn || []).filter((m) => m.direction !== 'out' && (m.kind || 'text') === 'text' && (m.body || '').trim()).slice(-WINDOW).map((m) => m.body.normalize('NFC').replace(/[\u{2018}\u{2019}]/gu, "'").trim());
  const empty: ToneProfile = { register: 'neutral', mood: 'neutral', greeting: '', address_terms: [], elongation: 0, emoji_rate: 0, lowercase: false, punctuation: 'light', avg_chars: 0, language: 'en', slang: [] };
  if (!texts.length) return { profile: empty, signals: null, notes: [], emojis: [] };

  const cleaned = texts.map((t) => t.replace(URLISH, ' '));
  const noEmoji = cleaned.map((t) => t.replace(EMOJI, ' '));
  const all = noEmoji.join('\n');
  const allLower = all.toLowerCase();
  const wordList = all.match(/(?<![\p{L}\d'])\p{L}[\p{L}']*(?!\d)/gu) || [];   // letters glued to digits (5000w, 72v) are units, not words
  const nWords = wordList.length || 1;

  // style features
  const stretched = wordList.filter(isStretched);
  const elongation = round2(Math.min(1, stretched.length / nWords));
  const emojis = cleaned.flatMap((t) => t.match(EMOJI) || [] as string[]);
  const emoji_rate = round2(emojis.length / texts.length);
  const withLetters = noEmoji.filter((t) => /\p{L}/u.test(t));
  const startsLower = withLetters.filter((t) => /^[^\p{L}]*\p{Ll}/u.test(t)).length;
  const letters = count(all, /\p{L}/gu) || 1, uppers = count(all, /\p{Lu}/gu);
  const lowercase = withLetters.length > 0 && startsLower / withLetters.length >= 0.6 && uppers / letters < 0.1;
  const longWords = wordList.filter((w) => w.length >= 3 && !ACRONYMS.has(w.toUpperCase()));
  const capsWords = longWords.filter((w) => w === w.toUpperCase() && /\p{Lu}/u.test(w));
  const shouting = capsWords.length >= 2 && capsWords.length / (longWords.length || 1) >= 0.5;
  const punctText = noEmoji.map((t) => t.replace(/\d[\d.,:]*\d/g, '0').replace(/\.{2,}/g, ' '));
  const marks = punctText.reduce((n, t) => n + count(t, /[.,;:]/g), 0);
  const punctuation: ToneProfile['punctuation'] = marks === 0 ? 'none' : marks / nWords >= 0.08 && punctText.some((t) => /[.,]/.test(t)) && !lowercase ? 'full' : 'light';
  const avg_chars = Math.round(texts.reduce((n, t) => n + t.length, 0) / texts.length);
  const multiBang = /!{2,}/.test(all);

  // greeting: the newest message that opens with one
  let greeting = '', greetingClass = '';
  for (let i = noEmoji.length - 1; i >= 0 && !greeting; i--) {
    const head = fold(noEmoji[i].toLowerCase()).replace(/^[^\p{L}]+/u, '');
    for (const [re, token, cls] of GREETINGS) {
      const m = head.match(re);
      if (m) { greeting = token || destretch(m[0]).trim(); greetingClass = cls; break; }
    }
  }

  // address terms the customer used as a form of address (never as a plain noun)
  const address_terms: string[] = [];
  const addAddr = (t: string) => { if (!address_terms.includes(t)) address_terms.push(t); };
  for (const t of noEmoji) {
    const low = t.toLowerCase();
    const re = /[\p{L}][\p{L}']*/gu;
    let m, prevEnd = 0, prevWord = '';
    while ((m = re.exec(low))) {
      const raw = m[0], w = baseWord(raw), two = prevWord && /^\s+$/.test(low.slice(prevEnd, m.index)) ? `${prevWord} ${w}` : '';
      const start = m.index, end = start + raw.length;
      const before = low.slice(0, start), after = low.slice(end);
      const atEnd = /^\s*(?:$|[.!?,\n]|\p{Extended_Pictographic})/u.test(after);
      const atStart = /(?:^|[.!?\n]\s*)$/.test(before);
      const afterLeader = ADDR_LEADERS.test(before);
      if (two && ADDRESS[two]) { const b2 = low.slice(0, start - prevWord.length - 1); if (!/\b(?:is|was|and|with|told|from|for)\s+$/.test(b2) && (atEnd || ADDR_LEADERS.test(b2) || /(?:^|[.!?\n]\s*)$/.test(b2))) addAddr(ADDRESS[two]); }
      else if (ADDRESS[w] && !w.includes(' ')) {
        const det = DETERMINERS.test(before);
        const ok = !det && (afterLeader || atEnd || (atStart && !ADDR_AMBIGUOUS.has(w) && /^\s*(?:,|\s+\p{L})/u.test(after)));
        if (ok && !(w === 'g' && raw !== 'g')) addAddr(ADDRESS[w]);
      }
      prevWord = w; prevEnd = end;
    }
  }

  // slang hits (base forms, unique, at most 8)
  const slang: string[] = [];
  const push = (s: string) => { if (!slang.includes(s) && slang.length < 8) slang.push(s); };
  for (const w of wordList) { const b = baseWord(w); if (SLANG_SET.has(b) && !(b.length === 1 && w !== w.toLowerCase())) push(b); }
  for (const s of SLANG_MULTI) if (new RegExp(`\\b${s}\\b`).test(allLower)) push(s);
  const strongSlang = slang.filter((s) => !SLANG_WEAK.has(s)).length;
  const noApos = wordList.filter((w) => NO_APOSTROPHE.has(w.toLowerCase())).length;
  const profanity = count(allLower, PROFANITY);
  const laughter = /\b(?:a?(?:ha){2,}h?|lo+l+|lmf?ao+|hehe+)\b/.test(allLower);

  // mood: weighted by recency, newest message counts most
  const mood = { angry: 0, frustrated: 0, confused: 0, positive: 0 };
  const newestFirst = [...cleaned].reverse();
  newestFirst.forEach((t, i) => {
    const low = t.toLowerCase(), w = RECENCY[i] ?? 0.2;
    for (const k of MOOD_KEYS) for (const [re, pts] of MOOD[k]) mood[k] += count(k === 'positive' ? t.toLowerCase() : low, re) * pts * w;
  });
  if (shouting) { if (mood.angry + mood.frustrated > 0) mood.angry += 2; else if (mood.positive > 0) mood.positive += 1; }
  if (profanity && mood.frustrated >= 2) mood.angry += 1;
  if (mood.angry + mood.frustrated >= 2) mood.positive = 0;                      // "thanks" inside a complaint is not a good mood
  for (const k of MOOD_KEYS) mood[k] = round2(mood[k]);
  const moodLabel: ToneProfile['mood'] = mood.angry >= 3 ? 'angry' : mood.frustrated >= 2 ? 'frustrated' : mood.confused >= 2 ? 'confused' : mood.positive >= 2 ? 'positive' : 'neutral';

  // register
  const formalHits = Math.min(3, count(allLower, FORMAL_PHRASES));
  const signOff = texts.some((t) => SIGN_OFF.test(t));
  const older = OLDER.test(all);
  let formal = (greetingClass === 'formal' ? 2 : 0) + (signOff ? 2 : 0) + formalHits + (punctuation === 'full' && !lowercase && avg_chars >= 120 ? 1 : 0) + (older ? 2 : 0) - (strongSlang >= 2 ? 2 : 0);
  let casual = Math.min(4, strongSlang + (slang.length > strongSlang ? 1 : 0)) + (lowercase ? 1 : 0) + (punctuation === 'none' ? 1 : 0) + (greetingClass === 'casual' ? 1 : 0)
    + (address_terms.some((a) => !['sir', 'madam', 'my friend'].includes(a)) ? 1 : 0) + (noApos ? 1 : 0) + (laughter ? 1 : 0) + (profanity ? 1 : 0);
  let hype = (elongation >= 0.3 ? 3 : elongation >= 0.15 ? 2 : elongation > 0 ? 1 : 0) + (emoji_rate >= 2 ? 2 : emoji_rate >= 1 ? 1 : 0) + (multiBang ? 1 : 0)
    + (shouting && mood.positive > 0 ? 1 : 0) + Math.min(2, count(allLower, HYPE_WORDS));
  const upset = moodLabel === 'angry' || moodLabel === 'frustrated';
  let register: ToneProfile['register'];
  if (formal >= 3 && casual <= 1) register = 'formal';
  else if (hype >= 3 && casual >= 1 && !upset) register = 'hype';
  else if (casual >= 2) register = 'casual';
  else if (formal >= 2 && casual === 0) register = 'formal';
  else register = 'neutral';

  // language
  let language = 'en';
  const script = SCRIPTS.find(([re]) => re.test(all));
  if (script) language = script[1] === 'ar' && /[\u{0679}\u{0688}\u{0691}\u{06BA}\u{06D2}\u{06AF}\u{067E}\u{0686}]/u.test(all) ? 'ur' : script[1];
  else {
    const folded = fold(allLower), en = count(folded, EN_WORDS);
    let best: [string, number] = ['en', 0];
    for (const [code, re] of Object.entries(LANG_WORDS)) { const n = count(folded, re); if (n > best[1]) best = [code, n]; }
    if (best[1] >= 2 && best[1] > en) language = best[0];
  }

  // notes for context_notes (plain strings the prompt can read)
  const notes: string[] = [];
  const last = texts[texts.length - 1]!;
  if (language !== 'en') notes.push(`customer wrote in ${language}: reply in simple English unless the owner enabled other languages`);
  else if (L2.test(allLower)) notes.push('customer may not be a native English speaker: short plain sentences, no slang, no idioms');
  if (older || (register === 'formal' && signOff)) notes.push('formal or older customer: full sentences, no slang, no emoji, explain one step at a time');
  if (shouting) notes.push('customer is writing in capitals');
  if (words(last) <= 2 && last.length <= 12) notes.push('last message is one or two words: answer in one short line');

  return {
    profile: { register, mood: moodLabel, greeting, address_terms, elongation, emoji_rate, lowercase, punctuation, avg_chars, language, slang },
    signals: { formal, casual, hype, mood, shouting, profanity, sign_off: signOff, stretched: stretched.map((w) => w.toLowerCase()), max_run: Math.max(0, ...stretched.map((w) => Math.max(...(w.toLowerCase().match(/(\p{L})\1+/gu) || ['']).map((r) => r.length)))) },
    notes, emojis: [...new Set(emojis)],
  };
}
function words(s: string): number { return (s.trim().match(/\S+/g) || []).length; }

// Topics where the reply stops mirroring whatever the mood is: money back, complaints, safety, the law.
// Cheap and deliberately broad. Run it on the last three customer messages joined with a space.
const SERIOUS = /\b(?:refund(?:s|ed)?|money back|return(?:s|ing|ed)?|send (?:it|this) back|cancel(?:led|ling|lation)?|charge ?back|dispute|complain(?:t|ts|ing)?|trading standards|solicitor|court|warranty claim|fire|caught fire|on fire|smok(?:e|ing)|burn(?:t|ing|s)?|melt(?:ed|ing)?|spark(?:s|ed|ing)?|swoll?en|swelling|bulg(?:e|ing)|over ?heat(?:s|ed|ing)?|(?:very|really|too|so|extremely) hot|explod(?:e|ed|ing)|leak(?:s|ed|ing)?|charg(?:e|ing) (?:it )?(?:overnight|over night|unattended|indoors|inside|in (?:my|the) (?:bedroom|hallway|flat|house))|overnight|crash(?:ed)?|came off|fell off|accident|injur(?:y|ed|ies)|hurt|hospital|road legal|street legal|on (?:the )?(?:road|roads|street|pavement|cycle (?:lane|path)|public)|sticker|legal(?:ly)?|illegal|law|police|seized|insurance|insured|licen[cs]e|register(?:ed)?|dvla|number ?plate|mot|derestrict(?:ed|ing)?|de restrict|unrestrict(?:ed)?|speed limiter|remove the limit(?:er)?|bypass|under ?age|my (?:kid|son|daughter|child)|\d{1,2} ?(?:year|yr) ?old)\b/i;
export function isSeriousTopic(text: string): boolean { return SERIOUS.test(String(text || '').toLowerCase()); }

// What the reply may do with a profile. Pure function, used to fill the <tone> block of the prompt and the sanitizer options.
export function mirrorPlan(tone: ToneProfile, voice: Partial<Pick<VoiceSettings, 'mirror_level' | 'max_chars' | 'emojis'>> = {}): MirrorPlan {
  const level = voice.mirror_level || 'match';
  const upset = tone.mood === 'angry' || tone.mood === 'frustrated';
  const formal = tone.register === 'formal';
  const off = level === 'off' || upset || formal;
  const SAFE_ADDR = ['bro', 'bruv', 'mate', 'man', 'pal', 'bud', 'buddy', 'lad', 'boss', 'chief', 'dude', 'guys', 'g', 'fam', 'bruh', 'my man', 'my guy'];
  const address = off ? '' : (tone.address_terms.find((a) => SAFE_ADDR.includes(a)) || '');
  const greetMap: Record<string, string> = { yo: 'yo', oi: 'hey', ay: 'hey', sup: 'hey', wagwan: 'yo', alright: 'alright', hiya: 'hiya', hey: 'hey', hi: 'hi', hello: 'hello', dear: 'Hello', salam: 'hi', 'ey up': 'hiya' };
  let greeting = tone.greeting ? (greetMap[tone.greeting] ?? (tone.greeting.startsWith('good ') ? tone.greeting.replace(/^g/, 'G') : 'hi')) : '';
  if (upset && greeting) greeting = 'hi';
  if (formal && greeting && !/^(Good|Hello)/.test(greeting)) greeting = 'Hello';
  const stretch = off || level !== 'match' || !tone.elongation ? 0 : 1;
  const budget = Math.max(60, Math.min(voice.max_chars || 260, Math.round((tone.avg_chars || 40) * 1.5 + 60)));
  return {
    greeting,                                         // say this once, only in the first reply of a conversation
    address,                                          // at most once per reply, '' means use none
    stretch_words: stretch,                           // how many words may carry ONE extra letter (broo, heyy)
    lowercase: !off && level === 'match' && tone.lowercase && (tone.register === 'hype' || tone.register === 'casual'),
    emoji_max: off || voice.emojis === 'never' ? 0 : voice.emojis === 'sometimes' ? 1 : Math.min(2, Math.ceil(tone.emoji_rate || 0)),
    exclamations_max: upset || formal ? 0 : tone.register === 'hype' ? 2 : 1,
    slang_ok: off ? [] : tone.slang.filter((s) => ['sick', 'mint', 'sound', 'sorted', 'buzzing', 'proper', 'decent', 'quid', 'cheers', 'nah', 'yeah', 'defo', 'rapid', 'beast', 'insane', 'mental', 'wheelie', 'surron'].includes(s)),
    char_budget: upset ? Math.max(budget, 160) : budget,
    end_with_full_stop: formal,
  };
}

/** How the customer writes, from the last few text messages they sent. */
export function profileTone(history: readonly ToneMessage[]): ToneProfile {
  return analyzeTone(history).profile;
}

/** "brooo" -> "bro", "yooo" -> "yo", "heyyy" -> "hey". Keeps genuine double letters ("cool" stays "cool"). */
export function collapseElongation(word: string): string {
  return destretch(word);
}
