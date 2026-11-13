/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { LocalRecord } from '$lib/sync/sync-db';
import {
  ATTACHMENT_KIND,
  MATCH,
  POSITION_KIND,
  SUBTITLES,
  attachmentId,
  compare,
  concernsBook,
  isMatched,
  pushMatch,
  pushPosition,
  pushSubtitles,
  resetAll,
  resetMatch,
  syncBook,
  type AudioBookRow,
  type DataRow,
  type SubtitleRow,
  type SyncDeps
} from './whispersync-sync';

const BOOK = { bookId: 'b1', localId: 7, title: '本' };
const MATCHED = '<div data-ttu-whispersync-matched-by="a.srt"><span>matched</span></div>';
const ORIGINAL = '<div>original</div>';

function fake() {
  const records = new Map<string, LocalRecord>();
  const files = new Map<string, { text: string; sha256: string; modifiedAt: number }>();
  const audioBook = new Map<string, AudioBookRow>();
  const subtitle = new Map<string, SubtitleRow>();
  const data = new Map<number, DataRow>();
  const uploads: { name: string; body: string; modifiedAt: number }[] = [];
  let clock = 10_000;
  const key = (kind: string, id: string) => `${kind}|${id}`;
  const setRecord = (kind: string, id: string, rec: Partial<LocalRecord>) =>
    records.set(key(kind, id), {
      kind,
      id,
      bookId: BOOK.bookId,
      deviceId: 'other',
      updatedAt: rec.updatedAt ?? clock,
      deletedAt: rec.deletedAt ?? null,
      rev: 1,
      data: rec.data ?? {}
    });
  /** Another device uploads an attachment (server writes file + record). */
  const remoteUpload = (name: string, payload: unknown, modifiedAt: number) => {
    const text = JSON.stringify(payload);
    const sha256 = `sha-${text.length}-${modifiedAt}`;
    files.set(name, { text, sha256, modifiedAt });
    setRecord(ATTACHMENT_KIND, attachmentId(BOOK.bookId, name as never), {
      data: { size: text.length, sha256, modifiedAt }
    });
  };
  const deps: SyncDeps = {
    engine: {
      get: async (kind, id) => records.get(key(kind, id)),
      put: async (kind, id, d) => {
        clock += 1;
        setRecord(kind, id, { data: d, updatedAt: clock });
        return true;
      },
      remove: async (kind, id) => {
        clock += 1;
        setRecord(kind, id, { deletedAt: clock, updatedAt: clock });
        return true;
      }
    },
    api: {
      upload: async (_bookId, name, body, modifiedAt) => {
        const cur = records.get(key(ATTACHMENT_KIND, attachmentId(BOOK.bookId, name)));
        if (cur && cur.deletedAt === null && Number(cur.data.modifiedAt) > modifiedAt)
          return 'stale';
        uploads.push({ name, body, modifiedAt });
        remoteUpload(name, JSON.parse(body), modifiedAt);
        return 'ok';
      },
      download: async (_bookId, name) => {
        const f = files.get(name);
        return f ? { text: f.text, sha256: f.sha256 } : null;
      }
    },
    local: {
      getAudioBook: async (t) => audioBook.get(t),
      putAudioBook: async (r) => void audioBook.set(r.title, r),
      getSubtitle: async (t) => subtitle.get(t),
      putSubtitle: async (r) => void subtitle.set(r.title, r),
      getData: async (id) => data.get(id),
      putData: async (r) => void data.set(r.id, r)
    }
  };
  return { deps, records, files, audioBook, subtitle, data, uploads, setRecord, remoteUpload, key };
}

describe('compare', () => {
  const rec = (data: Record<string, unknown>, deletedAt: number | null = null): LocalRecord => ({
    kind: 'k',
    id: 'i',
    bookId: null,
    deviceId: 'd',
    updatedAt: 1,
    deletedAt,
    rev: 1,
    data
  });
  it('says which side is newer, and when a reset elsewhere wins', () => {
    expect(compare(undefined, undefined)).toBe('same');
    expect(compare(undefined, 5)).toBe('local');
    expect(compare(rec({ modifiedAt: 9 }), 5)).toBe('remote');
    expect(compare(rec({ modifiedAt: 5 }), 9)).toBe('local');
    expect(compare(rec({ modifiedAt: 5 }), 5)).toBe('same');
    expect(compare(rec({}, 9), 5)).toBe('removed');
    expect(compare(rec({}, 5), 9)).toBe('local');
    expect(compare(rec({}, 5), undefined)).toBe('same');
  });

  it('knows a matched book and the records of a book', () => {
    expect(isMatched(MATCHED)).toBe(true);
    expect(isMatched(ORIGINAL)).toBe(false);
    expect(isMatched(undefined)).toBe(false);
    const r = { kind: POSITION_KIND, id: 'b1', bookId: 'b1' } as LocalRecord;
    expect(concernsBook([r], 'b1')).toBe(true);
    expect(concernsBook([{ ...r, kind: 'position' }], 'b1')).toBe(false);
    expect(concernsBook([{ ...r, kind: ATTACHMENT_KIND, id: 'b2:x', bookId: 'b2' }], 'b1')).toBe(
      false
    );
  });
});

describe('playback position', () => {
  it('goes up when this device saved it later, never older over newer', async () => {
    const f = fake();
    f.audioBook.set(BOOK.title, {
      title: BOOK.title,
      playbackPosition: 42,
      lastAudioBookModified: 500
    });
    await pushPosition(f.deps, BOOK);
    expect(f.records.get(f.key(POSITION_KIND, 'b1'))?.data).toEqual({
      position: 42,
      modifiedAt: 500
    });
    // Another device saved later: this older position must not go up.
    f.setRecord(POSITION_KIND, 'b1', { data: { position: 99, modifiedAt: 900 } });
    await pushPosition(f.deps, BOOK);
    expect(f.records.get(f.key(POSITION_KIND, 'b1'))?.data).toEqual({
      position: 99,
      modifiedAt: 900
    });
  });

  it("comes down into whispersync's row when another device's is newer", async () => {
    const f = fake();
    f.audioBook.set(BOOK.title, {
      title: BOOK.title,
      playbackPosition: 10,
      lastAudioBookModified: 100
    });
    f.setRecord(POSITION_KIND, 'b1', { data: { position: 321.5, modifiedAt: 800 } });
    const r = await syncBook(f.deps, BOOK);
    expect(r.changed.position).toBe(true);
    expect(f.audioBook.get(BOOK.title)).toEqual({
      title: BOOK.title,
      playbackPosition: 321.5,
      lastAudioBookModified: 800
    });
    // Level now: nothing more happens.
    expect((await syncBook(f.deps, BOOK)).changed.position).toBe(false);
  });
});

describe('saved subtitles', () => {
  it('upload when newer here, download when newer there', async () => {
    const f = fake();
    f.subtitle.set(BOOK.title, {
      title: BOOK.title,
      subtitleData: { name: 'a.srt', subtitles: [1] },
      lastSubtitleDataModified: 300
    });
    expect(await pushSubtitles(f.deps, BOOK)).toBe('ok');
    expect(f.uploads).toHaveLength(1);
    expect(await pushSubtitles(f.deps, BOOK)).toBe('skipped');

    f.remoteUpload(SUBTITLES, { subtitleData: { name: 'b.srt', subtitles: [2] } }, 700);
    const r = await syncBook(f.deps, BOOK);
    expect(r.changed.subtitles).toBe(true);
    expect(f.subtitle.get(BOOK.title)).toEqual({
      title: BOOK.title,
      subtitleData: { name: 'b.srt', subtitles: [2] },
      lastSubtitleDataModified: 700
    });
  });

  it('waits when the file on the server no longer matches the record', async () => {
    const f = fake();
    f.remoteUpload(SUBTITLES, { subtitleData: { name: 'b.srt', subtitles: [] } }, 700);
    f.files.set(SUBTITLES, { ...f.files.get(SUBTITLES)!, sha256: 'changed' });
    const r = await syncBook(f.deps, BOOK);
    expect(r.changed.subtitles).toBe(false);
    expect(f.subtitle.has(BOOK.title)).toBe(false);
  });

  it('are dropped here when removed elsewhere (reset all, or the link changed on the server)', async () => {
    const f = fake();
    f.subtitle.set(BOOK.title, {
      title: BOOK.title,
      subtitleData: { name: 'old.srt', subtitles: [1, 2] },
      lastSubtitleDataModified: 300
    });
    // The server removed them after this device saved them.
    f.setRecord(ATTACHMENT_KIND, attachmentId(BOOK.bookId, SUBTITLES), {
      updatedAt: 900,
      deletedAt: 900
    });
    const r = await syncBook(f.deps, BOOK);
    expect(r.changed.subtitles).toBe(true);
    // As whispersync's own Reset all leaves them: the name, no lines.
    expect(f.subtitle.get(BOOK.title)).toEqual({
      title: BOOK.title,
      subtitleData: { name: 'old.srt', subtitles: [] },
      lastSubtitleDataModified: 900
    });
    expect(f.uploads).toHaveLength(0);
    // Already empty: nothing changes again (no reload notice).
    expect((await syncBook(f.deps, BOOK)).changed.subtitles).toBe(false);
  });

  it('saved here after the removal are kept and go up', async () => {
    const f = fake();
    f.setRecord(ATTACHMENT_KIND, attachmentId(BOOK.bookId, SUBTITLES), {
      updatedAt: 900,
      deletedAt: 900
    });
    f.subtitle.set(BOOK.title, {
      title: BOOK.title,
      subtitleData: { name: 'new.srt', subtitles: [3] },
      lastSubtitleDataModified: 1000
    });
    const r = await syncBook(f.deps, BOOK);
    expect(r.changed.subtitles).toBe(false);
    expect(f.subtitle.get(BOOK.title)!.subtitleData).toEqual({ name: 'new.srt', subtitles: [3] });
    expect(f.uploads.map((u) => u.name)).toEqual([SUBTITLES]);
  });
});

describe('saved match', () => {
  it('a match saved here goes up; another device gets it with its backup', async () => {
    const f = fake();
    f.data.set(7, {
      id: 7,
      title: BOOK.title,
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: 1000
    });
    expect(await pushMatch(f.deps, BOOK)).toBe('ok');
    expect(JSON.parse(f.uploads[0].body)).toEqual({
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: 1000
    });

    // Device B: unmatched copy, older.
    const g = fake();
    g.data.set(7, {
      id: 7,
      title: BOOK.title,
      elementHtml: ORIGINAL,
      lastBookModified: 50,
      blobs: 'kept'
    });
    g.remoteUpload(MATCH, JSON.parse(f.uploads[0].body), 1000);
    const r = await syncBook(g.deps, BOOK);
    expect(r.changed.match).toBe(true);
    expect(g.data.get(7)).toEqual({
      id: 7,
      title: BOOK.title,
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: 1000,
      blobs: 'kept'
    });
  });

  it('an unmatched book is never uploaded', async () => {
    const f = fake();
    f.data.set(7, { id: 7, title: BOOK.title, elementHtml: ORIGINAL, lastBookModified: 1000 });
    expect(await pushMatch(f.deps, BOOK)).toBe('skipped');
    await syncBook(f.deps, BOOK);
    expect(f.uploads).toEqual([]);
  });

  it('reset match on another device restores the backup here; a newer local match is kept', async () => {
    const f = fake();
    f.data.set(7, {
      id: 7,
      title: BOOK.title,
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: 1000
    });
    f.setRecord(ATTACHMENT_KIND, attachmentId('b1', MATCH), { deletedAt: 5000, updatedAt: 5000 });
    const r = await syncBook(f.deps, BOOK);
    expect(r.changed.match).toBe(true);
    expect(f.data.get(7)).toEqual({
      id: 7,
      title: BOOK.title,
      elementHtml: ORIGINAL,
      lastBookModified: 5000
    });

    // Matched again here after that reset: kept, and it goes up.
    const g = fake();
    g.data.set(7, {
      id: 7,
      title: BOOK.title,
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: 9000
    });
    g.setRecord(ATTACHMENT_KIND, attachmentId('b1', MATCH), { deletedAt: 5000, updatedAt: 5000 });
    const s = await syncBook(g.deps, BOOK);
    expect(s.changed.match).toBe(false);
    expect(g.data.get(7)?.elementHtml).toBe(MATCHED);
    expect(g.uploads.map((u) => u.name)).toEqual([MATCH]);
  });

  it('a book matched before WP15c with no record goes up once, and is never reset by "no record"', async () => {
    const f = fake();
    f.data.set(7, {
      id: 7,
      title: BOOK.title,
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: 1000
    });
    const r = await syncBook(f.deps, BOOK);
    expect(r.changed.match).toBe(false);
    expect(f.data.get(7)?.elementHtml).toBe(MATCHED);
    expect(f.uploads).toHaveLength(1);
  });
});

describe('resets', () => {
  it('reset match removes only the match; reset all removes match, subtitles and position', async () => {
    const f = fake();
    await resetMatch(f.deps, BOOK);
    expect(f.records.get(f.key(ATTACHMENT_KIND, 'b1:whispersync-match'))?.deletedAt).not.toBeNull();
    expect(f.records.has(f.key(POSITION_KIND, 'b1'))).toBe(false);
    await resetAll(f.deps, BOOK);
    for (const k of [
      f.key(ATTACHMENT_KIND, 'b1:whispersync-match'),
      f.key(ATTACHMENT_KIND, 'b1:whispersync-subtitles'),
      f.key(POSITION_KIND, 'b1')
    ]) {
      expect(f.records.get(k)?.deletedAt).not.toBeNull();
    }
  });

  it('problems are reported, never thrown', async () => {
    const f = fake();
    f.deps.local.getAudioBook = async () => {
      throw new Error('idb gone');
    };
    const r = await syncBook(f.deps, BOOK);
    expect(r.problems).toEqual(['position: idb gone']);
  });
});
