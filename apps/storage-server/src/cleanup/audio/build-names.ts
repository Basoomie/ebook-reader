/**
 * Folder and file names of the new library (WP21e-1, design "Layout and naming"). Pure.
 *
 * - Characters Windows can't show over SMB (\ / : * ? " < > |) become their full-width forms,
 *   and so does the old look-alike colon U+A789 that the copy script wrote (decided 2026-11-16).
 * - Control characters become spaces; spaces at either end are dropped; a leading or trailing
 *   dot becomes a full-width dot (a leading dot hides a folder, Windows drops a trailing one).
 * - Names are cut to 255 bytes (UTF-8) at a character boundary (graphemes, so a character
 *   with its marks stays whole); the full title stays in the metadata.
 * - Collision keys compare names the way Windows does over SMB: case-insensitively (NFC).
 */

export const MAX_NAME_BYTES = 255;

const FULL_WIDTH: Record<string, string> = {
  '\\': '＼',
  '/': '／',
  ':': '：',
  '*': '＊',
  '?': '？',
  '"': '＂',
  '<': '＜',
  '>': '＞',
  '|': '｜',
};
/** The old copy script's colon look-alike (MODIFIER LETTER COLON). */
const MODIFIER_COLON = String.fromCharCode(0xa789);
const FULL_STOP = '．';

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function isControl(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0);
}

export interface CleanedName {
  name: string;
  /** Characters replaced by their full-width forms (or controls by spaces). */
  replaced: number;
}

/** One path segment from a title, an author or a file name (no cutting). */
export function cleanSegment(input: string): CleanedName {
  let replaced = 0;
  let out = '';
  for (const ch of input.normalize('NFC')) {
    if (FULL_WIDTH[ch] !== undefined) {
      out += FULL_WIDTH[ch];
      replaced++;
    } else if (ch === MODIFIER_COLON) {
      out += '：';
      replaced++;
    } else if (isControl(ch)) {
      out += ' ';
      replaced++;
    } else out += ch;
  }
  out = out.trim();
  if (out.startsWith('.')) {
    const m = /^\.+/.exec(out)![0];
    out = FULL_STOP.repeat(m.length) + out.slice(m.length);
    replaced += m.length;
  }
  if (out.endsWith('.')) {
    const m = /\.+$/.exec(out)![0];
    out = out.slice(0, out.length - m.length) + FULL_STOP.repeat(m.length);
    replaced += m.length;
  }
  return { name: out === '' ? '_' : out, replaced };
}

/** Cuts `s` to at most `maxBytes` UTF-8 bytes at a grapheme boundary (spaces at the end dropped). */
export function cutToBytes(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const { segment } of segmenter.segment(s)) {
    const b = utf8Bytes(segment);
    if (bytes + b > maxBytes) break;
    out += segment;
    bytes += b;
  }
  out = out.trimEnd();
  if (out.endsWith('.')) out = out.slice(0, -1) + FULL_STOP;
  return out;
}

export interface FittedName {
  name: string;
  cut: boolean;
}

/** `base` + `suffix` in at most 255 bytes: only `base` is cut. */
export function fitName(base: string, suffix = '', maxBytes = MAX_NAME_BYTES): FittedName {
  const room = maxBytes - utf8Bytes(suffix);
  if (utf8Bytes(base) <= room) return { name: base + suffix, cut: false };
  const cutBase = cutToBytes(base, Math.max(room, 1));
  return { name: (cutBase || '_') + suffix, cut: true };
}

/** A file name: the extension is kept, the rest cut. */
export function fitFileName(name: string, maxBytes = MAX_NAME_BYTES): FittedName {
  const i = name.lastIndexOf('.');
  const ext = i > 0 && name.length - i <= 10 ? name.slice(i) : '';
  const base = ext ? name.slice(0, i) : name;
  return fitName(base, ext, maxBytes);
}

/** Inserts a suffix before a file's extension: `a.pdf` -> `a (2).pdf`. */
export function withFileSuffix(name: string, suffix: string): string {
  const i = name.lastIndexOf('.');
  const ext = i > 0 && name.length - i <= 10 ? name.slice(i) : '';
  const base = ext ? name.slice(0, i) : name;
  return fitName(base, suffix + ext).name;
}

/** How two names in one folder are compared (Windows over SMB: case-insensitive). */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** A series position as written in a folder name: 5, 5.5, 0. */
export function formatPosition(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}
