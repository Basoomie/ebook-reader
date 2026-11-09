/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { Candidate, FolderDetails, LegacyBookView, LinkMethod, NeedsReason } from './api';

/** Plain-language texts for the migration pages (WP5). */

export function reasonText(book: Pick<LegacyBookView, 'reason' | 'candidates'>): string {
  const n = book.candidates.length;
  const first = book.candidates[0];
  switch (book.reason as NeedsReason | null) {
    case 'several':
      return `${n} identical copies in Calibre (same file). Pick the one to use.`;
    case 'unverified':
      return first?.fingerprinted && first.imagesTotal !== undefined
        ? `${first.titleMatches ? 'Title matches' : 'Similar title'} but the file differs ` +
            `(${first.imagesMatched ?? 0} of ${first.imagesTotal} pictures match).`
        : 'A similar title is in Calibre, but the file differs.';
    case 'no_candidate':
      return 'No book with this title in Calibre.';
    case 'no_book_file':
      return 'The old sync has no book file for this title (only position or statistics), so it can’t be compared.';
    case 'damaged':
      return 'The stored data can’t be read.';
    case 'conflict':
      return 'Your devices opened different Calibre books under this title.';
    case 'unlinked':
      return 'You removed the automatic link.';
    default:
      return '';
  }
}

export function methodText(method: LinkMethod | null): string {
  switch (method) {
    case 'calibre-link':
      return 'opened from the library (exact)';
    case 'fingerprint':
      return 'same file (fingerprint)';
    case 'user':
      return 'linked by you';
    default:
      return '';
  }
}

export function fingerprintText(c: Candidate): string {
  if (!c.fingerprinted) return 'not compared';
  if (c.error) return 'could not be read';
  const tick = (ok: boolean | undefined) => (ok ? '✓' : '✗');
  return [
    `title ${tick(c.titleMatches)}`,
    `pictures ${c.imagesMatched ?? 0}/${c.imagesTotal ?? 0}`,
    `chapters ${tick(c.missingSpineIds === 0)}`
  ].join(' · ');
}

export function formatWhen(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
  const date = new Date(ms);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `today ${time}` : `${date.toLocaleDateString()} ${time}`;
}

export function percent(progress: number | null | undefined): string {
  return progress === null || progress === undefined ? '' : `${Math.round(progress * 100)}%`;
}

/** "place 63% · 14 reading days · last read 3 Nov" */
export function dataText(d: FolderDetails): string {
  const parts: string[] = [];
  if (d.progress) parts.push(`place ${percent(d.progress.progress) || d.progress.charPos}`);
  if (d.stats) parts.push(`${d.stats.days} reading day${d.stats.days === 1 ? '' : 's'}`);
  const last = d.stats?.lastDay ?? null;
  if (last) parts.push(`last read ${last}`);
  if (d.audioBook || d.subtitles) parts.push('audiobook (stays on the old sync)');
  return parts.length ? parts.join(' · ') : 'no position or statistics';
}

export function duration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min ${s % 60} s`;
}
