/**
 * ref4.py's read_epub(), ported (WP20d): what the measured stage-4 rules read from the file.
 * The OPF is read with ref4's regexes (not stage 2's XML parser) so the rules get exactly the
 * values they were measured on: the title, creators with roles, identifiers and ASIN, the text
 * of the first 3 and last 4 spine documents (1,500 / 3,000 characters; stage 2's shorter
 * windows cost one illustrator on the 600 labeled books), the counted characters and the
 * number of images. The cover is not read here (stage 2's evidence has its facts).
 * Read-only through source-fs.
 */
import { openSourceFile } from '../../calibre/source-fs';
import { PY_SPACE, pyStrip } from '../title-rules';
import { ZipFile } from '../../migration/zip-read';
import { decodeIgnore, textOf, unescapeHtml } from './ref-text';
import type { RefRecord } from './rules-v3';

export type RefFile = RefRecord['file'] & {
  publisher: string[];
  identifiers: string[];
  language: string[];
  description: string;
  asin: string | null;
};

/** posixpath.normpath. */
export function normpath(p: string): string {
  if (p === '') return '.';
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(part);
  }
  const s = (abs ? '/' : '') + out.join('/');
  return s || (abs ? '/' : '.');
}

/** urllib.parse.unquote (UTF-8, bad sequences replaced). */
export function unquote(s: string): string {
  if (!s.includes('%')) return s;
  const bytes: number[] = [];
  let out = '';
  const flush = () => {
    if (bytes.length) out += Buffer.from(bytes).toString('utf8');
    bytes.length = 0;
  };
  for (let i = 0; i < s.length; i++) {
    const m = s[i] === '%' ? /^[0-9a-fA-F]{2}/.exec(s.slice(i + 1, i + 3)) : null;
    if (m) {
      bytes.push(parseInt(m[0], 16));
      i += 2;
    } else {
      flush();
      out += s[i];
    }
  }
  flush();
  return out;
}

const SPACES = new RegExp(`[${PY_SPACE}]`, 'gu');
const cpSlice = (s: string, from?: number, to?: number) => [...s].slice(from, to).join('');

/** Reads an EPUB as ref4 did. Throws for a damaged file (the caller records the error). */
export async function readRefEpub(file: string, counted?: { bytes: number }): Promise<RefFile> {
  const zip = await ZipFile.open(file, openSourceFile);
  try {
    const names = new Set(zip.entries.map((e) => e.name));
    const read = async (name: string) => {
      const e = zip.get(name);
      if (!e) throw new Error(`missing ${name}`);
      if (counted) counted.bytes += e.compressedSize;
      return decodeIgnore(await zip.readBytes(e, 64 * 1024 * 1024));
    };
    const container = await read('META-INF/container.xml');
    const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
    if (!opfPath) throw new Error('container.xml names no OPF');
    const x = await read(opfPath);
    const slash = opfPath.lastIndexOf('/');
    const base = slash >= 0 ? opfPath.slice(0, slash) : '';
    const resolve = (href: string) =>
      normpath((base ? base + '/' : '') + unescapeHtml(unquote(href)));

    const items = new Map<string, [string, string]>();
    for (const m of x.matchAll(/<item\b[^>]*>/g)) {
      const tag = m[0];
      const i = /\bid="([^"]+)"/.exec(tag);
      const h = /\bhref="([^"]+)"/.exec(tag);
      if (i && h) items.set(i[1], [h[1], tag]);
    }
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const creators: { name: string; role: string | null }[] = [];
    for (const m of x.matchAll(/<dc:creator([^>]*)>([^<]*)<\/dc:creator>/g)) {
      const attrs = m[1];
      const name = pyStrip(unescapeHtml(m[2]));
      const role = /role="([^"]+)"/.exec(attrs);
      const cid = /\bid="([^"]+)"/.exec(attrs);
      let r = role ? role[1] : null;
      if (!r && cid) {
        const rm =
          new RegExp(`refines="#${esc(cid[1])}"[^>]*property="role"[^>]*>([^<]+)<`).exec(x) ??
          new RegExp(`property="role"[^>]*refines="#${esc(cid[1])}"[^>]*>([^<]+)<`).exec(x);
        r = rm ? pyStrip(rm[1]) : null;
      }
      creators.push({ name, role: r });
    }
    const all = (re: RegExp) => [...x.matchAll(re)].map((m) => m[1]);
    const identifiers = all(/<dc:identifier[^>]*>([^<]*)/g).map((s) => pyStrip(unescapeHtml(s)));
    const asin = identifiers.map((s) => /\bB0[0-9A-Z]{8}\b/.exec(s)?.[0]).find(Boolean) ?? null;
    const desc = /<dc:description[^>]*>([\s\S]*?)<\/dc:description>/.exec(x)?.[1] ?? '';

    const spine = all(/<itemref[^>]*idref="([^"]+)"/g)
      .filter((s) => items.has(s))
      .map((s) => items.get(s)![0]);
    const plain = async (href: string) => {
      const p = resolve(href);
      if (!names.has(p)) return '';
      let d = await read(p);
      d = d.replace(/<rt\b[^>]*>[\s\S]*?<\/rt>|<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '');
      d = d.replace(/<head[\s\S]*?<\/head>/gi, '');
      return textOf(d);
    };
    const texts: string[] = [];
    for (const h of spine) texts.push(await plain(h));
    return {
      opf_title: pyStrip(unescapeHtml(all(/<dc:title[^>]*>([^<]*)/g)[0] ?? '')),
      creators,
      publisher: all(/<dc:publisher[^>]*>([^<]*)/g).map((s) => pyStrip(unescapeHtml(s))),
      identifiers,
      language: all(/<dc:language[^>]*>([^<]*)/g),
      description: cpSlice(textOf(desc), 0, 2000),
      asin,
      chars: texts.reduce((n, t) => n + [...t.replace(SPACES, '')].length, 0),
      images: [...names].filter((n) => /\.(jpe?g|png|gif|webp)$/i.test(n)).length,
      front_text: cpSlice(texts.slice(0, 3).join('\n'), 0, 1500),
      colophon_text: cpSlice(texts.slice(-4).join('\n'), -3000),
    };
  } finally {
    await zip.close();
  }
}
