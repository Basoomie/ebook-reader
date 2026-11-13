/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP15c: whispersync's data on the library server instead of the old file sync. Only
 * the transport changes; whispersync still keeps its own rows in the books database
 * (audioBook and subtitle by title, the matched book in `data`) and matches, re-matches
 * and resets exactly as before.
 *
 * - Playback position: record "audiobook-position" (<bookId>) { position, modifiedAt }.
 * - Saved subtitles and saved match: files on the server (book attachments), announced
 *   by "book-attachment" records (<bookId>:<name>) { size, sha256, modifiedAt }.
 *
 * Newest wins by the device's own save time (`modifiedAt` = whispersync's
 * lastAudioBookModified / lastSubtitleDataModified / lastBookModified), as with the old
 * sync. A device never uploads a copy older than the server's. Reset match removes the
 * saved match on every device: another device that finds a deletion newer than its own
 * matched copy restores its backup, the same step whispersync's own reset takes.
 *
 * Pure apart from the injected stores; never throws (problems are returned).
 */
import type { LocalRecord } from '$lib/sync/sync-db';

export const POSITION_KIND = 'audiobook-position';
export const ATTACHMENT_KIND = 'book-attachment';
export const SUBTITLES = 'whispersync-subtitles';
export const MATCH = 'whispersync-match';
export type AttachmentName = typeof SUBTITLES | typeof MATCH;

export function attachmentId(bookId: string, name: AttachmentName): string {
  return `${bookId}:${name}`;
}

export interface EngineLike {
  get(kind: string, id: string): Promise<LocalRecord | undefined>;
  put(
    kind: string,
    id: string,
    data: Record<string, unknown>,
    options?: { bookId?: string | null }
  ): Promise<boolean>;
  remove(kind: string, id: string): Promise<boolean>;
}

export interface AttachmentApi {
  /** 'stale' when the server already has newer data. */
  upload(
    bookId: string,
    name: AttachmentName,
    body: string,
    modifiedAt: number
  ): Promise<'ok' | 'stale'>;
  /** null when the server has none. `sha256` from the response's ETag. */
  download(
    bookId: string,
    name: AttachmentName
  ): Promise<{ text: string; sha256: string | null } | null>;
}

export interface AudioBookRow {
  title: string;
  playbackPosition: number;
  lastAudioBookModified: number;
}

export interface SubtitleRow {
  title: string;
  subtitleData: unknown;
  lastSubtitleDataModified: number;
}

export interface DataRow {
  id: number;
  title: string;
  elementHtml: string;
  htmlBackup?: string;
  lastBookModified: number;
  [key: string]: unknown;
}

/** whispersync's own rows (the reader's books database). */
export interface LocalStores {
  getAudioBook(title: string): Promise<AudioBookRow | undefined>;
  putAudioBook(row: AudioBookRow): Promise<void>;
  getSubtitle(title: string): Promise<SubtitleRow | undefined>;
  putSubtitle(row: SubtitleRow): Promise<void>;
  getData(localId: number): Promise<DataRow | undefined>;
  putData(row: DataRow): Promise<void>;
}

export interface SyncDeps {
  engine: EngineLike;
  api: AttachmentApi;
  local: LocalStores;
}

/** A book open in the reader: its library id, local id and title (whispersync's key). */
export interface BookRef {
  bookId: string;
  localId: number;
  title: string;
}

export interface SyncResult {
  /** Something from another device was written into this device's rows. */
  changed: { position: boolean; subtitles: boolean; match: boolean };
  problems: string[];
}

/** Whether a book's text carries whispersync's match stamp (Match.svelte). */
export function isMatched(elementHtml: string | undefined): boolean {
  return !!elementHtml && /data-ttu-whispersync-matched-by=/.test(elementHtml.slice(0, 4000));
}

/** Whether whispersync's saved subtitleData ({ name, subtitles }) holds any lines. */
function hasSubtitles(subtitleData: unknown): boolean {
  const lines = (subtitleData as { subtitles?: unknown } | null)?.subtitles;
  return Array.isArray(lines) && lines.length > 0;
}

function live(rec: LocalRecord | undefined): rec is LocalRecord {
  return !!rec && rec.deletedAt === null;
}

function modifiedAtOf(rec: LocalRecord | undefined): number {
  const value = rec?.data?.modifiedAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * What a record says compared with a local save time:
 * - 'remote': the server has something newer (live) to apply here;
 * - 'removed': the server removed it after the local save (a reset elsewhere);
 * - 'local': this device's copy is newer (or the server has none) and should go up;
 * - 'same': nothing to do.
 */
export function compare(
  rec: LocalRecord | undefined,
  localModified: number | undefined
): 'remote' | 'removed' | 'local' | 'same' {
  const local = localModified ?? 0;
  if (!rec) return local > 0 ? 'local' : 'same';
  if (rec.deletedAt !== null) {
    if (local > rec.deletedAt) return 'local';
    return local > 0 ? 'removed' : 'same';
  }
  const remote = modifiedAtOf(rec);
  if (remote > local) return 'remote';
  if (local > remote) return 'local';
  return 'same';
}

function message(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

// ---- this device → server ---------------------------------------------------------

/** After whispersync saved the playback position. */
export async function pushPosition(deps: SyncDeps, book: BookRef): Promise<void> {
  const row = await deps.local.getAudioBook(book.title);
  if (!row) return;
  const rec = await deps.engine.get(POSITION_KIND, book.bookId);
  if (compare(rec, row.lastAudioBookModified) !== 'local') return;
  await deps.engine.put(
    POSITION_KIND,
    book.bookId,
    { position: Math.max(0, row.playbackPosition || 0), modifiedAt: row.lastAudioBookModified },
    { bookId: book.bookId }
  );
}

/** After whispersync saved subtitles. Uploads when this device's copy is the newest. */
export async function pushSubtitles(
  deps: SyncDeps,
  book: BookRef
): Promise<'ok' | 'stale' | 'skipped'> {
  const row = await deps.local.getSubtitle(book.title);
  if (!row) return 'skipped';
  const rec = await deps.engine.get(ATTACHMENT_KIND, attachmentId(book.bookId, SUBTITLES));
  if (compare(rec, row.lastSubtitleDataModified) !== 'local') return 'skipped';
  const body = JSON.stringify({
    subtitleData: row.subtitleData,
    lastSubtitleDataModified: row.lastSubtitleDataModified
  });
  return deps.api.upload(book.bookId, SUBTITLES, body, row.lastSubtitleDataModified);
}

/** After whispersync saved a match (before it reloads). */
export async function pushMatch(
  deps: SyncDeps,
  book: BookRef
): Promise<'ok' | 'stale' | 'skipped'> {
  const row = await deps.local.getData(book.localId);
  if (!row || !isMatched(row.elementHtml)) return 'skipped';
  const rec = await deps.engine.get(ATTACHMENT_KIND, attachmentId(book.bookId, MATCH));
  if (compare(rec, row.lastBookModified) !== 'local') return 'skipped';
  const body = JSON.stringify({
    elementHtml: row.elementHtml,
    htmlBackup: row.htmlBackup ?? null,
    lastBookModified: row.lastBookModified
  });
  return deps.api.upload(book.bookId, MATCH, body, row.lastBookModified);
}

/** Reset match (whispersync's own reset ran): removed on every device. */
export async function resetMatch(deps: SyncDeps, book: BookRef): Promise<void> {
  await deps.engine.remove(ATTACHMENT_KIND, attachmentId(book.bookId, MATCH));
}

/** Reset all: the match, the subtitles and the position, on every device. */
export async function resetAll(deps: SyncDeps, book: BookRef): Promise<void> {
  await deps.engine.remove(ATTACHMENT_KIND, attachmentId(book.bookId, MATCH));
  await deps.engine.remove(ATTACHMENT_KIND, attachmentId(book.bookId, SUBTITLES));
  await deps.engine.remove(POSITION_KIND, book.bookId);
}

// ---- server → this device -----------------------------------------------------------

async function fetchChecked(
  deps: SyncDeps,
  book: BookRef,
  name: AttachmentName,
  rec: LocalRecord
): Promise<Record<string, unknown> | null> {
  const file = await deps.api.download(book.bookId, name);
  if (!file) return null;
  // Replaced on the server since the record came: wait for the next record.
  const expected = rec.data.sha256;
  if (file.sha256 && typeof expected === 'string' && file.sha256 !== expected) return null;
  const parsed = JSON.parse(file.text) as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
}

/**
 * Brings this device and the server level for one book, both ways: newer data from
 * another device is written into whispersync's rows (as its own save would), this
 * device's newer data goes up. Called when the book opens and when a sync brings a
 * record of the open book. Never throws.
 */
export async function syncBook(deps: SyncDeps, book: BookRef): Promise<SyncResult> {
  const result: SyncResult = {
    changed: { position: false, subtitles: false, match: false },
    problems: []
  };

  // Playback position.
  try {
    const row = await deps.local.getAudioBook(book.title);
    const rec = await deps.engine.get(POSITION_KIND, book.bookId);
    const state = compare(rec, row?.lastAudioBookModified);
    if (state === 'remote' && live(rec)) {
      const position = Number(rec.data.position);
      await deps.local.putAudioBook({
        title: book.title,
        playbackPosition: Number.isFinite(position) && position >= 0 ? position : 0,
        lastAudioBookModified: modifiedAtOf(rec)
      });
      result.changed.position = true;
    } else if (state === 'local') {
      await pushPosition(deps, book);
    }
  } catch (error) {
    result.problems.push(`position: ${message(error)}`);
  }

  // Saved subtitles.
  try {
    const row = await deps.local.getSubtitle(book.title);
    const rec = await deps.engine.get(ATTACHMENT_KIND, attachmentId(book.bookId, SUBTITLES));
    const state = compare(rec, row?.lastSubtitleDataModified);
    if (state === 'remote' && live(rec)) {
      const payload = await fetchChecked(deps, book, SUBTITLES, rec);
      if (payload && payload.subtitleData) {
        await deps.local.putSubtitle({
          title: book.title,
          subtitleData: payload.subtitleData,
          lastSubtitleDataModified: modifiedAtOf(rec)
        });
        result.changed.subtitles = true;
      }
    } else if (state === 'removed' && rec && row && hasSubtitles(row.subtitleData)) {
      // Removed on another device (Reset all) or by the server (the book's audiobook or
      // subtitle link changed): the same step as whispersync's onResetAll, so the linked
      // subtitle file loads next time.
      await deps.local.putSubtitle({
        title: book.title,
        subtitleData: { ...(row.subtitleData as Record<string, unknown>), subtitles: [] },
        lastSubtitleDataModified: rec.deletedAt!
      });
      result.changed.subtitles = true;
    } else if (state === 'local') {
      await pushSubtitles(deps, book);
    }
  } catch (error) {
    result.problems.push(`subtitles: ${message(error)}`);
  }

  // Saved match.
  try {
    const row = await deps.local.getData(book.localId);
    if (row) {
      const rec = await deps.engine.get(ATTACHMENT_KIND, attachmentId(book.bookId, MATCH));
      const state = compare(rec, row.lastBookModified);
      if (state === 'remote' && live(rec)) {
        const payload = await fetchChecked(deps, book, MATCH, rec);
        if (payload && typeof payload.elementHtml === 'string') {
          const next: DataRow = {
            ...row,
            elementHtml: payload.elementHtml,
            lastBookModified: modifiedAtOf(rec)
          };
          if (typeof payload.htmlBackup === 'string') next.htmlBackup = payload.htmlBackup;
          await deps.local.putData(next);
          result.changed.match = true;
        }
      } else if (
        state === 'removed' &&
        rec &&
        isMatched(row.elementHtml) &&
        typeof row.htmlBackup === 'string'
      ) {
        // Reset match on another device: the same step as whispersync's onResetBook.
        const next: DataRow = {
          ...row,
          elementHtml: row.htmlBackup,
          lastBookModified: rec.deletedAt!
        };
        delete next.htmlBackup;
        await deps.local.putData(next);
        result.changed.match = true;
      } else if (state === 'local' && isMatched(row.elementHtml)) {
        await pushMatch(deps, book);
      }
    }
  } catch (error) {
    result.problems.push(`match: ${message(error)}`);
  }

  return result;
}

/** Whether pulled records concern this book's whispersync data. */
export function concernsBook(records: LocalRecord[], bookId: string): boolean {
  return records.some(
    (r) =>
      (r.kind === POSITION_KIND && r.id === bookId) ||
      (r.kind === ATTACHMENT_KIND && r.bookId === bookId)
  );
}
