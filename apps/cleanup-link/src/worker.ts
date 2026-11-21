/**
 * The linking sidecar's loop (WP21e-1): a heartbeat, then batches from the reader's server.
 *
 * - preflight batches: every planned torrent file checked (read only, inspect.ts);
 * - build batches: folders, links and metadata files made one after another through the writer
 *   (the only module that writes);
 * - switch batches (WP21e-2): the folder renames, the library-only files' names under
 *   _from-library, the old copy script's files kept, and the entries of japanese-old deleted,
 *   each through the writer. The first operation that fails ends the batch; the server
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
import { entryStream, extractArgs, listArchive, type ArchiveEntry } from './archive';
import { inspectSource, processInfo, type ProcessInfo } from './inspect';
import { LinkWriter, WriteRefused, type PlannedSource } from './writer';

/** 1.2.0 (WP21f-1): new books after the switch (arrival batches) and archives (list, extract). */
export const VERSION = '1.2.0';
const HEARTBEAT_MS = 30_000;

interface BatchOp {
  id: number;
  /**
   * WP21e-1: folder, link, pdf, metadata (the build). WP21e-2 (the switch): rename (a root
   * folder of media/audiobooks: `src.rel` -> `dst`, `ino` the folder's), from_library (`src.rel`
   * in media/audiobooks/japanese -> `dst` under the torrents' _from-library), inventory (`dst`
   * the file's name), delete (`src.rel` in media/audiobooks/japanese-old; `dir` for a folder).
   */
  kind: 'folder' | 'link' | 'pdf' | 'metadata' | 'rename' | 'from_library' | 'inventory' | 'delete';
  dst: string;
  src: { rel: string; raw: string | null } | null;
  size: number | null;
  mtimeMs: number | null;
  dev: number | null;
  ino: number | null;
  bytes: string | null;
  sha256?: string | null;
  dir?: boolean;
  /** WP21f-1 (arrival batches): the new book's folder and its planned entries. */
  book?: string | null;
  planned?: string[] | null;
  /** WP21f-1 (extract batches): the entry inside the archive (`src` is the archive). */
  entry?: { name: string; size: number; encoding: 'utf8' | 'cp932' } | null;
}

interface Batch {
  id: number;
  /** arrival (WP21f-1): a new book's folder, links and metadata; list/extract: archives. */
  kind: 'preflight' | 'build' | 'switch' | 'arrival' | 'list' | 'extract';
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
  sha256?: string;
  freed?: number;
  size?: number;
  absRewrote?: boolean;
  /** list batches: the archive's entries, its names' encoding, or why it can't be read. */
  entries?: ArchiveEntry[];
  encoding?: 'utf8' | 'cp932';
  listProblem?: string | null;
  bytes?: number;
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
    // WP21e-2: the disk's free space, for the deletion's report.
    const free = await fs.statfs(this.writer.media).catch(() => null);
    return {
      problem,
      info: {
        ...this.info,
        freeBytes: free ? Number(free.bavail) * Number(free.bsize) : null,
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
    if (batch.kind === 'list') return this.listBatch(batch);
    if (batch.kind === 'arrival' || batch.kind === 'extract') return this.arrivalBatch(batch);
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
        } else if (op.kind === 'rename') {
          if (!op.src || op.ino === null) throw new WriteRefused('A rename needs a folder');
          const r = await this.writer.renameRoot(op.src.rel, op.dst, op.ino);
          results.push({ id: op.id, ok: true, existed: r.existed });
        } else if (op.kind === 'from_library') {
          if (!op.src || !op.sha256) throw new WriteRefused('A library-only file needs a source');
          const r = await this.writer.linkToFromLibrary(
            {
              rel: op.src.rel,
              raw: op.src.raw,
              size: op.size ?? -1,
              mtimeMs: op.mtimeMs ?? -1,
              dev: op.dev ?? -1,
              ino: op.ino ?? -1,
              sha256: op.sha256
            },
            op.dst
          );
          results.push({
            id: op.id,
            ok: true,
            existed: r.existed,
            dev: r.dev,
            ino: r.ino,
            sha256: r.sha256
          });
        } else if (op.kind === 'inventory') {
          const r = await this.writer.copyInventory(op.dst, {
            size: op.size ?? -1,
            mtimeMs: op.mtimeMs ?? -1,
            dev: op.dev ?? -1,
            ino: op.ino ?? -1
          });
          results.push({ id: op.id, ok: true, existed: r.existed, size: r.size });
        } else if (op.kind === 'delete') {
          if (!op.src) throw new WriteRefused('A delete needs an entry');
          const r = await this.writer.deleteOld({
            rel: op.src.rel,
            raw: op.src.raw,
            size: op.size ?? -1,
            mtimeMs: op.mtimeMs ?? -1,
            dev: op.dev ?? -1,
            ino: op.ino ?? -1,
            dir: op.dir === true
          });
          results.push({ id: op.id, ok: true, existed: r.existed, freed: r.freed });
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

  private planned(op: BatchOp): PlannedSource {
    if (!op.src) throw new WriteRefused('A source is needed');
    return {
      rel: op.src.rel,
      raw: op.src.raw,
      size: op.size ?? -1,
      mtimeMs: op.mtimeMs ?? -1,
      dev: op.dev ?? -1,
      ino: op.ino ?? -1
    };
  }

  /** WP21f-1: archives listed (read only): every entry, or why the archive can't be read. */
  private async listBatch(batch: Batch): Promise<OpResult[]> {
    const results: OpResult[] = [];
    for (const op of batch.ops) {
      if (this.stopped) break;
      try {
        const handle = await this.writer.openArchive(this.planned(op));
        try {
          const l = await listArchive(this.config.bsdtar, handle, this.config.archiveCharset);
          results.push({
            id: op.id,
            ok: true,
            entries: l.entries,
            encoding: l.encoding,
            listProblem: l.problem
          });
        } finally {
          await handle.close();
        }
      } catch (err) {
        results.push({
          id: op.id,
          ok: true,
          entries: [],
          listProblem: (err as Error).message.slice(0, 500)
        });
      }
    }
    return results;
  }

  /** WP21f-1: a new book's operations, or archive entries unpacked; stops at the first failure. */
  private async arrivalBatch(batch: Batch): Promise<OpResult[]> {
    const results: OpResult[] = [];
    for (const op of batch.ops) {
      if (this.stopped) break;
      try {
        if (batch.kind === 'extract') {
          if (!op.entry) throw new WriteRefused('An entry is needed');
          const e = op.entry;
          const r = await this.writer.extractEntry(this.planned(op), op.dst, e.size, op.id, (h) =>
            entryStream(
              this.config.bsdtar,
              h,
              extractArgs(e.name, e.encoding, this.config.archiveCharset)
            )
          );
          results.push({ id: op.id, ok: true, existed: r.existed, bytes: r.bytes });
          continue;
        }
        const book = op.book ?? '';
        const planned = op.planned ?? [];
        if (op.kind === 'folder') {
          const r = await this.writer.makeArrivalFolder(op.dst, book, planned);
          results.push({ id: op.id, ok: true, existed: r.existed });
        } else if (op.kind === 'metadata') {
          const r = await this.writer.writeArrivalMetadata(
            op.dst,
            Buffer.from(op.bytes ?? '', 'base64'),
            op.id,
            book,
            planned
          );
          results.push({ id: op.id, ok: true, existed: r.existed, absRewrote: r.absRewrote });
        } else if (op.kind === 'link' || op.kind === 'pdf') {
          const r = await this.writer.linkArrival(this.planned(op), op.dst, book, planned);
          results.push({ id: op.id, ok: true, existed: r.existed, dev: r.dev, ino: r.ino });
        } else throw new WriteRefused(`Not an operation of a new book: ${op.kind}`);
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
    const failed = results.filter((x) => !x.ok && batch.kind !== 'preflight').length;
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
