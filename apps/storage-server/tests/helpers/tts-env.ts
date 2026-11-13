/**
 * WP17 tests: a WP16 job environment plus the TTS job service (a stand-in script reader,
 * real ffmpeg for voices), the model list and voice presets; FLAC/WAV tones made with ffmpeg.
 * Shared by the server and worker tests.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import type { BookScript } from '../../src/audio/book-script';
import { TtsJobService } from '../../src/audio/tts-jobs';
import { TtsModelService } from '../../src/audio/tts-models';
import { DEFAULT_AUDIO_MERGE, DEFAULT_TTS } from '../../src/config';
import { VoiceService } from '../../src/voices/voice-service';
import { VoiceStore } from '../../src/voices/voice-store';
import { makeTempDir } from './spawn-server';
import { jobEnv, type Track } from './worker-env';

export function hasTool(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
export const HAS_FFMPEG = hasTool('ffmpeg') && hasTool('ffprobe');

const TOOL_DIR = makeTempDir('wp17-tools');
/** A mono 48 kHz FLAC tone of `seconds` (what the PC uploads for a chapter). */
export function flac(name: string, seconds: number): string {
  const file = path.join(TOOL_DIR, `${name}.flac`);
  if (!fs.existsSync(file)) {
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${seconds}`,
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'flac',
        file,
      ],
      { windowsHide: true },
    );
  }
  return file;
}
export function wav(name: string, seconds: number): Buffer {
  const file = path.join(TOOL_DIR, `${name}.wav`);
  if (!fs.existsSync(file)) {
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=330:duration=${seconds}`,
        '-ac',
        '2',
        '-ar',
        '44100',
        file,
      ],
      { windowsHide: true },
    );
  }
  return fs.readFileSync(file);
}
export function probe(file: string) {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:format_tags=title,artist,genre:chapter=start_time,end_time:chapter_tags=title:stream=codec_name,codec_type,channels',
      '-of',
      'json',
      file,
    ],
    { windowsHide: true },
  ).toString();
  return JSON.parse(out) as {
    format: { duration: string; tags?: Record<string, string> };
    chapters: { start_time: string; end_time: string; tags: { title: string } }[];
    streams: { codec_name: string; codec_type: string; channels?: number }[];
  };
}

export const SCRIPT: BookScript = {
  version: 1,
  characters: 40,
  chapters: [
    {
      index: 0,
      title: '第一章',
      startCharacter: 0,
      characters: 20,
      sentences: [
        {
          text: '善なるものは畢竟、遠い。',
          reading: '善なるものはひっきょう、遠い。',
          position: 0,
          paragraphEnd: false,
        },
        {
          text: 'けれども悪は近い！',
          reading: 'けれども悪は近い！',
          position: 11,
          paragraphEnd: true,
        },
      ],
    },
    {
      index: 1,
      title: '第二章',
      startCharacter: 20,
      characters: 20,
      sentences: [{ text: '最後の文。', reading: '最後の文。', position: 20, paragraphEnd: true }],
    },
  ],
};

export async function ttsEnv(
  track: Track,
  opts: { script?: BookScript; leaseSeconds?: number } = {},
) {
  const t = await jobEnv(track, { leaseSeconds: opts.leaseSeconds ?? 60 });
  let clock = Date.now();
  const cacheDir = makeTempDir('wp17-cache');
  const models = new TtsModelService(
    t.e.db,
    async () => 'f'.repeat(40),
    () => clock,
  );
  const voices = new VoiceService({
    db: t.e.db,
    store: new VoiceStore(t.e.config.dataRoot),
    config: { ...DEFAULT_TTS, voiceClipMinSeconds: 1 },
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
  });
  await voices.start();
  const scripts: string[] = [];
  const tts = new TtsJobService({
    db: t.e.db,
    jobs: t.jobs,
    scan: t.service,
    writer: (t.jobs as unknown as { writer: never }).writer,
    models,
    voices,
    config: DEFAULT_TTS,
    tools: { ...DEFAULT_AUDIO_MERGE, minFreeMb: 0 },
    cacheDir,
    calibreDir: t.e.config.calibre.dir,
    uploads: null,
    importOptions: {},
    readScript: async (file) => {
      scripts.push(file);
      return opts.script ?? SCRIPT;
    },
    now: () => clock,
    log: (m) => t.logs.push(m),
    logError: (m) => t.logs.push(`ERROR ${m}`),
  });
  await tts.start();
  t.audio.tts = tts;
  t.audio.models = models;
  t.audio.voices = voices;
  const app = t.app;
  const addVoice = async (name = 'Narrator') =>
    (
      await request(app)
        .post(`/api/v1/voices?name=${encodeURIComponent(name)}&consent=1`)
        .set(t.auth)
        .set('Content-Type', 'application/octet-stream')
        .send(wav('voice', 4))
    ).body.voice as { id: string };
  const startBook = (book: string, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/v1/books/${t.bookId(book)}/audiobook-job`)
      .set(t.auth)
      .send(body);
  const uploadChapter = (id: number, idx: number, file: string) =>
    request(app)
      .put(`/api/v1/worker/jobs/${id}/chapters/${idx}`)
      .set(t.worker)
      .set('Content-Type', 'audio/flac')
      .send(fs.readFileSync(file));
  const doneChapter = (id: number, idx: number, body: Record<string, unknown>) =>
    request(app).post(`/api/v1/worker/jobs/${id}/chapters/${idx}/done`).set(t.worker).send(body);
  const latestBook = async (book: string) =>
    (
      await request(app)
        .get(`/api/v1/books/${t.bookId(book)}/audiobook-job`)
        .set(t.auth)
    ).body.job;
  return {
    ...t,
    // Every file of the audiobooks folder now (SHA-256, size, mtime), to prove what changes.
    before: t.tree(),
    tts,
    models,
    voices,
    scripts,
    cacheDir,
    addVoice,
    startBook,
    uploadChapter,
    doneChapter,
    latestBook,
    tickAll: (ms: number) => {
      clock += ms;
      t.tick(ms);
    },
  };
}

export type TtsEnv = Awaited<ReturnType<typeof ttsEnv>>;
