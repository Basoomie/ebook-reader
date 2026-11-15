/**
 * Season 2 Phase 10: the copyright and license a font file states about itself, read from
 * its `name` table (name IDs 0 copyright, 13 license description, 14 license URL). Used for
 * fonts added from Google Fonts: every Japanese Google font checked (68, 2026-11-15) has
 * IDs 0 and 14 in its file. Reads plain sfnt (ttf/otf) and woff2; anything else, or a file
 * it can't read, gives nulls. Never throws.
 */
import { brotliDecompressSync } from 'zlib';

export interface FontNames {
  copyright: string | null;
  licenseDescription: string | null;
  licenseUrl: string | null;
}

const NONE: FontNames = { copyright: null, licenseDescription: null, licenseUrl: null };

/** Longest text kept from a name entry. */
const MAX_TEXT = 500;

/** The WOFF2 known-table tags, by index (WOFF2 spec, table 5.1). */
const WOFF2_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

function sfntNameTable(buf: Buffer): Buffer | null {
  const count = buf.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const o = 12 + i * 16;
    if (buf.toString('latin1', o, o + 4) !== 'name') continue;
    const offset = buf.readUInt32BE(o + 8);
    const length = buf.readUInt32BE(o + 12);
    return buf.subarray(offset, offset + length);
  }
  return null;
}

function woff2NameTable(buf: Buffer): Buffer | null {
  const numTables = buf.readUInt16BE(12);
  const compressedLength = buf.readUInt32BE(20);
  let p = 48;
  const base128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[p++];
      value = value * 128 + (b & 0x7f);
      if (!(b & 0x80)) return value;
    }
    throw new Error('bad UIntBase128');
  };
  const tables: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++];
    let tag: string;
    if ((flags & 0x3f) === 0x3f) {
      tag = buf.toString('latin1', p, p + 4);
      p += 4;
    } else {
      tag = WOFF2_TAGS[flags & 0x3f];
    }
    const version = flags >> 6;
    let length = base128();
    // glyf and loca are transformed at version 0; every other table at a nonzero version.
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    if (transformed) length = base128();
    tables.push({ tag, length });
  }
  const data = brotliDecompressSync(buf.subarray(p, p + compressedLength));
  let offset = 0;
  for (const t of tables) {
    if (t.tag === 'name') return data.subarray(offset, offset + t.length);
    offset += t.length;
  }
  return null;
}

/** Windows (platform 3) English (0x409) entries first, then any Windows entry. */
function readEntries(name: Buffer): Map<number, string> {
  const count = name.readUInt16BE(2);
  const stringsAt = name.readUInt16BE(4);
  const english = new Map<number, string>();
  const other = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = name.readUInt16BE(r);
    const language = name.readUInt16BE(r + 4);
    const id = name.readUInt16BE(r + 6);
    const length = name.readUInt16BE(r + 8);
    const offset = name.readUInt16BE(r + 10);
    if (platform !== 3 || ![0, 13, 14].includes(id)) continue;
    const bytes = name.subarray(stringsAt + offset, stringsAt + offset + length);
    let text = '';
    for (let k = 0; k + 1 < bytes.length; k += 2)
      text += String.fromCharCode(bytes.readUInt16BE(k));
    const target = language === 0x409 ? english : other;
    if (!target.has(id)) target.set(id, text);
  }
  for (const [id, text] of other) if (!english.has(id)) english.set(id, text);
  return english;
}

function clean(text: string | undefined): string | null {
  // Control characters out, spaces folded; nothing goes on screen as markup.
  const value = Array.from(text ?? '', (c) => {
    const code = c.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? ' ' : c;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return value ? Array.from(value).slice(0, MAX_TEXT).join('') : null;
}

export function readFontNames(buf: Buffer): FontNames {
  try {
    if (buf.length < 12) return NONE;
    const tag = buf.toString('latin1', 0, 4);
    let name: Buffer | null = null;
    if (tag === 'wOF2') name = woff2NameTable(buf);
    else if (tag === 'OTTO' || tag === 'true' || buf.readUInt32BE(0) === 0x00010000) {
      name = sfntNameTable(buf);
    }
    if (!name || name.length < 6) return NONE;
    const entries = readEntries(name);
    return {
      copyright: clean(entries.get(0)),
      licenseDescription: clean(entries.get(13)),
      licenseUrl: clean(entries.get(14)),
    };
  } catch {
    return NONE;
  }
}
