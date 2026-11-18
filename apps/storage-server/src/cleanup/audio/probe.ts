/**
 * File health for the audiobook cleanup's stage 2 (WP21a): what ffprobe finds in an audio file
 * (format from the content, not the name), and a short decode at its start and at its end
 * (damage check, rule 0 of the best-copy order; a full decode only later, for duplicate copies).
 *
 * Read-only by construction: the tools never get an output file (`-f null -` only, built by
 * `toolArgs`), and on Linux they get only a read-only descriptor of the file (`/dev/fd/3`,
 * opened by audio-source-fs), never its path.
 */
import { spawn } from 'child_process';
import os from 'os';
import { openReadOnly } from './audio-source-fs';

export interface ToolPaths {
  ffprobePath: string;
  ffmpegPath: string;
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

/** decode-both: the start and the end in one ffmpeg run (two inputs of the same file). */
export type ToolKind = 'probe' | 'decode-start' | 'decode-end' | 'decode-both';

/**
 * The only place tool arguments are built. Every command reads one input and writes nothing:
 * ffprobe prints JSON to stdout; ffmpeg decodes to the null muxer (`-f null -`).
 */
export function toolArgs(kind: ToolKind, input: string, decodeSeconds: number): string[] {
  const base = ['-hide_banner', '-nostdin', '-v', 'error'];
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
  stderr: string;
  timedOut: boolean;
}

function run(
  bin: string,
  args: string[],
  fd: number | null,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const stdio: ('ignore' | 'pipe' | number)[] = ['ignore', 'pipe', 'pipe'];
    if (fd !== null) stdio.push(fd);
    const child = spawn(bin, args, { stdio, windowsHide: true });
    try {
      if (child.pid) os.setPriority(child.pid, 10);
    } catch {
      // Lower priority is a nicety only.
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout!.on('data', (b: Buffer) => {
      if (outBytes < 32 * 1024 * 1024) out.push(b);
      outBytes += b.length;
    });
    child.stderr!.on('data', (b: Buffer) => {
      if (err.length < 64 * 1024) err += b.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err, timedOut });
    });
  });
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
];

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
