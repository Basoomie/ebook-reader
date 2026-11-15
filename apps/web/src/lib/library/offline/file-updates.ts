/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { LoadData } from '$lib/functions/file-loaders/types';
import { LibraryApiError, type LibraryApi } from '$lib/library/api';
import type { CalibreLink } from '$lib/library/library-db';

/**
 * Season 2 "Cached book whose Calibre file changed" (decided: the device fetches the new
 * file automatically; detected by the server's file hash; the stored EPUB title is kept;
 * the saved place is found again by its text; a whispersync match is tied to its file).
 *
 * For each library book this device imported from a library file (not a copy it already had,
 * `how: 'matched'`; not uploads, which never change):
 * - the server's hash equals the link's: nothing to do;
 * - no hash on the link yet (stored before this update): an unchanged ETag means the file
 *   is the downloaded one, so its hash is adopted; otherwise the file is checked like a
 *   changed one;
 * - a different hash: the file is downloaded and imported with this device's settings and
 *   its text compared with the stored text (a matched copy's text from before the match):
 *   - the same text: only the link is updated (the copy and its match stay);
 *   - different text: the copy is replaced in place (replaceBookContent): same record, title
 *     and saved place found again by its text. A live whispersync match that names no file
 *     (saved before Season 2) is reset first, so it can't be pulled over the new text;
 *   - a matched copy without a hash on its link whose text differs: left as it is (its
 *     backup may come from another device's import settings), the current hash adopted.
 * Books open in the reader are skipped until the next check. Nothing is ever deleted; a
 * failure leaves the copy and the link as they were.
 */

export interface StoredRow {
  title: string;
  elementHtml: string;
  htmlBackup?: string;
}

export interface FileUpdateDeps {
  api: Pick<LibraryApi, 'fileHashes' | 'downloadFile'>;
  /** Library links whose local copy exists on this device. */
  links(): Promise<CalibreLink[]>;
  putLink(link: CalibreLink): Promise<void>;
  getRow(localId: number): Promise<StoredRow | undefined>;
  /** The saved place (bookmark) of a local book, if any. */
  getPlace(localId: number): Promise<number | null>;
  /** The existing EPUB loader with this device's import settings. */
  loadEpub(file: File): Promise<LoadData>;
  /** The saved place in the new text (place-remap.ts). */
  remapPlace(oldHtml: string, newHtml: string, position: number): number;
  replace(
    localId: number,
    content: LoadData,
    place: { exploredCharCount: number; progress: number } | null
  ): Promise<boolean>;
  isMatched(html: string): boolean;
  /** The live whispersync match of a book and the file it names; null: none. */
  liveMatchFile(link: CalibreLink): Promise<{ file: string | null } | null>;
  resetMatch(link: CalibreLink): Promise<void>;
  isOpenInReader(localId: number): boolean;
  warn(message: string): void;
}

export interface FileUpdateResult {
  checked: number;
  adopted: number;
  sameText: number;
  replaced: number;
  skipped: number;
  /** Stopped early: the server could not be reached. */
  stopped: boolean;
}

const HASH_CHUNK = 50;

function unreachable(error: unknown): boolean {
  return (
    error instanceof LibraryApiError &&
    (error.kind === 'unreachable' || error.kind === 'timeout' || error.kind === 'aborted')
  );
}

/** The links whose copy the check keeps up to date. */
export function updatableLinks(links: readonly CalibreLink[]): CalibreLink[] {
  return links.filter((l) => l.how === 'imported' && l.sourceKind !== 'upload');
}

export async function updateChangedFiles(
  deps: FileUpdateDeps,
  signal: AbortSignal = new AbortController().signal
): Promise<FileUpdateResult> {
  const result: FileUpdateResult = {
    checked: 0,
    adopted: 0,
    sameText: 0,
    replaced: 0,
    skipped: 0,
    stopped: false
  };
  const links = updatableLinks(await deps.links());
  for (let i = 0; i < links.length; i += HASH_CHUNK) {
    const chunk = links.slice(i, i + HASH_CHUNK);
    let answers: Map<string, { sha256: string | null; etag: string | null }>;
    try {
      const { books } = await deps.api.fileHashes(
        chunk.map((l) => l.bookId),
        { signal }
      );
      answers = new Map(books.map((b) => [b.id, b]));
    } catch (error) {
      if (!unreachable(error)) deps.warn(`file check failed: ${(error as Error).message}`);
      result.stopped = true;
      return result;
    }
    for (const link of chunk) {
      result.checked += 1;
      const now = answers.get(link.bookId);
      if (!now?.sha256) continue;
      if (link.fileSha256 === now.sha256) continue;
      if (!link.fileSha256 && link.fileEtag && link.fileEtag === now.etag) {
        await deps.putLink({ ...link, fileSha256: now.sha256 });
        result.adopted += 1;
        continue;
      }
      try {
        const outcome = await updateOne(deps, link, now.sha256, signal);
        result[outcome] += 1;
      } catch (error) {
        if (unreachable(error)) {
          result.stopped = true;
          return result;
        }
        deps.warn(`"${link.calibreTitle}": not updated: ${(error as Error).message}`);
        result.skipped += 1;
      }
    }
  }
  return result;
}

async function updateOne(
  deps: FileUpdateDeps,
  link: CalibreLink,
  sha256: string,
  signal: AbortSignal
): Promise<'adopted' | 'sameText' | 'replaced' | 'skipped'> {
  if (deps.isOpenInReader(link.localId)) return 'skipped';
  const row = await deps.getRow(link.localId);
  if (!row || !row.elementHtml) return 'skipped';
  const { blob, etag } = await deps.api.downloadFile(link.bookId, signal);
  const content = await deps.loadEpub(
    new File([blob], 'book.epub', { type: 'application/epub+zip' })
  );
  const matched = deps.isMatched(row.elementHtml);
  const storedText = matched ? row.htmlBackup : row.elementHtml;
  if (storedText === content.elementHtml) {
    await deps.putLink({ ...link, fileSha256: sha256, fileEtag: etag ?? link.fileEtag });
    return 'sameText';
  }
  if (matched && !link.fileSha256) {
    // Can't tell a changed file from another device's import settings: keep the copy.
    deps.warn(`"${link.calibreTitle}": a matched copy whose file can't be compared; kept`);
    await deps.putLink({ ...link, fileSha256: sha256, fileEtag: etag ?? link.fileEtag });
    return 'adopted';
  }
  // The reader may have opened it while the file was being fetched.
  if (deps.isOpenInReader(link.localId)) return 'skipped';
  const match = await deps.liveMatchFile(link);
  if (match && match.file === null) await deps.resetMatch(link);
  const position = await deps.getPlace(link.localId);
  const place =
    position === null
      ? null
      : (() => {
          const moved = deps.remapPlace(row.elementHtml, content.elementHtml, position);
          return {
            exploredCharCount: moved,
            progress: content.characters > 0 ? Math.min(1, moved / content.characters) : 0
          };
        })();
  if (!(await deps.replace(link.localId, content, place))) return 'skipped';
  await deps.putLink({
    ...link,
    characters: content.characters,
    fileEtag: etag ?? link.fileEtag,
    fileSha256: sha256
  });
  return 'replaced';
}
