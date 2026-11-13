/**
 * WP17: voice presets (decided with the user, 2026-11-12). A preset is a named reference
 * clip the TTS model copies:
 * - 'clip': the user's own recording. Uploading needs the consent confirmation (the model
 *   card forbids cloning a voice without its owner's consent).
 * - 'design': a voice made on the PC from a written description ("Describe a voice") and
 *   kept by the user; its sample is the fixed reference, so a whole book keeps one voice.
 * Every clip is converted to 48 kHz mono WAV with ffmpeg and must be voiceClipMinSeconds..
 * voiceClipMaxSeconds long. Files live in DATA_DIR/.uploads/voices (voice-store.ts).
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import type { TtsConfig } from '../config';
import { probeFile, runTool } from '../audio/tool-run';
import { VoiceStore } from './voice-store';

export interface Voice {
  id: string;
  name: string;
  kind: 'clip' | 'design';
  description: string | null;
  modelSource: string | null;
  seed: number | null;
  clipSeconds: number;
  size: number;
  sha256: string;
  consentAt: number | null;
  createdAt: number;
}

interface VoiceRow {
  id: string;
  user_id: string;
  name: string;
  kind: 'clip' | 'design';
  description: string | null;
  model_source: string | null;
  seed: number | null;
  clip_seconds: number;
  size: number;
  sha256: string;
  consent_at: number | null;
  created_at: number;
}

const toVoice = (r: VoiceRow): Voice => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  description: r.description,
  modelSource: r.model_source,
  seed: r.seed,
  clipSeconds: r.clip_seconds,
  size: r.size,
  sha256: r.sha256,
  consentAt: r.consent_at,
  createdAt: r.created_at,
});

export class VoiceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface VoiceServiceOptions {
  db: Database.Database;
  store: VoiceStore;
  config: TtsConfig;
  ffmpegPath: string;
  ffprobePath: string;
  now?: () => number;
  log?: (message: string) => void;
}

export function parseVoiceName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (name === '' || name.length > 60) {
    throw new VoiceRequestError(
      400,
      'invalid_name',
      'Give the voice a name (at most 60 characters)',
    );
  }
  return name;
}

export class VoiceService {
  readonly store: VoiceStore;
  readonly config: TtsConfig;
  private readonly db: Database.Database;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(opts: VoiceServiceOptions) {
    this.db = opts.db;
    this.store = opts.store;
    this.config = opts.config;
    this.ffmpegPath = opts.ffmpegPath;
    this.ffprobePath = opts.ffprobePath;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.log;
  }

  list(userId: string): Voice[] {
    return (
      this.db
        .prepare('SELECT * FROM tts_voices WHERE user_id = ? ORDER BY created_at, id')
        .all(userId) as VoiceRow[]
    ).map(toVoice);
  }

  get(userId: string, id: string): Voice | null {
    const row = this.db
      .prepare('SELECT * FROM tts_voices WHERE id = ? AND user_id = ?')
      .get(id, userId) as VoiceRow | undefined;
    return row ? toVoice(row) : null;
  }

  /** Any user's voice by id (the worker reads the clip of its job's voice). */
  byId(id: string): Voice | null {
    const row = this.db.prepare('SELECT * FROM tts_voices WHERE id = ?').get(id) as
      | VoiceRow
      | undefined;
    return row ? toVoice(row) : null;
  }

  private checkNameFree(userId: string, name: string): void {
    const taken = this.db
      .prepare('SELECT 1 FROM tts_voices WHERE user_id = ? AND lower(name) = lower(?)')
      .get(userId, name);
    if (taken)
      throw new VoiceRequestError(409, 'name_taken', 'A voice with this name exists already');
  }

  /**
   * Converts any audio file to the preset's WAV (in the store's temp area) and checks its
   * length. Returns the temp WAV and its length; the caller commits or discards it.
   */
  private async convert(input: string): Promise<{ wav: string; seconds: number }> {
    const wav = this.store.tempPath('wav');
    try {
      await runTool(
        this.ffmpegPath,
        [
          '-hide_banner',
          '-nostdin',
          '-v',
          'error',
          '-i',
          input,
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          '48000',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          wav,
        ],
        { timeoutMs: 120_000 },
      );
    } catch {
      await this.store.discard(wav);
      throw new VoiceRequestError(400, 'not_audio', "This file couldn't be read as audio");
    }
    let seconds: number;
    try {
      seconds = (await probeFile(this.ffprobePath, wav)).duration;
    } catch {
      seconds = NaN;
    }
    const { voiceClipMinSeconds: min, voiceClipMaxSeconds: max } = this.config;
    if (!Number.isFinite(seconds) || seconds < min || seconds > max) {
      await this.store.discard(wav);
      throw new VoiceRequestError(
        400,
        'bad_length',
        Number.isFinite(seconds)
          ? `The clip is ${Math.round(seconds)} s long; use ${min}–${max} s (about 30 s works well)`
          : "This file couldn't be read as audio",
      );
    }
    return { wav, seconds };
  }

  private async insert(
    userId: string,
    fields: Omit<Voice, 'id' | 'clipSeconds' | 'size' | 'sha256' | 'createdAt'>,
    wav: string,
    seconds: number,
  ): Promise<Voice> {
    const id = randomUUID();
    let committed: { relative: string; size: number; sha256: string };
    try {
      committed = await this.store.commit(wav, id);
    } catch (err) {
      await this.store.discard(wav);
      throw err;
    }
    try {
      this.db
        .prepare(
          `INSERT INTO tts_voices (id, user_id, name, kind, description, model_source, seed,
             clip_seconds, size, sha256, consent_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          userId,
          fields.name,
          fields.kind,
          fields.description,
          fields.modelSource,
          fields.seed,
          seconds,
          committed.size,
          committed.sha256,
          fields.consentAt,
          this.now(),
        );
    } catch (err) {
      await this.store.remove(id).catch(() => undefined);
      throw err;
    }
    this.log(`Voices: added "${fields.name}" (${fields.kind}, ${seconds.toFixed(1)} s)`);
    return this.get(userId, id)!;
  }

  /** The user's own clip (`upload` is a temp file of the store, removed here). */
  async addClip(
    userId: string,
    upload: string,
    input: { name?: unknown; consent?: unknown },
  ): Promise<Voice> {
    try {
      const name = parseVoiceName(input.name);
      if (input.consent !== true) {
        throw new VoiceRequestError(
          400,
          'consent_required',
          'Confirm that this is your own voice or that its owner agreed',
        );
      }
      this.checkNameFree(userId, name);
      const { wav, seconds } = await this.convert(upload);
      return await this.insert(
        userId,
        {
          name,
          kind: 'clip',
          description: null,
          modelSource: null,
          seed: null,
          consentAt: this.now(),
        },
        wav,
        seconds,
      );
    } finally {
      await this.store.discard(upload);
    }
  }

  /** A described voice the user kept: `sample` is the PC's sample file (not removed here). */
  async addDesign(
    userId: string,
    sample: string,
    input: { name: string; description: string; modelSource: string; seed: number },
  ): Promise<Voice> {
    const name = parseVoiceName(input.name);
    this.checkNameFree(userId, name);
    const { wav, seconds } = await this.convert(sample);
    return this.insert(
      userId,
      {
        name,
        kind: 'design',
        description: input.description,
        modelSource: input.modelSource,
        seed: input.seed,
        consentAt: null,
      },
      wav,
      seconds,
    );
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const voice = this.get(userId, id);
    if (!voice) return false;
    this.db.prepare('DELETE FROM tts_voices WHERE id = ? AND user_id = ?').run(id, userId);
    await this.store.remove(id).catch((err) => this.log(`Voices: could not remove a clip: ${err}`));
    this.log(`Voices: removed "${voice.name}"`);
    return true;
  }

  clipRelative(id: string): string {
    return VoiceStore.clipPath(id);
  }

  /** At start: the store's temp files go; a clip whose row is gone is removed. */
  async start(): Promise<void> {
    this.store.init();
    let names: string[] = [];
    try {
      names = await fs.readdir(this.store.root);
    } catch {
      return;
    }
    const known = new Set(
      (this.db.prepare('SELECT id FROM tts_voices').all() as { id: string }[]).map((r) => r.id),
    );
    for (const name of names) {
      if (/^[0-9a-f-]{36}$/.test(name) && !known.has(name)) {
        await this.store.remove(name).catch(() => undefined);
      }
    }
  }
}
