// The reply sanitizer: deterministic clean up applied to every message before it can be sent.
// The model is asked to follow the same rules, but nothing leaves without passing through here, so
// the owner's rules hold even when the model slips: no dashes, no markdown, no stock assistant
// phrases, short, and properly written (a capital at the start of every message and sentence).
//
// Ported from the reference in the voice research (research/voice.md section E, voice_ref/sanitize.mjs).
// Rule ids in the comments (S0..S14, B1..B3, C1..C7) match that spec. Two owner rules were added later
// and differ from it: capitals are never mirrored away (properCase, S13b) and commas stay as written
// unless the owner switches them off. test/unit/vectors/sanitize.vectors.json holds the expected output.
// Every non ASCII character is written as \u{...} on purpose so the source stays reviewable.
// The rest of the brain uses this through style.ts.
import type { Channel, ToneProfile, VoiceSettings } from '../types';

export interface SanitizeOptions {
  channel: Channel;
  max_chars: number;
  max_sentences: number;
  commas: VoiceSettings['commas'];
  emojis: VoiceSettings['emojis'];
  mirror_level: VoiceSettings['mirror_level'];
  banned_phrases: string[];
  /** Literal strings that must survive untouched (SKUs, order names, links from the knowledge base). */
  protect: string[];
  /** Keeps the honest "this is the ACX assistant" line from being stripped. */
  asked_if_bot: boolean;
  /** The topic is a complaint, refund, safety or legality question: no mirroring of case, stretch or emoji. */
  serious: boolean;
  tone: Partial<ToneProfile> | null;
  /** Emoji the customer used in the profiled window. */
  customer_emojis: string[];
}

export interface SanitizeFlags {
  /** Set when the text must not be sent at all, for example "claims_human". */
  blocked: string | null;
  /** Hints that the wording reads machine written and is worth one regeneration. */
  regen: string[];
  /** Something was cut to fit the length limits. */
  overflow: boolean;
  /** Nothing sendable was left. */
  empty: boolean;
  /** Sentences removed to fit. */
  dropped: string[];
}

export interface SanitizeResult {
  parts: string[];
  flags: SanitizeFlags;
  /** Hard rules the output still breaks. Always empty unless there is a bug. */
  violations: string[];
}

type CommaMode = 'none' | 'normal' | 'formal';
type Filter = ((m: string, rest: unknown[]) => boolean) | null;
interface Vault {
  hide(text: string, re: RegExp, filter?: Filter, type?: string): string;
  isLink(c: string): boolean;
  show(text: string): string;
  items: string[];
}

const P_OPEN = '\u{E000}', P_CLOSE = '\u{E001}';
const PH = /\u{E000}([\u{E100}-\u{E8FF}])\u{E001}/gu;
const PH_ANY = /\u{E000}[\u{E100}-\u{E8FF}]\u{E001}/u;
const DASH = '\u{2014}';

export const DEFAULT_OPTS: SanitizeOptions = {
  channel: 'whatsapp',          // 'whatsapp' | 'tiktok' | 'gmail'
  max_chars: 260,
  max_sentences: 3,
  commas: 'normal',             // 'none' | 'normal'
  emojis: 'mirror',             // 'mirror' | 'never' | 'sometimes'
  mirror_level: 'match',        // 'match' | 'light' | 'off'
  banned_phrases: [],
  protect: [],                  // literal strings that must survive untouched (SKUs, order names, links from the KB)
  asked_if_bot: false,          // keeps the honest "this is the ACX assistant" line from being stripped
  serious: false,               // topic is a complaint, refund, safety or legality question (isSeriousTopic in tone.mjs)
  tone: null,                   // ToneProfile or null
  customer_emojis: [],          // emojis the customer used in the profiled window
};

// ---------------------------------------------------------------- lexicons
const UNIT = '(?:kw|wh|ah|mph|kmh|kph|km|kg|mm|cm|nm|miles?|days?|hrs?|hours?|mins?|minutes?|weeks?|wks?|months?|years?|yrs?|am|pm|mi|k|w|v|a|g|m|%)';
const NUM = '[\\u{00A3}$\\u{20AC}]?\\d+(?:,\\d{3})*(?:\\.\\d+)?';   // pound, dollar, euro
const MONEY = '[\\u{00A3}$\\u{20AC}]\\d+(?:,\\d{3})*(?:\\.\\d+)?';
const DAY = '(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?';

const CONNECTORS = new Set(['and', 'but', 'so', 'or', 'because', 'cos', 'coz', 'which', 'then', 'plus', 'though', 'if', 'when', 'as', 'while', 'unless', 'until', 'since', 'that', 'who', 'with', 'for', 'to', 'in', 'on', 'at', 'from', 'by', 'about', 'like']);
const CONJ = new Set(['but', 'so', 'then', 'plus', 'cos', 'coz', 'cause', 'because', 'as', 'though', 'although', 'while', 'if', 'when', 'which', 'who', 'unless', 'until', 'since', 'once', 'before', 'after', 'whereas', 'and', 'or', 'that', 'where', 'whenever', 'whether']);
const SUBORD = /\b(if|when|once|after|before|while|unless|until|since|because|cos|coz|although|though|whenever|whether|which|who|where|as soon as|as long as|in case)\b/i;
const SPLICE = new Set(['i', "i'm", 'im', "i'll", "i've", 'ive', "i'd", 'we', "we're", "we'll", "we've", "we'd", 'you', "you're", 'youre', "you'll", "you've", "you'd", 'it', "it's", 'its', "it'll", 'they', "they're", "they'll", "they've", "that's", 'thats', "there's", 'theres', 'there', 'this', 'these', 'those', 'he', 'she', "he's", "she's", 'just', 'let', "let's", 'lets', 'lemme', 'drop', 'send', 'pop', 'check', 'try', 'give', 'make', 'have', 'grab', 'ping', 'message', 'shoot', 'hit', 'what', "what's", 'whats', 'how', 'do', 'does', 'did', 'can', 'could', 'would', 'will', 'is', 'are', 'my', 'our', 'your', 'no', 'not', 'yes', 'yeah', 'nah', 'everything', 'all', 'both', 'each', 'most', 'some', 'any', 'nothing', 'someone', 'one']);
const VERBISH = new Set(['is', 'are', 'was', 'were', 'has', 'have', 'had', 'will', 'can', 'could', 'should', 'would', 'does', 'do', 'did', 'comes', 'goes', 'fits', 'ships', 'costs', 'works', 'runs', 'needs', 'takes', 'gets', 'makes', "isn't", "doesn't", "won't", "can't"]);
const ADDR = ['bro', 'bruv', 'bruh', 'mate', 'man', 'pal', 'bud', 'buddy', 'fam', 'g', 'lad', 'lads', 'boss', 'chief', 'dude', 'guys', 'geezer', 'my man', 'my guy', 'big man', 'legend', 'sir', 'madam'];
const OPENER_WORDS = ['hey', 'heya', 'hi', 'hiya', 'hello', 'yo', 'oi', 'morning', 'afternoon', 'evening', 'good morning', 'good afternoon', 'good evening', 'yeah', 'yea', 'yep', 'yup', 'yes', 'no', 'nah', 'nope', 'ok', 'okay', 'sure', 'cool', 'nice', 'nice one', 'sweet', 'sound', 'safe', 'alright', 'right', 'so', 'well', 'oh', 'ah', 'ahh', 'haha', 'lol', 'thanks', 'thank you', 'cheers', 'ta', 'sorry', 'sorry about that', 'apologies', 'honestly', 'basically', 'tbh', 'tbf', 'also', 'and', 'but', 'or', 'plus', 'btw', 'fyi', 'unfortunately', 'sadly', 'luckily', 'no worries', 'no problem', 'all good', 'got it', 'gotcha', 'fair enough', 'good news', 'bad news', 'hmm', 'ooh', 'perfect', 'great', 'awesome', 'amazing', 'brilliant', 'lovely', 'legend', 'ahh ok', 'ah ok', 'oh ok', 'now', 'then', 'otherwise', 'however', 'still', 'anyway', 'either way', 'in that case', 'if so', 'if not', 'for now', 'at the moment', 'right now', 'currently', 'normally', 'usually', 'generally', 'typically', 'obviously', 'actually', 'first', 'firstly', 'second', 'secondly', 'next', 'finally', 'lastly', 'heads up', 'quick one', 'just so you know', 'to be fair', 'to be honest', 'dear'];
const TAGS = [...ADDR, 'though', 'tho', 'too', 'as well', 'thanks', 'thank you', 'cheers', 'please', 'pls', 'innit', 'yeah', 'right', 'haha', 'lol', 'tbh', 'tbf', 'honestly', 'to be fair', 'to be honest', 'no worries', 'for sure', 'sadly', 'unfortunately', 'obviously', 'really', 'either', 'anyway', 'sorry', 'sorry about that', 'if that helps', 'if that works', 'if you like', 'if you want'];

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (arr: string[]): string => [...arr].sort((a, b) => b.length - a.length).map(esc).join('|');
const OPENER_RE = new RegExp(`^(?:${alt(OPENER_WORDS)})(?:\\s+(?:${alt(ADDR)}|there|all|team|[A-Z][a-z]+))?$`, 'i');
const TAG_RE = new RegExp(`^(?:${alt(TAGS)})(?:\\s+(?:${alt(ADDR)}))?$`, 'i');

// B rules: never rewritten, only reported. blocked = do not send. regen = ask the model again once.
const CLAIMS_HUMAN = /\bi\s*(?:'m|am|m)\s+(?:a\s+|an\s+)?(?:real\s+|actual\s+|genuine\s+)?(?:human|person)\b|\bi\s*(?:'m|am)\s+real\b|(?:\bnot|n't|\baint)\s+(?:a\s+|an\s+)?(?:bot|robot|chatbot|ai|machine|computer)\b|\b(?:real|actual)\s+(?:human|person)\s+(?:here|typing|speaking|talking)\b|\bno\s+(?:bots?|robots?|ai)\s+here\b/i;
const NOT_JUST = /\b(?:it'?s|its|that'?s|this is|we'?re|they'?re)\s+not\s+(?:just|only|merely|simply)\b[^.?!]*\b(?:it'?s|its|but|they'?re|we'?re)\b|\bnot only\b[^.?!]*\bbut also\b/i;
const AI_WORDS = /\b(?:delve|tapestry|testament|seamless(?:ly)?|leverage|robust|crucial|pivotal|vibrant|landscape|elevate|unleash|game[- ]changer|embark|navigat(?:e|ing) the|treasure trove|holistic|meticulous(?:ly)?|foster(?:ing)?|underscore[sd]?|showcas(?:e|ing)|in today's|when it comes to|look no further)\b/i;

// S8 stock phrases. SENT = drop the whole sentence. LEAD = drop at the start of a sentence. INLINE = drop anywhere.
const THANKS_FOR = "thanks? (?:you )?(?:so much |very much )?for (?:reaching out|getting in touch|contacting (?:us|acx(?: ebikes)?)|your (?:message|email|enquiry|inquiry|question|interest|patience))(?: (?:to|with) (?:us|acx(?: ebikes)?))?(?: today)?";
const STOCK_SENT = [
  /^(?:that(?:'s| is) )?(?:a )?(?:really |very )?(?:great|good|excellent|fantastic|fair|interesting) question$/i,
  /^(?:certainly|absolutely|of course|sure thing|definitely|no problem at all)$/i,
  new RegExp(`^(?:(?:hi|hello|hey)(?: there)?,? (?:and )?)?${THANKS_FOR}$`, 'i'),
  /^i hope (?:this (?:message|email) finds you well|you(?:'re| are) (?:doing |keeping )?well|you(?:'re| are) having a (?:great|good|lovely|wonderful) (?:day|week))$/i,
  /^i(?:'d| would) be (?:more than )?(?:happy|glad|delighted) to (?:help|assist)(?: you)?(?: with (?:that|this))?$/i,
  /^(?:i|we) (?:completely |totally |fully |truly |really )?understand(?: (?:your|the) (?:frustration|concerns?|confusion|disappointment))?$/i,
  /^(?:i|we) (?:sincerely |truly |do )?apologi[sz]e for (?:any|the) (?:inconvenience|confusion|trouble)(?: (?:this|that|it) (?:may have |might have |has )?caused(?: you)?)?$/i,
  /^(?:we|i) (?:truly |really |sincerely |greatly )?(?:appreciate|value) your (?:patience|understanding|interest|business|custom|support)$/i,
  /^(?:i |we )?hope (?:this|that) (?:helps|clears (?:things|that) up|answers your question)$/i,
  /^(?:please )?(?:feel free to|don'?t hesitate to|do not hesitate to) (?:reach out|ask|contact us|get in touch|let (?:me|us) know|message us)\b.*$/i,
  /^(?:please )?(?:just )?let (?:me|us) know if (?:you (?:have|need|want|would like|'d like)|there(?:'s| is)) (?:any|anything)\b.*$/i,
  /^if you (?:have|need) any(?:thing)? (?:other |further |more |else )?(?:questions?|queries|help|assistance|information)?\b.*$/i,
  /^is there anything else (?:i|we) can (?:help|assist)(?: you)?(?: with)?(?: today)?$/i,
  /^(?:have|enjoy) (?:a|your) (?:great|wonderful|lovely|nice|fantastic|good) (?:day|evening|weekend|week|ride)(?: ahead)?$/i,
  /^happy (?:riding|to help|shopping)$/i,
  /^(?:i(?:'m| am)|we(?:'re| are)) (?:always )?here to help(?: (?:you|if you need (?:anything|us)))?$/i,
  /^(?:i(?:'m| am)|we(?:'re| are)) (?:delighted|pleased|happy|glad|thrilled|excited) to (?:help|assist)\b.*$/i,
];
const STOCK_SENT_CHAT = [/^(?:kind |best |warm |many )?(?:regards|wishes)(?:,?\s+.{0,40})?$/i, /^yours (?:sincerely|faithfully)(?:,?\s+.{0,40})?$/i];   // email sign offs have no place in a chat
const STOCK_LEAD = [
  /^(?:that(?:'s| is) )?(?:a )?(?:really |very )?(?:great|good|excellent|fantastic) question[!,.:]?\s+/i,
  /^(?:certainly|absolutely|of course|sure thing)[!,.]\s+/i,
  new RegExp(`^${THANKS_FOR}[!,.]?\\s+(?:and\\s+)?`, 'i'),
  /^i(?:'d| would) be (?:more than )?(?:happy|glad|delighted) to (?:help|assist)(?: you)?(?: with (?:that|this))?[!,.]\s+/i,
  /^i (?:completely |totally |fully )?understand(?: (?:your|the) (?:frustration|concerns?|confusion))?(?:,\s*(?:and\s+|but\s+)?|\s+and\s+|\s+but\s+)/i,
  /^dear (?:valued )?customer,?\s*/i,
];
const STOCK_INLINE = [
  /\bplease (?:note|be advised|be aware)(?: that)?,?\s*/gi,
  /\bit(?:'s| is) (?:worth|important) (?:noting|mentioning|to note)(?: that)?,?\s*/gi,
  /\bjust to (?:clarify|confirm|let you know),?\s*/gi,
  /\bas (?:mentioned|noted|stated)(?: earlier| above| previously)?,?\s*/gi,
  /\b(?:in summary|in conclusion|to summari[sz]e|to sum up|overall|additionally|furthermore|moreover|that being said|that said|with that in mind|essentially|importantly|rest assured|needless to say),?\s*/gi,
  /\s*\bat this (?:point in )?time\b/gi,
  /\bi wanted to (?:let you know|reach out and say) (?:that )?/gi,
];
const SWAPS: [RegExp, string][] = [
  [/\butili[sz]e(s|d)?\b/gi, 'use$1'], [/\butili[sz]ing\b/gi, 'using'], [/\bin order to\b/gi, 'to'], [/\bprior to\b/gi, 'before'],
  [/\bapproximately\b/gi, 'about'], [/\bregarding\b/gi, 'about'], [/\b(?:inquiry|enquiry)\b/gi, 'question'], [/\b(?:inquiries|enquiries)\b/gi, 'questions'],
  [/\bassistance\b/gi, 'help'], [/(?<!\b(?:pedal|walk|the|power|motor|throttle) )\bassist\b(?! (?:cuts|level|levels|sensor|mode))/gi, 'help'], [/\bhowever,?\s+/gi, 'but '], [/\btherefore,?\s+/gi, 'so '], [/\bkindly\b/gi, 'please'],
  [/\bcannot\b/gi, "can't"], [/\bdo not\b/gi, "don't"], [/\bdoes not\b/gi, "doesn't"], [/\bwill not\b/gi, "won't"], [/\bis not\b/gi, "isn't"], [/\bare not\b/gi, "aren't"], [/\bdid not\b/gi, "didn't"],
];

const EMOJI = /(?:\p{Extended_Pictographic}(?:\u{FE0F}|\u{200D}\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*|[\u{1F1E6}-\u{1F1FF}]{2})/gu;
// check mark, sparkles, rocket, bulb, pin, pointing hand, arrow, target, stars, diamonds, squares, ticks, memo, party, raised hands, 100, megaphone, bell, speech, cart, warning, marks, map pin
const EMOJI_BANNED = new Set(['\u{2705}', '\u{2728}', '\u{1F680}', '\u{1F4A1}', '\u{1F4CC}', '\u{1F449}', '\u{27A1}', '\u{27A1}\u{FE0F}', '\u{1F3AF}', '\u{1F31F}', '\u{2B50}', '\u{1F539}', '\u{1F538}', '\u{25AA}', '\u{25AA}\u{FE0F}', '\u{2714}', '\u{2714}\u{FE0F}', '\u{2611}', '\u{2611}\u{FE0F}', '\u{1F4DD}', '\u{1F389}', '\u{1F64C}', '\u{1F4AF}', '\u{1F4E2}', '\u{1F514}', '\u{1F4AC}', '\u{1F6D2}', '\u{26A0}', '\u{26A0}\u{FE0F}', '\u{2757}', '\u{2753}', '\u{1F4CD}']);
// thumbs up, folded hands, sweat smile, joy, handshake, flexed arm, fire, ok hand, rofl, grin, slight smile, smile, salute, bolt, bicycle
const EMOJI_SAFE = new Set(['\u{1F44D}', '\u{1F64F}', '\u{1F605}', '\u{1F602}', '\u{1F91D}', '\u{1F4AA}', '\u{1F525}', '\u{1F44C}', '\u{1F923}', '\u{1F601}', '\u{1F642}', '\u{1F60A}', '\u{1FAE1}', '\u{26A1}', '\u{26A1}\u{FE0F}', '\u{1F6B2}']);
export const CLEAR_ADDR = ['bro', 'bruv', 'bruh', 'mate', 'pal', 'bud', 'buddy', 'fam', 'geezer', 'my man', 'my guy', 'big man'];   // unambiguous address terms: only say them if the customer did
const KEEP_CAPS = new Set(['UK', 'ACX', 'DPD', 'DHL', 'UPS', 'BMS', 'LCD', 'PAS', 'VAT', 'EU', 'USA', 'OK', 'AI', 'FAQ', 'USB', 'LED', 'PDF', 'DM', 'MOT', 'DVLA', 'EAPC', 'AH', 'KW', 'MPH', 'RRP', 'GPS', 'AM', 'PM', 'UKCA', 'CE', 'NI', 'ROI', 'PO', 'KT', 'BBS', 'TV', 'ID', 'PIN', 'SMS', 'QR', 'MTB', 'BMX', 'TBC', 'XL', 'XXL', 'CHF', 'EUR', 'USD', 'GBP', 'AUD', 'CAD', 'NOK', 'SEK', 'DKK', 'PLN', 'WH', 'CNC', 'ODI', 'MHT', 'GT', 'ST']);
// dialect and in-group words the agent understands but never says, whoever said them first.
// bare, peak and ends are left out on purpose: "peak power" and "bar ends" are normal shop words.
const MARKED_SLANG = /(?<![\p{L}])(?:wagwan|wag1|mandem|gyaldem|blud|bredrin|fam|akh|akhi|ting|tings|innit|peng|leng|wallahi|inshallah|dat|dis|dem|wid|ya get me|you get me|my g|big man ting|roadman|yute)(?![\p{L}])/iu;
const DESTRETCH: Record<string, string> = { heyy: 'hey', yoo: 'yo', broo: 'bro', bruvv: 'bruv', matee: 'mate', yess: 'yes', yeahh: 'yeah', yeaa: 'yea', soo: 'so', noo: 'no', nicee: 'nice', thankss: 'thanks', pleasee: 'please', okk: 'ok', okayy: 'okay', loll: 'lol', ayy: 'ay', hii: 'hi', helloo: 'hello', sickk: 'sick', maan: 'man', mann: 'man', yepp: 'yep', nahh: 'nah', cheerss: 'cheers', ohh: 'oh', ahh: 'ah', wayy: 'way' };
const LEGIT_DOUBLE = new Set(['cool', 'good', 'too', 'soon', 'need', 'sweet', 'free', 'see', 'all', 'well', 'will', 'off', 'feel', 'been', 'speed', 'wheel', 'look', 'really', 'book', 'room', 'three', 'keep', 'week', 'meet', 'agree', 'still', 'full', 'call', 'small', 'stuff', 'less', 'miss', 'pass', 'boss', 'class', 'yall', 'hello', 'sorry', 'cheers', 'proper', 'ebook', 'tell', 'sell', 'fell', 'bell', 'hill', 'pull', 'roll', 'poll', 'bill', 'fill', 'kill', 'mill', 'till', 'wall', 'ball', 'fall', 'tall', 'add', 'odd', 'egg', 'inn', 'err', 'ass', 'mood', 'food', 'root', 'boot', 'door', 'floor', 'poor', 'moon', 'noon', 'zoom', 'loop', 'hook', 'took', 'cook', 'foot', 'wood', 'wool', 'tool', 'pool', 'school', 'smooth', 'choose', 'loose', 'goose', 'green', 'seen', 'seem', 'deep', 'sleep', 'sheet', 'street', 'steel', 'teeth', 'fee', 'bee', 'tree', 'coffee', 'weeeek']);

// ---------------------------------------------------------------- helpers
const KEEP_TAIL: Filter = () => true;
function makeVault(): Vault {
  const items: string[] = [], types: string[] = [];
  return {
    hide(text: string, re: RegExp, filter: Filter = null, type = 'x'): string {
      return text.replace(re, (m: string, ...rest: unknown[]) => {
        if (filter && !filter(m, rest)) return m;
        let tail = '';
        const t = m.match(/[.,!?;:)\]'"]+$/);                 // never swallow trailing sentence punctuation
        if (t && filter !== KEEP_TAIL) { tail = t[0]; m = m.slice(0, -tail.length); }
        if (!m) return tail;
        items.push(m.replace(/[\u{2012}-\u{2015}\u{2212}\u{FE58}]/gu, '-')); types.push(type);
        return P_OPEN + String.fromCharCode(0xE100 + items.length - 1) + P_CLOSE + tail;
      });
    },
    isLink(c: string): boolean { return types[c.charCodeAt(0) - 0xE100] === 'link'; },
    show(text: string): string { let t = text; for (let i = 0; i < 3 && PH_ANY.test(t); i++) t = t.replace(PH, (_, c: string) => items[c.charCodeAt(0) - 0xE100] ?? ''); return t; },
    items,
  };
}
const words = (s: string): string[] => (s.trim().match(/\S+/g) || []);
const firstWord = (s: string): string => ((s.trim().match(/^[\p{L}']+/u) || [''])[0] ?? '').toLowerCase();
const hasFact = (s: string): boolean => /\d/.test(s) || PH_ANY.test(s);
const matchCase = (src: string, to: string): string => (/^\p{Lu}/u.test(src) && !/^\p{Lu}{2,}/u.test(src) ? to.charAt(0).toUpperCase() + to.slice(1) : to);
// Abbreviations whose full stop does not end a sentence.
const PC_ABBR = /^(?:eg|ie|etc|vs|approx|incl|mr|mrs|ms|dr|(?:\p{L}\.)+\p{L})$/iu;
const PC_TOKEN = /^((?:["'(\[\u{201C}\u{2018}]|\p{Extended_Pictographic}|[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}])*)(.*?)([.,!?:;"')\]\u{201D}\u{2019}]*)$/su;
/**
 * Proper writing whatever the customer does: a capital at the start of every message, line and
 * sentence, and for the word I (English only, since "i" is a word in Polish and Italian).
 * Only plain words are touched. Anything with a digit, dot, slash, @ or a hidden span in it (links,
 * emails, product codes, prices) is left alone, and so is a word with a capital inside it (iPhone).
 * A sentence that starts with one of those stays as written. An ellipsis or an abbreviation
 * ("e.g.", "etc.") does not start a new sentence. A leading emoji, quote or bracket is skipped.
 */
export function properCase(text: string, english = true): string {
  let start = true;
  return text.split(/(\s+)/).map((tok) => {
    if (!tok) return tok;
    if (/^\s+$/.test(tok)) { if (tok.includes('\n')) start = true; return tok; }
    const m = PC_TOKEN.exec(tok);
    if (!m) { start = false; return tok; }
    const pre = m[1] ?? '', post = m[3] ?? '';
    let core = m[2] ?? '';
    const ends = /[.!?]/.test(post) && !/\.{2,}/.test(post);
    if (!/[\p{L}\p{N}\u{E000}]/u.test(core)) { if (ends) start = true; return tok; }   // an emoji or punctuation on its own
    const plain = /^\p{L}[\p{L}'\u{2019}-]*$/u.test(core);
    if (plain && english && /^i(?:['\u{2019}](?:m|ll|ve|d))?$/u.test(core)) core = 'I' + core.slice(1);
    else if (plain && start && /^\p{Ll}/u.test(core) && !/\p{Lu}/u.test(core)) core = core.charAt(0).toUpperCase() + core.slice(1);
    start = ends && !(post.startsWith('.') && PC_ABBR.test(core));
    return pre + core + post;
  }).join('');
}
const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
function splitSentences(text: string): string[] {
  // numbers, links and abbreviations are already hidden, so . ! ? followed by a space is real punctuation.
  // split() never loses text: a full stop with no space after it simply does not end a sentence.
  return text.split(/\n+/).flatMap((line) => line.split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter(Boolean);
}

// S2: hide everything that must survive byte for byte. Order matters: most specific first.
const PRODUCT_CODE = /(?<![\w-])(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)+(?![\w-])/g;
function protectSpans(p: string, vault: Vault, protect: string[] = []): string {
  for (const lit of protect) if (lit && lit.trim()) p = vault.hide(p, new RegExp(`(?<![\\w-])${esc(lit.trim().replace(/[\u{2010}-\u{2015}\u{2212}]/gu, '-'))}(?![\\w-])`, 'gi'), KEEP_TAIL);   // S2a KB literals
  p = p.replace(new RegExp(`(${MONEY})(?:\\s?${DASH}\\s?|-)((?:${MONEY})|\\d+(?:,\\d{3})*(?:\\.\\d+)?)(?![\\w-]|\\.\\d)`, 'gu'), '$1 to $2');                               // S2b price ranges
  p = vault.hide(p, new RegExp(MONEY, 'gu'), KEEP_TAIL);                                                                                 // S2c prices
  p = vault.hide(p, /\bhttps?:\/\/[^\s<>"\u{2014}\u{E000}]+/giu, null, 'link');                                                          // S2d links
  p = vault.hide(p, /#[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g);                                                                                // S2e order numbers
  p = vault.hide(p, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g);                                                                                  // S2f emails
  p = vault.hide(p, /(?<![\w./-])(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:co\.uk|org\.uk|com|uk|net|org|io|shop|store|app|me|ly|link|bike)(?:\/[^\s<>"\u{2014}\u{E000}]*)?/giu, null, 'link');   // S2g bare domains
  return vault.hide(p, /(?<![\w-])(?:\+\d|0)[\d ()-]{7,18}\d(?![\w-])/g, (m: string) => { const d = m.replace(/\D/g, '').length; return d >= 9 && d <= 15; });       // S2h phone numbers
}

// ---------------------------------------------------------------- the pipeline
/** Clean a whole reply (one to three parts). Never throws. */
export function sanitizeParts(partsIn: string | string[], optsIn: Partial<SanitizeOptions> = {}): SanitizeResult {
  const o: SanitizeOptions = { ...DEFAULT_OPTS, ...optsIn };
  const tone: Partial<ToneProfile> = o.tone || {};
  const chat = o.channel !== 'gmail';
  const upset = tone.mood === 'angry' || tone.mood === 'frustrated';
  const formal = tone.register === 'formal';
  const mirror = o.mirror_level === 'match';
  const calm = upset || !!o.serious;                              // complaints, refunds, safety, legality: no mirroring of stretch, emoji
  // The owner wants proper writing: commas stay as written unless switched off. Capitals are never mirrored away (S13b).
  const commas: CommaMode = o.commas === 'none' ? (formal ? 'formal' : 'none') : 'normal';
  const flags: SanitizeFlags = { blocked: null, regen: [], overflow: false, empty: false, dropped: [] };
  const vault = makeVault();

  let parts = (Array.isArray(partsIn) ? partsIn : [partsIn]).map((p) => String(p ?? ''));
  const rawJoined = parts.join('\n');

  // B1 never claim to be human. B2 and B3 are hints for one regeneration.
  if (CLAIMS_HUMAN.test(rawJoined)) flags.blocked = 'claims_human';
  if (NOT_JUST.test(rawJoined)) flags.regen.push('not_just_x_but_y');
  if (AI_WORDS.test(rawJoined)) flags.regen.push('ai_vocabulary');

  parts = parts.map((p) => {
    // S0 normalise characters
    p = p.normalize('NFC').replace(/\r\n?/g, '\n')
      .replace(/[\u{200B}-\u{200D}\u{2060}\u{FEFF}\u{00AD}]/gu, '')                               // zero width and soft hyphen
      .replace(/[\u{00A0}\u{2007}\u{2009}\u{200A}\u{202F}\u{3000}]/gu, ' ')                        // odd spaces
      .replace(/[\u{2018}\u{2019}\u{201B}\u{2032}]/gu, "'").replace(/[\u{201C}\u{201D}\u{201F}\u{2033}]/gu, '"')
      .replace(/\u{2026}/gu, '...')
      .replace(/[\u{2010}\u{2011}\u{FE63}\u{FF0D}\u{2043}]/gu, '-')                                // hyphen look-alikes
      .replace(/[\u{2012}\u{2013}\u{2014}\u{2015}\u{2212}\u{FE58}]/gu, DASH);                      // every long dash becomes one marker

    // S1 markdown links and images become plain text plus the bare link
    p = p.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, '$1')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|www\.[^)\s]+)\)/g, (_, t: string, u: string) => (t.replace(/^https?:\/\//, '') === u.replace(/^https?:\/\//, '') ? u : `${t} ${u}`));

    // S2 protect spans that must survive byte for byte
    p = protectSpans(p, vault, o.protect);

    // S3 markdown. Every marker becomes a space, never nothing, so two tokens can never fuse.
    p = p.replace(/```[a-z]*\n?/gi, ' ').replace(/`([^`\n]*)`/g, ' $1 ')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s{0,3}>\s?/gm, '').replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')
      .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, ' $2 ').replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, ' $1 ').replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, ' $1 ')
      .replace(/~~([^~\n]+)~~/g, ' $1 ').replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, '').replace(/\s*\|\s*/g, ' ').replace(/\*\*/g, ' ')
      .replace(/[ \t]+([,.!?:)])/g, '$1').replace(/([(])[ \t]+/g, '$1').replace(/[ \t]{2,}/g, ' ');

    // S4 bullets and numbered lists become plain sentences
    p = flattenLists(p);
    if (chat) p = p.trim().replace(/[,;:]?[ \t]*\n+[ \t]*/g, (_m: string, off: number, str: string) => (/[.!?]$/.test(str.slice(0, off)) ? ' ' : '. '));   // chat parts never carry a line break

    // S5 dashes and hyphens
    p = p.replace(/\s*(?:<?-{1,2}>|=>|[\u{2192}\u{279C}\u{27A1}\u{21D2}\u{2794}]\u{FE0F}?)\s*/gu, ' > ');             // S5a arrows
    p = p.replace(/\b24-7\b/g, '24/7').replace(/\b50-50\b/g, '50/50').replace(/\bwi-fi\b/gi, (m) => matchCase(m, 'wifi'));
    p = p.replace(/-{2,}/g, DASH).replace(/\s+-\s+/g, ` ${DASH} `).replace(/(?<=\S)-\s+(?=\S)/g, ` ${DASH} `).replace(/(?<=\S)\s+-(?=[^\d\s-])/g, ` ${DASH} `); // S5b spaced hyphen is a dash
    const range = new RegExp(`(?<![\\w-])(${NUM})(\\s?${UNIT})?(?:\\s?${DASH}\\s?|-)(${NUM})(\\s?${UNIT})?(?![\\w-]|\\.\\d)`, 'giu');   // a tight hyphen or any long dash
    p = p.replace(range, (m: string, a: string, ua: string | undefined, b: string, ub: string | undefined) => {                                                                          // S5c number ranges
      const x = (ua || '').trim().toLowerCase(), y = (ub || '').trim().toLowerCase();
      const ok = !x || !y || x === y || (/^(am|pm)$/.test(x) && /^(am|pm)$/.test(y));
      return ok ? `${a}${ua || ''} to ${b}${ub || ''}` : m;
    });
    p = p.replace(new RegExp(`\\b(${DAY})\\s?[${DASH}-]\\s?(${DAY})\\b`, 'giu'), '$1 to $2');                             // S5d day ranges
    p = p.replace(/(?<![\w-])(\d{1,4})-(\d{1,2})-(\d{1,4})(?![\w-])/g, '$1/$2/$3');                                       // S5e dates
    p = vault.hide(p, /\d+(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d{1,2}:\d{2}/g, KEEP_TAIL);                                              // S5f big numbers, decimals, times
    p = vault.hide(p, PRODUCT_CODE);                                                                                      // S5f product codes
    p = p.replace(new RegExp(`${DASH}([^${DASH}.!?\\n]{1,60})${DASH}\\s*(?=(\\p{L}[\\p{L}']*))`, 'gu'), (m: string, inner: string, next: string) => // S5g paired dashes
      (words(inner).length <= 6 && VERBISH.has(next.toLowerCase()) ? ` (${inner.trim()}) ` : m));
    p = p.replace(new RegExp(`\\s*${DASH}\\s*`, 'gu'), (m: string, off: number, str: string) => {                                                 // S5h single dash
      const before = str.slice(0, off), after = str.slice(off + m.length);
      if (!before.trim() || !after.trim() || /[.!?:,(]$/.test(before.trim())) return ' ';
      if (CONNECTORS.has(firstWord(after))) return ' ';
      const clause = before.split(/[.!?\n]/).pop() ?? '';
      if (words(clause).length <= 2) return commas === 'normal' || commas === 'formal' ? ', ' : ' ';
      return '. ';
    });
    p = p.replace(/\b(e|re|pre|de)-(?=\p{L})/giu, '$1').replace(/(?<![\w])-(?=\d)/g, 'minus ').replace(/-/g, ' ');       // S5i word hyphens

    // S6 abbreviations lose their dots so that every remaining full stop is a real one
    p = p.replace(/\b([ap])\.m\.?(?=\W|$)/gi, '$1m').replace(/\be\.g\.?(?=\W|$)/gi, 'eg').replace(/\bi\.e\.?(?=\W|$)/gi, 'ie').replace(/\b(etc|approx|vs|incl|inc|min|max|no|tel)\.(?=\s+[a-z0-9])/g, '$1');

    // S7 semicolons
    return p.replace(/\s*;\s*/g, '. ');
  });

  // S8 owner banned phrases, stock phrases, word swaps
  parts = parts.map((p) => {
    for (const b of o.banned_phrases) if (b && b.trim()) p = p.replace(new RegExp(`(?<![\\p{L}\\d])${esc(b.trim())}(?![\\p{L}\\d])[,!]?\\s*`, 'giu'), '');
    const sentRules = chat ? [...STOCK_SENT, ...STOCK_SENT_CHAT] : STOCK_SENT;
    const scrub = (text: string): string => splitSentences(text).map((s) => {
      const upper = /^[^\p{L}]*\p{Lu}/u.test(s);
      for (const re of STOCK_LEAD) s = s.replace(re, '');
      for (const re of STOCK_INLINE) s = s.replace(re, '');
      return upper ? s.replace(/^([^\p{L}\u{E000}]*)(\p{Ll})/u, (_, a, b) => a + b.toUpperCase()) : s;   // a sentence that lost its opener keeps its capital
    }).filter((s) => {
      const core = s.replace(/[.!?,\s]+$/g, '').replace(EMOJI, '').trim();
      return core && (hasFact(core) || !sentRules.some((re) => re.test(core)));
    }).join(' ');
    p = chat ? scrub(p) : p.split(/(\n+)/).map((chunk) => (/^\n+$/.test(chunk) ? chunk : scrub(chunk))).join('');   // email keeps its line breaks
    if (!formal) for (const [re, to] of SWAPS) p = p.replace(re, (m: string, g1: unknown) => matchCase(m, to.replace('$1', typeof g1 === 'string' ? g1 : '')));
    if (!o.asked_if_bot) p = p.replace(/\bas an ai(?: language model| assistant)?,?\s*/gi, '');
    return p;
  });

  // S9 commas
  parts = parts.map((p) => fixCommas(p, commas));

  // S10 capitals, exclamation marks, emoji, stretched letters
  parts = parts.map((p) => {                                       // S10a never shout: two or more ALL CAPS words are lower cased
    const caps = (p.match(/(?<![\p{L}\d])\p{Lu}{2,}(?![\p{L}\d])/gu) || []).filter((w) => !KEEP_CAPS.has(w));
    if (caps.length < 2) return p;
    const first = /^[^\p{L}]*\p{Lu}{2,}(?![\p{L}\d])/u.test(p);
    p = p.replace(/(?<![\p{L}\d])\p{Lu}{2,}(?![\p{L}\d])/gu, (w) => (KEEP_CAPS.has(w) ? w : w.toLowerCase()));
    return first ? p.replace(/\p{Ll}/u, (ch) => ch.toUpperCase()) : p;
  });
  if (o.tone) {                                                    // B4 and B5: hints only, the model rewrites
    const said = parts.join(' ').toLowerCase();
    const used = new Set((tone.address_terms || []).map((a) => a.toLowerCase()));
    if (CLEAR_ADDR.some((a) => !used.has(a) && new RegExp(`(?<![\\p{L}\\d])${a === 'bro' ? 'broo*' : a}(?![\\p{L}\\d])`, 'u').test(said))) flags.regen.push('address_term_not_mirrored');
    if (upset && /(?<![\p{L}])(?:haha+|lol|lmao)(?![\p{L}])/u.test(said)) flags.regen.push('laughing_at_upset_customer');
  }
  if (MARKED_SLANG.test(parts.join(' '))) flags.regen.push('marked_slang');
  const bangCap = calm || formal ? 0 : tone.register === 'hype' ? 2 : 1;
  let bangs = 0, emojiCount = 0;
  const emojiCap = o.emojis === 'never' || calm || formal || o.mirror_level === 'off' ? 0 : o.emojis === 'sometimes' ? 1 : Math.min(2, Math.ceil(tone.emoji_rate || 0));
  const allowed = new Set([...EMOJI_SAFE, ...(o.customer_emojis || [])]);
  const stretchBudget = !mirror || calm || formal || !tone.elongation ? 0 : tone.elongation >= 0.25 ? parts.length : 1;
  const ADDR_SET = new Set(ADDR);
  const classify = (w: string): { keep: string; base: string; fixed?: boolean } | null => {                                       // -> null | { keep: one extra letter, base: plain spelling }
    const two = w.replace(/(\p{L})\1{2,}/giu, '$1$1');
    if (two !== w) return LEGIT_DOUBLE.has(two.toLowerCase()) ? { keep: two, base: two, fixed: true } : { keep: two, base: w.replace(/(\p{L})\1{2,}/giu, '$1') };
    const base = DESTRETCH[w.toLowerCase()];
    return base ? { keep: w, base: matchCase(w, base) } : null;
  };
  const found: string[] = [];                                               // every stretched word in the reply, in order
  parts.forEach((p) => p.replace(/[\p{L}']+/gu, (w) => { const c = classify(w); if (c && !c.fixed) found.push(c.base.toLowerCase()); return w; }));
  const order = found.map((b, i): [number, number] => [ADDR_SET.has(b) ? 0 : 1, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, stretchBudget).map((x) => x[1]);
  const keepIdx = new Set(order);                                 // address terms get the stretch first: "hey broo", not "heyy bro"
  let seen = -1;
  parts = parts.map((p) => {
    p = p.replace(/[!?]*\?[!?]*/g, '?').replace(/!+/g, (m: string, off: number, str: string) => (++bangs <= bangCap ? '!' : '.') + (/^[\p{L}\d\u{E000}]/u.test(str.slice(off + m.length)) ? ' ' : ''));
    p = p.replace(EMOJI, (e) => (EMOJI_BANNED.has(e) || !allowed.has(e) || ++emojiCount > emojiCap ? ' ' : e));
    return p.replace(/[\p{L}']+/gu, (w) => {
      const c = classify(w);
      if (!c) return w;
      if (c.fixed) return c.keep;
      return keepIdx.has(++seen) ? c.keep : c.base;
    });
  });

  // S11 tidy
  parts = parts.map((p) => tidy(p, chat)).filter(Boolean);

  // S12 length: sentence cap, character cap, part cap
  const units: { part: number; para: number; line: number; s: string }[] = [];
  parts.forEach((p, i) => p.split(/\n{2,}/).forEach((para, pi) => para.split('\n').forEach((line, li) => splitSentences(line).forEach((s) => units.push({ part: i, para: pi, line: li, s })))));
  const full = (u: { s: string }): boolean => words(u.s).length >= 4;                      // greetings and fragments do not count as sentences
  const total = () => vault.show(units.map((u) => u.s).join(' ')).length;
  const drop = () => {
    let k = -1;
    for (let i = units.length - 1; i > 0 && k < 0; i--) if (!hasFact(units[i].s) && !/\?\s*$/.test(units[i].s)) k = i;   // filler first
    for (let i = units.length - 1; i > 0 && k < 0; i--) if (!/\?\s*$/.test(units[i].s)) k = i;                           // then facts, never the question
    if (k < 0) k = units.length - 1;
    flags.overflow = true; flags.dropped.push(vault.show(units[k].s)); units.splice(k, 1);
  };
  while (units.filter(full).length > o.max_sentences && units.length > 1) drop();
  while (total() > o.max_chars && units.length > 1) drop();
  if (units.length === 1 && total() > o.max_chars) { flags.overflow = true; units[0].s = hardCut(units[0].s, o.max_chars, vault); }
  const grouped: { part: number; para: number; line: number; s: string }[] = [];
  for (const u of units) {
    const last = grouped[grouped.length - 1];
    if (last && last.part === u.part) { last.s += (last.para !== u.para ? '\n\n' : last.line !== u.line ? '\n' : ' ') + u.s; last.para = u.para; last.line = u.line; } else grouped.push({ ...u });
  }
  parts = grouped.map((g) => g.s);
  const maxParts = chat ? 2 : 1;   // the owner wants 1 or 2 messages per reply
  // A repeated message is dropped before folding, so it never ends up twice inside one message.
  const key = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  parts = parts.filter((x, i) => !parts.slice(0, i).some((y) => key(y) === key(x)));
  while (parts.length > maxParts) {
    let tail = parts.pop()!;
    const head = parts[parts.length - 1]!;
    if (/^[^\p{L}\u{E000}]*\p{Lu}/u.test(head)) tail = tail.replace(/^([^\p{L}\u{E000}]*)(\p{Ll})/u, (_, a: string, b: string) => a + b.toUpperCase());   // keep casing consistent after a merge
    parts[parts.length - 1] = chat ? head + (/[.!?]$/.test(head) ? ' ' : '. ') + tail : head + '\n\n' + tail;
  }

  for (let guard = 0; guard < 6 && parts.length && vault.show(parts.join(' ')).length > o.max_chars; guard++) {   // merge separators can add a character or two
    const k = parts.length - 1, room = o.max_chars - (k ? vault.show(parts.slice(0, k).join(' ')).length + 1 : 0);
    flags.overflow = true;
    if (room < 8) parts.pop(); else parts[k] = hardCut(parts[k], room, vault);
  }

  // S13 final full stop comes off chat messages, nothing may trail a link, placeholders go back
  const masked = parts.map((p) => {
    p = p.replace(new RegExp(`(\\u{E000}([\\u{E100}-\\u{E8FF}])\\u{E001})[.,;:!?]+$`, 'u'), (m: string, ph: string, c: string) => (vault.isLink(c) ? ph : m));   // a link at the end of a message stays the last character
    if (chat && !formal) p = p.replace(/(?<![.])\.$/, '');
    // Currency codes next to an amount are always in capitals: "chf 902" becomes "CHF 902".
    const codes = p.replace(/\b(chf|eur|usd|gbp|nok|sek|dkk|pln|czk|huf|aud|nzd|cad|zar|aed)\b(?=\s?\d)|(?<=\d\s?)\b(chf|eur|usd|gbp|nok|sek|dkk|pln|czk|huf|aud|nzd|cad|zar|aed)\b/gi, (m) => m.toUpperCase());
    return properCase(codes.trim(), (tone.language ?? 'en') === 'en');   // S13b capitals, while links and codes are still hidden
  }).filter(Boolean);
  parts = masked.map((p) => vault.show(p));
  if (!parts.length) flags.empty = true;

  // S14 invariants
  const violations = styleViolations(parts, o, masked);            // exact: checked against the spans this run protected
  return { parts, flags, violations };
}

function flattenLists(p: string): string {
  const mark = /^\s*(?:([-*+\u{2022}\u{00B7}\u{2023}\u{25AA}\u{25E6}\u{25CF}\u{2043}\u{2014}])|(\p{Extended_Pictographic}\u{FE0F}?)|(\(?\d{1,2}[.)]|\(?[a-z]\)))(?:\s+(?=\S)|(?=[,;:!?.])|\s*$)/u;
  const out: string[] = [];
  let run: { raw: string; text: string; kind: 'symbol' | 'emoji' | 'ordered' }[] = [];
  const orderedLines = p.split('\n').filter((l) => { const m = l.match(mark); return m && m[3]; }).length;   // "28. That is the top speed" alone is a sentence, "1." or two numbered lines are a list
  const flush = () => {
    if (!run.length) return;
    const symbol = run.every((r) => r.kind === 'symbol');
    const lone = run.length === 1 && !symbol && !(run[0].kind === 'ordered' && (orderedLines >= 2 || /^\s*\(?\d[.)]/.test(run[0].raw)));
    if (lone) { out.push(run[0].raw.trim()); run = []; return; }                          // a lone "28." or a lone leading emoji is not a list
    const items = run.map((r) => r.text.replace(/[.;,]+$/, '').trim()).filter(Boolean);
    const ordered = run.every((r) => r.kind === 'ordered');
    const short = items.length > 1 && items.length <= 6 && items.every((s) => words(s).length <= 8);
    const prev = out.length ? out[out.length - 1] : null;
    const intro = prev !== null && /:\s*$/.test(prev);
    let joined: string;
    if (short && !ordered) joined = items.map((s, i) => (i || intro ? lowerFirst(s) : s)).reduce((a, s, i, arr) => a + (i === 0 ? '' : i === arr.length - 1 ? ' and ' : ', ') + s, '');
    else joined = items.join('. ');
    if (intro && short && !ordered) out[out.length - 1] = prev.replace(/:\s*$/, '') + ' ' + joined;
    else if (intro) out[out.length - 1] = prev.replace(/:\s*$/, '') + '. ' + joined;
    else out.push(joined);
    run = [];
  };
  for (const line of p.split('\n')) {
    const m = line.match(mark);
    if (m) run.push({ raw: line, text: line.replace(mark, ''), kind: m[1] ? 'symbol' : m[2] ? 'emoji' : 'ordered' });
    else { flush(); out.push(line.trim()); }                       // blank lines are kept so emails keep their paragraphs
  }
  flush();
  // inline steps on one line, only the unambiguous "1) ... 2) ..." shape
  return out.map((line) => (/(?:^|\s)1\)\s/.test(line) && /\s2\)\s/.test(line) ? line.replace(/(?:^|\s)\(?\d{1,2}\)\s+/g, (m, off) => (off === 0 ? '' : '. ')) : line)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function fixCommas(p: string, mode: CommaMode): string {
  p = p.replace(/[ \t]+,/g, ',').replace(/(?<!\d),(?=[^\s\d,])/g, ', ').replace(/,{2,}/g, ',');
  if (mode === 'normal') return p;
  return p.split('\n').map((line) => (line.match(/[^.!?]+[.!?]*\s*|[.!?]+\s*/g) || []).map((sent) => {
    if (!sent.includes(',')) return sent;
    const segs = sent.split(',');
    const starter = (s: string): boolean => SPLICE.has(firstWord(s)) || CONJ.has(firstWord(s));
    const listMany = segs.length >= 3 && segs.slice(1, -1).every((s) => words(s).length <= 4 && !starter(s));
    let out = segs[0], clauseStart = 0;
    for (let i = 1; i < segs.length; i++) {
      const after = segs[i], fw = firstWord(after);
      const before = out.slice(clauseStart).replace(/^[\s.!?]+/, '').trim();
      const rest = segs.slice(i).join(',').replace(/[.!?\s]+$/, '').trim();
      const listOne = !starter(after) && /^\s*(?:\S+\s+){1,4}(?:and|or)\s/i.test(after + ' ');
      let action: 'keep' | 'drop' | 'stop';
      if (fw === 'and' || fw === 'or') action = 'drop';                                  // C1 before and / or
      else if (mode === 'formal') action = 'keep';                                       //    formal register stops here
      else if (OPENER_RE.test(before)) action = 'drop';                                  // C2 after a greeting or opener
      else if (CONJ.has(fw)) action = 'drop';                                            // C3 before a conjunction
      else if (TAG_RE.test(rest)) action = 'drop';                                       // C4 before a trailing tag or address term
      else if (SUBORD.test(before)) action = 'drop';                                     // C5 after a dependent clause
      else if (listMany || listOne) action = mode === 'none' ? 'drop' : 'keep';          // C6 real list
      else if (SPLICE.has(fw)) action = 'stop';                                          // C7 two full clauses
      else action = 'drop';
      const tail = after.replace(/^\s+/, '');
      if (action === 'keep') out += ',' + after;
      else if (action === 'drop') out = out.replace(/\s+$/, '') + ' ' + tail;
      else out = out.replace(/\s+$/, '') + '. ' + tail;
      if (action !== 'keep') clauseStart = out.length - tail.length;
    }
    return out;
  }).join('')).join('\n');
}

function tidy(p: string, chat: boolean): string {
  return p.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(chat ? /\n{2,}/g : /\n{3,}/g, chat ? '\n' : '\n\n')
    .replace(/`+|\*+/g, ' ').replace(/#{2,}/g, ' ').replace(/(^|\s)#(?=\s|$)/g, '$1').replace(/(?<![\p{L}\d])_+|_+(?![\p{L}\d])/gu, ' ').replace(/[ \t]+/g, ' ')   // markdown leftovers
    .replace(/[ \t]+([,.!?:)])(?!\d)/g, '$1').replace(/\([ \t]+/g, '(').replace(/\(\)/g, '').replace(/([!?]),/g, '$1')
    .replace(/([,.!?])\1+/g, (m: string, c: string) => (c === '.' && m.length >= 3 ? '...' : c))
    .replace(/,\s*([.!?])/g, '$1').replace(/\.\s*([!?])/g, '$1').replace(/([!?])\./g, '$1')
    .replace(/(^|\n)[ \t,.;:]+/g, '$1').replace(/[,;:]+\s*$/g, '').replace(/[ \t]+/g, ' ').trim();   // capitals are set once, at the very end (properCase)
}

function hardCut(s: string, max: number, vault: Vault): string {
  let out = '';
  for (const tok of s.split(/(\s+)/)) { if (vault.show(out + tok).length > max) break; out += tok; }
  return out.replace(/[\s,;:]+$/, '');
}

// S14: returns [] when every hard guarantee holds. Works on final strings, so tests can call it on anything.
export function styleViolations(parts: string[], o: Partial<SanitizeOptions> = {}, masked: string[] | null = null): string[] {
  const v = [];
  parts.forEach((raw, i) => {
    const t = masked ? masked[i] : makeVaultMask(raw, o.protect);   // without the pipeline's own mask this is a best effort re-scan
    if (/[\u{2010}-\u{2015}\u{2212}\u{2043}\u{FE58}\u{FE63}\u{FF0D}]/u.test(raw)) v.push(`part${i}:dash_char`);
    if (/-/.test(t)) v.push(`part${i}:hyphen_outside_protected_span`);
    if (/(^|\n)\s*[*+\u{2022}\u{00B7}]\s/u.test(t) || /(^|\n)\s*\d[.)](\s|$)/.test(t) || (t.match(/(^|\n)\s*\d{1,2}[.)](\s|$)/g) || []).length >= 2) v.push(`part${i}:list_marker`);
    if (/\*|__|`|#{2,}|(^|\s)#\s|\]\(/m.test(t)) v.push(`part${i}:markdown`);
    if (/;/.test(t)) v.push(`part${i}:semicolon`);
    if (/[\u{2018}\u{2019}\u{201C}\u{201D}\u{2026}]/u.test(t)) v.push(`part${i}:smart_punctuation`);
    if (o.channel !== 'gmail' && /\n/.test(raw)) v.push(`part${i}:newline_in_chat_part`);
  });
  if (parts.length > (o.channel === 'gmail' ? 1 : 2)) v.push('too_many_parts');
  if (o.max_chars && parts.join(' ').length > o.max_chars) v.push('over_max_chars');
  if (CLAIMS_HUMAN.test(parts.join('\n'))) v.push('claims_human');
  return v;
}
function makeVaultMask(text: string, protect?: string[]): string { const vault = makeVault(); return vault.hide(protectSpans(text, vault, protect), PRODUCT_CODE); }

// Every number in the output must already exist in the input: prices, watts, volts and days never change.
// Digit runs are compared as a multiset, and every currency amount must appear character for character.
export function numbersPreserved(before: string[], after: string[]): boolean {
  const runs = (s: string[]): string[] => (s.join(' ').match(/\d+/g) || []);
  const money = (s: string[]): string[] => (s.join(' ').match(/[\u{00A3}$\u{20AC}]\d+(?:,\d{3})*(?:\.\d+)?/gu) || []);
  const pool = runs(before), prices = money(before);
  return runs(after).every((n) => { const k = pool.indexOf(n); if (k < 0) return false; pool.splice(k, 1); return true; })
    && money(after).every((m) => prices.includes(m));
}

// Guard G1 (research/voice.md section D.3): every number in the reply must appear in the text the model was given
// (knowledge entries, conversation, notes). 1,299 and 1299 count as the same number. Run it on the model's parts before sanitizing.
export function numbersGrounded(parts: string[], sourceText: string): boolean {
  const norm = (s: string): string => String(s).replace(/,(?=\d{3}(?!\d))/g, '');
  const have = new Set(norm(sourceText).match(/\d+(?:\.\d+)?/g) || []);
  return (norm(parts.join(' ')).match(/\d+(?:\.\d+)?/g) || []).every((n) => have.has(n));
}
