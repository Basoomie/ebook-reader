/**
 * Books without an EPUB: the server's check of each EPUB the sidecar made (decided at stop 1):
 *   - it opens with the reader's own import (stage 3's reader processes run the counter bundle,
 *     vendor/epub-count.cjs: the very code a device runs);
 *   - a text book keeps its text: calibre's text of the EPUB holds at least `textKeptMin` of
 *     calibre's text of the source, both counted by the reader's rule (the sidecar measured both);
 *   - a picture book keeps every page: the EPUB has at least as many pictures as the archive;
 *   - an extracted or rebuilt EPUB has something to read (text or pictures).
 */
import fs from 'fs/promises';
import type { Stage3Reader } from '../../counts/book-text-worker';
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
  ms: number;
}

const IMAGE = /\.(jpe?g|png|gif|webp|bmp|avif|jxl|tiff?|svg)$/i;

/** Pictures inside an EPUB (every image entry). */
export async function epubImageCount(file: string): Promise<number> {
  const zip = await ZipFile.open(file, (f) => fs.open(f, 'r'));
  try {
    return zip.entries.filter((e) => IMAGE.test(e.name)).length;
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
  s: Pick<FormatSettings, 'textKeptMin' | 'pictureMaxChars'>,
): Pick<CheckResult, 'ok' | 'reason' | 'textShare'> {
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
      return { ok: false, reason: 'The EPUB has no pictures', textShare: null };
    if (facts.sourceImages !== null && m.epubImages < facts.sourceImages)
      return {
        ok: false,
        reason: `Pages missing: ${m.epubImages} pictures in the EPUB, ${facts.sourceImages} in the archive`,
        textShare: null,
      };
    return { ok: true, reason: null, textShare: null };
  }
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
  s: Pick<FormatSettings, 'textKeptMin' | 'pictureMaxChars'>,
): Promise<CheckResult> {
  const t0 = Date.now();
  let epubImages = 0;
  try {
    epubImages = await epubImageCount(file);
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
