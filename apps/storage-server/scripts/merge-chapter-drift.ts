/**
 * "Merge keeps the original chapters": compares a merged file with its originals.
 *
 * - Chapters: the merged file's chapters (ffprobe) against `mergedChapters` of the originals
 *   (the list the merge writes): count, titles, order, starts.
 * - Drift: where each original's audio really is in the merged file. A window of the
 *   original's own audio (the loudest of a few near its start) is found in the merged audio
 *   around the file's expected start by cross-correlation (8 kHz mono, so 0.125 ms steps).
 *   drift = found − expected; the chapters of that file are off by the same amount.
 *
 * Read only: ffprobe/ffmpeg read the files, nothing is written.
 *
 * Usage: npx ts-node --transpile-only scripts/merge-chapter-drift.ts <merged> <original>...
 *        (originals in the merge's order; prints JSON)
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { mergedChapters, parseProbe, type ProbeResult } from '../src/audio/merge-service';

const RATE = 8000;

export interface DriftReport {
  merged: { duration: number; chapters: { title: string | null; start: number }[] };
  expected: { title: string | null; startMs: number }[];
  chapters: {
    countEqual: boolean;
    titlesEqual: boolean;
    /** Largest |merged start − expected start| over all chapters (ms). */
    maxStartDiffMs: number;
    firstDifference: string | null;
  };
  files: {
    name: string;
    duration: number;
    streamDuration: number;
    ownChapters: number;
    expectedStartMs: number;
    measuredStartMs: number | null;
    driftMs: number | null;
    /** Correlation of the best match (1 = identical); low means the measure is unsure. */
    score: number | null;
  }[];
  /** Drift of the last file (what has added up by the end) and the largest of any file. */
  totalDriftMs: number | null;
  maxAbsDriftMs: number | null;
  durationDiffMs: number;
}

function probe(ffprobe: string, file: string): ProbeResult {
  return parseProbe(
    execFileSync(
      ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:format_tags:stream=index,codec_type,codec_name,sample_rate,channels,profile,duration:stream_disposition=attached_pic:chapter=id,time_base,start,end,start_time,end_time:chapter_tags=title',
        '-of',
        'json',
        file,
      ],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    ).toString('utf8'),
  );
}

function pcm(ffmpeg: string, file: string, start: number, seconds: number): Float32Array {
  const buf = execFileSync(
    ffmpeg,
    [
      '-v',
      'error',
      '-ss',
      Math.max(0, start).toFixed(4),
      '-i',
      file,
      '-t',
      seconds.toFixed(4),
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      String(RATE),
      '-f',
      'f32le',
      'pipe:1',
    ],
    { windowsHide: true, maxBuffer: 256 * 1024 * 1024 },
  );
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const energy = (a: Float32Array) => a.reduce((n, x) => n + x * x, 0);

/** Best lag (samples) of `needle` inside `hay`, with its normalized correlation. */
function bestLag(hay: Float32Array, needle: Float32Array): { lag: number; score: number } {
  const n = needle.length;
  const ne = Math.sqrt(energy(needle)) || 1;
  let best = { lag: 0, score: -Infinity };
  // Running energy of the hay window.
  let he = 0;
  for (let i = 0; i < n && i < hay.length; i++) he += hay[i] * hay[i];
  for (let lag = 0; lag + n <= hay.length; lag++) {
    if (lag > 0) he += hay[lag + n - 1] ** 2 - hay[lag - 1] ** 2;
    let dot = 0;
    for (let i = 0; i < n; i++) dot += hay[lag + i] * needle[i];
    const score = dot / (ne * (Math.sqrt(Math.max(he, 0)) || 1));
    if (score > best.score) best = { lag, score };
  }
  return best;
}

export function measureMerge(
  mergedFile: string,
  originals: string[],
  { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', searchSeconds = 1, windowSeconds = 1.5 } = {},
): DriftReport {
  const probes = originals.map((f) => probe(ffprobe, f));
  const mergedProbe = probe(ffprobe, mergedFile);
  const { chapters: expected } = mergedChapters(
    originals.map((f, i) => ({
      name: path.basename(f),
      duration: probes[i].duration,
      chapters: probes[i].chapters,
    })),
  );
  const actual = mergedProbe.chapters;
  let maxStartDiffMs = 0;
  let firstDifference: string | null = null;
  const n = Math.min(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(actual[i].start * 1000 - expected[i].startMs);
    maxStartDiffMs = Math.max(maxStartDiffMs, d);
    if (!firstDifference && (actual[i].title ?? '') !== (expected[i].title ?? '')) {
      firstDifference = `chapter ${i + 1}: "${actual[i].title}" vs "${expected[i].title}"`;
    }
  }
  if (actual.length !== expected.length && !firstDifference) {
    firstDifference = `${actual.length} chapters vs ${expected.length}`;
  }

  const files: DriftReport['files'] = [];
  let offset = 0;
  for (const [i, f] of originals.entries()) {
    const p = probes[i];
    const audio = p.streams.find((s) => s.codecType === 'audio');
    const expectedStartMs = Math.round(offset * 1000);
    // The loudest of a few windows near the start (silence can't be found).
    let pick = { at: 0, e: -1, w: new Float32Array(0) };
    for (const at of [0.2, 3, 8, 15, 30]) {
      if (at + windowSeconds > p.duration - 0.05) continue;
      const w = pcm(ffmpeg, f, at, windowSeconds);
      const e = energy(w);
      if (e > pick.e) pick = { at, e, w };
    }
    let measuredStartMs: number | null = null;
    let score: number | null = null;
    if (pick.e > 1e-6) {
      const from = offset + pick.at - searchSeconds;
      const hay = pcm(ffmpeg, mergedFile, from, windowSeconds + 2 * searchSeconds);
      const cut = from < 0 ? -from : 0; // the hay starts at 0 when `from` is negative
      const best = bestLag(hay, pick.w);
      measuredStartMs = (from + cut + best.lag / RATE - pick.at) * 1000;
      score = Number(best.score.toFixed(4));
    }
    files.push({
      name: path.basename(f),
      duration: p.duration,
      streamDuration: audio?.duration ?? NaN,
      ownChapters: p.chapters.length,
      expectedStartMs,
      measuredStartMs: measuredStartMs === null ? null : Number(measuredStartMs.toFixed(2)),
      driftMs:
        measuredStartMs === null ? null : Number((measuredStartMs - expectedStartMs).toFixed(2)),
      score,
    });
    offset += p.duration;
  }
  const drifts = files.map((f) => f.driftMs).filter((d): d is number => d !== null);
  return {
    merged: {
      duration: mergedProbe.duration,
      chapters: actual.map((c) => ({ title: c.title, start: c.start })),
    },
    expected: expected.map((c) => ({ title: c.title, startMs: c.startMs })),
    chapters: {
      countEqual: actual.length === expected.length,
      titlesEqual: actual.length === expected.length && firstDifference === null,
      maxStartDiffMs: Number(maxStartDiffMs.toFixed(3)),
      firstDifference,
    },
    files,
    totalDriftMs: drifts.length ? drifts[drifts.length - 1] : null,
    maxAbsDriftMs: drifts.length ? Math.max(...drifts.map(Math.abs)) : null,
    durationDiffMs: Number(((mergedProbe.duration - offset) * 1000).toFixed(2)),
  };
}

if (require.main === module) {
  const [merged, ...originals] = process.argv.slice(2);
  if (!merged || originals.length === 0) {
    console.error('usage: merge-chapter-drift.ts <merged> <original>...');
    process.exit(2);
  }
  const report = measureMerge(merged, originals, {
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  });
  console.log(JSON.stringify({ ...report, merged: { duration: report.merged.duration } }, null, 2));
}
