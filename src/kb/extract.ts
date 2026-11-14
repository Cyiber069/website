// Turns an uploaded file into plain text for the knowledge base.
// Text formats are read here. PDF, Word, Excel and images go through Workers AI document conversion.
import type { Env } from '../types';
import { HttpError } from '../lib/http';

export interface UploadedFile {
  name: string;
  /** MIME type as sent by the browser, may be empty. */
  type: string;
  bytes: ArrayBuffer;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const NATIVE = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'log']);
// What env.AI.toMarkdown accepts that we cannot read ourselves.
const CONVERTED: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel', xlsm: 'application/vnd.ms-excel.sheet.macroenabled.12', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text', numbers: 'application/vnd.apple.numbers',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
};
const MIME_TO_EXT: Record<string, string> = {
  'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json', 'text/html': 'html',
  ...Object.fromEntries(Object.entries(CONVERTED).map(([ext, mime]) => [mime, ext])),
};

export function fileExtension(name: string, type = ''): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  if (m) return m[1]!.toLowerCase();
  return MIME_TO_EXT[type.split(';')[0]!.trim().toLowerCase()] ?? '';
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€', copy: '©', reg: '®', trade: '™', hellip: '...',
  ndash: '–', mdash: '—', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', middot: '·', bull: '•', deg: '°', times: '×', frac12: '½',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** HTML to readable text. Headings become markdown headings (they drive chunking), lists become "- " lines. */
export function htmlToText(html: string): string {
  let t = html.replace(/\r\n?/g, '\n');
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<(script|style|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  t = t.replace(/\s*\n\s*/g, ' ');
  t = t.replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `).replace(/<\/h[1-6]\s*>/gi, '\n\n');
  t = t.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/(td|th)\s*>/gi, ' | ');
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote|header|footer|main|dl|dd|dt)\s*>/gi, '\n\n');
  t = t.replace(/<(p|div|section|article|table|blockquote)\b[^>]*>/gi, '\n\n');
  t = t.replace(/<[^>]+>/g, '');
  t = decodeEntities(t);
  t = t.replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/( \| )+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function decodeUtf8(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(bytes).replace(/^﻿/, '');
}

/**
 * Read the text out of an uploaded file.
 * Throws HttpError `unsupported_type`, `too_large` or `empty_text` (the codes the dashboard knows).
 */
export async function extractText(env: Env, file: UploadedFile): Promise<{ text: string; mime: string }> {
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', 'That file is larger than 10 MB');
  const ext = fileExtension(file.name, file.type);
  let text = '';
  let mime = file.type || 'application/octet-stream';

  if (NATIVE.has(ext)) {
    const raw = decodeUtf8(file.bytes);
    if (ext === 'html' || ext === 'htm') text = htmlToText(raw);
    else if (ext === 'json') {
      // Pretty printed JSON chunks far better than one long line.
      try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { text = raw; }
    } else text = raw;
    if (!file.type) mime = ext === 'html' || ext === 'htm' ? 'text/html' : ext === 'json' ? 'application/json' : ext === 'csv' ? 'text/csv' : 'text/plain';
  } else if (CONVERTED[ext]) {
    mime = CONVERTED[ext]!;
    if (!env.AI) {
      throw new HttpError(400, 'unsupported_type', `Reading .${ext} files needs Workers AI, which is not switched on for this Worker. Upload a text, markdown, CSV, JSON or HTML file, or paste the text as a note.`);
    }
    let result: unknown;
    try {
      result = await env.AI.toMarkdown({ name: file.name, blob: new Blob([file.bytes], { type: mime }) });
    } catch (err) {
      throw new HttpError(502, 'unsupported_type', `Could not read that .${ext} file: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    }
    const one = (Array.isArray(result) ? result[0] : result) as { format: string; data?: string; error?: string } | undefined;
    if (!one || one.format === 'error') throw new HttpError(400, 'unsupported_type', `Could not read that .${ext} file${one?.error ? `: ${one.error.slice(0, 200)}` : ''}`);
    text = one.data ?? '';
  } else {
    throw new HttpError(400, 'unsupported_type', `Files of type ${ext ? `.${ext}` : 'unknown'} cannot be read. Use txt, md, csv, json, html, pdf, docx, xlsx or an image.`);
  }

  text = text.replace(/\u0000/g, '').trim();
  if (text.replace(/\s+/g, '').length < 3) throw new HttpError(400, 'empty_text', 'No text could be read from that file');
  return { text, mime };
}
