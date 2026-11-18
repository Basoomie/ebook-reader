/**
 * Text helpers of the reference fetcher (ref4.py, the run the stage-4 rules were measured on),
 * ported so the parsers see pages exactly as the measurement did: Python's html.unescape,
 * text_of, NFKC, and bytes decoded as UTF-8 with invalid bytes dropped ('ignore').
 */
import { pyStrip } from '../title-rules';
import { HTML5_ENTITIES, INVALID_CHARREFS, INVALID_CODEPOINT_RANGES } from './html-entities';

const ch = (...codes: number[]) => String.fromCharCode(...codes);
const REPLACEMENT = ch(0xfffd);
const IDEOGRAPHIC_SPACE = ch(0x3000);
/** Python's html._charref: a reference ends at a tab, newline, form feed, space, <, &, # or ;. */
const CHARREF = new RegExp(
  `&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^${ch(9, 10, 12)} <&#;]{1,32};?)`,
  'g',
);

function invalidCodepoint(n: number): boolean {
  return INVALID_CODEPOINT_RANGES.some(([a, b]) => n >= a && n <= b);
}

/** Python 3's html.unescape (the html5 entity table and its handling of bad references). */
export function unescapeHtml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(CHARREF, (_m, ref: string) => {
    if (ref[0] === '#') {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      const num = parseInt(ref.slice(hex ? 2 : 1).replace(/;$/, ''), hex ? 16 : 10);
      if (INVALID_CHARREFS[String(num)] !== undefined) return INVALID_CHARREFS[String(num)];
      if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return REPLACEMENT;
      if (invalidCodepoint(num)) return '';
      return String.fromCodePoint(num);
    }
    if (HTML5_ENTITIES[ref] !== undefined) return HTML5_ENTITIES[ref];
    // The longest name the standard defines without a semicolon.
    for (let x = ref.length - 1; x > 1; x--) {
      const name = ref.slice(0, x);
      if (HTML5_ENTITIES[name] !== undefined) return HTML5_ENTITIES[name] + ref.slice(x);
    }
    return '&' + ref;
  });
}

const REPLACEMENT_BYTES = Buffer.from([0xef, 0xbf, 0xbd]);

/**
 * bytes.decode('utf8', 'ignore'): invalid bytes dropped, everything else kept, a byte-order mark
 * and genuine U+FFFD characters included (both appear in real EPUBs: 12 of the labeled books
 * start their documents with a BOM, one carries U+FFFD in its OPF). TextDecoder replaces each
 * invalid sequence with U+FFFD (the same maximal-subpart rule as Python), so the text is decoded
 * between the genuine U+FFFD bytes and the replacements removed.
 */
export function decodeIgnore(body: Buffer): string {
  const dec = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const at = body.indexOf(REPLACEMENT_BYTES, from);
    const piece = body.subarray(from, at === -1 ? body.length : at);
    parts.push(dec.decode(piece).split(REPLACEMENT).join(''));
    if (at === -1) break;
    parts.push(REPLACEMENT);
    from = at + 3;
  }
  return parts.join('');
}

export const nfkc = (s: string | null | undefined): string => (s ?? '').normalize('NFKC');

const BLANKS = new RegExp(`[ ${ch(9)}${IDEOGRAPHIC_SPACE}]+`, 'g');

/** ref4 text_of: tags out, line breaks for <br>, </p>, </div>, entities resolved. */
export function textOf(fragment: string): string {
  let f = fragment.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  f = f.replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n');
  let t = unescapeHtml(f.replace(/<[^>]+>/g, ''));
  t = t.replace(BLANKS, ' ');
  return pyStrip(t.replace(/\n\s*\n+/g, '\n'));
}
