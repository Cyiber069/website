// Splits a document into pieces of about 300 to 400 tokens for search. Pure functions, no database.
//
// A chunk never crosses a top or second level heading, and every chunk carries the path of headings
// it sits under ("Shipping policy > International orders"), so a piece that is read on its own still
// says what it is about.
import { estimateTokens } from '../lib/db';

export interface Chunk {
  heading: string;
  content: string;
  token_estimate: number;
}

export interface ChunkOptions {
  /** Start a new chunk once the current one has reached this many tokens. */
  target?: number;
  /** A chunk is never larger than this many tokens. */
  max?: number;
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const CHARS_PER_TOKEN = 3.6; // same ratio as estimateTokens

/** Cut text that is longer than maxChars at line ends, then sentence ends, then spaces. */
function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let buf = '';
  const push = (piece: string, joiner: string) => {
    if (buf && buf.length + joiner.length + piece.length > maxChars) { out.push(buf); buf = ''; }
    buf = buf ? buf + joiner + piece : piece;
  };
  for (const line of text.split('\n')) {
    if (line.length <= maxChars) { push(line, '\n'); continue; }
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if (sentence.length <= maxChars) { push(sentence, ' '); continue; }
      let rest = sentence;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(' ', maxChars);
        if (cut < maxChars * 0.5) cut = maxChars;
        push(rest.slice(0, cut), ' ');
        rest = rest.slice(cut).trimStart();
      }
      if (rest) push(rest, ' ');
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Split markdown or plain text into search chunks. `title` is the document title, the root of every heading path. */
export function chunkMarkdown(title: string, content: string, opts: ChunkOptions = {}): Chunk[] {
  const target = opts.target ?? 340;
  const max = Math.max(target, opts.max ?? 400);
  const maxChars = Math.floor(max * CHARS_PER_TOKEN) - 8;
  const targetChars = Math.floor(target * CHARS_PER_TOKEN);
  const smallChars = Math.floor(targetChars / 3);

  const chunks: Chunk[] = [];
  const stack: { level: number; text: string }[] = [];
  const docTitle = title.trim();
  const path = () => {
    const parts = [docTitle, ...stack.map((h) => h.text)].filter(Boolean);
    // A document that starts with its own title as a heading would otherwise say it twice.
    return parts.filter((p, i) => i === 0 || p.toLowerCase() !== parts[i - 1]!.toLowerCase()).join(' > ');
  };

  let heading = path();
  let buf = '';
  const flush = () => {
    const text = buf.trim();
    buf = '';
    if (text) chunks.push({ heading, content: text, token_estimate: estimateTokens(`${heading}\n${text}`) });
    heading = path(); // whatever comes next sits under the headings open right now
  };
  const add = (block: string) => {
    for (const piece of splitLong(block, maxChars - heading.length)) {
      if (buf && buf.length + 2 + piece.length > maxChars - heading.length) flush();
      buf = buf ? `${buf}\n\n${piece}` : piece;
      if (buf.length >= targetChars) flush();
    }
  };

  // Paragraphs are runs of lines between blank lines. Headings always stand alone.
  let para: string[] = [];
  const endPara = () => {
    if (para.length) add(para.join('\n'));
    para = [];
  };
  let fenced = false;
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*```/.test(line)) fenced = !fenced;
    const h = fenced ? null : HEADING.exec(line);
    if (h) {
      endPara();
      const level = h[1]!.length;
      const text = h[2]!.trim();
      // A short lead in under a deeper heading stays with what follows it, so tiny sections do not
      // become tiny chunks. The heading is kept as a line of text inside the chunk.
      const keepGoing = level > 2 && buf.length > 0 && buf.length < smallChars;
      if (!keepGoing) flush();
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text });
      if (keepGoing) buf += `\n\n${text}:`;
      else heading = path();
      continue;
    }
    if (!line.trim()) { endPara(); continue; }
    para.push(line);
  }
  endPara();
  flush();
  return chunks;
}

export interface Section {
  title: string;
  content: string;
}

/**
 * Split one large markdown file into its second level sections, each of which becomes its own
 * knowledge document. Text before the first "## " heading is returned as `intro`.
 */
export function splitSections(content: string): { intro: string; sections: Section[] } {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const sections: Section[] = [];
  const intro: string[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      if (current) sections.push({ title: current.title, content: current.lines.join('\n').trim() });
      current = { title: h[1]!, lines: [] };
    } else if (current) current.lines.push(line);
    else if (!/^#\s+/.test(line)) intro.push(line);
  }
  if (current) sections.push({ title: current.title, content: current.lines.join('\n').trim() });
  return { intro: intro.join('\n').trim(), sections };
}
