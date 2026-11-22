/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { LocalRecord } from '$lib/sync/sync-db';
import type { Subtitle } from '$lib/whispersync/lib/general';
import type { MatchInput, MatchResult } from '$lib/whispersync/lib/match';
import {
  figureText,
  hasLiveMatch,
  loadLines,
  resetBookMatch,
  runMatch,
  saveMatch,
  sourceRow,
  timeLeftText,
  type BookMatchDeps
} from './whispersync-book-match';
import {
  ATTACHMENT_KIND,
  MATCH,
  attachmentId,
  type DataRow,
  type SubtitleRow
} from './whispersync-sync';

const BOOK = { bookId: 'b1', localId: 7, title: '本' };
const ORIGINAL = '<div id="ttu-1"><p>original</p></div>';
const NOW = '<div id="ttu-1" data-ttu-whispersync-matched-by="a.srt"><p><span>now</span></p></div>';
const MATCHED =
  '<div id="ttu-1" data-ttu-whispersync-matched-by="a.srt"><p><span>original</span></p></div>';

const line = (id: number, text: string): Subtitle => ({
  id: `${id}`,
  originalStartSeconds: id,
  startSeconds: id,
  startTime: '',
  originalEndSeconds: id + 1,
  endSeconds: id + 1,
  endTime: '',
  originalText: text,
  text,
  subIndex: id - 1
});

function fake() {
  const records = new Map<string, LocalRecord>();
  const data = new Map<number, DataRow>();
  const subtitle = new Map<string, SubtitleRow>();
  const uploads: { name: string; body: string; modifiedAt: number }[] = [];
  const calls: string[] = [];
  const matcherInputs: MatchInput[] = [];
  let failUpload = false;
  let picked = false;
  let linkedFile: File | null = new File(
    ['1\n00:00:01,000 --> 00:00:02,000\nlinked\n'],
    'linked.srt'
  );
  let clock = 1000;
  const key = (kind: string, id: string) => `${kind}|${id}`;
  const deps: BookMatchDeps = {
    engine: {
      get: async (kind, id) => records.get(key(kind, id)),
      put: async () => true,
      remove: async (kind, id) => {
        calls.push(`remove ${kind} ${id}`);
        records.set(key(kind, id), {
          kind,
          id,
          bookId: BOOK.bookId,
          deviceId: 'me',
          updatedAt: 1,
          deletedAt: 5000,
          rev: 2,
          data: {}
        });
        return true;
      }
    },
    api: {
      upload: async (_b, name, body, modifiedAt) => {
        if (failUpload) throw new Error('unreachable');
        uploads.push({ name, body, modifiedAt });
        return 'ok';
      },
      download: async () => null
    },
    local: {
      getAudioBook: async () => undefined,
      putAudioBook: async () => {},
      getSubtitle: async (t) => subtitle.get(t),
      putSubtitle: async (r) => void subtitle.set(r.title, r),
      getData: async (id) => data.get(id),
      putData: async (r) => void data.set(r.id, r)
    },
    hasPickedSubtitleFile: async () => picked,
    linkedSubtitleFile: async () => {
      calls.push('linked file');
      return linkedFile;
    },
    parseSubtitleFile: async (file) => {
      calls.push(`parse ${file.name}`);
      return new Map([['1', line(1, 'linked')]]);
    },
    savedLines: (saved) => {
      calls.push('saved lines');
      return new Map(saved.map((s) => [s.id, s]));
    },
    settings: { ignoreRp: () => false, similarityThreshold: () => 0.9, maxAttempts: () => 50 },
    matcher: async (input) => {
      matcherInputs.push(input);
      return {
        bookHTML: { innerHTML: NOW } as unknown as HTMLElement,
        matchedSubtitles: 1,
        lineMatchRate: '1 / 1 (100%)',
        bookSubtitleDiffRate: '0 / 1 (0%)',
        subtitlesForDownload: [],
        subtitleDiffDetails: [],
        unmatchedSubtitles: []
      } satisfies MatchResult;
    },
    withinRequestTime: (promise) => promise,
    now: () => ++clock
  };
  return {
    deps,
    data,
    subtitle,
    records,
    uploads,
    calls,
    matcherInputs,
    set: {
      failUpload: (v: boolean) => (failUpload = v),
      picked: (v: boolean) => (picked = v),
      linkedFile: (f: File | null) => (linkedFile = f)
    }
  };
}

describe('the lines (the reader order)', () => {
  it('a subtitle file picked in the reader is left to the reader', async () => {
    const f = fake();
    f.set.picked(true);
    expect(await loadLines(f.deps, BOOK)).toEqual({ kind: 'picked-file' });
    expect(f.calls).toEqual([]);
  });

  it('saved subtitles with lines come before the linked file, under their own name', async () => {
    const f = fake();
    f.subtitle.set(BOOK.title, {
      title: BOOK.title,
      subtitleData: { name: 'saved.srt', subtitles: [line(1, 'saved'), line(2, 'too')] },
      lastSubtitleDataModified: 1
    });
    const lines = await loadLines(f.deps, BOOK);
    expect(lines).toMatchObject({ kind: 'lines', name: 'saved.srt' });
    expect(lines.kind === 'lines' && lines.subtitles.map((s) => s.text)).toEqual(['saved', 'too']);
    expect(f.calls).toEqual(['saved lines']);
  });

  it('otherwise the linked file, parsed as when dropped; saved subtitles without lines count as none', async () => {
    const f = fake();
    f.subtitle.set(BOOK.title, {
      title: BOOK.title,
      subtitleData: { name: 'saved.srt', subtitles: [] },
      lastSubtitleDataModified: 1
    });
    expect(await loadLines(f.deps, BOOK)).toMatchObject({ kind: 'lines', name: 'linked.srt' });
    expect(f.calls).toEqual(['linked file', 'parse linked.srt']);
    f.set.linkedFile(null);
    expect(await loadLines(f.deps, BOOK)).toEqual({ kind: 'none' });
  });
});

describe('matching, saving and resetting as the reader does', () => {
  const lines = { kind: 'lines' as const, subtitles: [line(1, 'x')], name: 'a.srt' };

  it('Match starts from the text of an unmatched copy; Match again from its original (backup)', async () => {
    const f = fake();
    f.data.set(7, { id: 7, title: BOOK.title, elementHtml: ORIGINAL, lastBookModified: 1 });
    await runMatch(f.deps, 7, lines, new AbortController().signal, () => {});
    expect(f.matcherInputs[0].elementHtml).toBe(ORIGINAL);
    expect(f.matcherInputs[0].hint).toBeUndefined();
    expect(f.matcherInputs[0].subtitleFileName()).toBe('a.srt');

    f.data.set(7, {
      id: 7,
      title: BOOK.title,
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: 2
    });
    const again = await runMatch(f.deps, 7, lines, new AbortController().signal, () => {});
    expect(f.matcherInputs[1].elementHtml).toBe(ORIGINAL);
    expect(again.source).not.toHaveProperty('htmlBackup');
    // The current match stays until Save.
    expect(f.data.get(7)?.elementHtml).toBe(MATCHED);
  });

  it('sourceRow is onResetBook for a matched copy and the copy itself otherwise', () => {
    const plain = { id: 1, title: 't', elementHtml: ORIGINAL, lastBookModified: 1 };
    expect(sourceRow(plain, 9)).toBe(plain);
    expect(sourceRow({ ...plain, elementHtml: MATCHED, htmlBackup: ORIGINAL }, 9)).toEqual({
      ...plain,
      lastBookModified: 9
    });
  });

  it('Save stores onSaveMatch row (original as the backup) and uploads the match', async () => {
    const f = fake();
    f.data.set(7, {
      id: 7,
      title: BOOK.title,
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: 2,
      kept: 'yes'
    });
    const match = await runMatch(f.deps, 7, lines, new AbortController().signal, () => {});
    expect(await saveMatch(f.deps, BOOK, match)).toBe('uploaded');
    const row = f.data.get(7)!;
    expect(row.elementHtml).toBe(NOW);
    expect(row.htmlBackup).toBe(ORIGINAL);
    expect(row.kept).toBe('yes');
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0].name).toBe(MATCH);
    expect(f.uploads[0].modifiedAt).toBe(row.lastBookModified);
    expect(JSON.parse(f.uploads[0].body)).toMatchObject({ elementHtml: NOW, htmlBackup: ORIGINAL });
  });

  it("Save that can't upload keeps the match here (the reader's next open sends it)", async () => {
    const f = fake();
    f.data.set(7, { id: 7, title: BOOK.title, elementHtml: ORIGINAL, lastBookModified: 1 });
    const match = await runMatch(f.deps, 7, lines, new AbortController().signal, () => {});
    f.set.failUpload(true);
    expect(await saveMatch(f.deps, BOOK, match)).toBe('pending');
    expect(f.data.get(7)?.elementHtml).toBe(NOW);
  });

  it('Reset restores a matched copy here and removes the match on every device', async () => {
    const f = fake();
    f.data.set(7, {
      id: 7,
      title: BOOK.title,
      elementHtml: MATCHED,
      htmlBackup: ORIGINAL,
      lastBookModified: 2
    });
    await resetBookMatch(f.deps, BOOK);
    expect(f.data.get(7)).toMatchObject({ elementHtml: ORIGINAL });
    expect(f.data.get(7)).not.toHaveProperty('htmlBackup');
    expect(f.calls).toEqual([`remove ${ATTACHMENT_KIND} ${attachmentId(BOOK.bookId, MATCH)}`]);
  });

  it('Reset without a matched copy here only removes the shared match', async () => {
    const f = fake();
    await resetBookMatch(f.deps, { ...BOOK, localId: null });
    f.data.set(7, { id: 7, title: BOOK.title, elementHtml: ORIGINAL, lastBookModified: 1 });
    await resetBookMatch(f.deps, BOOK);
    expect(f.data.get(7)).toEqual({
      id: 7,
      title: BOOK.title,
      elementHtml: ORIGINAL,
      lastBookModified: 1
    });
    expect(f.calls).toHaveLength(2);
  });

  it('the state is the live record on the server', async () => {
    const f = fake();
    expect(await hasLiveMatch(f.deps.engine, BOOK.bookId)).toBe(false);
    f.records.set(`${ATTACHMENT_KIND}|${attachmentId(BOOK.bookId, MATCH)}`, {
      kind: ATTACHMENT_KIND,
      id: attachmentId(BOOK.bookId, MATCH),
      bookId: BOOK.bookId,
      deviceId: 'x',
      updatedAt: 1,
      deletedAt: null,
      rev: 1,
      data: { modifiedAt: 1 }
    });
    expect(await hasLiveMatch(f.deps.engine, BOOK.bookId)).toBe(true);
    await resetBookMatch(f.deps, { ...BOOK, localId: null });
    expect(await hasLiveMatch(f.deps.engine, BOOK.bookId)).toBe(false);
  });
});

describe('words', () => {
  it("shows whispersync's figures with thousands separators", () => {
    expect(figureText('12418 / 12552 (98.93%)')).toBe('12,418 / 12,552 (98.93%)');
    expect(figureText('55 / 12418 (0.44%)')).toBe('55 / 12,418 (0.44%)');
  });

  it('estimates the time left once it can tell', () => {
    expect(timeLeftText(1000, 50)).toBe('');
    expect(timeLeftText(10_000, 0)).toBe('');
    expect(timeLeftText(10_000, 50)).toBe('about 10 s left');
    expect(timeLeftText(10_000, 95)).toBe('a few seconds left');
    expect(timeLeftText(60_000, 25)).toBe('about 3 min left');
  });
});
