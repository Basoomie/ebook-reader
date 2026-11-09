/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
// Load the store first, like the app does (store.ts and database.service.ts import each other).
import '$lib/data/store';
import { configure as zipConfigure } from '@zip.js/zip.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '$lib/data/database/books-db/database.service';
import { createBooksDb } from '$lib/data/database/books-db/factory';
import type { BooksDbBookData } from '$lib/data/database/books-db/versions/books-db';
import loadEpub from '$lib/functions/file-loaders/epub/load-epub';
import { ReplicationSaveBehavior } from '$lib/functions/replication/replication-options';
import { installNodeDom } from '$lib/server/epub/node-dom';
import { LibraryApiError } from './api';
import { createLibraryDb, LibraryStore } from './library-db';
import { openCalibreBook, type OpenDeps } from './open-calibre-book';
import type { CatalogBookDetail } from './types';

/**
 * The open flow end to end against fake IndexedDB, with the real EPUB loader
 * and the real books database (the same upsert a manual import uses).
 */
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures');
const EPUB = readFileSync(path.join(fixtures, 'synthetic-epub3.epub'));
const OTHER_EPUB = readFileSync(path.join(fixtures, 'synthetic-epub2-ncx.epub'));

/** Node has no Image; the loader only uses it to check that a cover decodes. */
class LoadingImage extends EventTarget {
  #src = '';
  get src() {
    return this.#src;
  }
  set src(value: string) {
    this.#src = value;
    setTimeout(() => this.dispatchEvent(new Event('load')));
  }
}

let document: Document;
beforeAll(() => {
  document = installNodeDom();
  zipConfigure({ useWebWorkers: false });
  const g = globalThis as Record<string, unknown>;
  g.Image ??= LoadingImage;
});

let run = 0;
let books: DatabaseService;
let store: LibraryStore;
beforeEach(() => {
  run += 1;
  books = new DatabaseService(createBooksDb(`books-test-${run}`));
  store = new LibraryStore(() => createLibraryDb(`library-test-${run}`));
});

function detail(id: string, uuid: string): CatalogBookDetail {
  return {
    id,
    libraryId: 'lib-1',
    title: `Calibre ${id}`,
    authors: [],
    series: null,
    tags: [],
    addedAt: 1,
    charCount: null,
    missing: false,
    thumbnail: null,
    sources: [
      {
        kind: 'calibre',
        libraryId: 'lib-1',
        calibreUuid: uuid,
        calibreId: 42,
        filePath: 'a/b.epub',
        fileSize: EPUB.length,
        missingAt: null
      }
    ]
  };
}

const load = (file: File) => loadEpub(file, document, 1000);

/** What a manual import stores (BrowserStorageHandler.saveBook -> upsertData). */
async function manualImport(bytes: Buffer, name = 'manual.epub'): Promise<BooksDbBookData> {
  const content = await load(new File([new Uint8Array(bytes)], name));
  return books.upsertData(content, ReplicationSaveBehavior.NewOnly, false, true);
}

function deps(files: Record<string, Buffer>, overrides: Partial<OpenDeps> = {}) {
  const downloads: string[] = [];
  const d: OpenDeps = {
    api: {
      book: async (id) => detail(id, `uuid-${id}`),
      downloadFile: async (id, _signal, onProgress) => {
        downloads.push(id);
        onProgress?.(files[id].length, files[id].length);
        return { blob: new Blob([new Uint8Array(files[id])]), etag: `"etag-${id}"` };
      }
    },
    store,
    getLocalBook: async (id) => info(await books.getData(id)),
    getLocalBookByTitle: async (title) => info(await books.getDataByTitle(title)),
    loadEpub: load,
    saveNewBook: async (content) =>
      (await books.upsertData(content, ReplicationSaveBehavior.NewOnly, false, true)).id,
    calibreLibraryUuid: async () => 'calibre-library-uuid',
    confirmExisting: vi.fn(async () => true),
    now: () => 5000,
    ...overrides
  };
  return { d, downloads };
}

function info(book: BooksDbBookData | undefined) {
  return book
    ? {
        id: book.id,
        title: book.title,
        characters: book.characters,
        isPlaceholder: !book.elementHtml,
        storageSource: book.storageSource
      }
    : undefined;
}

async function allBooks() {
  return (await books.db).getAll('data');
}

const signal = () => new AbortController().signal;

describe('openCalibreBook', () => {
  it('imports a new title once and opens it from the device afterwards', async () => {
    const { d, downloads } = deps({ a: EPUB });
    const stages: string[] = [];
    const first = await openCalibreBook({ id: 'a', title: 'A' }, d, signal(), (s) =>
      stages.push(s.stage)
    );
    expect(first).toMatchObject({ status: 'opened', how: 'imported' });
    expect(stages).toEqual(['download', 'download', 'prepare', 'save']);

    const stored = await allBooks();
    expect(stored).toHaveLength(1);
    const localId = stored[0].id;
    expect(await store.getLink('a')).toEqual({
      bookId: 'a',
      libraryId: 'lib-1',
      calibreLibraryUuid: 'calibre-library-uuid',
      calibreUuid: 'uuid-a',
      calibreId: 42,
      localId,
      title: stored[0].title,
      calibreTitle: 'Calibre a',
      characters: stored[0].characters,
      fileEtag: '"etag-a"',
      linkedAt: 5000,
      how: 'imported'
    });

    const second = await openCalibreBook({ id: 'a', title: 'A' }, d, signal());
    expect(second).toEqual({ status: 'opened', localId, how: 'cached' });
    expect(downloads).toEqual(['a']);
  });

  it('links a manually imported copy without changing it', async () => {
    const manual = await manualImport(EPUB);
    const { d } = deps({ a: EPUB });
    const result = await openCalibreBook({ id: 'a', title: 'A' }, d, signal());
    expect(result).toEqual({ status: 'opened', localId: manual.id, how: 'matched' });

    const stored = await allBooks();
    expect(stored).toHaveLength(1);
    expect(stored[0].elementHtml).toBe(manual.elementHtml);
    expect(stored[0].lastBookModified).toBe(manual.lastBookModified);
    expect((await store.getLink('a'))?.how).toBe('matched');
    expect(d.confirmExisting).not.toHaveBeenCalled();
  });

  it('asks before linking a same-title book with a different count, and changes nothing on cancel', async () => {
    const manual = await manualImport(EPUB);
    const db = await books.db;
    await db.put('data', { ...manual, characters: manual.characters + 5 });

    const no = deps({ a: EPUB }, { confirmExisting: vi.fn(async () => false) });
    expect(await openCalibreBook({ id: 'a', title: 'A' }, no.d, signal())).toEqual({
      status: 'cancelled'
    });
    expect(await store.getLink('a')).toBeUndefined();
    expect(no.d.confirmExisting).toHaveBeenCalledWith({
      title: manual.title,
      localCharacters: manual.characters + 5,
      calibreCharacters: manual.characters
    });

    const yes = deps({ a: EPUB });
    expect(await openCalibreBook({ id: 'a', title: 'A' }, yes.d, signal())).toMatchObject({
      status: 'opened',
      localId: manual.id,
      how: 'matched'
    });
    expect((await store.getLink('a'))?.characters).toBe(manual.characters + 5);
    expect((await allBooks())[0].characters).toBe(manual.characters + 5);
  });

  it('refuses a second Calibre book with the same EPUB title', async () => {
    const { d } = deps({ a: EPUB, b: EPUB });
    await openCalibreBook({ id: 'a', title: 'A' }, d, signal());
    const result = await openCalibreBook({ id: 'b', title: 'B' }, d, signal());
    expect(result.status).toBe('refused');
    expect((result as { message: string }).message).toContain('Calibre a');
    expect(await allBooks()).toHaveLength(1);
    expect(await store.getLink('b')).toBeUndefined();
  });

  it('never fills or replaces a placeholder', async () => {
    const manual = await manualImport(EPUB);
    const db = await books.db;
    await db.put('data', { ...manual, elementHtml: '', storageSource: 'NAS' });
    const { d } = deps({ a: EPUB });
    const result = await openCalibreBook({ id: 'a', title: 'A' }, d, signal());
    expect(result.status).toBe('refused');
    expect((result as { message: string }).message).toContain('placeholder from "NAS"');
    expect((await allBooks())[0].elementHtml).toBe('');
  });

  it('downloads again after the book was deleted locally', async () => {
    const { d, downloads } = deps({ a: EPUB });
    await openCalibreBook({ id: 'a', title: 'A' }, d, signal());
    const [stored] = await allBooks();
    await (await books.db).delete('data', stored.id);

    const result = await openCalibreBook({ id: 'a', title: 'A' }, d, signal());
    expect(result).toMatchObject({ status: 'opened', how: 'imported' });
    expect(downloads).toEqual(['a', 'a']);
    const [again] = await allBooks();
    expect((await store.getLink('a'))?.localId).toBe(again.id);
  });

  it('keeps different titles apart', async () => {
    const { d } = deps({ a: EPUB, b: OTHER_EPUB });
    await openCalibreBook({ id: 'a', title: 'A' }, d, signal());
    await openCalibreBook({ id: 'b', title: 'B' }, d, signal());
    const stored = await allBooks();
    expect(new Set(stored.map((b) => b.title)).size).toBe(2);
    expect((await store.getLink('a'))?.localId).not.toBe((await store.getLink('b'))?.localId);
  });

  it('reports a cancelled download and saves nothing', async () => {
    const controller = new AbortController();
    const { d } = deps(
      { a: EPUB },
      {
        api: {
          book: async (id) => detail(id, 'uuid'),
          downloadFile: async () => {
            controller.abort();
            throw new LibraryApiError('aborted', 'Cancelled');
          }
        }
      }
    );
    expect(await openCalibreBook({ id: 'a', title: 'A' }, d, controller.signal)).toEqual({
      status: 'cancelled'
    });
    expect(await allBooks()).toHaveLength(0);
  });

  it('passes other errors on', async () => {
    const { d } = deps(
      { a: EPUB },
      {
        api: {
          book: async () => {
            throw new LibraryApiError('unreachable', 'down');
          },
          downloadFile: async () => ({ blob: new Blob([]), etag: null })
        }
      }
    );
    await expect(openCalibreBook({ id: 'a', title: 'A' }, d, signal())).rejects.toThrow('down');
  });
});
