/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DUP_FIELDS,
  DUP_LISTS,
  audioStage3Bar,
  audioStage3Lines,
  copyFacts,
  damageLine,
  decisionText,
  dupLines,
  gateLines,
  groupHeadline,
  missLine,
  pairCopies,
  scoresLine
} from './audio-dup-text';
import {
  CleanupApi,
  type AudioDupCopy,
  type AudioDupGroup,
  type AudioStage3Progress
} from './cleanup-api';

const NOW = 1_800_000_000_000;

function progress(over: Partial<AudioStage3Progress> = {}): AudioStage3Progress {
  return {
    analysisId: 'a',
    phase: 'fingerprints',
    startedAt: NOW - 600_000,
    finishedAt: null,
    copies: 5855,
    excluded: 0,
    pairsByTest: { identical: 868, asin: 226, abs_asin: 75, title: 86, title_groups_too_large: 0 },
    windowsTotal: 2055,
    windowsDone: 1000,
    windowsReused: 400,
    windowErrors: 0,
    decodesDone: 0,
    decodesReused: 0,
    yields: 2,
    phaseStartedAt: NOW - 600_000,
    phaseStartDone: 400,
    phaseTimes: {},
    tools: null,
    counts: null,
    gate: null,
    error: null,
    ...over
  };
}

const copy = (over: Partial<AudioDupCopy> = {}): AudioDupCopy => ({
  id: 1,
  key: 'k1',
  kind: 'file',
  name: '本',
  paths: ['torrents/a.m4b'],
  files: 1,
  seconds: 32963.3,
  codec: 'aac',
  bitrate: 125588,
  sampleRate: 44100,
  chapters: 11,
  cover: true,
  asins: ['B0DBH181YY'],
  absAsins: [],
  ai: false,
  damage: null,
  damageDetail: null,
  excluded: null,
  ...over
});

describe('the Audiobooks tab, stage 3 wording', () => {
  it('shows the progress of the listening step with what was heard before', () => {
    const bar = audioStage3Bar(progress(), NOW)!;
    expect(bar.label).toBe('Listening to a few stretches of each copy: 1,000 of 2,055');
    expect(bar.fraction).toBeCloseTo(1000 / 2055);
    // Older progress without the counts: no bar rather than a wrong one.
    expect(audioStage3Bar(progress({ phase: 'compare' }), NOW)).toBeNull();
    expect(audioStage3Bar(progress({ phase: 'decode' }), NOW)).toBeNull();
    const cmp = audioStage3Bar(
      progress({ phase: 'compare', compareDone: 100, compareTotal: 396 }),
      NOW
    )!;
    expect(cmp.label).toBe('Comparing what was heard: 100 of 396 pairs');
    // Decodes: files done of all known, audio left, time left from the pace since the start.
    const dec = audioStage3Bar(
      progress({
        phase: 'decode',
        decodesDone: 60,
        decodesLeft: 240,
        decodeAudioDone: 60 * 30_000,
        decodeAudioLeft: 240 * 30_000,
        decodeRateFrom: { at: NOW - 30 * 60_000, audio: 0 }
      }),
      NOW
    )!;
    expect(dec.label).toBe(
      'Playing the chosen copies all the way through: 60 of 300 files (2000 h 0 min of audio left)'
    );
    expect(dec.fraction).toBeCloseTo(0.2);
    expect(dec.eta).toBe('about 2 h left (estimate; more may be added)');
    const lines = audioStage3Lines(progress());
    expect(lines).toContain('Now: Listening to a few stretches of each copy.');
    expect(lines).toContain(
      'Possible duplicates: 868 by identical files, 226 by same ASIN in the names, 75 by same ASIN in Audiobookshelf, 86 by same title and volume.'
    );
    expect(lines).toContain('1,000 of 2,055 stretches heard (400 heard before, not read again).');
    expect(lines).toContain('Gave the disk to the Calibre cleanup 2 times.');
  });

  it('says what was found: groups by test, decisions by rule, review items', () => {
    const lines = dupLines({
      'groups.group.identical.auto': 400,
      'groups.group.asin.auto': 150,
      'groups.group.asin.review': 12,
      'groups.group.title.auto': 30,
      'decisions.auto.rule.identical': 400,
      'decisions.auto.rule.5': 120,
      'decisions.auto.rule.0': 2,
      dropped: 610,
      review: 20,
      'pairs.title.different': 41,
      damaged_groups: 3,
      'decodes.fewBadFrames': 37,
      'decodes.undecodable': 1
    });
    expect(lines[0]).toBe(
      '592 recordings have more than one copy (found by identical files 400, same ASIN in the names 162, same title and volume 30).'
    );
    expect(lines[1]).toBe(
      'Proven the same, so one copy is enough: identical files 400, higher bitrate / sample rate 120, damaged or incomplete copy loses 2; 610 copies not needed.'
    );
    expect(lines).toContain(
      '20 recordings keep every copy (not proven identical); you can still choose one.'
    );
    expect(lines).toContain('41 pairs with the same name turned out to be different recordings.');
    expect(lines).toContain(
      'Played all the way through: 37 files have a few bad frames at the very start or end and play normally (not damaged).'
    );
    expect(lines).toContain(
      '1 file uses xHE-AAC, which this ffmpeg can’t decode, so it wasn’t played through.'
    );
    expect(lines.join(' ')).not.toContain('faad2');
  });

  it('a copy with a few bad frames plays normally; nothing says "possibly damaged"', () => {
    const copy = { damage: 'ok', damageDetail: 'a.m4b: 7 bad frames at most, too few to hear' };
    expect(damageLine(copy as never)).toBe(
      'Played all the way through, plays normally: a.m4b: 7 bad frames at most, too few to hear'
    );
    expect(damageLine({ damage: 'ok', damageDetail: null } as never)).toBe(
      'Played all the way through without errors.'
    );
    expect(damageLine({ damage: 'suspect', damageDetail: 'x' } as never)).toBeNull();
  });

  it('the gate: the score and each miss', () => {
    const g = {
      passed: false,
      checked: 94,
      correct: 93,
      sameChecked: 94,
      sameCorrect: 94,
      bestChecked: 60,
      bestCorrect: 59,
      skipped: 6,
      misses: [
        {
          n: 6,
          kind: 'same_asin',
          expected: 'same, best a',
          got: 'review (best guess a)',
          ok: false
        }
      ],
      error: null
    };
    expect(gateLines(g)).toEqual([
      '93 of 94 labeled pairs came out as labeled (same or not: 94 of 94; best copy: 59 of 60); 6 without a label left out.'
    ]);
    expect(missLine(g.misses[0])).toBe(
      'Pair 6 (same_asin): labeled same, best a, came out review (best guess a).'
    );
    expect(gateLines({ ...g, error: 'not there' })).toEqual([
      'The labeled pairs can’t be read: not there'
    ]);
  });

  it('a copy, its damage, the scores and the choice', () => {
    expect(copyFacts(copy())).toBe(
      '9 h 9 min · one file · 11 chapters · aac 126 kbps 44.1 kHz · cover · ASIN B0DBH181YY'
    );
    expect(
      copyFacts(
        copy({ kind: 'library_only', files: 3, cover: false, asins: [], sampleRate: 22050 })
      )
    ).toBe(
      '9 h 9 min · 3 files · 11 chapters · aac 126 kbps 22.05 kHz · no cover · only in the library'
    );
    expect(damageLine(copy({ damage: 'damaged', damageDetail: 'a.m4b: ffmpeg errors' }))).toBe(
      'Damaged: a.m4b: ffmpeg errors'
    );
    expect(damageLine(copy())).toBeNull();
    expect(
      scoresLine({
        a_id: 1,
        b_id: 2,
        test: 'asin',
        verdict: 'same',
        fp_verdict: 'same',
        length_diff: 15.02,
        detail: null,
        scores: {
          windows: [
            { name: 'start', score: 0.897, shiftSeconds: -7.78 },
            { name: 'end', score: 0.905, shiftSeconds: -7.78 },
            { name: 'middle', score: 0.978, shiftSeconds: -7.78 }
          ],
          skipped: []
        }
      })
    ).toBe(
      'Heard alike: start 0.90 (-7.8 s), middle 0.98 (-7.8 s), end 0.91 (-7.8 s); lengths +15.0 s'
    );
    const g: AudioDupGroup = {
      id: 1,
      groupKey: 'g',
      kind: 'group',
      firstTest: 'asin',
      tests: ['asin'],
      rule: 'tie',
      outcome: 'review',
      reviewReason: 'nothing separates them, and their lengths differ by 15.0 s',
      damaged: false,
      bestCopyId: 1,
      decision: { decision: 'keep:k2', decided_by: 'you', decided_at: NOW },
      copies: [copy(), copy({ id: 2, key: 'k2' })],
      pairs: []
    };
    expect(groupHeadline(g)).toBe(
      'Same recording, not proven identical: every copy stays (same ASIN in the names); best guess by: nothing separates them'
    );
    expect(decisionText(g)).toBe('Your choice: keep only copy 2.');
    expect(decisionText({ ...g, decision: { ...g.decision!, decision: 'keep_all' } })).toBe(
      'Your choice: keep all copies.'
    );
    expect(groupHeadline({ ...g, kind: 'unsure' })).toMatch(/^Not sure/);
    expect(groupHeadline({ ...g, outcome: 'auto', rule: 'branding' })).toBe(
      'Proven the same (same ASIN in the names): the same apart from Audible’s opening and closing (the copy without them stays)'
    );
    const ver = audioStage3Bar(
      progress({
        phase: 'verify',
        verifyDone: 50,
        verifyLeft: 150,
        verifyRateFrom: { at: NOW - 600_000, done: 0 }
      }),
      NOW
    )!;
    expect(ver.label).toBe('Comparing the copies frame by frame: 50 of 200 pairs');
    expect(ver.eta).toBe('about 30 min left (estimate)');
    // Every test that joined the group, and which copies a score line is about.
    expect(groupHeadline({ ...g, firstTest: 'identical', tests: ['identical', 'asin'] })).toMatch(
      /\(identical files, same ASIN in the names\)/
    );
    const pc = { a_id: 2, b_id: 1 } as Parameters<typeof pairCopies>[1];
    expect(pairCopies(g, pc)).toBe('Copies 1 and 2: ');
    expect(DUP_LISTS[0].id).toBe('review');
    expect(DUP_FIELDS.map((d) => d.key)).toContain('dupSameScore');
  });
});

describe('CleanupApi, stage 3', () => {
  it('lists, records a choice and fetches a clip; a clip waits while Calibre uses the disk', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/clip/')) return new Response(new Uint8Array([1, 2, 3]), { status });
      return new Response(JSON.stringify({ total: 0, items: [], ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = new CleanupApi('http://s', 'ttsu_x', 0, fetchImpl);
    await api.audioDups('review', 50, 50);
    expect(calls[0].url).toBe('http://s/api/v1/cleanup/audio/dups?list=review&offset=50&limit=50');
    await api.decideAudioDup(7, 'keep:abc');
    expect(calls[1].url).toBe('http://s/api/v1/cleanup/audio/dups/7');
    expect(calls[1].init.method).toBe('POST');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ decision: 'keep:abc' });
    const blob = await api.audioClip(3, 'end');
    expect(calls[2].url).toBe('http://s/api/v1/cleanup/audio/clip/3/end');
    expect(blob!.size).toBe(3);
    status = 503;
    expect(await api.audioClip(3, 'start')).toBeNull();
  });
});
