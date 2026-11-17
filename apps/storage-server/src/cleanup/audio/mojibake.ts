/**
 * Names that are Shift-JIS shown as CP437 (WP21a; found in Discord/ and a few library folders:
 * an archive extracted with the DOS code page). The text is mapped back to its CP437 bytes and
 * decoded as Shift-JIS (CP932). Accepted only when every character is ASCII or a CP437
 * character, the bytes decode without error, and the result contains kana or kanji; anything
 * else is left as it is. Names on disk are never changed: the decoded form is stored beside.
 */

/** CP437 bytes 0x80-0xFF in order. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■' +
  String.fromCharCode(0xa0);

const TO_BYTE = new Map<string, number>([...CP437_HIGH].map((c, i) => [c, 0x80 + i]));
const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;

let decoder: { decode(b: Uint8Array): string } | null = null;
function sjis(): { decode(b: Uint8Array): string } {
  decoder ??= new TextDecoder('shift_jis', { fatal: true });
  return decoder;
}

/** The decoded form of one name (one path segment), or null when it is not this kind of mojibake. */
export function decodeMojibake(name: string): string | null {
  let high = false;
  const bytes: number[] = [];
  for (const c of name) {
    const cp = c.codePointAt(0)!;
    if (cp < 0x80) {
      bytes.push(cp);
      continue;
    }
    const b = TO_BYTE.get(c);
    if (b === undefined) return null;
    high = true;
    bytes.push(b);
  }
  if (!high) return null;
  let text: string;
  try {
    text = sjis().decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
  return JAPANESE.test(text) ? text : null;
}

/** A root-relative path with every mojibake segment decoded, or null when none is. */
export function decodePath(rel: string): string | null {
  let changed = false;
  const out = rel.split('/').map((seg) => {
    const d = decodeMojibake(seg);
    if (d === null) return seg;
    changed = true;
    return d;
  });
  return changed ? out.join('/') : null;
}
