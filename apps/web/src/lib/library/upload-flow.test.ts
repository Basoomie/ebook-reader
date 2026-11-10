/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it, vi } from 'vitest';
import { LibraryApi, LibraryApiError, type UploadXhr } from './api';
import type { CatalogBook, StagedUpload } from './types';
import { uploadFiles, type UploadFlowDeps } from './upload-flow';

function book(id: string, source: 'calibre' | 'upload' = 'calibre'): CatalogBook {
  return {
    id,
    libraryId: 'lib',
    title: `Book ${id}`,
    authors: [],
    series: null,
    tags: [],
    addedAt: 1,
    charCount: null,
    missing: false,
    thumbnail: null,
    source
  };
}

function staged(id: string, duplicates: StagedUpload['duplicates'] = []): StagedUpload {
  return {
    uploadId: id,
    libraryId: 'lib',
    title: id,
    authors: [],
    series: null,
    size: 10,
    duplicates
  };
}

const epub = (name: string, size = 10) =>
  new File([new Uint8Array(size)], name, { type: 'application/epub+zip' });

function deps(overrides: Partial<UploadFlowDeps> = {}) {
  const added: string[] = [];
  const discarded: string[] = [];
  const d: UploadFlowDeps = {
    api: {
      uploadEpub: vi.fn(async (file: Blob, name: string) => staged(name)),
      addUpload: vi.fn(async (id: string) => {
        added.push(id);
        return { book: book(`new-${id}`, 'upload') };
      }),
      discardUpload: vi.fn(async (id: string) => {
        discarded.push(id);
      })
    },
    maxBytes: 100,
    askDuplicate: vi.fn(async () => 'use' as const),
    onProgress: vi.fn(),
    signal: new AbortController().signal,
    ...overrides
  };
  return { d, added, discarded };
}

describe('uploadFiles', () => {
  it('adds files without a duplicate and never asks', async () => {
    const { d, added } = deps();
    const results = await uploadFiles([epub('a.epub'), epub('b.epub')], 'lib', d);
    expect(results.map((r) => r.status)).toEqual(['added', 'added']);
    expect(added).toEqual(['a.epub', 'b.epub']);
    expect(d.askDuplicate).not.toHaveBeenCalled();
  });

  it('asks for a duplicate: use the library copy, add separately, or cancel', async () => {
    const dup = [{ match: 'fingerprint' as const, book: book('existing') }];
    for (const [decision, status] of [
      ['use', 'used-copy'],
      ['add', 'added'],
      ['cancel', 'cancelled']
    ] as const) {
      const { d, added, discarded } = deps({
        askDuplicate: vi.fn(async () => decision)
      });
      d.api.uploadEpub = vi.fn(async () => staged('s1', dup));
      const [result] = await uploadFiles([epub('a.epub')], 'lib', d);
      expect(result.status).toBe(status);
      if (status === 'used-copy') expect(result).toMatchObject({ book: { id: 'existing' } });
      expect(added).toEqual(decision === 'add' ? ['s1'] : []);
      expect(discarded).toEqual(decision === 'add' ? [] : ['s1']);
    }
  });

  it('refuses non-EPUB and too large files before sending them', async () => {
    const { d } = deps({ maxBytes: 5 });
    const results = await uploadFiles(
      [new File(['x'], 'notes.txt', { type: 'text/plain' }), epub('big.epub', 6)],
      'lib',
      d
    );
    expect(results).toEqual([
      { name: 'notes.txt', status: 'failed', message: 'Only EPUB files can be uploaded.' },
      {
        name: 'big.epub',
        status: 'failed',
        message: "It's larger than the server's upload limit (0 MB)."
      }
    ]);
    expect(d.api.uploadEpub).not.toHaveBeenCalled();
  });

  it('reports a damaged file and stops after Cancel', async () => {
    const controller = new AbortController();
    const { d } = deps({ signal: controller.signal });
    d.api.uploadEpub = vi
      .fn()
      .mockRejectedValueOnce(new LibraryApiError('server', 'x', 422, 'bad_epub'))
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new LibraryApiError('aborted', 'Cancelled');
      });
    const results = await uploadFiles([epub('a.epub'), epub('b.epub'), epub('c.epub')], 'l', d);
    expect(results).toEqual([
      { name: 'a.epub', status: 'failed', message: "This file can't be read as an EPUB." },
      { name: 'b.epub', status: 'cancelled' },
      { name: 'c.epub', status: 'cancelled' }
    ]);
  });
});

class FakeXhr implements UploadXhr {
  static last: FakeXhr;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = '';
  upload = {} as XMLHttpRequestUpload;
  onload: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onabort: ((ev: unknown) => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string | URL) {
    this.method = method;
    this.url = String(url);
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body?: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
  }
  abort() {
    this.onabort?.({});
  }
  answer(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.({});
  }
}

describe('LibraryApi uploads', () => {
  const api = () =>
    new LibraryApi('http://nas:3080', 'ttsu_t', 20, fetch, () => new FakeXhr() as UploadXhr);

  it('posts the EPUB with the token and the library, and reports progress', async () => {
    const progress: number[] = [];
    const file = epub('本 1.epub');
    const pending = api().uploadEpub(file, '本 1.epub', 'lib-1', {
      onProgress: (loaded) => progress.push(loaded)
    });
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('http://nas:3080/api/v1/uploads?library=lib-1&name=%E6%9C%AC+1.epub');
    expect(xhr.headers).toEqual({
      Authorization: 'Bearer ttsu_t',
      'Content-Type': 'application/epub+zip'
    });
    expect(xhr.body).toBe(file);
    (xhr.upload.onprogress as (ev: ProgressEvent) => void)({
      loaded: 5,
      total: 10
    } as ProgressEvent);
    xhr.answer(201, staged('u1'));
    expect(await pending).toEqual(staged('u1'));
    expect(progress).toEqual([5]);
  });

  it('turns error answers, network errors and cancel into LibraryApiError', async () => {
    const tooBig = api().uploadEpub(epub('a.epub'), 'a.epub', 'l');
    FakeXhr.last.answer(413, { error: { code: 'too_large', message: 'Too big' } });
    await expect(tooBig).rejects.toMatchObject({ kind: 'server', status: 413, code: 'too_large' });

    const offline = api().uploadEpub(epub('a.epub'), 'a.epub', 'l');
    FakeXhr.last.onerror?.({});
    await expect(offline).rejects.toMatchObject({ kind: 'unreachable' });

    const controller = new AbortController();
    const cancelled = api().uploadEpub(epub('a.epub'), 'a.epub', 'l', {
      signal: controller.signal
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: 'aborted' });
  });
});
