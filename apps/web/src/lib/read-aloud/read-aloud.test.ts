/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildBookTextIndex, parseBookHtml } from '$lib/components/book-reader/book-search';
import type { PacerChar } from '$lib/components/book-reader/pacer/pacer-text';
import { PacerText } from '$lib/components/book-reader/pacer/pacer-text';
import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
import type { ReadAloudPc, ReadAloudSession } from '$lib/audio/tts-types';
import { LibraryApiError } from '$lib/library/api';
import { installNodeDom } from '$lib/server/epub/node-dom';
import { countEpubFile } from '$lib/server/epub/count-epub-node';
import { followAction, indexOfPosition, readingPoint, sentenceSpan } from './follow';
import { lineAt, placeLines, type ReadAloudPlayer, type TimedLine } from './player';
import { countedLength, ReadAloudScript } from './script';
import { ReadAloudController, type ReadAloudHost, type ReadAloudView } from './session';
import { stepSpeed, usableSpeed } from './settings';
import { endedText, waitingText } from './text';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures'
);

let doc: Document;

beforeAll(() => {
  doc = installNodeDom();
});

describe('the script built on the device', () => {
  it("gives every sentence the reader's own positions on the fixture books", async () => {
    for (const book of [
      'synthetic-epub3.epub',
      'synthetic-epub2-ncx.epub',
      'synthetic-epub3-navonly.epub'
    ]) {
      const result = await countEpubFile(path.join(fixturesDir, book), {
        importHTMLFixMode: ImportHTMLFixMode.OFF,
        restrictImportFixToAnchor: true
      });
      // The reader's counted characters over the whole book, as the pacer and the reader count.
      const root = parseBookHtml(result.elementHtml);
      // A document of the same window (each import makes a new one in Node, and a gaiji is an
      // image of that window's own kind; in a browser every document shares the window).
      const script = ReadAloudScript.build(
        result.elementHtml,
        result.sections ?? [],
        result.characters,
        root.ownerDocument!
      );
      expect(script.lines.length, book).toBeGreaterThan(0);
      const text = new PacerText(root);
      const counted = text.chars(0, text.nodes.length, 0).filter((c) => c.counted);
      const shown = (c: PacerChar) =>
        c.gaiji ? '〓' : (c.node.textContent ?? '').slice(c.offset, c.offset + c.len);
      for (const line of script.lines) {
        // The characters the reader counts at [position, end) are the sentence's own.
        const own = counted.slice(line.position, line.end).map(shown).join('');
        const expected = [...line.text].filter((ch) => countedLength(ch) === 1).join('');
        expect(own, `${book}: ${line.text}`).toBe(expected);
      }
      // In order, and none past the book's end.
      for (let i = 1; i < script.lines.length; i++) {
        expect(script.lines[i].position).toBeGreaterThanOrEqual(script.lines[i - 1].end);
      }
      expect(script.lines[script.lines.length - 1].end).toBeLessThanOrEqual(text.total);
      expect(buildBookTextIndex(root).total).toBe(text.total);
    }
  });

  it('keeps the furigana runs and finds where to start', () => {
    const html =
      '<div id="a"><p>「<ruby>漢字<rt>かんじ</rt></ruby>を読む。」</p><p>次の文。三つ目！</p></div>';
    const script = ReadAloudScript.build(html, [], 0, doc);
    expect(script.lines.map((l) => [l.text, l.reading, l.position, l.end])).toEqual([
      ['「漢字を読む。」', '「かんじを読む。」', 0, 5],
      ['次の文。', '次の文。', 5, 8],
      ['三つ目！', '三つ目！', 8, 11]
    ]);
    expect(script.lines[0].ruby).toEqual([{ start: 1, end: 3, rt: 'かんじ' }]);
    expect(script.startAt(0)).toBe(0);
    expect(script.startAt(3)).toBe(0);
    expect(script.startAt(5)).toBe(1);
    expect(script.startAt(10)).toBe(2);
    expect(script.startAt(11)).toBe(-1);
    expect(countedLength('〓だ、ね。')).toBe(3);
  });

  it('keeps the dialogue runs the server reads with the dialogue voice (session 4)', () => {
    const html = '<div id="a"><p>「行こう」と彼は言った。</p><p>地の文。</p></div>';
    const script = ReadAloudScript.build(html, [], 0, doc);
    expect(script.lines[0].parts).toEqual([{ start: 0, end: 5, role: 'dialogue', quote: 0 }]);
    expect(script.lines[1].parts).toBeUndefined();
  });
});

describe('the player timeline', () => {
  it("scales a batch's cues into the length the buffer got", () => {
    const lines = placeLines(
      [7, 8],
      [
        [0, 1000],
        [1300, 2000]
      ],
      2300,
      10,
      12.3
    );
    expect(lines.map((l) => [l.line, +l.start.toFixed(3), +l.end.toFixed(3)])).toEqual([
      [7, 10, 11],
      [8, 11.3, 12]
    ]);
    // A slightly longer buffer (MP3 padding) stretches the times a little.
    const padded = placeLines([1], [[0, 1000]], 1000, 0, 1.05);
    expect(padded[0].end).toBeCloseTo(1.05);
  });

  it('finds the line playing (a pause after a sentence still belongs to it)', () => {
    const lines: TimedLine[] = [
      { line: 0, start: 0, end: 1 },
      { line: 1, start: 1.3, end: 2 }
    ];
    expect(lineAt(lines, 0)?.line).toBe(0);
    expect(lineAt(lines, 1.1)?.line).toBe(0);
    expect(lineAt(lines, 1.3)?.line).toBe(1);
    expect(lineAt(lines, 5)?.line).toBe(1);
    expect(lineAt([], 1)).toBeNull();
  });
});

describe('following the voice', () => {
  const chars = (from: number, n: number): PacerChar[] =>
    Array.from({ length: n }, (_, i) => ({
      node: {} as Node,
      offset: i,
      len: 1,
      gaiji: false,
      counted: true,
      start: from + i,
      end: from + i + 1,
      block: null
    }));

  it('does nothing while the reading point is on the screen, turns to the next, jumps elsewhere', () => {
    const snap = { chars: chars(100, 40), firstVisible: 0, lastVisible: 19 };
    expect(followAction(snap, 105)).toBe('none');
    expect(followAction(snap, 125)).toBe('next');
    expect(followAction(snap, 99)).toBe('jump');
    expect(followAction(snap, 200)).toBe('jump');
    expect(followAction({ ...snap, firstVisible: -1, lastVisible: -1 }, 105)).toBe('jump');
  });

  it("finds a sentence's characters and the point a share of the way into it", () => {
    const list = chars(10, 10);
    // An uncounted closing bracket shares the time of the character before it.
    list.splice(5, 0, { ...list[4], counted: false, offset: 99 });
    expect(indexOfPosition(list, 14)).toBe(4);
    expect(indexOfPosition(list, 15)).toBe(6);
    expect(indexOfPosition(list, 50)).toBe(-1);
    expect(sentenceSpan(list, { position: 12, end: 15 })).toEqual([2, 6]);
    expect(sentenceSpan(list, { position: 40, end: 45 })).toEqual([0, 0]);
    expect(readingPoint({ position: 100, end: 110 }, 0)).toBe(100);
    expect(readingPoint({ position: 100, end: 110 }, 0.55)).toBe(105);
    expect(readingPoint({ position: 100, end: 110 }, 1)).toBe(109);
  });
});

describe('texts and settings', () => {
  const pc = (over: Partial<ReadAloudPc>): ReadAloudPc => ({
    online: true,
    lastSeenAt: 1_000,
    paused: false,
    problem: null,
    version: '1.2.0',
    supportsLive: true,
    answering: true,
    lastAskedAt: 1_000,
    engine: { state: 'ready', source: 'a/b', revision: 'r', since: 0 },
    busy: null,
    ...over
  });

  it('says why read-aloud waits', () => {
    expect(waitingText(null)).toBe('Asking the library server…');
    expect(waitingText(pc({ lastSeenAt: null }))).toMatch(/hasn't checked in yet/);
    expect(waitingText(pc({ online: false }))).toMatch(/^The PC is off \(last seen .+\)/);
    expect(waitingText(pc({ paused: true }))).toBe('The PC is paused (Settings > Audiobooks).');
    expect(waitingText(pc({ supportsLive: false, version: '1.1.2' }))).toMatch(
      /needs an update.*1\.1\.2/
    );
    expect(
      waitingText(
        pc({ busy: { kind: 'sync_subtitles', bookTitle: '羊と鋼の森', yielding: false } })
      )
    ).toBe('The PC is making subtitles for 羊と鋼の森; read-aloud starts when that is done.');
    expect(
      waitingText(pc({ busy: { kind: 'generate_audiobook', bookTitle: 'X', yielding: true } }))
    ).toBe('The PC is stopping the audiobook for X; it goes on after read-aloud.');
    expect(
      waitingText(
        pc({ engine: { state: 'loading', source: 'a', revision: 'r', since: 0 } }),
        75_000
      )
    ).toBe('The PC is loading the voice (about 2 minutes) · 1:15');
    expect(waitingText(pc({ answering: false }))).toMatch(/^Waiting for the PC \(last answered/);
    expect(waitingText(pc({}))).toBe('The PC is reading…');
    expect(endedText('takeover')).toBe('Read-aloud moved to another device.');
    expect(endedText('stopped')).toBeNull();
  });

  it('steps the speed in tenths between 0.5 and 2', () => {
    expect(stepSpeed(1, 1)).toBe(1.1);
    expect(stepSpeed(2, 1)).toBe(2);
    expect(stepSpeed(0.5, -1)).toBe(0.5);
    expect(stepSpeed(1.3, -1)).toBe(1.2);
    expect(usableSpeed('x')).toBe(1);
    expect(usableSpeed(1.5)).toBe(1.5);
  });
});

// ---------------------------------------------------------------- the controller

/** A stand-in for the audio: lines play one second each, time moves by `advance`. */
class FakePlayer {
  segments: { seq: number; lines: TimedLine[] }[] = [];
  time = 0;
  paused = true;
  rate = 1;
  resets = 0;
  audio = { addEventListener: () => undefined };
  private end = 0;

  async append(seq: number, lines: number[], cues: number[][], durationMs: number) {
    const t0 = this.end;
    this.end += durationMs / 1000;
    this.segments.push({ seq, lines: placeLines(lines, cues, durationMs, t0, this.end) });
  }
  private all() {
    return this.segments.flatMap((s) => s.lines);
  }
  currentLine() {
    return lineAt(this.all(), this.time)?.line ?? null;
  }
  currentProgress() {
    return 0;
  }
  has(line: number) {
    return this.all().some((l) => l.line === line);
  }
  lastLine() {
    const a = this.all();
    return a.length ? a[a.length - 1].line : null;
  }
  aheadSeconds() {
    return Math.max(0, this.end - this.time);
  }
  atEnd() {
    return this.segments.length === 0 || this.time >= this.end - 0.05;
  }
  seekLine(line: number) {
    const hit = this.all().find((l) => l.line === line);
    if (!hit) return false;
    this.time = hit.start;
    return true;
  }
  async reset() {
    this.resets += 1;
    this.segments = [];
    this.time = this.end;
  }
  async play() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  destroy() {
    this.segments = [];
  }
}

const PC: ReadAloudPc = {
  online: true,
  lastSeenAt: Date.now(),
  paused: false,
  problem: null,
  version: '1.2.0',
  supportsLive: true,
  answering: true,
  lastAskedAt: Date.now(),
  engine: { state: 'ready', source: 'a/b', revision: 'r', since: 0 },
  busy: null
};

/** A stand-in for the server: batches are read when the test says so. */
class FakeApi {
  batches: { seq: number; lines: string[]; replace: boolean; state: string; error?: string }[] = [];
  /** What each batch sent (session 4: the dialogue runs go along). */
  sent: { text: string; parts?: unknown }[][] = [];
  polls: { after: number; playing: boolean }[] = [];
  stopped = 0;
  endWith: string | null = null;
  /** The voice a new session reads with (the server picks it when a session starts). */
  voice = 'Narrator';
  starts = 0;
  private sessionVoice = 'Narrator';
  private wake: (() => void) | null = null;

  async startReadAloud(): Promise<ReadAloudSession> {
    this.starts += 1;
    this.sessionVoice = this.voice;
    return this.view();
  }
  async readAloudBatch(
    _id: string,
    sentences: { text: string; parts?: unknown }[],
    replace: boolean
  ) {
    this.sent.push(sentences);
    if (replace) for (const b of this.batches) if (b.state === 'waiting') b.state = 'dropped';
    const seq = this.batches.length + 1;
    this.batches.push({ seq, lines: sentences.map((s) => s.text), replace, state: 'waiting' });
    return seq;
  }
  /** The PC reads every waiting batch (one second a sentence). */
  read(fail?: string) {
    for (const b of this.batches) {
      if (b.state !== 'waiting') continue;
      b.state = fail ? 'failed' : 'done';
      b.error = fail;
    }
    this.changed();
  }
  changed() {
    this.wake?.();
  }
  async readAloudPoll(
    _id: string,
    q: { after: number; playing: boolean },
    options: { signal?: AbortSignal } = {}
  ): Promise<ReadAloudSession> {
    this.polls.push({ after: q.after, playing: q.playing });
    if (this.endWith) {
      throw new LibraryApiError('server', 'ended', 410, 'ended', undefined, this.endWith);
    }
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        this.wake = null;
        resolve();
      };
      this.wake = done;
      setTimeout(done, 30);
      options.signal?.addEventListener('abort', () =>
        reject(new LibraryApiError('aborted', 'Cancelled'))
      );
    });
    return this.view(q.after);
  }
  async readAloudAudio() {
    return new ArrayBuffer(8);
  }
  async stopReadAloud() {
    this.stopped += 1;
  }
  private view(after = 0): ReadAloudSession {
    return {
      id: 'a'.repeat(32),
      bookId: 'book',
      state: 'open',
      ended: null,
      voice: { name: this.sessionVoice, model: 'v4.1 Small', from: 'global' },
      batches: this.batches
        .filter((b) => b.seq > after && b.state !== 'dropped')
        .map((b) => ({
          seq: b.seq,
          state: b.state as 'waiting' | 'done' | 'failed',
          durationMs: b.state === 'done' ? b.lines.length * 1000 : null,
          cues: b.state === 'done' ? b.lines.map((_, i) => [i * 1000, i * 1000 + 800]) : null,
          error: b.error ?? null
        })),
      pc: PC
    };
  }
}

const fakeWindow = {
  document: {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelectorAll: () => []
  },
  navigator: {}
} as unknown as Window;

function setup(lineCount = 20, extra: Partial<ReadAloudHost> = {}) {
  const html = `<div id="a">${Array.from({ length: lineCount }, (_, i) => `<p>文${'あ'.repeat(i % 3)}${i}です。</p>`).join('')}</div>`;
  const script = ReadAloudScript.build(html, [], 0, doc);
  const api = new FakeApi();
  const views: ReadAloudView[] = [];
  const lines: (number | null)[] = [];
  let player!: FakePlayer;
  const host: ReadAloudHost = {
    api: () => api as never,
    bookId: () => 'book',
    script: async () => script,
    pauses: () => ({ sentenceMs: 300, paragraphMs: 700, chapterMs: 0 }),
    speed: () => 1,
    aheadSeconds: () => 6,
    lookupResume: () => 0.05,
    screenPosition: () => 0,
    onLine: (line) => lines.push(line?.index ?? null),
    onView: (v) => views.push(v),
    media: () => null,
    warn: () => undefined,
    ...extra
  };
  const controller = new ReadAloudController(host, fakeWindow, () => {
    player = new FakePlayer();
    return player as unknown as ReadAloudPlayer;
  });
  controllers.push(controller);
  return {
    api,
    script,
    controller,
    views,
    lines,
    view: () => views[views.length - 1],
    player: () => player
  };
}

const controllers: ReadAloudController[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.destroy();
});

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('the read-aloud controller', () => {
  it('asks for 1, then 3, then 8 sentences, plays them in order and keeps the ahead time', async () => {
    const t = setup(30);
    await t.controller.play();
    await until(() => t.api.batches.length === 2);
    expect(t.api.batches.map((b) => b.lines.length)).toEqual([1, 3]);
    expect(t.api.batches[0]).toMatchObject({ replace: true, lines: ['文0です。'] });
    expect(t.view().phase).toBe('waiting');
    t.api.read();
    await until(() => t.player().segments.length === 2);
    // 4 s here, less than the 6 s ahead: two more batches of eight on their way (at most two).
    await until(() => t.api.batches.length === 4);
    expect(t.api.batches.slice(2).map((b) => [b.lines.length, b.lines[0]])).toEqual([
      [8, t.script.lines[4].text],
      [8, t.script.lines[12].text]
    ]);
    await until(() => t.view().phase === 'playing');
    expect(t.view().line).toBe(0);
    // Time moves on: the line follows.
    t.player().time = 2.1;
    await until(() => t.view().line === 2);
    expect(t.lines).toContain(2);
    // 20 s here: nothing more is asked for until less than 6 s is ahead.
    t.api.read();
    await until(() => t.player().segments.length === 4);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.api.batches).toHaveLength(4);
    // 5 s left: two more batches go out.
    t.player().time = 15;
    await until(() => t.api.batches.length === 6);
    expect(t.api.batches[4].lines[0]).toBe(t.script.lines[20].text);
    // The server lets go of what the device has.
    await until(() => t.api.polls.some((p) => p.after >= 4));
  });

  it('skips within the audio here, and asks again from a sentence beyond it', async () => {
    const t = setup();
    await t.controller.play();
    await until(() => t.api.batches.length === 2);
    t.api.read();
    await until(() => t.player().segments.length === 2);
    await t.controller.skip(1);
    expect(t.player().time).toBe(1);
    expect(t.player().resets).toBe(1); // the start
    await t.controller.readFrom(t.script.lines[15].position);
    expect(t.player().resets).toBe(2);
    await until(() =>
      t.api.batches.some((b) => b.replace && b.lines[0] === t.script.lines[15].text)
    );
  });

  it('waits at a failed batch and says why; Play reads from there again', async () => {
    const t = setup();
    await t.controller.play();
    await until(() => t.api.batches.length === 2);
    t.api.read('CUDA out of memory');
    await until(() => t.view().phase === 'error');
    expect(t.view().status).toBe(
      "The PC couldn't read this part: CUDA out of memory. Play tries again."
    );
    await t.controller.play();
    await until(() => t.api.batches.some((b) => b.seq > 2 && b.replace));
  });

  it('pauses for a lookup and goes on after the wait; tells the server it pauses', async () => {
    const t = setup();
    await t.controller.play();
    await until(() => t.api.batches.length === 2);
    t.api.read();
    await until(() => t.view().phase === 'playing');
    t.controller.lookup('start');
    expect(t.view()).toMatchObject({ phase: 'paused', pausedFor: 'lookup' });
    await until(() => t.api.polls.some((p) => !p.playing));
    t.controller.lookup('end');
    await until(() => t.view().phase === 'playing');
  });

  it('says when another device took over', async () => {
    const t = setup();
    await t.controller.play();
    await until(() => t.api.batches.length === 2);
    t.api.endWith = 'takeover';
    t.api.changed();
    await until(() => t.view().status === 'Read-aloud moved to another device.');
    expect(t.lines[t.lines.length - 1]).toBeNull();
  });

  it('reads with a newly chosen voice from the next Play or Read from here', async () => {
    const t = setup();
    await t.controller.play();
    await until(() => t.api.batches.length === 2);
    t.api.read();
    await until(() => t.view().phase === 'playing');
    t.player().time = 2.1;
    await until(() => t.view().line === 2);
    t.controller.pause();
    expect(t.view().voice).toBe('Narrator · v4.1 Small');

    // A new voice while paused: Play starts a new session at the sentence it paused at.
    t.api.voice = 'Mahito';
    t.controller.noteVoiceChanged();
    const before = t.api.batches.length;
    await t.controller.play();
    expect(t.api.starts).toBe(2);
    expect(t.api.stopped).toBe(1);
    expect(t.view().voice).toBe('Mahito · v4.1 Small');
    await until(() => t.api.batches.length > before);
    expect(t.api.batches[before]).toMatchObject({
      replace: true,
      lines: [t.script.lines[2].text]
    });

    // Without a change, Play goes on in the same session.
    t.controller.pause();
    await t.controller.play();
    expect(t.api.starts).toBe(2);

    // Read from here after a change: a new session there too.
    t.api.voice = 'Makima';
    t.controller.noteVoiceChanged();
    await t.controller.readFrom(t.script.lines[10].position);
    expect(t.api.starts).toBe(3);
    expect(t.view().voice).toBe('Makima · v4.1 Small');
    await until(() =>
      t.api.batches.some((b) => b.replace && b.lines[0] === t.script.lines[10].text)
    );
  });

  it('needs a voice: the panel shows the choice', async () => {
    const t = setup();
    t.api.startReadAloud = async () => {
      throw new LibraryApiError('server', 'off', 409, 'voice_choice_off');
    };
    await t.controller.play();
    expect(t.view()).toMatchObject({ phase: 'error', needsVoice: true });
  });

  it('sends each sentence with its dialogue runs', async () => {
    const html = '<div id="a"><p>「行こう」と彼は言った。</p><p>地の文。</p></div>';
    const script = ReadAloudScript.build(html, [], 0, doc);
    const t = setup(2, { script: async () => script });
    await t.controller.play();
    await until(() => t.api.sent.length >= 1);
    expect(t.api.sent[0][0]).toMatchObject({
      text: '「行こう」と彼は言った。',
      parts: [{ start: 0, end: 5, role: 'dialogue', quote: 0 }]
    });
    await until(() => t.api.sent.length >= 2);
    expect(t.api.sent[1][0].parts).toBeUndefined();
  });

  it('ends at the end of the book', async () => {
    const t = setup(3);
    await t.controller.play();
    await until(() => t.api.batches.length === 2);
    t.api.read();
    await until(() => t.player().segments.length === 2);
    t.player().time = 10;
    await until(() => t.view().phase === 'ended');
    expect(t.view().status).toBe('The end of the book.');
  });
});
