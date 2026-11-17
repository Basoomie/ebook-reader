/**
 * The worker's side of /api/v1/worker/* on the reader's server (storage server). Every
 * request carries the worker token; the server lets it read only the files of the job it
 * holds. The worker never writes on the server: it uploads the result.
 */
import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export type JobKind =
  | 'sync_subtitles'
  | 'generate_audiobook'
  | 'preview_audiobook'
  | 'voice_sample'
  | 'sentence_audio'
  | 'attribute_speakers';

/** Session 5: what a speaker job needs (the server's SpeakerClaim, in the claim's `tts`). */
export interface SpeakerClaim {
  speakers: {
    model: {
      repo: string;
      file: string;
      revision: string;
      size: number | null;
      sha256: string | null;
      label: string;
    };
    contextSize: number;
  };
}

/** Session 5: one request for the speaker model (the server's LlmRequest). */
export interface SpeakerRequest {
  seq: number;
  stage: string;
  window: number;
  messages: { role: 'system' | 'user'; content: string }[];
  grammar?: string;
  jsonSchema?: unknown;
  nPredict: number;
  nProbs: number;
  think?: boolean;
}

/** WP17: what a TTS job needs (the server's TtsClaim). */
export interface TtsClaim {
  kind: JobKind;
  model: { source: string; revision: string };
  voice: { sha256: string; seconds: number } | null;
  /**
   * Session 4 (server 23+): every voice the job reads with, by key, with its seed. A
   * sentence's segments name these keys.
   */
  voices?: Record<string, { sha256: string; seed: number }>;
  caption: string | null;
  seed: number;
  pauses: { sentenceMs: number; paragraphMs: number; chapterMs: number; dialogueMs?: number };
  whole: boolean;
  chaptersTotal: number;
  chaptersDone: number;
}

export interface ClaimedJob {
  id: number;
  kind: JobKind;
  bookTitle: string | null;
  /** sync_subtitles only. */
  audioFileName: string;
  audioSize: number;
  /** The audio length the server indexed; null while unknown. */
  audioSeconds?: number | null;
  epubSize: number | null;
  /** WP17 kinds only (session 5: a speaker job sends its SpeakerClaim here). */
  tts?: TtsClaim;
  leaseSeconds: number;
}

/** Session 4: a run of a sentence read with the voice its key names. */
export interface ScriptSegment {
  reading: string;
  voice: string;
}

export interface ScriptSentence {
  text: string;
  reading: string;
  paragraphEnd: boolean;
  segments?: ScriptSegment[];
}

export interface ScriptChapter {
  index: number;
  title: string;
  sentences: ScriptSentence[];
}

export interface ModelEntry {
  source: string;
  revision: string;
  /** The model's folder under the models folder: `<owner>--<name>[--sub]/<revision>`. */
  dir: string;
}

export type Stage = 'downloading' | 'syncing' | 'uploading' | 'preparing' | 'generating';

/** Season 2 Phase 12 session 3: the voice process as the worker reports it. */
export interface EngineReport {
  state: 'loading' | 'ready';
  source: string;
  revision: string;
}

/** What the server says at a check-in (live, keepVoiceSeconds: server 22+). */
export interface HeartbeatAnswer {
  paused: boolean;
  pollSeconds: number;
  live?: boolean;
  keepVoiceSeconds?: number | null;
  keepLoadedMinutes?: number;
}

/** Read-aloud work from /worker/live/next. */
export interface LiveAssignment {
  session: {
    id: string;
    model: { source: string; revision: string };
    voice: { sha256: string };
    seed: number;
    /** Session 4 (server 23+): every voice by key; segments name these keys. */
    voices?: Record<string, { sha256: string; seed: number }>;
    pauses: { sentenceMs: number; paragraphMs: number; chapterMs: number; dialogueMs?: number };
  };
  batch: {
    seq: number;
    sentences: ScriptSentence[];
  } | null;
}

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ServerApiOptions {
  serverUrl: string;
  token: string;
  requestTimeoutSeconds: number;
  fetchImpl?: typeof fetch;
}

export class ServerApi {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ServerApiOptions) {
    this.base = `${opts.serverUrl.replace(/\/+$/, '')}/api/v1`;
    this.token = opts.token;
    this.timeoutMs = opts.requestTimeoutSeconds * 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    {
      raw,
      timeout = true,
      timeoutMs,
      contentType = 'application/x-subrip',
    }: { raw?: Buffer; timeout?: boolean; timeoutMs?: number; contentType?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let payload: BodyInit | undefined;
    if (raw) {
      headers['Content-Type'] = contentType;
      payload = new Uint8Array(raw);
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      body: payload,
      signal: timeout ? AbortSignal.timeout(timeoutMs ?? this.timeoutMs) : undefined,
    });
    if (!res.ok) {
      let code = 'http_error';
      let message = `${method} ${path}: HTTP ${res.status}`;
      try {
        const json = (await res.json()) as { error?: { code?: string; message?: string } };
        if (json.error?.code) code = json.error.code;
        if (json.error?.message) message = json.error.message;
      } catch {
        // Not JSON.
      }
      throw new ServerError(res.status, code, message);
    }
    return res;
  }

  async health(): Promise<{ ok: boolean; version?: string; schemaVersion?: number }> {
    const res = await this.fetchImpl(`${this.base}/health`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return (await res.json()) as { ok: boolean; version?: string; schemaVersion?: number };
  }

  /**
   * The idle check-in. `wait` (1.2.0): the server may hold it open that many seconds until
   * there is work (an older server answers at once).
   */
  async heartbeat(input: {
    version: string;
    image: string;
    ttsImage?: string;
    problem: string | null;
    currentJobId: number | null;
    engine?: EngineReport | null;
    wait?: number;
  }): Promise<HeartbeatAnswer> {
    return (await (
      await this.request('POST', '/worker/heartbeat', input, {
        timeoutMs: this.timeoutMs + (input.wait ?? 0) * 1000,
      })
    ).json()) as HeartbeatAnswer;
  }

  /** The next job of one of `kinds` (WP17: the kinds this PC can run now). */
  async claim(kinds?: JobKind[], engine?: EngineReport | null): Promise<ClaimedJob | null> {
    const json = (await (
      await this.request('POST', '/worker/claim', { kinds, engine })
    ).json()) as {
      job: ClaimedJob | null;
    };
    return json.job;
  }

  async progress(
    id: number,
    input: { stage: Stage; progress: number | null; message: string | null },
  ): Promise<{ cancel: boolean; pause?: boolean; yield?: boolean }> {
    return (await (await this.request('POST', `/worker/jobs/${id}/progress`, input)).json()) as {
      cancel: boolean;
      pause?: boolean;
      yield?: boolean;
    };
  }

  // ---------------------------------------------------------------- read-aloud (1.2.0)

  /**
   * Read-aloud work: the session and (`take`) its next batch, the request held open up to
   * `wait` seconds. Null: no session needs the PC now.
   */
  async liveNext(input: {
    engine: EngineReport | null;
    take: boolean;
    wait: number;
  }): Promise<LiveAssignment | null> {
    const json = (await (
      await this.request('POST', '/worker/live/next', input, {
        timeoutMs: this.timeoutMs + input.wait * 1000,
      })
    ).json()) as LiveAssignment | { end: true };
    return 'end' in json ? null : json;
  }

  /** The session's voice clip, saved to `dest` (a new file). */
  async liveVoice(sha256: string, dest: string): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/worker/live/voice/${sha256}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(this.timeoutMs * 4),
    });
    if (!res.ok || !res.body) await this.raise(res, 'Download of the voice clip');
    const source = Readable.fromWeb(res.body as import('stream/web').ReadableStream<Uint8Array>);
    await pipeline(source, fs.createWriteStream(dest, { flags: 'wx' }));
  }

  /** A read batch: its FLAC (streamed from disk), then its timings. */
  async liveUpload(session: string, seq: number, file: string): Promise<void> {
    const size = fs.statSync(file).size;
    const res = await this.fetchImpl(`${this.base}/worker/live/${session}/${seq}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'audio/flac',
        'Content-Length': String(size),
      },
      body: Readable.toWeb(fs.createReadStream(file)) as unknown as BodyInit,
      duplex: 'half',
      signal: AbortSignal.timeout(this.timeoutMs * 4),
    } as RequestInit);
    if (!res.ok) await this.raise(res, `Upload of read-aloud batch ${seq}`);
  }

  async liveDone(
    session: string,
    seq: number,
    meta: { durationMs: number; cues: number[][] },
  ): Promise<void> {
    await this.request('POST', `/worker/live/${session}/${seq}/done`, meta, {
      timeoutMs: this.timeoutMs * 4,
    });
  }

  async liveFail(session: string, seq: number, error: string): Promise<void> {
    await this.request('POST', `/worker/live/${session}/${seq}/fail`, { error });
  }

  // ---------------------------------------------------------------- WP17: TTS jobs

  /** The chapters still to read. */
  async script(id: number): Promise<{ chapters: ScriptChapter[] }> {
    return (await (await this.request('GET', `/worker/jobs/${id}/script`)).json()) as {
      chapters: ScriptChapter[];
    };
  }

  /** A finished chapter: its FLAC (streamed from disk), then its timings. */
  async uploadChapter(id: number, idx: number, file: string, signal?: AbortSignal): Promise<void> {
    const size = fs.statSync(file).size;
    const res = await this.fetchImpl(`${this.base}/worker/jobs/${id}/chapters/${idx}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'audio/flac',
        'Content-Length': String(size),
      },
      body: Readable.toWeb(fs.createReadStream(file)) as unknown as BodyInit,
      // Node's fetch needs this for a streamed body.
      duplex: 'half',
      signal,
    } as RequestInit);
    if (!res.ok) await this.raise(res, `Upload of chapter ${idx + 1}`);
  }

  async finishChapter(
    id: number,
    idx: number,
    meta: { durationMs: number; cues: number[][]; spoken: string[] },
  ): Promise<{ state: string; chaptersDone: number }> {
    return (await (
      await this.request('POST', `/worker/jobs/${id}/chapters/${idx}/done`, meta)
    ).json()) as { state: string; chaptersDone: number };
  }

  /** Paused between chapters: the job goes back to the queue. */
  async release(id: number): Promise<string> {
    return (
      (await (await this.request('POST', `/worker/jobs/${id}/release`, {})).json()) as {
        state: string;
      }
    ).state;
  }

  // ---------------------------------------------------------------- speakers (1.4.0)

  /** The speaker job's next request; null when the run is complete (the server saved it). */
  async speakersNext(id: number): Promise<{
    request: SpeakerRequest | null;
    progress: { stage: string; done: number; total: number };
  }> {
    return (await (await this.request('POST', `/worker/jobs/${id}/speakers/next`, {})).json()) as {
      request: SpeakerRequest | null;
      progress: { stage: string; done: number; total: number };
    };
  }

  /** The model's answer to request `seq`; the server says whether to stop, pause or make way. */
  async speakersAnswer(
    id: number,
    seq: number,
    body: { content: string; probs?: unknown; ms: number },
  ): Promise<{ cancel: boolean; pause?: boolean; yield?: boolean }> {
    return (await (
      await this.request('POST', `/worker/jobs/${id}/speakers/${seq}`, body, {
        timeoutMs: this.timeoutMs * 4,
      })
    ).json()) as { cancel: boolean; pause?: boolean; yield?: boolean };
  }

  /** Still waiting on the model (keeps the job's lease); the server says whether to stop or make way. */
  async speakersWorking(
    id: number,
  ): Promise<{ cancel: boolean; pause?: boolean; yield?: boolean }> {
    return (await (
      await this.request('POST', `/worker/jobs/${id}/speakers/working`, {})
    ).json()) as { cancel: boolean; pause?: boolean; yield?: boolean };
  }

  /** Made way (Pause, read-aloud, sentence clips): the job goes back to the queue. */
  async speakersRelease(id: number): Promise<string> {
    return (
      (await (await this.request('POST', `/worker/jobs/${id}/speakers/release`, {})).json()) as {
        state: string;
      }
    ).state;
  }

  /** The speaker models, and the folders of removed ones (deleted on this PC). */
  async speakerModels(): Promise<{ models: { dir: string }[]; removed: { dir: string }[] }> {
    return (await (await this.request('GET', '/worker/speaker-models')).json()) as {
      models: { dir: string }[];
      removed: { dir: string }[];
    };
  }

  async models(): Promise<{ models: ModelEntry[]; removed: ModelEntry[] }> {
    return (await (await this.request('GET', '/worker/models')).json()) as {
      models: ModelEntry[];
      removed: ModelEntry[];
    };
  }

  async capabilities(input: {
    source: string;
    revision: string;
    description: boolean;
    clip: boolean;
  }): Promise<void> {
    await this.request('POST', '/worker/models/capabilities', input);
  }

  private async raise(res: Response, what: string): Promise<never> {
    let message = `${what} failed: HTTP ${res.status}`;
    let code = 'http_error';
    try {
      const json = (await res.json()) as { error?: { code?: string; message?: string } };
      if (json.error?.message) message = json.error.message;
      if (json.error?.code) code = json.error.code;
    } catch {
      // Not JSON.
    }
    throw new ServerError(res.status, code, message);
  }

  async fail(id: number, input: { error: string; logTail: string | null }): Promise<string> {
    const json = (await (await this.request('POST', `/worker/jobs/${id}/fail`, input)).json()) as {
      state: string;
    };
    return json.state;
  }

  async uploadResult(
    id: number,
    data: Buffer,
  ): Promise<{ state: string; outputName: string | null; linked: boolean; error: string | null }> {
    return (await (
      await this.request('PUT', `/worker/jobs/${id}/result`, undefined, { raw: data })
    ).json()) as {
      state: string;
      outputName: string | null;
      linked: boolean;
      error: string | null;
    };
  }

  /**
   * Saves the job's EPUB or audio file to `dest` (a new file), reporting bytes. Checks the
   * size against Content-Length. `signal` stops it (the job was stopped).
   */
  async download(
    id: number,
    which: 'epub' | 'audio' | 'voice',
    dest: string,
    onBytes: (received: number, total: number | null) => void,
    signal?: AbortSignal,
    /** Session 4: which of the job's voices (by its clip's sha256); none: the narration. */
    sha256?: string,
  ): Promise<number> {
    const query = which === 'voice' && sha256 ? `?sha=${sha256}` : '';
    const res = await this.fetchImpl(`${this.base}/worker/jobs/${id}/${which}${query}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
    });
    if (!res.ok || !res.body) {
      let message = `Download of the ${which === 'epub' ? 'EPUB' : 'audio file'} failed: HTTP ${res.status}`;
      let code = 'http_error';
      try {
        const json = (await res.json()) as { error?: { code?: string; message?: string } };
        if (json.error?.message) message = json.error.message;
        if (json.error?.code) code = json.error.code;
      } catch {
        // Not JSON.
      }
      throw new ServerError(res.status, code, message);
    }
    const total = Number(res.headers.get('content-length'));
    const expected = Number.isFinite(total) && total > 0 ? total : null;
    let received = 0;
    const source = Readable.fromWeb(res.body as import('stream/web').ReadableStream<Uint8Array>);
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      onBytes(received, expected);
    });
    await pipeline(source, fs.createWriteStream(dest, { flags: 'wx' }), { signal });
    if (expected !== null && received !== expected) {
      throw new Error(
        `The ${which === 'epub' ? 'EPUB' : 'audio file'} download was cut short (${received} of ${expected} bytes)`,
      );
    }
    return received;
  }
}
