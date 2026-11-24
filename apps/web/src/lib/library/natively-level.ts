/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The Natively level on the book page (2026-11-24): which books have one to ask for (a direct
 * Natively link, as the Links section decides it), and a fresh answer laid over the book. Pure,
 * so it is tested on its own.
 */
import { bookLink, linkDef } from '$lib/book-links/links';
import type { NativelyLevelAnswer } from './api';
import type { CatalogBookDetail, NativelyLevel } from './types';

/** The book has a saved Natively id the links use (a direct link). */
export function hasDirectNatively(book: CatalogBookDetail): boolean {
  if (book.source === 'upload') return false;
  return bookLink(linkDef('natively'), book, false)?.kind === 'direct';
}

/** The level an answer gives (null: none to show). */
export function levelOf(answer: NativelyLevelAnswer): NativelyLevel | null {
  return answer.level === null ? null : { level: answer.level, temporary: answer.temporary };
}

/** "about 5 h 12 min left" for the first pass's bar. */
export function timeLeftText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `about ${h} h ${m} min left` : `about ${h} h left`;
}

/** The book with the answer's level; the same object when nothing changed. */
export function withNativelyLevel(
  book: CatalogBookDetail,
  answer: NativelyLevelAnswer
): CatalogBookDetail {
  const next = levelOf(answer);
  const now = book.nativelyLevel ?? null;
  if (next?.level === now?.level && next?.temporary === now?.temporary) return book;
  return { ...book, nativelyLevel: next };
}
