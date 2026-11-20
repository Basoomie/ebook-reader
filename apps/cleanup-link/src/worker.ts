/**
 * The linking sidecar's loop (WP21e-1): a heartbeat, then batches from the reader's server.
 *
 * - preflight batches: every planned torrent file checked (read only, inspect.ts);
 * - build batches: folders, links and metadata files made one after another through the writer
 *   (the only module that writes). The first operation that fails ends the batch; the server
 *   pauses the build and shows it. Operations are safe to repeat: a link or file already there
 *   as planned counts as done, so a batch handed out again after a restart does no harm.
 *
 * The server hands out build batches only while it holds the disk lock shared with the Calibre
 * cleanup, so a batch is small (about a second of disk work).
 */
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import type { LinkConfig } from './config';
import { inspectSource, processInfo, type ProcessInfo } from './inspect';
import { LinkWriter, WriteRefused } from './writer';

export const VERSION = '1.0.0';
const HEARTBEAT_MS = 30_000;

interface BatchOp {
  id: number;
  kind: 'folder' | 'link' | 'pdf' | 'metadata';
  dst: string;
  src: { rel: string; raw: string | null } | null;
  size: number | null;
  mtimeMs: number | null;
  dev: number | null;
  ino: number | null;
  bytes: string | null;
}

interface Batch {
  id: number;
  kind: 'preflight' | 'build';
  leaseSeconds: number;
  ops: BatchOp[];
}

export interface OpResult {
  id: number;
  ok: boolean;
  problem?: string | null;
  error?: string | null;
  existed?: boolean;
  dev?: number;
  ino?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LinkWorker {
  readonly id = `${os.hostname()}`;
  readonly runId = randomUUID();
  readonly writer: LinkWriter;
  private stopped = false;
  private info: ProcessInfo | null = null;
  private lastBeat = 0;
  private active = false;
  private pollMs = 15_000;
  private wake: (() => void) | null = null;

  constructor(
    private readonly config: LinkConfig,
    private readonly log: (m: string) => void = (m) => console.log(m),
    private readonly httpFetch: typeof fetch = fetch
  ) {
    this.writer = new LinkWriter({
      dataDir: config.dataDir,
      dirMode: config.dirMode,
      fileMode: config.fileMode
    });
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  private async server(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await this.httpFetch(`${this.config.serverUrl}/api/v1/cleanup-link${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.serverTimeoutSeconds * 1000)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`server answered ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Record<string, unknown>;
  }

  /** What the page shows about this sidecar (and what the preflight goes by). */
  private async describe(): Promise<{ problem: string | null; info: Record<string, unknown> }> {
    this.info ??= await processInfo();
    const t = await fs.lstat(this.writer.torrents).catch(() => null);
    const m = await fs.lstat(this.writer.media).catch(() => null);
    let problem: string | null = null;
    if (!t?.isDirectory()) problem = `The torrents folder is missing: ${this.writer.torrents}`;
    else if (!m?.isDirectory()) problem = `The audiobooks folder is missing: ${this.writer.media}`;
    else if (t.dev !== m.dev)
      problem =
        'The torrents and media/audiobooks are on different filesystems (mount /mnt/disk1/data once)';
    return {
      problem,
      info: {
        ...this.info,
        dataDir: this.config.dataDir,
        torrentsDev: t?.dev ?? null,
        mediaDev: m?.dev ?? null,
        dirMode: this.config.dirMode.toString(8),
        fileMode: this.config.fileMode.toString(8)
      }
    };
  }

  async heartbeat(): Promise<void> {
    const d = await this.describe();
    const r = await this.server('/heartbeat', {
      sidecarId: this.id,
      runId: this.runId,
      version: VERSION,
      problem: d.problem,
      info: d.info
    });
    this.lastBeat = Date.now();
    this.active = r.active === true;
    if (typeof r.pollSeconds === 'number') this.pollMs = Math.max(250, r.pollSeconds * 1000);
  }

  /** One preflight or build batch: the results in order, a build stopping at its first failure. */
  async process(batch: Batch): Promise<OpResult[]> {
    const results: OpResult[] = [];
    if (batch.kind === 'preflight') {
      this.info ??= await processInfo();
      for (const op of batch.ops) {
        if (!op.src) continue;
        const problem = await inspectSource(
          this.writer,
          {
            rel: op.src.rel,
            raw: op.src.raw,
            size: op.size ?? -1,
            mtimeMs: op.mtimeMs ?? -1,
            dev: op.dev ?? -1,
            ino: op.ino ?? -1
          },
          this.info
        );
        results.push({ id: op.id, ok: problem === null, problem });
      }
      return results;
    }
    for (const op of batch.ops) {
      if (this.stopped) break;
      try {
        if (op.kind === 'folder') {
          const r = await this.writer.makeFolder(op.dst);
          results.push({ id: op.id, ok: true, existed: r.existed });
        } else if (op.kind === 'metadata') {
          const r = await this.writer.writeMetadata(
            op.dst,
            Buffer.from(op.bytes ?? '', 'base64'),
            op.id
          );
          results.push({ id: op.id, ok: true, existed: r.existed });
        } else {
          if (!op.src) throw new WriteRefused('A link needs a source');
          const r = await this.writer.linkFile(
            {
              rel: op.src.rel,
              raw: op.src.raw,
              size: op.size ?? -1,
              mtimeMs: op.mtimeMs ?? -1,
              dev: op.dev ?? -1,
              ino: op.ino ?? -1
            },
            op.dst
          );
          results.push({ id: op.id, ok: true, existed: r.existed, dev: r.dev, ino: r.ino });
        }
      } catch (err) {
        results.push({
          id: op.id,
          ok: false,
          error: `${op.kind} ${op.dst}: ${(err as Error).message}`.slice(0, 500)
        });
        break;
      }
    }
    return results;
  }

  /** Reports a batch's results, trying again until the server has them (they are safe to repeat). */
  private async report(batch: Batch, results: OpResult[]): Promise<void> {
    for (let wait = 2000; ; wait = Math.min(wait * 2, 60_000)) {
      try {
        await this.server(`/batches/${batch.id}/report`, { results });
        return;
      } catch (err) {
        const m = (err as Error).message;
        // The server no longer knows the batch (a new plan): nothing to report to.
        if (/answered 4(04|09)/.test(m)) return;
        this.log(`report of batch ${batch.id} failed (${m}); trying again in ${wait / 1000} s`);
        if (this.stopped) return;
        await sleep(wait);
      }
    }
  }

  /** One round: heartbeat when due, then a batch if there is one. True when it did work. */
  async cycle(): Promise<boolean> {
    if (Date.now() - this.lastBeat >= HEARTBEAT_MS || !this.active) await this.heartbeat();
    if (!this.active) return false;
    const r = await this.server('/claim', { sidecarId: this.id });
    const batch = r.batch as Batch | null;
    if (!batch) return false;
    const t = Date.now();
    const results = await this.process(batch);
    await this.report(batch, results);
    const failed = results.filter((x) => !x.ok && batch.kind === 'build').length;
    this.log(
      `${batch.kind} batch ${batch.id}: ${results.length} of ${batch.ops.length} in ${Date.now() - t} ms` +
        (failed ? `, ${failed} failed` : '')
    );
    return true;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      let worked = false;
      try {
        worked = await this.cycle();
      } catch (err) {
        this.log(`server: ${(err as Error).message}`);
        this.active = false;
        await new Promise<void>((r) => {
          this.wake = r;
          setTimeout(r, 10_000);
        });
        continue;
      }
      if (!worked) {
        await new Promise<void>((r) => {
          this.wake = r;
          setTimeout(r, this.pollMs);
        });
      }
    }
  }
}
