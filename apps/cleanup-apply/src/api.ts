/**
 * The sidecar's side of /api/v1/cleanup-apply/* on the reader's server. The sidecar never
 * writes cleanup.db: it reports each step and waits for the server's answer before the
 * next. When the server is away (stopped every night around 00:00 for the backup), calls
 * are retried with a growing pause until it is back.
 */
import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export interface CalibreLogin {
  contentServerUrl: string;
  /** null until the reader's server knows which of the content server's libraries to use. */
  libraryId: string | null;
  username: string;
  password: string;
}

export interface HeartbeatAnswer {
  calibre: CalibreLogin | null;
  itemDelaySeconds: number;
  pollSeconds: number;
}

export type ItemState =
  | 'pending'
  | 'verified'
  | 'exported'
  | 'tagged'
  | 'removed'
  | 'restored'
  | 'failed'
  | 'skipped';

export interface BatchItem {
  itemId: number;
  changeId: number;
  state: ItemState;
  quarantineDir: string | null;
  calibreId: number;
  uuid: string;
  title: string;
  lastModified: string | null;
  formats: string[];
  sha256: string;
  kept: { calibreId: number; uuid: string };
  /** apply: the user's tags to add to the kept copy; undo: the tags to take off it again. */
  addTags: string[];
}

export interface Batch {
  id: string;
  kind: 'apply' | 'undo';
  stage: number;
  createdAt: number;
  leaseSeconds: number;
  itemDelaySeconds: number;
  snapshotSha256: string | null;
  snapshotSaved: boolean;
  items: BatchItem[];
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string | null;
}

export interface Heartbeat {
  version: string;
  calibredb: string | null;
  serverVersion: string | null;
  trashRestore: boolean | null;
  problem: string | null;
  checks: CheckResult[];
  /** The library ids the content server lists. */
  libraries: string[];
}

export interface StepReport {
  step: ItemState;
  detail?: string;
  quarantineDir?: string;
  exportSha256?: string;
  method?: 'trash' | 'readd';
  calibreId?: number;
  uuid?: string;
}

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** The server answered, but with an error that waiting won't fix. */
export function isFinal(err: unknown): err is ServerError {
  return (
    err instanceof ServerError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 429
  );
}

export class ServerApi {
  private readonly base: string;

  constructor(
    serverUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.base = `${serverUrl.replace(/\/+$/, '')}/api/v1/cleanup-apply`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!res.ok) {
      let code = 'http_error';
      let message = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: { code?: string; message?: string } };
        code = j.error?.code ?? code;
        message = j.error?.message ?? message;
      } catch {
        // Not JSON.
      }
      throw new ServerError(res.status, code, message);
    }
    return (await res.json()) as T;
  }

  heartbeat(h: Heartbeat): Promise<HeartbeatAnswer> {
    return this.call('POST', '/heartbeat', h);
  }

  claim(): Promise<{ batch: Batch | null; wait: string | null }> {
    return this.call('POST', '/claim', {});
  }

  progress(batchId: string): Promise<unknown> {
    return this.call('POST', `/batches/${batchId}/progress`, {});
  }

  report(batchId: string, itemId: number, report: StepReport): Promise<{ state: ItemState }> {
    return this.call('POST', `/batches/${batchId}/items/${itemId}`, report);
  }

  snapshotSaved(batchId: string, sha256: string): Promise<unknown> {
    return this.call('POST', `/batches/${batchId}/snapshot-saved`, { sha256 });
  }

  finish(batchId: string, error: string | null): Promise<unknown> {
    return this.call('POST', `/batches/${batchId}/finish`, error ? { error } : {});
  }

  /** Streams the batch's metadata.db snapshot into `file` (created new; never replaces). */
  async downloadSnapshot(batchId: string, file: string): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/batches/${batchId}/metadata-snapshot`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 600_000))
    });
    if (!res.ok || !res.body) throw new ServerError(res.status, 'snapshot', `HTTP ${res.status}`);
    const out = fs.createWriteStream(file, { flags: 'wx' });
    await pipeline(Readable.fromWeb(res.body as never), out);
  }
}
