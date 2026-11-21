/**
 * The audiobook cleanup's tools. Stage 2 (WP21a): what ffprobe finds in an audio file (format
 * from the content, not the name), and a short decode at its start and at its end. Stage 3
 * (WP21b): Chromaprint fingerprints of a few windows (ffmpeg decodes the window to raw samples
 * on stdout, fpcalc reads them on stdin), full decodes of competing copies (ffmpeg, and faad2
 * as a second, independent AAC decoder), and short clips for the review page (mp3 on stdout).
 *
 * Read-only by construction: the tools never get an output file (`-f null -` or stdout only,
 * built by `toolArgs`), and on Linux they get only a read-only descriptor of the file
 * (`/dev/fd/3`, opened by audio-source-fs), never its path.
 */
import { spawn } from 'child_process';
import os from 'os';
import { openReadOnly } from './audio-source-fs';
import { FrameCollector, type FrameList } from './dup-frames';
import { parseFpcalc } from './dup-fingerprint';

export interface ToolPaths {
  ffprobePath: string;
  ffmpegPath: string;
  /** Chromaprint's fpcalc (stage 3); default 'fpcalc'. */
  fpcalcPath?: string;
  /** faad2's command-line decoder (stage 3); default 'faad'. */
  faadPath?: string;
}

/** Every tool path, the optional ones with their defaults. */
export function allTools(t: ToolPaths): Required<ToolPaths> {
  return {
    ffprobePath: t.ffprobePath,
    ffmpegPath: t.ffmpegPath,
    fpcalcPath: t.fpcalcPath || 'fpcalc',
    faadPath: t.faadPath || 'faad',
  };
}

export interface Chapter {
  start: number;
  end: number;
  title: string | null;
}

export interface HealthResult {
  format: string | null;
  formatLong: string | null;
  codec: string | null;
  profile: string | null;
  bitrate: number | null;
  sampleRate: number | null;
  channels: number | null;
  duration: number | null;
  chapters: Chapter[];
  hasCover: boolean;
  tags: Record<string, string>;
  /** ffprobe read the file and found an audio stream. */
  headerOk: boolean;
  startDecodeOk: boolean | null;
  endDecodeOk: boolean | null;
  decodeError: string | null;
  /** Why ffprobe failed, or what it reported (shortened). */
  error: string | null;
  /** The chapter titles or tags were not valid UTF-8 (shown with U+FFFD). */
  invalidUtf8: boolean;
}

/**
 * decode-both: the start and the end in one ffmpeg run (two inputs of the same file).
 * Stage 3: window-pcm (a stretch as raw 11,025 Hz mono samples on stdout), fpcalc (reads those
 * on stdin), full-decode (the whole file to the null muxer), faad (the whole file decoded to
 * stdout, counted and dropped), clip-start / clip-end (a few seconds as mp3 on stdout).
 */
export type ToolKind =
  | 'probe'
  | 'decode-start'
  | 'decode-end'
  | 'decode-both'
  | 'window-pcm'
  | 'fpcalc'
  | 'full-decode'
  | 'faad'
  | 'clip-start'
  | 'clip-end'
  | 'frame-hashes';

/** Seconds as tool arguments (three decimals). */
function secs(x: number): string {
  return (Math.round(Math.max(0, x) * 1000) / 1000).toFixed(3);
}

/**
 * The only place tool arguments are built. Every command reads one input and writes nothing
 * but stdout: ffprobe prints JSON; ffmpeg decodes to the null muxer (`-f null -`) or to stdout
 * (`-`); fpcalc reads stdin (`-`); faad writes to stdout (`-w`).
 */
export function toolArgs(
  kind: ToolKind,
  input: string,
  decodeSeconds: number,
  span: { start: number; length: number } = { start: 0, length: 0 },
): string[] {
  const base = ['-hide_banner', '-nostdin', '-v', 'error'];
  if (kind === 'window-pcm') {
    return [
      ...base,
      '-ss',
      secs(span.start),
      '-t',
      secs(span.length),
      '-i',
      input,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '11025',
      '-f',
      's16le',
      '-',
    ];
  }
  if (kind === 'fpcalc') {
    return [
      '-raw',
      '-format',
      's16le',
      '-rate',
      '11025',
      '-channels',
      '1',
      '-length',
      String(Math.ceil(span.length) + 5),
      '-',
    ];
  }
  if (kind === 'full-decode') return [...base, '-i', input, '-map', '0:a:0', '-f', 'null', '-'];
  // Each audio frame's MD5 on stdout, frames copied as they are (nothing decoded).
  if (kind === 'frame-hashes') {
    return [...base, '-i', input, '-map', '0:a:0', '-c', 'copy', '-f', 'framemd5', '-'];
  }
  if (kind === 'faad') return ['-w', input];
  if (kind === 'clip-start' || kind === 'clip-end') {
    const len = secs(Math.max(1, span.length));
    return [
      ...base,
      ...(kind === 'clip-start' ? ['-ss', secs(span.start), '-t', len] : ['-sseof', `-${len}`]),
      '-i',
      input,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '64k',
      '-f',
      'mp3',
      '-',
    ];
  }
  if (kind === 'probe') {
    return [
      '-hide_banner',
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      '-of',
      'json',
      input,
    ];
  }
  const s = String(Math.max(1, Math.round(decodeSeconds)));
  if (kind === 'decode-both') {
    return [
      ...base,
      '-t',
      s,
      '-i',
      input,
      '-sseof',
      `-${s}`,
      '-i',
      input,
      '-map',
      '0:a:0',
      '-map',
      '1:a:0',
      '-f',
      'null',
      '-',
    ];
  }
  const position = kind === 'decode-start' ? ['-t', s] : ['-sseof', `-${s}`];
  return [...base, ...position, '-i', input, '-map', '0:a:0', '-f', 'null', '-'];
}

interface RunResult {
  code: number | null;
  stdout: Buffer;
  /** Bytes written to stdout in all (also those not kept). */
  stdoutBytes: number;
  stderr: string;
  /** Lines written to stderr in all (also those not kept). */
  stderrLines: number;
  timedOut: boolean;
}

interface RunOptions {
  /** Keep at most this many stdout bytes (the rest is only counted); default 32 MB. */
  keepStdout?: number;
  /** Each stdout chunk as it comes (e.g. to pass samples on to fpcalc). */
  onStdout?: (b: Buffer) => void;
  /** stdin is a pipe the caller writes (see `Started.stdin`). */
  stdinPipe?: boolean;
  /** Stops the run early (killed) when it turns true; checked every second. */
  shouldStop?: () => boolean;
}

interface Started {
  done: Promise<RunResult>;
  stdin: NodeJS.WritableStream | null;
}

/** The one place a process is started. */
function start(
  bin: string,
  args: string[],
  fd: number | null,
  timeoutMs: number,
  opts: RunOptions = {},
): Started {
  const stdio: ('ignore' | 'pipe' | number)[] = [
    opts.stdinPipe ? 'pipe' : 'ignore',
    'pipe',
    'pipe',
  ];
  if (fd !== null) stdio.push(fd);
  const child = spawn(bin, args, { stdio, windowsHide: true });
  try {
    if (child.pid) os.setPriority(child.pid, 10);
  } catch {
    // Lower priority is a nicety only.
  }
  const keep = opts.keepStdout ?? 32 * 1024 * 1024;
  const done = new Promise<RunResult>((resolve, reject) => {
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let errLines = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const poll = opts.shouldStop
      ? setInterval(() => {
          if (opts.shouldStop!()) child.kill('SIGKILL');
        }, 1000)
      : null;
    child.stdout!.on('data', (b: Buffer) => {
      if (outBytes < keep) {
        out.push(outBytes + b.length <= keep ? b : b.subarray(0, keep - outBytes));
      }
      outBytes += b.length;
      opts.onStdout?.(b);
    });
    child.stderr!.on('data', (b: Buffer) => {
      const t = b.toString('utf8');
      for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) errLines++;
      if (err.length < 64 * 1024) err += t;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve({
        code,
        stdout: Buffer.concat(out),
        stdoutBytes: outBytes,
        stderr: err,
        stderrLines: errLines,
        timedOut,
      });
    });
  });
  // A broken pipe (the reader ended early) shows in the result, it is not thrown.
  child.stdin?.on('error', () => undefined);
  return { done, stdin: child.stdin ?? null };
}

function run(
  bin: string,
  args: string[],
  fd: number | null,
  timeoutMs: number,
  opts: RunOptions = {},
): Promise<RunResult> {
  return start(bin, args, fd, timeoutMs, opts).done;
}

/**
 * ffmpeg messages about the file's container that say nothing about the audio. A play that
 * reports only these is clean. Found in the live run (2026-11-18): one file was counted as
 * damaged for "Referenced QT chapter track not found" (a broken reference to the chapter
 * track; the audio plays with exit 0 and the chapter list still reads). ffmpeg 8.0 prefixes it
 * with "[mov,mp4,…]", 8.1 with "[in#0 …]", so only the message text is matched.
 */
const NOT_AUDIO_PROBLEMS: readonly RegExp[] = [/Referenced QT chapter track not found/];

/** What a play reported about the audio itself: its messages without the notices above. */
export function audioProblems(stderr: string): string {
  const kept: string[] = [];
  let skippedLast = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // ffmpeg folds repeats into "Last message repeated N times": it belongs to the line before.
    if (/Last message repeated \d+ times?/.test(line) && skippedLast) continue;
    skippedLast = NOT_AUDIO_PROBLEMS.some((re) => re.test(line));
    if (!skippedLast) kept.push(line);
  }
  return kept.join('\n').trim();
}

function short(text: string, max = 500): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** ffprobe's format_name in a short form: "mov,mp4,m4a,3gp,3g2,mj2" → mp4. */
export function shortFormat(name: string | null | undefined): string | null {
  if (!name) return null;
  const first = name.split(',')[0];
  return first === 'mov' ? 'mp4' : first;
}

const TAG_KEYS = [
  'title',
  'artist',
  'album',
  'album_artist',
  'composer',
  'genre',
  'date',
  'comment',
  'asin',
  'audible_asin',
  'publisher',
  // WP21f-2: a multi-file book's story order starts with its track numbers.
  'track',
  'disc',
];

/**
 * What the stored tags hold: 2 = with `track` and `disc` (WP21f-2). Rows of files in multi-file
 * books checked before (null) are checked again once, so their story order can use the tags.
 */
export const HEALTH_TAGS_VERSION = 2;

/** Parses ffprobe's JSON (stdout as bytes: chapter titles may not be valid UTF-8). */
export function parseProbe(
  stdout: Buffer,
): Omit<HealthResult, 'startDecodeOk' | 'endDecodeOk' | 'decodeError' | 'error'> {
  let text: string;
  let invalidUtf8 = false;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
  } catch {
    text = stdout.toString('utf8');
    invalidUtf8 = true;
  }
  const json = JSON.parse(text) as {
    format?: {
      format_name?: string;
      format_long_name?: string;
      duration?: string;
      bit_rate?: string;
      tags?: Record<string, string>;
    };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      profile?: string;
      sample_rate?: string;
      channels?: number;
      bit_rate?: string;
      duration?: string;
      disposition?: { attached_pic?: number };
      tags?: Record<string, string>;
    }[];
    chapters?: { start_time?: string; end_time?: string; tags?: { title?: string } }[];
  };
  const streams = json.streams ?? [];
  const audio = streams.find((s) => s.codec_type === 'audio');
  const cover = streams.some(
    (s) =>
      s.disposition?.attached_pic === 1 ||
      (s.codec_type === 'video' && /^(mjpeg|png|bmp|gif)$/.test(s.codec_name ?? '')),
  );
  const tags: Record<string, string> = {};
  const fmtTags = json.format?.tags ?? {};
  for (const [k, v] of Object.entries({ ...(audio?.tags ?? {}), ...fmtTags })) {
    const key = k.toLowerCase();
    if (TAG_KEYS.includes(key) && typeof v === 'string') tags[key] = v.slice(0, 500);
  }
  const chapters = (json.chapters ?? []).map((c) => ({
    start: num(c.start_time) ?? 0,
    end: num(c.end_time) ?? 0,
    title: typeof c.tags?.title === 'string' ? c.tags.title.slice(0, 300) : null,
  }));
  if (chapters.some((c) => c.title?.includes(String.fromCharCode(0xfffd)))) invalidUtf8 = true;
  return {
    format: shortFormat(json.format?.format_name),
    formatLong: json.format?.format_long_name ?? null,
    codec: audio?.codec_name ?? null,
    profile: audio?.profile ?? null,
    bitrate: num(audio?.bit_rate) ?? num(json.format?.bit_rate),
    sampleRate: num(audio?.sample_rate),
    channels: typeof audio?.channels === 'number' ? audio.channels : null,
    duration: num(json.format?.duration) ?? num(audio?.duration),
    chapters,
    hasCover: cover,
    tags,
    headerOk: Boolean(audio),
    invalidUtf8,
  };
}

/** Runs ffprobe and the two short decodes on one file. Never throws for a bad file. */
export async function checkHealth(
  file: string | Buffer,
  tools: ToolPaths,
  {
    decodeSeconds,
    timeoutMs,
    combined = true,
  }: {
    decodeSeconds: number;
    timeoutMs: number;
    /** false: always play the two ends in separate runs (the tests compare both ways). */
    combined?: boolean;
  },
): Promise<HealthResult> {
  const empty: HealthResult = {
    format: null,
    formatLong: null,
    codec: null,
    profile: null,
    bitrate: null,
    sampleRate: null,
    channels: null,
    duration: null,
    chapters: [],
    hasCover: false,
    tags: {},
    headerOk: false,
    startDecodeOk: null,
    endDecodeOk: null,
    decodeError: null,
    error: null,
    invalidUtf8: false,
  };
  const useFd = process.platform === 'linux';
  if (!useFd && typeof file !== 'string') {
    return { ...empty, error: 'A name that is not UTF-8 can only be checked on Linux' };
  }
  const handle = useFd ? await openReadOnly(file) : null;
  try {
    const input = handle ? '/dev/fd/3' : (file as string);
    const fd = handle ? handle.fd : null;
    const probe = await run(
      tools.ffprobePath,
      toolArgs('probe', input, decodeSeconds),
      fd,
      timeoutMs,
    );
    if (probe.timedOut) return { ...empty, error: 'ffprobe took too long' };
    let result: HealthResult;
    try {
      result = { ...empty, ...parseProbe(probe.stdout) };
    } catch {
      return { ...empty, error: short(probe.stderr) || `ffprobe failed (exit ${probe.code})` };
    }
    if (probe.stderr.trim()) result.error = short(probe.stderr);
    if (!result.headerOk) {
      result.error ??= 'No audio stream found';
      return result;
    }
    // Both ends in one run. Clean (exit 0, nothing reported) = both ends play. Anything else:
    // each end is played again on its own, so every problem is recorded against its own end
    // exactly as before (the combined run only saves a second program start for clean files).
    const both = combined
      ? await run(tools.ffmpegPath, toolArgs('decode-both', input, decodeSeconds), fd, timeoutMs)
      : null;
    if (both && !both.timedOut && both.code === 0 && audioProblems(both.stderr) === '') {
      result.startDecodeOk = true;
      result.endDecodeOk = true;
      result.decodeError = null;
      return result;
    }
    const problems: string[] = [];
    for (const kind of ['decode-start', 'decode-end'] as const) {
      const r = await run(tools.ffmpegPath, toolArgs(kind, input, decodeSeconds), fd, timeoutMs);
      const reported = audioProblems(r.stderr);
      const ok = !r.timedOut && r.code === 0 && reported === '';
      if (kind === 'decode-start') result.startDecodeOk = ok;
      else result.endDecodeOk = ok;
      if (!ok) {
        const what = kind === 'decode-start' ? 'start' : 'end';
        problems.push(
          `${what}: ${r.timedOut ? 'took too long' : short(reported, 300) || `exit ${r.code}`}`,
        );
      }
    }
    result.decodeError = problems.length ? problems.join('; ') : null;
    return result;
  } finally {
    await handle?.close();
  }
}

/** The tools' version line (recorded with each result). */
export async function toolVersion(tools: ToolPaths): Promise<string | null> {
  try {
    const r = await run(tools.ffprobePath, ['-version'], null, 10_000);
    return r.stdout.toString('utf8').split(/\r?\n/)[0]?.slice(0, 200) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Stage 3 (WP21b)

/** A stretch of one file (seconds from the file's start). */
export interface FileSpan {
  file: string | Buffer;
  start: number;
  length: number;
}

export interface FingerprintResult {
  fp: Uint32Array | null;
  /** What the tools reported (shortened), or null. */
  error: string | null;
}

function refuseRawName(file: string | Buffer): string | null {
  return process.platform !== 'linux' && typeof file !== 'string'
    ? 'A name that is not UTF-8 can only be read on Linux'
    : null;
}

/**
 * A Chromaprint fingerprint of consecutive stretches (one window of a copy; it may run over
 * from one file of a split copy into the next). ffmpeg decodes each stretch to raw samples;
 * they go on to fpcalc's stdin.
 */
export async function fingerprintSpans(
  spans: FileSpan[],
  toolPaths: ToolPaths,
  { timeoutMs, shouldStop }: { timeoutMs: number; shouldStop?: () => boolean },
): Promise<FingerprintResult> {
  const tools = allTools(toolPaths);
  for (const sp of spans) {
    const refused = refuseRawName(sp.file);
    if (refused) return { fp: null, error: refused };
  }
  const total = spans.reduce((a, sp) => a + sp.length, 0);
  const fpc = start(
    tools.fpcalcPath,
    toolArgs('fpcalc', '-', 0, { start: 0, length: total }),
    null,
    timeoutMs,
    { stdinPipe: true, shouldStop },
  );
  // A tool that can't start rejects at once: handled here, reported when awaited below.
  fpc.done.catch(() => undefined);
  const problems: string[] = [];
  try {
    for (const sp of spans) {
      if (shouldStop?.()) break;
      const handle = process.platform === 'linux' ? await openReadOnly(sp.file) : null;
      try {
        const input = handle ? '/dev/fd/3' : (sp.file as string);
        const r = await run(
          tools.ffmpegPath,
          toolArgs('window-pcm', input, 0, { start: sp.start, length: sp.length }),
          handle ? handle.fd : null,
          timeoutMs,
          { keepStdout: 0, onStdout: (b) => fpc.stdin?.write(b), shouldStop },
        );
        const reported = audioProblems(r.stderr);
        if (r.timedOut) problems.push('ffmpeg took too long');
        else if (r.code !== 0 || reported) problems.push(short(reported, 200) || `exit ${r.code}`);
      } finally {
        await handle?.close();
      }
    }
  } finally {
    fpc.stdin?.end();
  }
  const out = await fpc.done;
  if (out.timedOut) problems.push('fpcalc took too long');
  const fp = parseFpcalc(out.stdout.toString('utf8'));
  if (!fp || fp.length === 0) {
    problems.push(short(out.stderr, 200) || `fpcalc gave no fingerprint (exit ${out.code})`);
    return { fp: null, error: problems.join('; ') };
  }
  return { fp, error: problems.length ? problems.join('; ') : null };
}

/**
 * Stage 4 (WP21c): a Chromaprint fingerprint of audio held in memory (a store's sample mp3, as
 * the fetcher brought it). ffmpeg reads it from stdin (no file is written anywhere), decodes up
 * to `seconds` to raw samples, and fpcalc reads those on its stdin, as for the files' windows.
 */
export async function fingerprintBytes(
  audio: Buffer,
  toolPaths: ToolPaths,
  { timeoutMs, seconds }: { timeoutMs: number; seconds: number },
): Promise<FingerprintResult> {
  const tools = allTools(toolPaths);
  const fpc = start(
    tools.fpcalcPath,
    toolArgs('fpcalc', '-', 0, { start: 0, length: seconds }),
    null,
    timeoutMs,
    { stdinPipe: true },
  );
  fpc.done.catch(() => undefined);
  const problems: string[] = [];
  try {
    const dec = start(
      tools.ffmpegPath,
      toolArgs('window-pcm', 'pipe:0', 0, { start: 0, length: seconds }),
      null,
      timeoutMs,
      { stdinPipe: true, keepStdout: 0, onStdout: (b) => fpc.stdin?.write(b) },
    );
    dec.stdin?.end(audio);
    const r = await dec.done;
    const reported = audioProblems(r.stderr);
    if (r.timedOut) problems.push('ffmpeg took too long');
    else if (r.code !== 0) problems.push(short(reported, 200) || `exit ${r.code}`);
  } finally {
    fpc.stdin?.end();
  }
  const out = await fpc.done;
  if (out.timedOut) problems.push('fpcalc took too long');
  const fp = parseFpcalc(out.stdout.toString('utf8'));
  if (!fp || fp.length === 0) {
    problems.push(short(out.stderr, 200) || `fpcalc gave no fingerprint (exit ${out.code})`);
    return { fp: null, error: problems.join('; ') };
  }
  return { fp, error: problems.length ? problems.join('; ') : null };
}

export interface DecodeResult {
  /** true: clean; false: damaged; null: stopped before the end (read again later). */
  ok: boolean | null;
  /** ffmpeg: problem lines reported; faad: 0 or 1. */
  errorCount: number;
  /** faad: seconds it decoded before stopping (it stops silently at damage). */
  decodedSeconds: number | null;
  detail: string | null;
  tookMs: number;
}

/** A whole file through ffmpeg's decoder (to the null muxer); counts what it reports. */
export async function decodeWithFfmpeg(
  file: string | Buffer,
  toolPaths: ToolPaths,
  { timeoutMs, shouldStop }: { timeoutMs: number; shouldStop?: () => boolean },
): Promise<DecodeResult> {
  const tools = allTools(toolPaths);
  const t0 = Date.now();
  const refused = refuseRawName(file);
  if (refused) {
    return { ok: null, errorCount: 0, decodedSeconds: null, detail: refused, tookMs: 0 };
  }
  const handle = process.platform === 'linux' ? await openReadOnly(file) : null;
  try {
    const input = handle ? '/dev/fd/3' : (file as string);
    let stopped = false;
    const r = await run(
      tools.ffmpegPath,
      toolArgs('full-decode', input, 0),
      handle ? handle.fd : null,
      timeoutMs,
      {
        keepStdout: 0,
        shouldStop: () => {
          if (shouldStop?.()) stopped = true;
          return stopped;
        },
      },
    );
    const took = Date.now() - t0;
    if (stopped)
      return { ok: null, errorCount: 0, decodedSeconds: null, detail: null, tookMs: took };
    const reported = audioProblems(r.stderr);
    const lines = reported ? reported.split('\n').length : 0;
    // stderr beyond 64 KB is only counted: use the larger of the two counts.
    const count = reported ? Math.max(lines, r.stderrLines) : 0;
    const ok = !r.timedOut && r.code === 0 && !reported;
    return {
      ok,
      errorCount: count,
      decodedSeconds: null,
      detail: r.timedOut
        ? 'took too long'
        : reported
          ? short(reported, 400)
          : ok
            ? null
            : `exit ${r.code}`,
      tookMs: took,
    };
  } finally {
    await handle?.close();
  }
}

/** The WAV header's sample rate, channels and bits, and where the samples start. */
export function wavFormat(
  head: Buffer,
): { rate: number; channels: number; bits: number; dataOffset: number } | null {
  if (head.length < 44 || head.toString('latin1', 0, 4) !== 'RIFF') return null;
  const fmt = head.indexOf('fmt ', 12, 'latin1');
  const data = head.indexOf('data', 12, 'latin1');
  if (fmt < 0 || data < 0) return null;
  const channels = head.readUInt16LE(fmt + 10);
  const rate = head.readUInt32LE(fmt + 12);
  const bits = head.readUInt16LE(fmt + 22);
  if (!channels || !rate || !bits) return null;
  return { rate, channels, bits, dataOffset: data + 8 };
}

/**
 * A whole file through faad2 (a second AAC decoder, independent of ffmpeg's). faad stops at
 * damage without saying so and still exits 0 (checked 2026-11-18 on a file with 200 KB of
 * noise written into it: 36 of 115 MB decoded), so the result is how much it decoded.
 */
export async function decodeWithFaad(
  file: string | Buffer,
  toolPaths: ToolPaths,
  {
    expectedSeconds,
    timeoutMs,
    shouldStop,
  }: { expectedSeconds: number; timeoutMs: number; shouldStop?: () => boolean },
): Promise<DecodeResult> {
  const tools = allTools(toolPaths);
  const t0 = Date.now();
  const refused = refuseRawName(file);
  if (refused) {
    return { ok: null, errorCount: 0, decodedSeconds: null, detail: refused, tookMs: 0 };
  }
  const handle = process.platform === 'linux' ? await openReadOnly(file) : null;
  try {
    const input = handle ? '/dev/fd/3' : (file as string);
    let stopped = false;
    const r = await run(
      tools.faadPath,
      toolArgs('faad', input, 0),
      handle ? handle.fd : null,
      timeoutMs,
      {
        keepStdout: 256,
        shouldStop: () => {
          if (shouldStop?.()) stopped = true;
          return stopped;
        },
      },
    );
    const took = Date.now() - t0;
    if (stopped)
      return { ok: null, errorCount: 0, decodedSeconds: null, detail: null, tookMs: took };
    const wav = wavFormat(r.stdout);
    if (!wav) {
      return {
        ok: false,
        errorCount: 1,
        decodedSeconds: 0,
        detail: r.timedOut
          ? 'took too long'
          : short(faadMessages(r.stderr), 300) || 'faad decoded nothing',
        tookMs: took,
      };
    }
    const decoded =
      Math.max(0, r.stdoutBytes - wav.dataOffset) / (wav.rate * wav.channels * (wav.bits / 8));
    const complete = decoded >= expectedSeconds - 1;
    const ok = !r.timedOut && r.code === 0 && complete;
    return {
      ok,
      errorCount: ok ? 0 : 1,
      decodedSeconds: Math.round(decoded * 100) / 100,
      detail: ok
        ? null
        : r.timedOut
          ? 'took too long'
          : `stopped at ${Math.round(decoded)} s of ${Math.round(expectedSeconds)} s${
              faadMessages(r.stderr) ? `: ${short(faadMessages(r.stderr), 200)}` : ''
            }`,
      tookMs: took,
    };
  } finally {
    await handle?.close();
  }
}

/** faad's messages without its banner, file info and progress lines. */
export function faadMessages(stderr: string): string {
  return stderr
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => /warning|error|unable|fail|not/i.test(l) && !/% decoding/.test(l))
    .join('\n');
}

/** A few seconds from the start or the end of a file as mp3 (the review page plays it). */
export async function cutClip(
  file: string | Buffer,
  toolPaths: ToolPaths,
  { at, seconds, timeoutMs }: { at: 'start' | 'end'; seconds: number; timeoutMs: number },
): Promise<Buffer | null> {
  const tools = allTools(toolPaths);
  if (refuseRawName(file)) return null;
  const handle = process.platform === 'linux' ? await openReadOnly(file) : null;
  try {
    const input = handle ? '/dev/fd/3' : (file as string);
    const r = await run(
      tools.ffmpegPath,
      toolArgs(at === 'start' ? 'clip-start' : 'clip-end', input, 0, { start: 0, length: seconds }),
      handle ? handle.fd : null,
      timeoutMs,
      { keepStdout: 4 * 1024 * 1024 },
    );
    return r.code === 0 && !r.timedOut && r.stdoutBytes > 0 ? r.stdout : null;
  } finally {
    await handle?.close();
  }
}

/** The stage 3 tools' version lines (recorded with each result). */
export async function stage3ToolVersions(
  toolPaths: ToolPaths,
): Promise<{ fpcalc: string | null; faad: string | null; ffmpeg: string | null }> {
  const tools = allTools(toolPaths);
  const first = (t: string) =>
    t
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 200) ?? null;
  const out = {
    fpcalc: null as string | null,
    faad: null as string | null,
    ffmpeg: null as string | null,
  };
  try {
    const r = await run(tools.fpcalcPath, ['-version'], null, 10_000);
    out.fpcalc = first(r.stdout.toString('utf8') || r.stderr);
  } catch {
    // Not installed: the stage reports it.
  }
  try {
    const r = await run(tools.faadPath, ['-h'], null, 10_000);
    // faad prints its usage on stdout and its banner ("… Decoder V2.11.2 …") on stderr.
    const banner = `${r.stderr}\n${r.stdout.toString('utf8')}`
      .split(/\r?\n/)
      .find((l) => /Decoder\s+V\d/i.test(l));
    out.faad = banner ? banner.replace(/\*/g, '').trim().slice(0, 200) : null;
  } catch {
    // Not installed: the stage reports it.
  }
  try {
    const r = await run(tools.ffmpegPath, ['-version'], null, 10_000);
    out.ffmpeg = first(r.stdout.toString('utf8'));
  } catch {
    // Not installed.
  }
  return out;
}

/**
 * Every audio frame's MD5 of a copy's files, in order (ffmpeg's framemd5, frames copied, nothing
 * decoded). Reads each file whole. Null frames when stopped (read again later) or unreadable.
 */
export async function frameHashes(
  files: (string | Buffer)[],
  toolPaths: ToolPaths,
  { timeoutMs, shouldStop }: { timeoutMs: number; shouldStop?: () => boolean },
): Promise<{ frames: FrameList | null; stopped: boolean; error: string | null; tookMs: number }> {
  const tools = allTools(toolPaths);
  const t0 = Date.now();
  const collector = new FrameCollector();
  const problems: string[] = [];
  let stopped = false;
  for (const file of files) {
    const refused = refuseRawName(file);
    if (refused) return { frames: null, stopped: false, error: refused, tookMs: Date.now() - t0 };
    const handle = process.platform === 'linux' ? await openReadOnly(file) : null;
    try {
      collector.nextFile();
      const input = handle ? '/dev/fd/3' : (file as string);
      const r = await run(
        tools.ffmpegPath,
        toolArgs('frame-hashes', input, 0),
        handle ? handle.fd : null,
        timeoutMs,
        {
          keepStdout: 0,
          onStdout: (b) => collector.push(b),
          shouldStop: () => {
            if (shouldStop?.()) stopped = true;
            return stopped;
          },
        },
      );
      collector.end();
      if (stopped) return { frames: null, stopped: true, error: null, tookMs: Date.now() - t0 };
      if (r.timedOut) problems.push('took too long');
      else if (r.code !== 0) problems.push(short(audioProblems(r.stderr), 200) || `exit ${r.code}`);
    } finally {
      await handle?.close();
    }
  }
  if (problems.length || collector.bad > 0) {
    return {
      frames: null,
      stopped: false,
      error: problems.join('; ') || `${collector.bad} frame lines could not be read`,
      tookMs: Date.now() - t0,
    };
  }
  return { frames: collector.result(), stopped: false, error: null, tookMs: Date.now() - t0 };
}
