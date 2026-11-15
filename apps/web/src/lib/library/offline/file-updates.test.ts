/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { LoadData } from '$lib/functions/file-loaders/types';
import { LibraryApiError } from '$lib/library/api';
import type { CalibreLink } from '$lib/library/library-db';
import { updateChangedFiles, type FileUpdateDeps, type StoredRow } from './file-updates';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const MATCHED = '<div data-ttu-whispersync-matched-by="a.srt">old text</div>';

function link(over: Partial<CalibreLink> = {}): CalibreLink {
  return {
    bookId: 'b1',
    libraryId: 'lib',
    calibreLibraryUuid: null,
    calibreUuid: 'u1',
    sourceKind: 'calibre',
    calibreId: 1,
    localId: 7,
    title: 'Stored title',
    calibreTitle: 'Book',
    characters: 100,
    fileEtag: '"1000-50"',
    fileSha256: H1,
    linkedAt: 1,
    how: 'imported',
    ...over
  };
}

function content(html: string, characters = 120): LoadData {
  return {
    title: 'New EPUB title',
    styleSheet: '',
    elementHtml: html,
    blobs: {},
    coverImage: undefined,
    hasThumb: true,
    characters,
    lastBookModified: 1,
    lastBookOpen: 0
  } as LoadData;
}

function setup(opts: {
  links?: CalibreLink[];
  server?: Record<string, { sha256: string | null; etag: string | null }>;
  row?: StoredRow;
  file?: LoadData;
  place?: number | null;
  match?: { file: string | null } | null;
  open?: boolean;
}) {
  const links = new Map((opts.links ?? [link()]).map((l) => [l.bookId, l]));
  const calls = { downloads: 0, replaced: [] as unknown[], resets: 0, warnings: [] as string[] };
  const deps: FileUpdateDeps = {
    api: {
      fileHashes: async (ids) => ({
        books: ids.map((id) => ({
          id,
          ...(opts.server?.[id] ?? { sha256: H2, etag: '"2000-60"' })
        }))
      }),
      downloadFile: async () => {
        calls.downloads += 1;
        return { blob: new Blob(['epub']), etag: '"2000-60"' };
      }
    },
    links: async () => [...links.values()],
    putLink: async (l) => void links.set(l.bookId, l),
    getRow: async () => opts.row ?? { title: 'Stored title', elementHtml: '<p>old text</p>' },
    getPlace: async () => (opts.place === undefined ? 40 : opts.place),
    loadEpub: async () => opts.file ?? content('<p>new text</p>'),
    remapPlace: (_o, _n, position) => position + 10,
    replace: async (localId, c, place) => {
      calls.replaced.push({ localId, html: c.elementHtml, place });
      return true;
    },
    isMatched: (html) => html.includes('matched-by'),
    liveMatchFile: async () => (opts.match === undefined ? null : opts.match),
    resetMatch: async () => void (calls.resets += 1),
    isOpenInReader: () => !!opts.open,
    warn: (m) => void calls.warnings.push(m)
  };
  return { deps, links, calls };
}

describe('a library file that changed', () => {
  it('the same hash: nothing is downloaded', async () => {
    const { deps, calls } = setup({ server: { b1: { sha256: H1, etag: '"9-9"' } } });
    expect((await updateChangedFiles(deps)).checked).toBe(1);
    expect(calls.downloads).toBe(0);
  });

  it('a link from before: an unchanged ETag adopts the hash without downloading', async () => {
    const { deps, links, calls } = setup({
      links: [link({ fileSha256: undefined, fileEtag: '"2000-60"' })]
    });
    expect((await updateChangedFiles(deps)).adopted).toBe(1);
    expect(calls.downloads).toBe(0);
    expect(links.get('b1')?.fileSha256).toBe(H2);
  });

  it('a different hash with the same text: only the link is updated', async () => {
    const { deps, links, calls } = setup({ file: content('<p>old text</p>') });
    expect((await updateChangedFiles(deps)).sameText).toBe(1);
    expect(calls.replaced).toEqual([]);
    expect(links.get('b1')).toMatchObject({ fileSha256: H2, fileEtag: '"2000-60"' });
  });

  it('a matched copy is compared by its text from before the match', async () => {
    const { deps, calls } = setup({
      row: { title: 't', elementHtml: MATCHED, htmlBackup: '<p>old text</p>' },
      file: content('<p>old text</p>')
    });
    expect((await updateChangedFiles(deps)).sameText).toBe(1);
    expect(calls.replaced).toEqual([]);
  });

  it('different text: replaced in place with the place found again, link updated', async () => {
    const { deps, links, calls } = setup({});
    expect((await updateChangedFiles(deps)).replaced).toBe(1);
    expect(calls.replaced).toEqual([
      { localId: 7, html: '<p>new text</p>', place: { exploredCharCount: 50, progress: 50 / 120 } }
    ]);
    expect(links.get('b1')).toMatchObject({
      characters: 120,
      fileSha256: H2,
      fileEtag: '"2000-60"',
      title: 'Stored title'
    });
  });

  it('nothing saved: replaced without moving a place', async () => {
    const { deps, calls } = setup({ place: null });
    await updateChangedFiles(deps);
    expect(calls.replaced).toEqual([{ localId: 7, html: '<p>new text</p>', place: null }]);
  });

  it('a live match saved before Season 2 is reset first; one that names a file is kept', async () => {
    const a = setup({ match: { file: null } });
    await updateChangedFiles(a.deps);
    expect(a.calls.resets).toBe(1);
    const b = setup({ match: { file: H1 } });
    await updateChangedFiles(b.deps);
    expect(b.calls.resets).toBe(0);
    expect(b.calls.replaced).toHaveLength(1);
  });

  it('a matched copy from before whose text differs is kept and its hash recorded', async () => {
    const { deps, links, calls } = setup({
      links: [link({ fileSha256: undefined, fileEtag: '"0-0"' })],
      row: { title: 't', elementHtml: MATCHED, htmlBackup: '<p>other settings</p>' }
    });
    expect((await updateChangedFiles(deps)).adopted).toBe(1);
    expect(calls.replaced).toEqual([]);
    expect(links.get('b1')?.fileSha256).toBe(H2);
    expect(calls.warnings[0]).toContain('kept');
  });

  it('skips the book open in the reader, copies this device had, uploads and missing books', async () => {
    const open = setup({ open: true });
    expect((await updateChangedFiles(open.deps)).skipped).toBe(1);
    expect(open.calls.downloads).toBe(0);
    const others = setup({
      links: [
        link({ bookId: 'm', how: 'matched' }),
        link({ bookId: 'u', sourceKind: 'upload' }),
        link({ bookId: 'gone' })
      ],
      server: { gone: { sha256: null, etag: null } }
    });
    expect(await updateChangedFiles(others.deps)).toMatchObject({ checked: 1, replaced: 0 });
    expect(others.calls.downloads).toBe(0);
  });

  it('stops quietly when the server goes away; a failing book is left as it was', async () => {
    const { deps, links, calls } = setup({});
    deps.api.fileHashes = async () => {
      throw new LibraryApiError('unreachable', 'no');
    };
    expect((await updateChangedFiles(deps)).stopped).toBe(true);
    expect(calls.warnings).toEqual([]);

    const failing = setup({});
    failing.deps.loadEpub = async () => {
      throw new Error('broken EPUB');
    };
    expect((await updateChangedFiles(failing.deps)).skipped).toBe(1);
    expect(failing.links.get('b1')?.fileSha256).toBe(H1);
    expect(failing.calls.replaced).toEqual([]);
    expect(links.get('b1')?.fileSha256).toBe(H1);
  });
});
