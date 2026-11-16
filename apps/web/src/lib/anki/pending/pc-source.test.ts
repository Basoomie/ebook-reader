/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { SentenceClip, SentencePc } from '$lib/audio/tts-types';
import { LibraryApiError } from '$lib/library/api';
import { AnkiConnect, type NoteInfo } from '../anki-connect';
import {
  pcClipFileName,
  pcVoiceChosen,
  pcWaitText,
  resolvePcClip,
  tooLong,
  WAITING_FOR_PC,
  type PcSourceDeps
} from './pc-source';
import { pendingStatus, type PcClipSource, type PendingClip } from './pending-clip';
import { createPendingDb, PendingStore } from './pending-db';
import { RetryLater, runPendingOnce } from './pending-runner';

/** Season 2 Phase 12: a waiting clip the PC reads for a book without an audiobook. */

let dbCount = 0;
const freshStore = () => {
  dbCount += 1;
  const name = `ttsu-anki-pending-pc-test-${dbCount}`;
  return new PendingStore(() => createPendingDb(name));
};

const CLIP_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const NOW = 10_000_000;

const source = (over: Partial<PcClipSource> = {}): PcClipSource => ({
  kind: 'pc',
  text: '猫が好きだ。',
  position: 42,
  bookCharacters: 1000,
  maxSeconds: 30,
  pauses: { sentenceMs: 300, paragraphMs: 700, chapterMs: 2000 },
  ...over
});

const record = (over: Partial<PcClipSource> = {}): PendingClip & { source: PcClipSource } => ({
  id: 'c1',
  createdAt: 1000,
  state: 'waiting',
  noteId: 300,
  noteType: 'JP Mining Note',
  word: '猫',
  field: 'SentenceAudio',
  mode: 'fill-if-empty',
  fieldAtTap: '',
  bookId: 'book-0001-abcd',
  localId: 7,
  localTitle: '猫の本',
  bookTitle: '猫の本',
  source: source(over)
});

const pc = (over: Partial<SentencePc> = {}): SentencePc => ({
  online: true,
  lastSeenAt: NOW - 5000,
  paused: false,
  problem: null,
  readsClips: true,
  ahead: null,
  ...over
});

const serverClip = (over: Partial<SentenceClip> = {}): SentenceClip => ({
  id: CLIP_ID,
  bookId: 'book-0001-abcd',
  state: 'queued',
  durationMs: null,
  bytes: null,
  error: null,
  found: true,
  createdAt: 1,
  doneAt: null,
  ...over
});

const apiError = (status: number, code: string, message = code) =>
  new LibraryApiError('server', message, status, code);

const MP3 = new Uint8Array([73, 68, 51]).buffer;

/** A stand-in server: what it answers, and what it was asked. */
function fakeServer(start: { clip?: SentenceClip; pc?: SentencePc } = {}) {
  const asked: string[] = [];
  const state = {
    clip: start.clip ?? serverClip(),
    pc: start.pc ?? pc(),
    queueError: null as LibraryApiError | null,
    statusError: null as LibraryApiError | null,
    fileError: null as LibraryApiError | null,
    queued: [] as unknown[]
  };
  const api: PcSourceDeps['api'] = {
    async queueSentenceAudio(bookId, body) {
      asked.push(`queue ${bookId}`);
      state.queued.push(body);
      if (state.queueError) throw state.queueError;
      return state.clip;
    },
    async sentenceAudioStatus(id) {
      asked.push(`status ${id}`);
      if (state.statusError) {
        const e = state.statusError;
        state.statusError = null;
        throw e;
      }
      return { clip: state.clip, pc: state.pc };
    },
    async sentenceAudioFile(id) {
      asked.push(`file ${id}`);
      if (state.fileError) throw state.fileError;
      return MP3.slice(0);
    },
    async dropSentenceAudio(id) {
      asked.push(`drop ${id}`);
    }
  };
  return { api, asked, state };
}

function deps(api: PcSourceDeps['api'], saved: unknown[] = []): PcSourceDeps {
  return { api, saveSource: async (s) => void saved.push(s), now: () => NOW };
}

describe('what a PC clip waits for (Settings > Anki)', () => {
  it('says why, from what the server last heard from the PC', () => {
    const q = { state: 'queued' as const };
    expect(pcWaitText({ state: 'running' }, pc(), NOW)).toBe('the PC is reading it');
    expect(pcWaitText(q, pc({ paused: true }), NOW)).toBe(
      'the PC is paused (Settings > Audiobooks)'
    );
    expect(pcWaitText(q, pc({ online: false, lastSeenAt: NOW - 3 * 3600_000 }), NOW)).toBe(
      'the PC is off (last seen 3 h ago)'
    );
    expect(pcWaitText(q, pc({ online: false, lastSeenAt: null }), NOW)).toBe(
      "the program on the PC hasn't checked in yet"
    );
    expect(pcWaitText(q, pc({ problem: 'Docker Desktop is not running on the PC' }), NOW)).toBe(
      "the PC can't read it now: Docker Desktop is not running on the PC"
    );
    expect(pcWaitText(q, pc({ readsClips: false }), NOW)).toMatch(/update it \(install-local\)/);
    expect(
      pcWaitText(
        q,
        pc({ ahead: { kind: 'generate_audiobook', bookTitle: '羊', makesWay: true } }),
        NOW
      )
    ).toBe("queued: the PC finishes a chapter of 「羊」's audiobook first");
    expect(
      pcWaitText(
        q,
        pc({ ahead: { kind: 'sync_subtitles', bookTitle: '羊', makesWay: false } }),
        NOW
      )
    ).toBe('queued: the PC makes subtitles for 「羊」 first');
    expect(pcWaitText(q, pc(), NOW)).toBe('queued on the PC');
  });

  it('shows "Waiting for the PC" for a PC clip, as the last try found it', () => {
    expect(pendingStatus(record())).toBe(WAITING_FOR_PC);
    expect(pendingStatus({ ...record(), waitingFor: 'Waiting for the library server' })).toBe(
      'Waiting for the library server'
    );
  });

  it('names the media file after the book and the server clip', () => {
    expect(pcClipFileName('book-0001-abcd', CLIP_ID)).toBe('ttsu-book0001-tts-a1b2c3d4e5f6.mp3');
  });
});

describe('asking the server about a PC clip', () => {
  it('asks the PC to read it once, keeps the clip id, then waits with the reason', async () => {
    const { api, asked, state } = fakeServer();
    const saved: unknown[] = [];
    const error = await resolvePcClip(record(), deps(api, saved)).catch((e) => e);
    expect(error).toBeInstanceOf(RetryLater);
    expect(error).toMatchObject({ message: 'queued on the PC', waitingFor: WAITING_FOR_PC });
    expect((error as RetryLater).sourceDown).toBe(false);
    expect(state.queued).toEqual([
      {
        text: '猫が好きだ。',
        position: 42,
        pauses: { sentenceMs: 300, paragraphMs: 700, chapterMs: 2000 }
      }
    ]);
    expect(saved).toEqual([{ ...source(), clipId: CLIP_ID }]);
    // Next time: only how it is doing.
    asked.length = 0;
    await resolvePcClip(record({ clipId: CLIP_ID }), deps(api)).catch(() => undefined);
    expect(asked).toEqual([`status ${CLIP_ID}`]);
  });

  it('fetches a finished clip', async () => {
    const { api, asked } = fakeServer({ clip: serverClip({ state: 'done', durationMs: 2500 }) });
    const made = await resolvePcClip(record({ clipId: CLIP_ID }), deps(api));
    expect(made).toEqual({ fileName: 'ttsu-book0001-tts-a1b2c3d4e5f6.mp3', data: MP3 });
    expect(asked).toEqual([`status ${CLIP_ID}`, `file ${CLIP_ID}`]);
  });

  it('leaves out a clip longer than "Longest sentence audio" at the tap', async () => {
    const { api, asked } = fakeServer({ clip: serverClip({ state: 'done', durationMs: 31_000 }) });
    expect(await resolvePcClip(record({ clipId: CLIP_ID }), deps(api))).toEqual({
      skip: tooLong(30)
    });
    expect(asked).toEqual([`status ${CLIP_ID}`, `drop ${CLIP_ID}`]);
  });

  it("says why when the PC couldn't read it", async () => {
    const failed = fakeServer({
      clip: serverClip({ state: 'failed', error: 'CUDA out of memory' })
    });
    expect(await resolvePcClip(record({ clipId: CLIP_ID }), deps(failed.api))).toEqual({
      skip: 'CUDA out of memory'
    });
  });

  it('asks again when the server forgot the clip (kept too long)', async () => {
    const { api, asked, state } = fakeServer();
    state.statusError = apiError(404, 'not_found');
    const saved: unknown[] = [];
    await resolvePcClip(record({ clipId: 'old' }), deps(api, saved)).catch(() => undefined);
    expect(asked).toEqual(['status old', 'queue book-0001-abcd', `status ${CLIP_ID}`]);
    expect(saved).toEqual([source(), { ...source(), clipId: CLIP_ID }]);
  });

  it('a book that got an audiobook meanwhile: the clip comes from it', async () => {
    const { api, state } = fakeServer();
    state.queueError = apiError(409, 'has_audiobook');
    const saved: unknown[] = [];
    const made = await resolvePcClip(record(), deps(api, saved));
    const library = {
      kind: 'library',
      text: '猫が好きだ。',
      position: 42,
      cueIds: [],
      bookCharacters: 1000
    };
    expect(made).toEqual({ library });
    expect(saved).toEqual([library]);
  });

  it('switched off or the voice gone: waits until it is put right', async () => {
    const { api, state } = fakeServer();
    state.queueError = apiError(
      409,
      'voice_choice_off',
      'Sentence audio from the PC is off: choose a voice in Settings > Anki'
    );
    const error = await resolvePcClip(record(), deps(api)).catch((e) => e);
    expect(error).toBeInstanceOf(RetryLater);
    expect(error.message).toBe(
      'Sentence audio from the PC is off: choose a voice in Settings > Anki'
    );
    state.queueError = apiError(400, 'too_long', 'the sentence is longer than 500 characters');
    expect(await resolvePcClip(record(), deps(api)).catch((e) => e)).toBe(state.queueError);
  });

  it("whether a voice is chosen for the book (null: the server can't)", async () => {
    const answer = (effective: unknown) => ({
      bookVoiceChoice: async () => ({ book: null, global: null, effective }) as never
    });
    expect(await pcVoiceChosen(answer({ voiceId: 'v' }), 'b')).toBe(true);
    expect(await pcVoiceChosen(answer(null), 'b')).toBe(false);
    const old = {
      bookVoiceChoice: async () => {
        throw apiError(404, 'not_found');
      }
    };
    expect(await pcVoiceChosen(old, 'b')).toBeNull();
    const down = {
      bookVoiceChoice: async () => {
        throw new LibraryApiError('unreachable', 'down');
      }
    };
    await expect(pcVoiceChosen(down, 'b')).rejects.toThrow('down');
  });
});

describe('a PC clip through the waiting-clip runner', () => {
  function note(value: string): NoteInfo {
    return {
      noteId: 300,
      modelName: 'JP Mining Note',
      tags: [],
      fields: { Key: { value: '猫', order: 0 }, SentenceAudio: { value, order: 1 } }
    };
  }

  function fakeAnki(n: NoteInfo) {
    const actions: string[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { action: string; params?: never };
      actions.push(body.action);
      const ok = (result: unknown) => new Response(JSON.stringify({ result, error: null }));
      switch (body.action) {
        case 'requestPermission':
          return ok({ permission: 'granted' });
        case 'notesInfo':
          return ok([n]);
        case 'storeMediaFile':
          return ok((body.params as unknown as { filename: string }).filename);
        case 'updateNoteFields': {
          const fields = (body.params as unknown as { note: { fields: Record<string, string> } })
            .note.fields;
          for (const [k, v] of Object.entries(fields)) n.fields[k].value = v;
          return ok(null);
        }
        default:
          return ok([]);
      }
    };
    return {
      actions,
      anki: () => new AnkiConnect({ url: 'http://anki.test:8765', timeoutSeconds: 5, fetchImpl })
    };
  }

  it('waits for the PC, then lands in the card, and the server lets go of it', async () => {
    const store = freshStore();
    await store.add(record());
    const server = fakeServer({ pc: pc({ online: false, lastSeenAt: NOW - 60_000 }) });
    const n = note('');
    const { anki, actions } = fakeAnki(n);
    const run = () =>
      runPendingOnce({
        store,
        resolve: async (c) => {
          const made = await resolvePcClip(c as PendingClip & { source: PcClipSource }, {
            api: server.api,
            saveSource: async (s) => void (await store.update(c.id, (r) => ({ ...r, source: s }))),
            now: () => NOW
          });
          if ('library' in made) throw new Error('not here');
          return made;
        },
        anki,
        tabId: 't',
        now: () => NOW,
        onReady: async (c) => {
          if (c.source.kind === 'pc' && c.source.clipId) {
            await server.api.dropSentenceAudio(c.source.clipId);
          }
        }
      });

    // The PC is off.
    expect(await run()).toEqual({ added: 0, failed: 0, waiting: 1 });
    const waiting = await store.get('c1');
    expect(waiting).toMatchObject({
      state: 'waiting',
      problem: 'the PC is off (last seen 1 min ago)',
      waitingFor: WAITING_FOR_PC,
      source: { kind: 'pc', clipId: CLIP_ID }
    });
    expect(pendingStatus(waiting!)).toBe(WAITING_FOR_PC);
    expect(actions).toEqual([]);

    // Switched on and read.
    server.state.pc = pc();
    server.state.clip = serverClip({ state: 'done', durationMs: 2000 });
    expect(await run()).toEqual({ added: 1, failed: 0, waiting: 0 });
    expect(n.fields.SentenceAudio.value).toBe('[sound:ttsu-book0001-tts-a1b2c3d4e5f6.mp3]');
    expect(server.asked.filter((a) => a.startsWith('drop'))).toEqual([`drop ${CLIP_ID}`]);
    expect(await store.all()).toEqual([]);
  });
});
