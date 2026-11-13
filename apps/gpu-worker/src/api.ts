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
  | 'voice_sample';

/** WP17: what a TTS job needs (the server's TtsClaim). */
export interface TtsClaim {
  kind: JobKind;
  model: { source: string; revision: string };
  voice: { sha256: string; seconds: number } | null;
  caption: string | null;
  seed: number;
  pauses: { sentenceMs: number; paragraphMs: number; chapterMs: number };
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
  /** WP17 kinds only. */
  tts?: TtsClaim;
  leaseSeconds: number;
}

export interface ScriptChapter {
  index: number;
  title: string;
  sentences: { text: string; reading: string; paragraphEnd: boolean }[];
}

export interface ModelEntry {
  source: string;
  revision: string;
  /** The model's folder under the models folder: `<owner>--<name>[--sub]/<revision>`. */
  dir: string;
}

export type Stage = 'downloading' | 'syncing' | 'uploading' | 'preparing' | 'generating';

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
      contentType = 'application/x-subrip',
    }: { raw?: Buffer; timeout?: boolean; contentType?: string } = {},
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
      signal: timeout ? AbortSignal.timeout(this.timeoutMs) : undefined,
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

  async heartbeat(input: {
    version: string;
    image: string;
    ttsImage?: string;
    problem: string | null;
    currentJobId: number | null;
  }): Promise<{ paused: boolean; pollSeconds: number }> {
    return (await (await this.request('POST', '/worker/heartbeat', input)).json()) as {
      paused: boolean;
      pollSeconds: number;
    };
  }

  /** The next job of one of `kinds` (WP17: the kinds this PC can run now). */
  async claim(kinds?: JobKind[]): Promise<ClaimedJob | null> {
    const json = (await (await this.request('POST', '/worker/claim', { kinds })).json()) as {
      job: ClaimedJob | null;
    };
    return json.job;
  }

  async progress(
    id: number,
    input: { stage: Stage; progress: number | null; message: string | null },
  ): Promise<{ cancel: boolean; pause?: boolean }> {
    return (await (await this.request('POST', `/worker/jobs/${id}/progress`, input)).json()) as {
      cancel: boolean;
      pause?: boolean;
    };
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
  ): Promise<number> {
    const res = await this.fetchImpl(`${this.base}/worker/jobs/${id}/${which}`, {
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
