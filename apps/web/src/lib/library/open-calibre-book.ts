/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { LoadData } from '$lib/functions/file-loaders/types';
import { LibraryApiError, type LibraryApi } from '$lib/library/api';
import {
  decideAfterLoad,
  decideBeforeDownload,
  type LocalBookInfo
} from '$lib/library/decide-open';
import type { CalibreLink, LibraryStore } from '$lib/library/library-db';
import type { CatalogBook } from '$lib/library/types';

/**
 * Opens a Calibre book (WP6, interim option): download the EPUB, run it
 * through the existing import pipeline and keep it like a manual import.
 * Reading data keeps using today's title-based sync. The link to the catalog
 * entry is stored in the separate library database for the later migration.
 */

export interface ExistingBookQuestion {
  title: string;
  localCharacters: number;
  calibreCharacters: number;
}

export interface OpenDeps {
  api: Pick<LibraryApi, 'book' | 'downloadFile'>;
  store: Pick<LibraryStore, 'getLink' | 'getLinksForLocalId' | 'putLink' | 'deleteLink'>;
  getLocalBook(id: number): Promise<LocalBookInfo | undefined>;
  getLocalBookByTitle(title: string): Promise<LocalBookInfo | undefined>;
  /** The existing EPUB loader (load-epub.ts) with this device's import settings. */
  loadEpub(file: File): Promise<LoadData>;
  /** Saves a new book exactly like a manual import; returns its local id. */
  saveNewBook(content: LoadData, signal: AbortSignal): Promise<number>;
  /** Calibre's own library UUID for a server library id. */
  calibreLibraryUuid(libraryId: string): Promise<string | null>;
  /** Asked when a book with the same title but a different character count exists. */
  confirmExisting(question: ExistingBookQuestion): Promise<boolean>;
  /** WP7b: the book the migration linked a local title to (null = none). */
  migratedBookId?(title: string): Promise<string | null>;
  /** WP7b: fills a migrated placeholder with the library copy; returns its local id. */
  fillPlaceholder?(content: LoadData, signal: AbortSignal): Promise<number>;
  /** WP7b: asked before filling a migrated placeholder whose character count differs. */
  confirmPlaceholder?(question: ExistingBookQuestion): Promise<boolean>;
  now?: () => number;
}

export type OpenStage =
  | { stage: 'download'; loaded: number; total: number | null }
  | { stage: 'prepare' }
  | { stage: 'save' };

export type OpenOutcome =
  | { status: 'opened'; localId: number; how: 'cached' | 'imported' | 'matched' }
  | { status: 'cancelled' }
  /** Nothing was changed; `message` tells the user why. */
  | { status: 'refused'; message: string };

function fileNameFor(title: string): string {
  // Only the fallback title when the EPUB has none; keep it a plain name.
  return `${title.replace(/[\\/:*?"<>|]/g, '_') || 'book'}.epub`;
}

/** The book to open; with its authors (when the caller has them) the link keeps them current. */
export type OpenTarget = Pick<CatalogBook, 'id' | 'title'> & {
  authors?: readonly { name: string }[];
};

const authorNames = (authors: readonly { name: string }[] | undefined) =>
  authors?.map((a) => a.name).filter(Boolean);

export async function openCalibreBook(
  book: OpenTarget,
  deps: OpenDeps,
  signal: AbortSignal,
  onStage: (stage: OpenStage) => void = () => {}
): Promise<OpenOutcome> {
  const now = deps.now ?? Date.now;
  try {
    // 1. Already on this device?
    const link = await deps.store.getLink(book.id);
    const linkedBook = link ? await deps.getLocalBook(link.localId) : undefined;
    const before = decideBeforeDownload(link, linkedBook);
    if (before.kind === 'open') {
      // WP19d: keep the remembered authors current (never in the way of opening).
      const names = authorNames(book.authors);
      if (link && names && JSON.stringify(names) !== JSON.stringify(link.authors ?? null)) {
        await deps.store.putLink({ ...link, authors: names }).catch(() => {});
      }
      return { status: 'opened', localId: before.localId, how: 'cached' };
    }
    if (before.staleLink) await deps.store.deleteLink(book.id);

    // 2. Download and run the import pipeline.
    const detail = await deps.api.book(book.id, { signal });
    // A Calibre file, or (WP7b) an uploaded one; a book has one source.
    const source = detail.sources.find(
      (s) => (s.kind === 'calibre' && s.calibreUuid) || s.kind === 'upload'
    );
    if (!source) {
      return { status: 'refused', message: 'This book has no file to open.' };
    }
    onStage({ stage: 'download', loaded: 0, total: source.fileSize });
    const { blob, etag } = await deps.api.downloadFile(book.id, signal, (loaded, total) =>
      onStage({ stage: 'download', loaded, total })
    );
    onStage({ stage: 'prepare' });
    const file = new File([blob], fileNameFor(detail.title), { type: 'application/epub+zip' });
    const content = await deps.loadEpub(file);
    if (signal.aborted) return { status: 'cancelled' };

    // 3. Decide against what is already stored under that title.
    const existing = await deps.getLocalBookByTitle(content.title);
    const existingLinks = existing ? await deps.store.getLinksForLocalId(existing.id) : [];
    const migrated =
      existing?.isPlaceholder && deps.migratedBookId
        ? await deps.migratedBookId(content.title)
        : null;
    const after = decideAfterLoad(book.id, content, existing, existingLinks, migrated);

    let localId: number;
    let how: CalibreLink['how'];
    let characters = content.characters;
    switch (after.kind) {
      case 'save-new':
        onStage({ stage: 'save' });
        localId = await deps.saveNewBook(content, signal);
        how = 'imported';
        break;
      case 'link-existing':
        localId = after.localId;
        how = 'matched';
        break;
      case 'ask-existing': {
        const ok = await deps.confirmExisting({
          title: content.title,
          localCharacters: after.localCharacters,
          calibreCharacters: after.calibreCharacters
        });
        if (!ok) return { status: 'cancelled' };
        localId = after.localId;
        how = 'matched';
        characters = after.localCharacters;
        break;
      }
      case 'ask-placeholder':
      case 'fill-placeholder': {
        if (after.kind === 'ask-placeholder') {
          const ok = await deps.confirmPlaceholder?.({
            title: content.title,
            localCharacters: after.localCharacters,
            calibreCharacters: after.calibreCharacters
          });
          if (!ok) return { status: 'cancelled' };
        }
        if (!deps.fillPlaceholder) {
          return { status: 'refused', message: "This book can't be opened here." };
        }
        onStage({ stage: 'save' });
        localId = await deps.fillPlaceholder(content, signal);
        how = 'imported';
        break;
      }
      case 'placeholder':
        return {
          status: 'refused',
          message:
            `"${content.title}" is on this device only as a copy kept in the old sync` +
            (after.storageSource ? ` ("${after.storageSource}")` : '') +
            ", and the migration didn't link it to this library book, so it isn't replaced. " +
            'Open it from Settings > Data > Old sync manager.'
        };
      case 'title-taken':
        return {
          status: 'refused',
          message:
            `Another Calibre book ("${after.otherCalibreTitle}") is already on this device with ` +
            `the same EPUB title "${content.title}". Books are stored by title until the sync ` +
            'update, so both cannot be kept. Nothing was changed.'
        };
    }

    // 4. Remember the link for the migration.
    await deps.store.putLink({
      bookId: book.id,
      libraryId: detail.libraryId,
      calibreLibraryUuid: await deps.calibreLibraryUuid(detail.libraryId),
      calibreUuid: source.kind === 'calibre' ? source.calibreUuid : null,
      calibreId: source.calibreId,
      sourceKind: source.kind,
      localId,
      title: content.title,
      calibreTitle: detail.title,
      characters,
      fileEtag: etag,
      linkedAt: now(),
      how,
      authors: authorNames(detail.authors) ?? []
    });
    return { status: 'opened', localId, how };
  } catch (error) {
    if (signal.aborted || (error instanceof LibraryApiError && error.kind === 'aborted')) {
      return { status: 'cancelled' };
    }
    throw error;
  }
}
