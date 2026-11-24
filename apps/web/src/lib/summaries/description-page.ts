/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { DescriptionView } from './summary-api';
import type { CachedDescription } from './summary-cache';

/**
 * Book descriptions translated like summaries (session 4b): the pure part of the Description
 * section's language buttons. The buttons are the summaries' (`languageChoices`: the book's
 * language and the Summary languages setting); this file decides the book's language before
 * the server says it, and what the section shows for the language chosen.
 */

const ISO_LANG: Record<string, string> = { jpn: 'ja', eng: 'en', ja: 'ja', en: 'en' };

/**
 * The description's own language as the server works it out (summaries/service.ts bookLang):
 * the library's language, else Calibre's first language, else Japanese.
 */
export function descriptionBookLang(
  libraryLanguage: string | null | undefined,
  languages: string[] | undefined
): string {
  if (libraryLanguage) return libraryLanguage;
  const first = languages?.[0];
  return (first && ISO_LANG[first]) || 'ja';
}

export type DescriptionNote = 'translating' | 'offline' | 'failed' | null;

export interface DescriptionShown {
  /** The paragraphs to show: the translation's, or the original's. */
  paragraphs: string[];
  translated: boolean;
  /** Why the original is shown for a translation that was chosen. */
  note: DescriptionNote;
  error: string | null;
}

/**
 * What the section shows. A translation is shown only when it was made from the description
 * the page shows (`description`, the catalog's text): the server's answer says so by its
 * `source`, a device copy by its own. So a description the cleanup changed shows the original
 * until it is translated again, never the old translation.
 */
export function shownDescription(o: {
  original: string[];
  description: string | null | undefined;
  lang: string;
  bookLang: string;
  server: DescriptionView | null;
  cached: CachedDescription | null;
  /** The server can't be reached (or didn't answer). */
  offline: boolean;
}): DescriptionShown {
  const original: DescriptionShown = {
    paragraphs: o.original,
    translated: false,
    note: null,
    error: null
  };
  if (!o.description || o.lang === o.bookLang) return original;
  const s = o.server;
  if (s && s.lang === o.lang && s.source === o.description && !o.offline) {
    if (s.state === 'done' && s.translation)
      return { paragraphs: s.translation.paragraphs, translated: true, note: null, error: null };
    if (s.state === 'failed') return { ...original, note: 'failed', error: s.error };
    if (s.state === 'queued') return { ...original, note: 'translating' };
  }
  if (o.cached && o.cached.lang === o.lang && o.cached.source === o.description)
    return { paragraphs: o.cached.paragraphs, translated: true, note: null, error: null };
  return { ...original, note: o.offline ? 'offline' : 'translating' };
}
