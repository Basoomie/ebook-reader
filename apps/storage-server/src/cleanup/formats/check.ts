/**
 * Books without an EPUB: the server's check of each EPUB the sidecar made (decided at stop 1):
 *   - it opens with the reader's own import (stage 3's reader processes run the counter bundle,
 *     vendor/epub-count.cjs: the very code a device runs);
 *   - a text book keeps its text: calibre's text of the EPUB holds at least `textKeptMin` of
 *     calibre's text of the source, both counted by the reader's rule (the sidecar measured both);
 *   - a picture book keeps every page: the EPUB's pages show at least as many pictures as the
 *     archive holds (pictures packed in the EPUB but on no page are not pages: the spot check,
 *     2026-11-27, found a rebuilt mokuro EPUB with 216 pictures and none shown);
 *   - an extracted or rebuilt EPUB has something to read (text or pictures);
 *   - a book with fewer than `minBookChars` characters and no picture on its pages beyond a cover
 *     is no book (listed and left: an 86-character note, a download advert).
 */
import fs from 'fs/promises';
import type { Stage3Reader } from '../../counts/book-text-worker';
import path from 'path';
import { ZipFile } from '../../migration/zip-read';
import type { FormatSettings } from '../settings';

/** What the sidecar reported for a converted book (its JobResult). */
export interface JobFacts {
  outcome: string;
  kind: string | null;
  method: string | null;
  detail: string | null;
  sourceSize: number | null;
  sourceSha256: string | null;
  sourceChars: number | null;
  epubChars: number | null;
  sourceImages: number | null;
  epubSha256: string | null;
  epubSize: number | null;
  ms: number;
  entries: number | null;
}

export interface CheckResult {
  ok: boolean;
  /** Why it failed, in plain words (null when it passed). */
  reason: string | null;
  /** The reader's own count and its chapter count (null when it didn't open). */
  readerChars: number | null;
  chapters: number | null;
  epubImages: number | null;
  /** Text kept: calibre's text of the EPUB over the source's (text books). */
  textShare: number | null;
  /** What kind of book it is for the spot check: text, picture, extracted, rebuilt. */
  group: 'text' | 'picture' | 'extracted' | 'rebuilt';
  /** Set when the book is listed for a reason of its own rather than a failed check. */
  listedAs?: 'too_little';
  ms: number;
}

const IMAGE = /\.(jpe?g|png|gif|webp|bmp|avif|jxl|tiff?|svg)$/i;
/** Pages larger than this are not read for their pictures (a page is small; a book is not). */
const MAX_PAGE_BYTES = 32 * 1024 * 1024;

/**
 * Every picture a page shows the way the reader shows it: an <img src> or an SVG <image href>
 * (generate-epub-html.ts rewrites only these; a stylesheet's url() never loads in the reader,
 * which is how calibre's rebuild of a mokuro page hides its 216 pictures). Pure.
 */
export function pictureRefs(markup: string): string[] {
  const out: string[] = [];
  const add = (ref: string) => {
    const bare = ref.trim().split('#')[0].split('?')[0];
    if (IMAGE.test(bare)) out.push(bare);
  };
  for (const m of markup.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of markup.matchAll(
    /<(?:svg:)?image\b[^>]*?\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi,
  ))
    add(m[1]);
  return out;
}

/** A link inside the EPUB resolved against the file it is in ("a/b.xhtml" + "../i.jpg" = "i.jpg"). */
function resolveRef(from: string, ref: string): string {
  let r = ref;
  try {
    r = decodeURIComponent(ref);
  } catch {
    // Kept as written.
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), r)).replace(/^\.\//, '');
}

/**
 * Pictures inside an EPUB: every image entry, and the distinct ones its pages show (a picture
 * an <img> or <image> of a document in the spine points at).
 */
export async function epubPictures(file: string): Promise<{ entries: number; shown: number }> {
  const zip = await ZipFile.open(file, (f) => fs.open(f, 'r'));
  try {
    const images = new Set(zip.entries.filter((e) => IMAGE.test(e.name)).map((e) => e.name));
    const container = zip.get('META-INF/container.xml');
    if (!container) return { entries: images.size, shown: 0 };
    const opfPath = /full-path\s*=\s*["']([^"']+)["']/i.exec(await zip.readText(container))?.[1];
    const opfEntry = opfPath ? zip.get(opfPath) : undefined;
    if (!opfPath || !opfEntry) return { entries: images.size, shown: 0 };
    const opf = await zip.readText(opfEntry);
    const items = new Map<string, string>();
    for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
      const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
      if (id && href) items.set(id, resolveRef(opfPath, href));
    }
    const spine = [...opf.matchAll(/<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["']/gi)]
      .map((m) => items.get(m[1]))
      .filter((x): x is string => !!x);
    const shown = new Set<string>();
    for (const name of spine) {
      const e = zip.get(name);
      if (!e || e.size > MAX_PAGE_BYTES) continue;
      const markup = (await zip.readBytes(e, MAX_PAGE_BYTES)).toString('utf8');
      for (const ref of pictureRefs(markup)) {
        const pic = resolveRef(name, ref);
        if (images.has(pic)) shown.add(pic);
      }
    }
    return { entries: images.size, shown: shown.size };
  } finally {
    await zip.close();
  }
}

/** The group a converted book belongs to (pure). */
export function groupOf(facts: Pick<JobFacts, 'method' | 'kind'>): CheckResult['group'] {
  if (facts.method === 'extract') return 'extracted';
  if (facts.method === 'comic') return 'picture';
  if (facts.method === 'rebuild') return 'rebuilt';
  return 'text';
}

/** The rules on the measured facts (pure: tests run every case). */
export function judge(
  facts: JobFacts,
  m: { opened: boolean; openError: string | null; readerChars: number | null; epubImages: number },
  s: Pick<FormatSettings, 'textKeptMin' | 'pictureMaxChars' | 'minBookChars'>,
): Pick<CheckResult, 'ok' | 'reason' | 'textShare' | 'listedAs'> {
  if (!m.opened)
    return {
      ok: false,
      reason: `The reader can’t open it: ${(m.openError ?? 'unknown error').slice(0, 300)}`,
      textShare: null,
    };
  const group = groupOf(facts);
  const reader = m.readerChars ?? 0;
  if (group === 'picture') {
    if (m.epubImages === 0)
      return { ok: false, reason: 'The EPUB has no pictures on its pages', textShare: null };
    if (facts.sourceImages !== null && m.epubImages < facts.sourceImages)
      return {
        ok: false,
        reason: `Pages missing: ${m.epubImages} pictures on the EPUB's pages, ${facts.sourceImages} in the archive`,
        textShare: null,
      };
    return { ok: true, reason: null, textShare: null };
  }
  // A cover alone is no book: a few lines of text beside it are a note, not a book.
  if (reader < s.minBookChars && m.epubImages <= 1)
    return {
      ok: false,
      reason: `${reader.toLocaleString('en-US')} characters and no pictures on its pages`,
      textShare: null,
      listedAs: 'too_little',
    };
  // Pictures packed in a rebuilt archive must still be on the EPUB's pages (mokuro's pages are
  // pictures that calibre's rebuild can drop from the markup).
  if (
    group === 'rebuilt' &&
    facts.sourceImages !== null &&
    facts.sourceImages >= 10 &&
    m.epubImages < facts.sourceImages * 0.9
  )
    return {
      ok: false,
      reason: `Pictures not on the pages: ${m.epubImages} shown, ${facts.sourceImages} in the archive`,
      textShare: null,
    };
  if (group === 'text') {
    const src = facts.sourceChars ?? 0;
    const out = facts.epubChars ?? 0;
    if (src >= s.pictureMaxChars) {
      const share = out / src;
      if (share < s.textKeptMin)
        return {
          ok: false,
          reason: `Text lost: ${out.toLocaleString('en-US')} of ${src.toLocaleString('en-US')} characters (${Math.round(share * 1000) / 10} %)`,
          textShare: share,
        };
      if (reader === 0)
        return { ok: false, reason: 'The reader counts no text in it', textShare: share };
      return { ok: true, reason: null, textShare: share };
    }
    // Hardly any text in the source (a Kindle comic): it must have pictures or text.
    if (m.epubImages === 0 && reader === 0)
      return { ok: false, reason: 'Nothing to read in it (no text, no pictures)', textShare: null };
    return { ok: true, reason: null, textShare: src > 0 ? out / src : null };
  }
  if (reader === 0 && m.epubImages === 0)
    return { ok: false, reason: 'Nothing to read in it (no text, no pictures)', textShare: null };
  return { ok: true, reason: null, textShare: null };
}

/** Checks one EPUB (read only). Never throws. */
export async function checkEpub(
  file: string,
  facts: JobFacts,
  reader: Stage3Reader,
  s: Pick<FormatSettings, 'textKeptMin' | 'pictureMaxChars' | 'minBookChars'>,
): Promise<CheckResult> {
  const t0 = Date.now();
  let epubImages = 0;
  try {
    epubImages = (await epubPictures(file)).shown;
  } catch (err) {
    return {
      ok: false,
      reason: `Not a readable EPUB: ${(err as Error).message.slice(0, 200)}`,
      readerChars: null,
      chapters: null,
      epubImages: null,
      textShare: null,
      group: groupOf(facts),
      ms: Date.now() - t0,
    };
  }
  const text = await reader.text(file);
  const opened = text.ok;
  const readerChars = text.ok ? text.data.characters : null;
  const verdict = judge(
    facts,
    { opened, openError: text.ok ? null : text.message, readerChars, epubImages },
    s,
  );
  return {
    ...verdict,
    readerChars,
    chapters: text.ok ? text.data.chapters.length : null,
    epubImages,
    group: groupOf(facts),
    ms: Date.now() - t0,
  };
}
