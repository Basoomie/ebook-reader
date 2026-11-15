/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { AnkiConnect, type NoteInfo } from '../anki-connect';
import {
  decideClip,
  FIELD_CHANGED,
  FIELD_FILLED,
  newPendingId,
  pendingStatus,
  supersededBy,
  workOrder,
  type PendingClip
} from './pending-clip';
import { createPendingDb, PendingStore } from './pending-db';
import { CARD_DELETED, RetryLater, runPendingOnce, type MadeClip } from './pending-runner';

// ---------------------------------------------------------------- helpers

let dbCount = 0;

function freshStore(): PendingStore {
  dbCount += 1;
  const name = `ttsu-anki-pending-test-${dbCount}`;
  return new PendingStore(() => createPendingDb(name));
}

function clip(over: Partial<PendingClip> = {}): PendingClip {
  return {
    id: 'c1',
    createdAt: 1000,
    state: 'waiting',
    noteId: 300,
    noteType: 'JP Mining Note',
    word: '猫',
    field: 'SentenceAudio',
    mode: 'fill-if-empty',
    fieldAtTap: '',
    bookId: 'b1',
    localId: 7,
    localTitle: '猫の本',
    bookTitle: '猫の本',
    source: {
      kind: 'library',
      text: '猫が好きだ。',
      position: 42,
      cueIds: [],
      bookCharacters: 1000
    },
    ...over
  };
}

function note(fields: Record<string, string>, id = 300): NoteInfo {
  return {
    noteId: id,
    modelName: 'JP Mining Note',
    tags: [],
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v], order) => [k, { value: v, order }])
    )
  };
}

interface Call {
  action: string;
  params?: Record<string, unknown>;
}

function fakeAnki({
  notes = [] as NoteInfo[],
  android = false,
  down = false
}: { notes?: NoteInfo[]; android?: boolean; down?: boolean } = {}) {
  const calls: Call[] = [];
  const state = { down };
  let stores = 0;
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    if (state.down) throw new TypeError('Failed to fetch');
    const body = JSON.parse(String(init?.body)) as Call;
    calls.push(body);
    const ok = (result: unknown) => new Response(JSON.stringify({ result, error: null }));
    const err = (error: string) => new Response(JSON.stringify({ result: null, error }));

    switch (body.action) {
      case 'requestPermission':
        return android
          ? err('com.google.gson.stream.MalformedJsonException: bad')
          : ok({ permission: 'granted' });
      case 'notesInfo': {
        const ids = body.params!.notes as number[];
        const found = notes.filter((n) => ids.includes(n.noteId));
        // Desktop answers [{}] for a note that is gone; Android an empty list.
        return ok(found.length ? found : android ? [] : [{}]);
      }
      case 'storeMediaFile': {
        stores += 1;
        const asked = body.params!.filename as string;
        const dot = asked.indexOf('.');
        return ok(
          android ? `${asked.slice(0, dot)}_4815162342${stores}${asked.slice(dot)}` : asked
        );
      }
      case 'updateNoteFields': {
        const n = body.params!.note as { id: number; fields: Record<string, string> };
        const target = notes.find((x) => x.noteId === n.id);
        if (!target) return err('note was not found');
        for (const [k, v] of Object.entries(n.fields)) target.fields[k].value = v;
        return ok(null);
      }
      case 'guiSelectedNotes':
        return ok([]);
      default:
        return err(`unknown action ${body.action}`);
    }
  };
  const anki = () =>
    new AnkiConnect({ url: 'http://anki.test:8765', timeoutSeconds: 5, fetchImpl });
  return { anki, calls, state };
}

const MP3 = new Uint8Array([73, 68, 51]).buffer; // "ID3"

function made(fileName = 'ttsu-b1-2000-6000.mp3'): MadeClip {
  return { fileName, data: MP3.slice(0) };
}

const actions = (calls: Call[]) => calls.map((c) => c.action);

// ---------------------------------------------------------------- the decision

describe('the field mode applied when the clip arrives', () => {
  const name = 'ttsu-b1-2000-6000.mp3';
  const write = (d: ReturnType<typeof decideClip>, stored = name) =>
    d.kind === 'write' ? d.value(stored) : d;

  it('fill if empty: only into an empty field', () => {
    const target = { mode: 'fill-if-empty' as const, fieldAtTap: '' };
    expect(write(decideClip(target, '', name))).toBe(`[sound:${name}]`);
    expect(write(decideClip(target, '<br>', name))).toBe(`[sound:${name}]`);
    expect(decideClip(target, '[sound:mine.mp3]', name)).toEqual({
      kind: 'fail',
      reason: FIELD_FILLED
    });
  });

  it('add to the end: after what the field has', () => {
    const target = { mode: 'append' as const, fieldAtTap: '' };
    expect(write(decideClip(target, '[sound:old.mp3]', name))).toBe(
      `[sound:old.mp3]<br>[sound:${name}]`
    );
    expect(write(decideClip(target, '', name), 'renamed_1.mp3')).toBe('[sound:renamed_1.mp3]');
  });

  it('overwrite: only while the field holds what the tap left', () => {
    const target = { mode: 'overwrite' as const, fieldAtTap: '[sound:yomitan.mp3]' };
    expect(write(decideClip(target, '[sound:yomitan.mp3]', name))).toBe(`[sound:${name}]`);
    expect(decideClip(target, '[sound:edited.mp3]', name)).toEqual({
      kind: 'fail',
      reason: FIELD_CHANGED
    });
  });

  it('overwrite of a shared field puts the clip between the other roles', () => {
    const target = {
      mode: 'overwrite' as const,
      fieldAtTap: 'S<br>L',
      shared: { before: ['S'], after: ['L'] }
    };
    expect(write(decideClip(target, 'S<br>L', name))).toBe(`S<br>[sound:${name}]<br>L`);
  });

  it('a field that already plays the clip (also as the Android copy) needs nothing', () => {
    for (const mode of ['fill-if-empty', 'append', 'overwrite'] as const) {
      expect(decideClip({ mode, fieldAtTap: '' }, `[sound:${name}]`, name)).toEqual({
        kind: 'already'
      });
      expect(
        decideClip({ mode, fieldAtTap: '' }, 'x [sound:ttsu-b1-2000-6000_123.mp3]', name)
      ).toEqual({ kind: 'already' });
    }
  });
});

describe('waiting clips: order, newer taps, status', () => {
  it('works oldest first and leaves failed ones', () => {
    const list = [
      clip({ id: 'b', createdAt: 3 }),
      clip({ id: 'a', createdAt: 1 }),
      clip({ id: 'f', createdAt: 0, state: 'failed' })
    ];
    expect(workOrder(list).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('a newer Overwrite tap drops older clips for the same card and field only', () => {
    const list = [
      clip({ id: 'o', mode: 'overwrite' }),
      clip({ id: 'a', mode: 'append' }),
      clip({ id: 'other', mode: 'overwrite', noteId: 1 }),
      clip({ id: 'f', mode: 'overwrite', state: 'failed' })
    ];
    expect(supersededBy(list, 300, 'SentenceAudio').map((c) => c.id)).toEqual(['o']);
    expect(supersededBy(list, 300, 'SentenceAudio', 'o')).toEqual([]);
  });

  it('says what it waits for', () => {
    expect(pendingStatus(clip())).toBe('Waiting for the library server');
    expect(pendingStatus(clip({ state: 'ready' }))).toBe('Waiting for Anki');
    expect(pendingStatus(clip({ state: 'failed', failedReason: CARD_DELETED }))).toBe(
      "Couldn't add: the card was deleted."
    );
  });

  it('makes ids without crypto.randomUUID', () => {
    expect(newPendingId(1000, () => 0.5)).toBe(
      `${(1000).toString(36)}-${(2147483647).toString(36)}`
    );
    expect(newPendingId(1000)).not.toBe(newPendingId(1000));
  });
});

// ---------------------------------------------------------------- the store

describe('the waiting-clip store', () => {
  it("tells the app's other tabs about a change", async () => {
    dbCount += 1;
    const name = `ttsu-anki-pending-test-${dbCount}`;
    const tab1 = new PendingStore(() => createPendingDb(name), name);
    const tab2 = new PendingStore(() => createPendingDb(name), name);
    let seen = 0;
    tab2.onChange(() => (seen += 1));
    await tab1.add(clip());
    await tab1.delete('c1');

    await expect.poll(() => seen).toBe(2);
  });

  it('lets one tab take a clip at a time; an old claim runs out', async () => {
    const store = freshStore();
    await store.add(clip());

    expect(await store.claim('c1', 'tab-a', 100, 200)).toBe(true);
    expect(await store.claim('c1', 'tab-b', 150, 250)).toBe(false);
    expect(await store.claim('c1', 'tab-b', 200, 300)).toBe(true);
    await store.release('c1', 'tab-b');
    expect((await store.get('c1'))?.claim).toBeUndefined();
    expect(await store.claim('missing', 'tab-a', 0, 1)).toBe(false);
  });

  it('never brings back a cancelled clip', async () => {
    const store = freshStore();
    await store.add(clip());
    await store.delete('c1');

    expect(await store.update('c1', (c) => ({ ...c, state: 'ready' }))).toBeUndefined();
    expect(await store.all()).toEqual([]);
  });

  it('keeps the clip bytes and tells listeners about changes', async () => {
    const store = freshStore();
    let changes = 0;
    store.onChange(() => (changes += 1));
    await store.add(clip());
    await store.update('c1', (c) => ({
      ...c,
      state: 'ready',
      clip: { fileName: 'x.mp3', data: MP3 }
    }));

    const kept = await store.get('c1');
    expect(new Uint8Array(kept!.clip!.data)).toEqual(new Uint8Array(MP3));
    expect(changes).toBe(2);
  });
});

// ---------------------------------------------------------------- the runner

describe('trying waiting clips again', () => {
  const run = (
    store: PendingStore,
    anki: () => AnkiConnect,
    resolve: (c: PendingClip) => Promise<MadeClip>,
    tabId = 'tab'
  ) => runPendingOnce({ store, anki, resolve, tabId, now: () => 5000 });

  it('server still down: stays waiting with the reason, and the other clips are not asked', async () => {
    const store = freshStore();
    await store.add(clip({ id: 'a', createdAt: 1 }));
    await store.add(clip({ id: 'b', createdAt: 2 }));
    const { anki, calls } = fakeAnki();
    let asked = 0;
    const report = await run(store, anki, async () => {
      asked += 1;
      throw new RetryLater("the library server can't be reached", true);
    });

    expect(asked).toBe(1);
    expect(report).toEqual({ added: 0, failed: 0, waiting: 2 });
    expect((await store.get('a'))?.problem).toBe("the library server can't be reached");
    expect((await store.get('a'))?.state).toBe('waiting');
    expect((await store.get('a'))?.claim).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('server back: the clip is cut, stored and written, and the record goes', async () => {
    const store = freshStore();
    await store.add(clip());
    const n = note({ Key: '猫', SentenceAudio: '' });
    const { anki, calls } = fakeAnki({ notes: [n] });
    const report = await run(store, anki, async () => made());

    expect(report).toEqual({ added: 1, failed: 0, waiting: 0 });
    expect(n.fields.SentenceAudio.value).toBe('[sound:ttsu-b1-2000-6000.mp3]');
    expect(calls.find((c) => c.action === 'storeMediaFile')?.params).toEqual({
      filename: 'ttsu-b1-2000-6000.mp3',
      data: 'SUQz'
    });
    expect(await store.all()).toEqual([]);
  });

  it('AnkiConnect Android: the field names the copy it stored', async () => {
    const store = freshStore();
    await store.add(clip());
    const n = note({ Key: '猫', SentenceAudio: '' });
    const { anki, calls } = fakeAnki({ notes: [n], android: true });
    await run(store, anki, async () => made());

    expect(n.fields.SentenceAudio.value).toBe('[sound:ttsu-b1-2000-6000_48151623421.mp3]');
    expect(actions(calls)).not.toContain('guiSelectedNotes');
  });

  it('Anki closed: the made clip waits for Anki and is not cut again', async () => {
    const store = freshStore();
    await store.add(clip());
    const n = note({ Key: '猫', SentenceAudio: '' });
    const fake = fakeAnki({ notes: [n], down: true });
    let cuts = 0;
    const resolve = async () => {
      cuts += 1;
      return made();
    };

    expect(await run(store, fake.anki, resolve)).toEqual({ added: 0, failed: 0, waiting: 1 });
    const ready = await store.get('c1');
    expect(ready?.state).toBe('ready');
    expect(ready?.problem).toContain("Anki didn't answer");

    fake.state.down = false;
    expect(await run(store, fake.anki, resolve)).toEqual({ added: 1, failed: 0, waiting: 0 });
    expect(cuts).toBe(1);
    expect(n.fields.SentenceAudio.value).toBe('[sound:ttsu-b1-2000-6000.mp3]');
  });

  it('a deleted card: failed with the reason (desktop and Android answers)', async () => {
    for (const android of [false, true]) {
      const store = freshStore();
      await store.add(clip());
      const { anki, calls } = fakeAnki({ notes: [], android });
      expect(await run(store, anki, async () => made())).toEqual({
        added: 0,
        failed: 1,
        waiting: 0
      });
      expect(await store.get('c1')).toMatchObject({ state: 'failed', failedReason: CARD_DELETED });
      expect(actions(calls)).not.toContain('storeMediaFile');
    }
  });

  it('a clip that can’t be made: failed with the reason; failed ones are not tried again', async () => {
    const store = freshStore();
    await store.add(clip());
    const { anki } = fakeAnki();
    let asked = 0;
    const resolve = async () => {
      asked += 1;
      return { skip: "the sentence wasn't found in the subtitles" };
    };
    await run(store, anki, resolve);
    await run(store, anki, resolve);

    expect(asked).toBe(1);
    expect(await store.get('c1')).toMatchObject({
      state: 'failed',
      failedReason: "the sentence wasn't found in the subtitles"
    });
  });

  it('overwrite: replaces an unchanged field, leaves a changed one', async () => {
    const store = freshStore();
    await store.add(clip({ id: 'same', mode: 'overwrite', fieldAtTap: '[sound:y.mp3]' }));
    await store.add(
      clip({
        id: 'edited',
        createdAt: 2,
        noteId: 301,
        mode: 'overwrite',
        fieldAtTap: '[sound:y.mp3]'
      })
    );
    const same = note({ Key: '猫', SentenceAudio: '[sound:y.mp3]' });
    const edited = note({ Key: '犬', SentenceAudio: '[sound:mine.mp3]' }, 301);
    const { anki } = fakeAnki({ notes: [same, edited] });
    const report = await run(store, anki, async () => made());

    expect(report).toEqual({ added: 1, failed: 1, waiting: 0 });
    expect(same.fields.SentenceAudio.value).toBe('[sound:ttsu-b1-2000-6000.mp3]');
    expect(edited.fields.SentenceAudio.value).toBe('[sound:mine.mp3]');
    expect(await store.get('edited')).toMatchObject({ failedReason: FIELD_CHANGED });
  });

  it('fill if empty into a field filled meanwhile: not added, with the reason', async () => {
    const store = freshStore();
    await store.add(clip());
    const n = note({ Key: '猫', SentenceAudio: '[sound:mine.mp3]' });
    const { anki, calls } = fakeAnki({ notes: [n] });
    await run(store, anki, async () => made());

    expect(n.fields.SentenceAudio.value).toBe('[sound:mine.mp3]');
    expect(await store.get('c1')).toMatchObject({ failedReason: FIELD_FILLED });
    expect(actions(calls)).not.toContain('updateNoteFields');
  });

  it('a field that already plays the clip: done without writing', async () => {
    const store = freshStore();
    await store.add(clip({ mode: 'append' }));
    const n = note({ Key: '猫', SentenceAudio: '[sound:ttsu-b1-2000-6000_99.mp3]' });
    const { anki, calls } = fakeAnki({ notes: [n] });

    expect(await run(store, anki, async () => made())).toEqual({ added: 1, failed: 0, waiting: 0 });
    expect(actions(calls)).not.toContain('storeMediaFile');
    expect(actions(calls)).not.toContain('updateNoteFields');
    expect(await store.all()).toEqual([]);
  });

  it('add to the end: two clips for one card land oldest first', async () => {
    const store = freshStore();
    await store.add(clip({ id: 'new', createdAt: 2, mode: 'append' }));
    await store.add(clip({ id: 'old', createdAt: 1, mode: 'append' }));
    const n = note({ Key: '猫', SentenceAudio: '' });
    const { anki } = fakeAnki({ notes: [n] });
    await run(store, anki, async (c) =>
      made(c.id === 'old' ? 'ttsu-b1-1000-2000.mp3' : 'ttsu-b1-3000-4000.mp3')
    );

    expect(n.fields.SentenceAudio.value).toBe(
      '[sound:ttsu-b1-1000-2000.mp3]<br>[sound:ttsu-b1-3000-4000.mp3]'
    );
  });

  it('two tabs at once write the clip once', async () => {
    const store = freshStore();
    await store.add(clip({ mode: 'append' }));
    const n = note({ Key: '猫', SentenceAudio: '' });
    const { anki, calls } = fakeAnki({ notes: [n] });
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return made();
    };
    await Promise.all([run(store, anki, slow, 'tab-a'), run(store, anki, slow, 'tab-b')]);

    expect(actions(calls).filter((a) => a === 'updateNoteFields')).toHaveLength(1);
    expect(n.fields.SentenceAudio.value).toBe('[sound:ttsu-b1-2000-6000.mp3]');
  });

  it('cancelled while its clip is being made: nothing is written or kept', async () => {
    const store = freshStore();
    await store.add(clip());
    const n = note({ Key: '猫', SentenceAudio: '' });
    const { anki, calls } = fakeAnki({ notes: [n] });
    await run(store, anki, async () => {
      await store.delete('c1');
      return made();
    });

    expect(await store.all()).toEqual([]);
    expect(actions(calls)).toEqual([]);
    expect(n.fields.SentenceAudio.value).toBe('');
  });

  it('an error that isn’t a known problem still keeps the clip', async () => {
    const store = freshStore();
    await store.add(clip());
    const { anki } = fakeAnki();
    await run(store, anki, async () => {
      throw new Error('surprise');
    });

    expect(await store.get('c1')).toMatchObject({ state: 'waiting', problem: 'surprise' });
  });
});
