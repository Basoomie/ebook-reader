/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Whispersync "Match" on the book page (2026-11-21): the book page's Audiobook section matches
 * a book to its linked subtitles with whispersync's own matcher (`$lib/whispersync/lib/match.ts`,
 * moved out of the reader's Match.svelte unchanged) and saves, re-matches and resets through
 * the same steps as the reader:
 * - the lines: whispersync's saved subtitles, else the linked subtitle file (the reader's order;
 *   a file picked in the reader is used there only, so the book page leaves it to the reader);
 * - the text: this device's copy after the reader's opening sync (syncBook), matched from its
 *   original text (the backup when it is matched: "Match again" = the reader's Reset + Match,
 *   without resetting first; decided with the user);
 * - Save: onSaveMatch's row, then the upload (pushMatch); Reset: onResetBook's row, then the
 *   match removed on every device (resetMatch). No reload: the page only shows the new state.
 * Pure apart from the injected dependencies (tested in whispersync-book-match.test.ts).
 */
import type { Subtitle } from '$lib/whispersync/lib/general';
import {
  matchedRow,
  resetRow,
  type MatchInput,
  type MatchResult,
  type MatchSettings
} from '$lib/whispersync/lib/match';
import {
  ATTACHMENT_KIND,
  MATCH,
  attachmentId,
  isMatched,
  pushMatch,
  resetMatch,
  syncBook,
  type BookRef,
  type DataRow,
  type EngineLike,
  type SyncDeps
} from './whispersync-sync';

/** The saved match on the server (as this device last heard of it). */
export type MatchState = 'matched' | 'not-matched';

/** Whether the server has this book's match (a live `book-attachment` record). */
export async function hasLiveMatch(engine: EngineLike, bookId: string): Promise<boolean> {
  const rec = await engine.get(ATTACHMENT_KIND, attachmentId(bookId, MATCH));
  return !!rec && rec.deletedAt === null;
}

/** Saved subtitles as whispersync keeps them (`subtitle` row's subtitleData). */
interface SavedSubtitles {
  name: string;
  subtitles: Subtitle[];
}

export interface BookMatchDeps extends SyncDeps {
  /** A subtitle file picked in the reader that whispersync would load there instead. */
  hasPickedSubtitleFile(title: string): Promise<boolean>;
  /** The book's linked subtitle file (subtitleFileFor), or null. */
  linkedSubtitleFile(): Promise<File | null>;
  /** whispersync's updateSubtitles (the file's lines, as when dropped). */
  parseSubtitleFile(file: File): Promise<Map<string, Subtitle>>;
  /** whispersync's persistedSubtitles with the stored paddings. */
  savedLines(saved: Subtitle[]): Map<string, Subtitle>;
  settings: MatchSettings;
  matcher(input: MatchInput): Promise<MatchResult>;
  /** Resolves `promise`, or `fallback` after the library request time. */
  withinRequestTime<T>(promise: Promise<T>, fallback: T): Promise<T>;
  now(): number;
}

export type Lines =
  | { kind: 'lines'; subtitles: Subtitle[]; name: string }
  | { kind: 'picked-file' }
  | { kind: 'none' };

/**
 * The lines whispersync matches in the reader: a file picked there wins there (left to the
 * reader), then the saved subtitles with lines, then the linked subtitle file.
 */
export async function loadLines(deps: BookMatchDeps, book: BookRef): Promise<Lines> {
  if (await deps.hasPickedSubtitleFile(book.title)) return { kind: 'picked-file' };
  const saved = (await deps.local.getSubtitle(book.title))?.subtitleData as
    | SavedSubtitles
    | undefined;
  if (saved && Array.isArray(saved.subtitles) && saved.subtitles.length) {
    return {
      kind: 'lines',
      subtitles: [...deps.savedLines(saved.subtitles).values()],
      name: saved.name
    };
  }
  const file = await deps.linkedSubtitleFile();
  if (!file) return { kind: 'none' };
  const lines = await deps.parseSubtitleFile(file);
  return { kind: 'lines', subtitles: [...lines.values()], name: file.name };
}

/** The reader's opening sync of this copy (newer data from other devices comes in first). */
export async function levelCopy(deps: BookMatchDeps, book: BookRef): Promise<string[]> {
  return (await syncBook(deps, book)).problems;
}

/**
 * The row the matcher starts from: this copy as the reader would match it. A matched copy
 * starts from its original text, as after the reader's Reset match (onResetBook's row).
 */
export function sourceRow(row: DataRow, now: number): DataRow {
  return isMatched(row.elementHtml) && typeof row.htmlBackup === 'string'
    ? resetRow(row, now)
    : row;
}

export interface BookMatch {
  result: MatchResult;
  /** The row matched (what Save stores the matched text over). */
  source: DataRow;
  subtitleName: string;
  /** The lines matched against (whispersync's "Lines to match"). */
  lineCount: number;
}

/** Runs whispersync's matcher on this copy (no start point: that is reader-only). */
export async function runMatch(
  deps: BookMatchDeps,
  localId: number,
  lines: Extract<Lines, { kind: 'lines' }>,
  signal: AbortSignal,
  onProgress: (progress: number) => void
): Promise<BookMatch> {
  const row = await deps.local.getData(localId);
  if (!row) throw new Error('This book is no longer on this device.');
  const source = sourceRow(row, deps.now());
  const result = await deps.matcher({
    elementHtml: source.elementHtml,
    subtitles: lines.subtitles,
    subtitleFileName: () => lines.name,
    settings: deps.settings,
    signal,
    onProgress
  });
  return { result, source, subtitleName: lines.name, lineCount: lines.subtitles.length };
}

/**
 * Save: onSaveMatch's row, then the upload (as the reader's syncAndReload does, waiting at
 * most the library request time). 'pending' = saved here, the upload didn't get through (the
 * reader's next opening sync sends it).
 */
export async function saveMatch(
  deps: BookMatchDeps,
  book: BookRef,
  match: BookMatch
): Promise<'uploaded' | 'pending'> {
  const current = await deps.local.getData(book.localId);
  const row = matchedRow(current, match.source, match.result.bookHTML.innerHTML, deps.now());
  await deps.local.putData(row as DataRow);
  const sent = await deps.withinRequestTime(
    pushMatch(deps, book).catch(() => 'failed' as const),
    'timeout' as const
  );
  return sent === 'ok' ? 'uploaded' : 'pending';
}

/**
 * Reset match: onResetBook's row when this copy is matched, then the match removed on every
 * device. Without a matched copy here only the shared match goes (the other devices restore
 * their own backups, as after a reset anywhere else).
 */
export async function resetBookMatch(
  deps: BookMatchDeps,
  book: { bookId: string; localId: number | null; title: string }
): Promise<void> {
  if (book.localId !== null) {
    const row = await deps.local.getData(book.localId);
    if (row && isMatched(row.elementHtml) && typeof row.htmlBackup === 'string') {
      await deps.local.putData(resetRow(row, deps.now()));
    }
  }
  await resetMatch(deps, {
    bookId: book.bookId,
    localId: book.localId ?? 0,
    title: book.title
  });
}

// ---- words on the page ---------------------------------------------------------------------

/** "12,418 / 12,552 (98.93%)" from whispersync's "12418 / 12552 (98.93%)". */
export function figureText(rate: string): string {
  return rate.replace(/\d{4,}/g, (n) => Number(n).toLocaleString('en-US'));
}

/** "about 3 min left" from the time so far and the progress (0-100); '' until it can tell. */
export function timeLeftText(elapsedMs: number, progress: number): string {
  if (progress <= 0 || progress >= 100 || elapsedMs < 1500) return '';
  const left = (elapsedMs * (100 - progress)) / progress / 1000;
  if (left < 10) return 'a few seconds left';
  if (left < 60) return `about ${Math.round(left / 5) * 5} s left`;
  return `about ${Math.round(left / 60)} min left`;
}

export const START_POINT_NOTE =
  'To match from a specific starting point, open the book and use Match in the reader.';
export const OFFLINE_NOTE =
  "This book isn't on this device, and the library server can't be reached to download it.";
export const PICKED_FILE_NOTE =
  'This book uses a subtitle file picked in the reader on this device. Match it in the reader.';
export const NO_LINES_NOTE =
  "The linked subtitle file couldn't be read, so there is nothing to match.";
export const PENDING_NOTE =
  'Matched on this device. It reaches your other devices when the library server can be reached.';
