/**
 * The apply sidecar's loop (WP20a): heartbeat with the safety-check results, claim a
 * batch, then for each item one step at a time, each reported to the server and
 * acknowledged before the next:
 *
 *   apply: verify (same Calibre record, kept copy present) -> export to the quarantine
 *          (the EPUB's SHA-256 must match) -> remove (to Calibre's trash).
 *   undo:  restore from Calibre's trash (same id and UUID, calibre 9.18+), else re-add the
 *          quarantined export (new id and UUID; the server re-binds the reader's book).
 *
 *   stage 2 (WP20b), per book: list what Calibre shows (one call per chunk of books) ->
 *          the server says what to write -> keep Calibre's old cover in the quarantine when a
 *          cover is replaced -> download the EPUB's cover -> one set_metadata call with all the
 *          book's fields -> list again and report; after an error or timeout, wait until
 *          Calibre shows the new values (never write twice).
 *
 * All state is on the server; after a restart (or the server's nightly stop) the sidecar
 * claims the batch again and continues from each item's state. Every step is safe to
 * repeat: an export is found again by its SHA-256, a removal is checked with `list`, an
 * interrupted re-add is found by the ids that appeared since its note was written.
 */
import fsp from 'fs/promises';
import path from 'path';
import {
  type Batch,
  type BatchItem,
  type CalibreLogin,
  type CheckResult,
  type HeartbeatAnswer,
  isFinal,
  ServerApi,
  ServerError,
  type Stage2Book,
  type StepReport
} from './api';
import {
  Calibredb,
  calibreTime,
  type Login,
  type RunResult,
  sameVersion,
  shorten,
  versionAtLeast
} from './calibredb';
import type { SidecarConfig } from './config';
import { exists, Quarantine, sha256File } from './quarantine';

export const SIDECAR_VERSION = '1.0.0';
/** calibredb's `trash restore` exists from this version on. */
export const TRASH_RESTORE_VERSION = '9.18.0';
/** Heartbeats while a check or a batch runs (the server calls a sidecar silent for 90 s offline). */
export const KEEPALIVE_MS = 30_000;

/** An answer from Calibre that waiting won't change (stops pollUntil at once). */
export class StopWaiting extends Error {}

/** What an Undo batch asked Calibre's trash for (kept in the batch's quarantine folder). */
export interface TrashRestorePlan {
  /** Books a trash restore was asked for: waited for, never re-added (no double copies). */
  requested: number[];
  /** Books Calibre said are not in its trash any more: re-added from the quarantine. */
  notInTrash: number[];
  /** When the restore was asked for (ms). */
  requestedAt: number;
}

export interface Logger {
  info(m: string): void;
  error(m: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`${new Date().toISOString()} ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`)
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WorkerOptions {
  config: SidecarConfig;
  api?: ServerApi;
  calibredb?: Calibredb;
  log?: Logger;
  /** Shortest and longest pause between retries when the server is away (ms). */
  retryMinMs?: number;
  retryMaxMs?: number;
  fetchImpl?: typeof fetch;
}

export class Worker {
  readonly api: ServerApi;
  readonly calibredb: Calibredb;
  readonly quarantine: Quarantine;
  private readonly log: Logger;
  private stopped = false;
  private checks: CheckResult[] = [];
  private checkedAt = 0;
  private calibredbVersion: string | null = null;
  private serverVersion: string | null = null;
  private trashRestore: boolean | null = null;
  private problem: string | null = null;
  private login: CalibreLogin | null = null;
  private libraries: string[] = [];
  private itemDelayMs = 2000;
  private pollMs = 15000;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WorkerOptions) {
    const c = opts.config;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.api =
      opts.api ??
      new ServerApi(c.serverUrl, c.token, c.requestTimeoutSeconds * 1000, this.fetchImpl);
    this.calibredb =
      opts.calibredb ??
      new Calibredb({ program: c.calibredb, timeoutMs: c.calibredbTimeoutSeconds * 1000 });
    this.quarantine = new Quarantine(c.quarantineDir);
    this.log = opts.log ?? consoleLogger;
    this.retryMinMs = opts.retryMinMs ?? 2000;
    this.retryMaxMs = opts.retryMaxMs ?? 60000;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Runs until stop(). */
  async run(): Promise<void> {
    this.log.info(`Cleanup sidecar ${SIDECAR_VERSION}: server ${this.opts.config.serverUrl}`);
    // Heartbeats also while the checks or a batch take long (calibredb against a big library
    // can take minutes), so the page never shows a working sidecar as not running.
    const beat = setInterval(() => void this.keepAlive(), KEEPALIVE_MS);
    try {
      while (!this.stopped) {
        try {
          await this.cycle();
        } catch (err) {
          this.log.error(`cycle: ${(err as Error).message}`);
        }
        if (!this.stopped) await sleep(this.pollMs);
      }
    } finally {
      clearInterval(beat);
    }
  }

  private beating = false;

  /** One heartbeat without retrying (the main loop retries); errors are ignored. */
  async keepAlive(): Promise<void> {
    if (this.beating || this.stopped) return;
    this.beating = true;
    try {
      this.applyAnswer(await this.api.heartbeat(this.heartbeatBody()));
    } catch {
      // The server is away (the nightly backup); the main loop waits for it.
    } finally {
      this.beating = false;
    }
  }

  /** One round: checks (when due), heartbeat, and one batch if there is one. */
  async cycle(): Promise<'batch' | 'idle'> {
    await this.heartbeat();
    if (Date.now() - this.checkedAt >= this.opts.config.checkSeconds * 1000) {
      await this.runChecks();
      const libraryBefore = this.login?.libraryId ?? null;
      await this.heartbeat();
      // The server picked the library from the list just sent: check that library now.
      if ((this.login?.libraryId ?? null) !== libraryBefore) {
        await this.runChecks();
        await this.heartbeat();
      }
    }
    if (!this.login?.libraryId) return 'idle';
    const { batch, wait } = await this.retry(() => this.api.claim());
    if (!batch) {
      if (wait) this.log.info(`No batch yet: ${wait}`);
      return 'idle';
    }
    await this.processBatch(batch);
    return 'batch';
  }

  private heartbeatBody() {
    return {
      version: SIDECAR_VERSION,
      calibredb: this.calibredbVersion ? `calibredb (calibre ${this.calibredbVersion})` : null,
      serverVersion: this.serverVersion ? `calibre ${this.serverVersion}` : null,
      trashRestore: this.trashRestore,
      problem: this.problem ? shorten(this.problem, 1500) : this.problem,
      checks: this.checks.map((c) => ({
        ...c,
        detail: c.detail ? shorten(c.detail, 1500) : c.detail
      })),
      libraries: this.libraries
    };
  }

  private async heartbeat(): Promise<void> {
    this.applyAnswer(await this.retry(() => this.api.heartbeat(this.heartbeatBody())));
  }

  private applyAnswer(answer: HeartbeatAnswer): void {
    const changed = JSON.stringify(answer.calibre) !== JSON.stringify(this.login);
    this.login = answer.calibre;
    this.itemDelayMs = Math.max(0, answer.itemDelaySeconds * 1000);
    this.pollMs = Math.max(1000, answer.pollSeconds * 1000);
    if (changed) this.checkedAt = 0;
  }

  /**
   * Retries a server call until the server answers (it is stopped every night for the
   * backup). Errors that waiting won't fix are thrown.
   */
  async retry<T>(fn: () => Promise<T>): Promise<T> {
    let wait = this.retryMinMs;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (isFinal(err) || this.stopped) throw err;
        this.log.info(
          `Server not reachable (${(err as Error).message}); trying again in ${Math.round(wait / 1000)} s`
        );
        await sleep(wait);
        wait = Math.min(this.retryMaxMs, wait * 2);
      }
    }
  }

  /** The safety checks (stage 0), sent with every heartbeat. */
  async runChecks(): Promise<CheckResult[]> {
    const out: CheckResult[] = [];
    const add = (name: string, ok: boolean, detail: string | null = null) =>
      out.push({ name, ok, detail });
    try {
      this.calibredbVersion = await this.calibredb.version();
    } catch (err) {
      this.calibredbVersion = null;
      this.problem = (err as Error).message;
    }
    const q = await this.quarantine.check(this.opts.config.minFreeMb);
    add('quarantine_writable', q.ok, q.detail);
    const login = this.login;
    if (!login) {
      add('content_server', false, 'The Calibre settings are not complete on /cleanup');
      this.checks = out;
      this.checkedAt = Date.now();
      return out;
    }
    // The content server's version is in its Server header ("calibre 9.18.0").
    try {
      const res = await this.fetchImpl(`${login.contentServerUrl.replace(/\/+$/, '')}/`, {
        method: 'GET',
        signal: AbortSignal.timeout(15000)
      });
      const server = res.headers.get('server') ?? '';
      void res.body?.cancel().catch(() => {});
      const m = /calibre\s+(\d+\.\d+(?:\.\d+)?)/i.exec(server);
      this.serverVersion = m ? m[1] : null;
      add('content_server', true, server || `HTTP ${res.status}`);
    } catch (err) {
      this.serverVersion = null;
      add('content_server', false, (err as Error).message);
    }
    const same = sameVersion(this.serverVersion, this.calibredbVersion);
    add(
      'versions_match',
      same,
      `content server ${this.serverVersion ?? '?'}, sidecar calibredb ${this.calibredbVersion ?? '?'}`
    );
    // The server's libraries (`#-` needs no library id); the reader's server picks the one to
    // clean from this list, so nobody has to type the id.
    try {
      const r = await this.calibredb.run('libraries', { ...login, libraryId: '-' });
      add('login', r.code === 0, r.code === 0 ? null : (r.stderr || r.stdout).trim().slice(-300));
      this.libraries = r.code === 0 ? parseLibraryIds(r.stdout) : [];
    } catch (err) {
      add('login', false, (err as Error).message);
      this.libraries = [];
    }
    if (!login.libraryId) {
      add('illustrator_column', false, 'Waiting until the library on the content server is known');
      this.trashRestore = null;
      this.checks = out;
      this.checkedAt = Date.now();
      return out;
    }
    const lib: Login = { ...login, libraryId: login.libraryId };
    try {
      const r = await this.calibredb.ok('custom_columns', lib);
      const ok = hasMultipleTextColumn(r.stdout, 'illustrator');
      const block = firstBlock(r.stdout, 'illustrator');
      add(
        'illustrator_column',
        ok,
        ok
          ? null
          : block
            ? `#illustrator is not a multiple-value text column: ${block.replace(/\s+/g, ' ').slice(0, 200)}`
            : 'Add it in Calibre: Preferences > Add your own columns, lookup name "illustrator", comma separated text'
      );
    } catch (err) {
      add('illustrator_column', false, (err as Error).message);
    }
    // `calibredb trash restore` exists from 9.18 on. The trash isn't listed here: with
    // thousands of entries that takes minutes (it did on the NAS, 2026-11-13); Undo simply
    // tries the restore and falls back to the quarantine copy.
    const trash =
      versionAtLeast(this.serverVersion, TRASH_RESTORE_VERSION) &&
      versionAtLeast(this.calibredbVersion, TRASH_RESTORE_VERSION);
    this.trashRestore = trash;
    add(
      'trash_restore',
      trash,
      trash
        ? null
        : `needs calibre ${TRASH_RESTORE_VERSION} or newer on both sides (content server ${this.serverVersion ?? '?'}, sidecar ${this.calibredbVersion ?? '?'})`
    );
    this.checks = out;
    this.checkedAt = Date.now();
    return out;
  }

  private requireLogin(): Login {
    if (!this.login?.libraryId) throw new Error('No Calibre login or library yet');
    return { ...this.login, libraryId: this.login.libraryId };
  }

  /** Reports a step; the next step starts only after the server's answer. */
  private async report(batch: Batch, item: BatchItem, report: StepReport): Promise<void> {
    // A long error message must never make the report itself too large for the server.
    const sent = report.detail ? { ...report, detail: shorten(report.detail, 1500) } : report;
    await this.retry(() => this.api.report(batch.id, item.itemId, sent));
    item.state = report.step;
  }

  async processBatch(batch: Batch): Promise<void> {
    this.log.info(`Batch ${batch.id} (${batch.kind}, ${batch.items.length} items)`);
    const lease = setInterval(
      () => {
        void this.api.progress(batch.id).catch(() => {});
      },
      Math.max(5000, (batch.leaseSeconds * 1000) / 4)
    );
    let error: string | null = null;
    try {
      await this.quarantine.makeBatchDir(batch.id);
      await this.quarantine.createOnce(
        path.join(this.quarantine.batchDir(batch.id), 'batch.json'),
        JSON.stringify(
          { id: batch.id, kind: batch.kind, stage: batch.stage, createdAt: batch.createdAt },
          null,
          2
        )
      );
      if (!batch.snapshotSaved) await this.saveSnapshot(batch);
      if (batch.stage === 2) {
        await this.stage2Books(batch);
        if (this.stopped) return;
      }
      const plan =
        batch.kind === 'undo' && batch.stage !== 2 ? await this.requestTrashRestore(batch) : null;
      for (const item of batch.stage === 2 ? [] : batch.items) {
        if (this.stopped) return;
        const final =
          batch.kind === 'apply'
            ? ['removed', 'failed', 'skipped']
            : ['restored', 'failed', 'skipped'];
        if (final.includes(item.state)) continue;
        try {
          if (batch.kind === 'apply') await this.applyItem(batch, item);
          else await this.undoItem(batch, item, plan!);
        } catch (err) {
          if (err instanceof ServerError) throw err;
          // Stopping (SIGTERM) can kill a calibredb call; the step is repeated after the restart.
          if (this.stopped) return;
          const message = (err as Error).message;
          this.log.error(`Item ${item.calibreId}: ${message}`);
          await this.report(batch, item, { step: 'failed', detail: message });
        }
        if (this.itemDelayMs > 0) await sleep(this.itemDelayMs);
      }
    } catch (err) {
      error = (err as Error).message;
      this.log.error(`Batch ${batch.id}: ${error}`);
      if (err instanceof ServerError && err.code === 'not_claimed') return; // claimed again later
    } finally {
      clearInterval(lease);
    }
    if (this.stopped) return;
    const sentError = error === null ? null : shorten(error, 1500);
    await this.retry(() => this.api.finish(batch.id, sentError));
    this.log.info(`Batch ${batch.id} finished${error ? ` with an error: ${error}` : ''}`);
  }

  /** Stage 2: Calibre's view of these books, asking again while Calibre is busy (408). */
  private async listChunk(
    login: Login,
    ids: number[],
    fields: string
  ): Promise<Map<number, Record<string, unknown>>> {
    const until = Date.now() + this.opts.config.writeWaitSeconds * 1000;
    const found = await this.pollUntil(until, () => this.calibredb.listBooks(login, ids, fields));
    if (!found) throw new Error("Calibre didn't answer a list of the batch's books");
    return found;
  }

  /** Stage 2 (WP20b): every book of the batch, a chunk at a time. */
  private async stage2Books(batch: Batch): Promise<void> {
    const login = this.requireLogin();
    const fields = batch.listFields ?? 'uuid,title,authors,last_modified';
    const chunkSize = Math.max(1, batch.chunkSize ?? 25);
    const final =
      batch.kind === 'apply' ? ['written', 'failed', 'skipped'] : ['restored', 'failed', 'skipped'];
    const books = (batch.books ?? []).filter((b) => !final.includes(b.state));
    await fsp.mkdir(this.opts.config.coverTmpDir, { recursive: true });
    for (let i = 0; i < books.length; i += chunkSize) {
      if (this.stopped) return;
      const chunk = books.slice(i, i + chunkSize);
      const before = await this.listChunk(
        login,
        chunk.map((b) => b.calibreId),
        fields
      );
      const attempted: {
        book: Stage2Book;
        error: string | null;
        oldCoverPath: string | null;
        coverSkipped: string | null;
      }[] = [];
      for (const book of chunk) {
        if (this.stopped) return;
        const a = await this.writeBook(batch, login, book, before.get(book.calibreId) ?? null);
        if (a) attempted.push(a);
        if (this.itemDelayMs > 0 && a) await sleep(this.itemDelayMs);
      }
      if (attempted.length === 0) continue;
      const after = await this.listChunk(
        login,
        attempted.map((a) => a.book.calibreId),
        fields
      );
      for (const a of attempted) {
        if (this.stopped) return;
        await this.confirmBook(batch, login, a, after.get(a.book.calibreId) ?? null, fields);
      }
    }
  }

  /** Where Calibre's old cover of a book is kept (apply batch's quarantine folder). */
  private oldCoverFile(batch: Batch, calibreId: number): string {
    return path.join(this.quarantine.batchDir(batch.id), String(calibreId), 'old-cover.jpg');
  }

  /** Verify with the server, then one set_metadata call. Returns what was attempted, or null. */
  private async writeBook(
    batch: Batch,
    login: Login,
    book: Stage2Book,
    current: Record<string, unknown> | null
  ): Promise<{
    book: Stage2Book;
    error: string | null;
    oldCoverPath: string | null;
    coverSkipped: string | null;
  } | null> {
    const keptOld = batch.kind === 'apply' ? this.oldCoverFile(batch, book.calibreId) : null;
    const oldCoverPath = keptOld && (await exists(keptOld)) ? keptOld : null;
    const answer = await this.retry(() =>
      this.api.verifyBook(batch.id, book.calibreId, { current, oldCoverPath })
    );
    for (const it of answer.items) {
      const f = book.fields.find((x) => x.itemId === it.itemId);
      if (f) f.state = it.state;
    }
    if (answer.action !== 'write') return null;
    const fields = [...answer.fields];
    let coverSkipped: string | null = null;
    let savedOld = oldCoverPath;
    let tmp: string | null = null;
    if (answer.cover) {
      if (batch.kind === 'apply') {
        if (answer.saveOldCover && !savedOld) {
          try {
            const file = this.oldCoverFile(batch, book.calibreId);
            await fsp.mkdir(path.dirname(file), { recursive: true });
            await this.retry(() =>
              this.api.downloadCover(batch.id, book.calibreId, 'old-cover', file)
            );
            savedOld = file;
          } catch (err) {
            coverSkipped = `Calibre's old cover couldn't be kept in the quarantine: ${shorten((err as Error).message, 300)}`;
          }
        }
        if (!coverSkipped) {
          const base = path.join(this.opts.config.coverTmpDir, `${batch.id}-${book.calibreId}`);
          try {
            // Only this sidecar writes its temp folder: a leftover from a stop is replaced.
            for (const ext of ['jpg', 'png', 'part'])
              await fsp.rm(`${base}.${ext}`, { force: true });
            const part = `${base}.part`;
            const got = await this.retry(() =>
              this.api.downloadCover(batch.id, book.calibreId, 'cover', part)
            );
            if (got.sha256 && (await sha256File(part)) !== got.sha256)
              throw new Error('The cover download is incomplete');
            tmp = `${base}.${got.ext === 'png' ? 'png' : 'jpg'}`;
            await fsp.rename(part, tmp);
            fields.push(`cover:${tmp}`);
          } catch (err) {
            coverSkipped = `The book's cover couldn't be fetched: ${shorten((err as Error).message, 300)}`;
          }
        }
      } else if (answer.oldCoverPath && (await exists(answer.oldCoverPath))) {
        fields.push(`cover:${answer.oldCoverPath}`);
      } else {
        coverSkipped = "Calibre's old cover is not in the quarantine any more";
      }
    }
    let error: string | null = null;
    if (fields.length > 0) {
      try {
        await this.calibredb.setFields(login, book.calibreId, fields, [
          this.opts.config.coverTmpDir,
          this.opts.config.quarantineDir
        ]);
      } catch (err) {
        if (this.stopped) throw err;
        error = shorten((err as Error).message, 1000);
        this.log.error(`Book ${book.calibreId}: ${error}`);
      } finally {
        if (tmp) await fsp.rm(tmp, { force: true }).catch(() => {});
      }
    }
    return { book, error, oldCoverPath: savedOld, coverSkipped };
  }

  /**
   * What Calibre shows after the write decides. After an error or a timeout the write may
   * still happen (the content server keeps working after its 408): look again until it shows
   * or the wait is over. Never written twice.
   */
  private async confirmBook(
    batch: Batch,
    login: Login,
    a: {
      book: Stage2Book;
      error: string | null;
      oldCoverPath: string | null;
      coverSkipped: string | null;
    },
    current: Record<string, unknown> | null,
    fields: string
  ): Promise<void> {
    const send = (cur: unknown, finalReport: boolean) =>
      this.retry(() =>
        this.api.writtenBook(batch.id, a.book.calibreId, {
          current: cur,
          error: a.error,
          final: finalReport,
          oldCoverPath: a.oldCoverPath,
          coverSkipped: a.coverSkipped
        })
      );
    let answer = await send(current, false);
    if (!answer.done) {
      const until = Date.now() + this.opts.config.writeWaitSeconds * 1000;
      const done = await this.pollUntil(until, async () => {
        const now =
          (await this.calibredb.listBooks(login, [a.book.calibreId], fields)).get(
            a.book.calibreId
          ) ?? null;
        const r = await send(now, false);
        return r.done ? r : null;
      });
      if (done) answer = done;
      else {
        let last: unknown = null;
        try {
          last =
            (await this.calibredb.listBooks(login, [a.book.calibreId], fields)).get(
              a.book.calibreId
            ) ?? null;
        } catch {
          // Calibre still busy: the server marks what it can't see as failed.
        }
        answer = await send(last, true);
      }
    }
    for (const it of answer.items) {
      const f = a.book.fields.find((x) => x.itemId === it.itemId);
      if (f) f.state = it.state;
    }
  }

  /** The metadata.db snapshot, saved into the batch folder before the first item. */
  private async saveSnapshot(batch: Batch): Promise<void> {
    const dir = this.quarantine.batchDir(batch.id);
    // An earlier attempt may have saved it already.
    for (let n = 1; n < 100; n++) {
      const file = path.join(dir, n === 1 ? 'metadata.db' : `metadata-${n}.db`);
      if (!(await exists(file))) {
        await this.retry(() => this.api.downloadSnapshot(batch.id, file));
        const sha = await sha256File(file);
        if (batch.snapshotSha256 && sha !== batch.snapshotSha256) {
          throw new Error('The downloaded metadata.db snapshot is incomplete; trying again later');
        }
        await this.retry(() => this.api.snapshotSaved(batch.id, sha));
        return;
      }
      if (batch.snapshotSha256 && (await sha256File(file)) === batch.snapshotSha256) {
        await this.retry(() => this.api.snapshotSaved(batch.id, batch.snapshotSha256!));
        return;
      }
    }
    throw new Error('Too many snapshot files in the batch folder');
  }

  private async applyItem(batch: Batch, item: BatchItem): Promise<void> {
    const login = this.requireLogin();
    if (item.state === 'pending') {
      const book = await this.calibredb.book(login, item.calibreId);
      if (!book) {
        await this.report(batch, item, {
          step: 'skipped',
          detail: 'The copy is no longer in Calibre'
        });
        return;
      }
      if (book.uuid !== item.uuid) {
        await this.report(batch, item, {
          step: 'skipped',
          detail: 'The Calibre id now belongs to another book'
        });
        return;
      }
      if (!hasEpub(book.formats)) {
        await this.report(batch, item, {
          step: 'skipped',
          detail: 'The copy has no EPUB in Calibre any more'
        });
        return;
      }
      const then = calibreTime(item.lastModified);
      const now = calibreTime(book.last_modified);
      if (then !== null && now !== null && Math.abs(now - then) > 1000) {
        await this.report(batch, item, {
          step: 'skipped',
          detail: 'The copy was changed in Calibre since the analysis'
        });
        return;
      }
      const kept = await this.calibredb.book(login, item.kept.calibreId);
      const keptProblem = keptCopyProblem(kept, item.kept.uuid);
      if (keptProblem) {
        await this.report(batch, item, { step: 'skipped', detail: keptProblem });
        return;
      }
      await this.report(batch, item, { step: 'verified' });
    }
    if (item.state === 'verified') {
      const dir = await this.exportItem(batch, item, login);
      const epub = await this.quarantine.epubIn(dir);
      if (!epub) throw new Error('The export has no EPUB');
      const sha = await sha256File(epub);
      if (sha !== item.sha256) {
        await this.report(batch, item, {
          step: 'failed',
          detail: `The exported EPUB differs from the analysed file (${sha.slice(0, 12)}…); nothing was removed`
        });
        return;
      }
      await this.quarantine.createOnce(
        path.join(this.quarantine.batchDir(batch.id), `${item.calibreId}.json`),
        JSON.stringify(
          {
            removed: {
              calibreId: item.calibreId,
              uuid: item.uuid,
              title: item.title,
              formats: item.formats
            },
            duplicateOf: item.kept,
            sha256: item.sha256,
            exportedTo: path.basename(dir),
            exportedAt: new Date().toISOString()
          },
          null,
          2
        )
      );
      await this.report(batch, item, { step: 'exported', quarantineDir: dir, exportSha256: sha });
    }
    if (item.state === 'exported') {
      // Decided with the user 2026-11-13: the removed copy's own tags (PeepoHappyBooks,
      // TMW-collection-*, ...) are added to the copy that stays instead of leaving with it.
      if (item.addTags.length > 0) {
        const kept = await this.calibredb.book(login, item.kept.calibreId);
        if (!kept || kept.uuid !== item.kept.uuid) throw new Error('The copy to keep is gone');
        const have = new Set(kept.tags.map((t) => t.toLowerCase()));
        const missing = item.addTags.filter((t) => !have.has(t.toLowerCase()));
        if (missing.length > 0) {
          await this.calibredb.setTags(login, kept.id, [...kept.tags, ...missing]);
          const after = await this.calibredb.book(login, kept.id);
          const now = new Set((after?.tags ?? []).map((t) => t.toLowerCase()));
          if (!missing.every((t) => now.has(t.toLowerCase()))) {
            throw new Error('Calibre did not keep the added tags');
          }
          this.log.info(`Added ${missing.join(', ')} to ${kept.id} (from ${item.calibreId})`);
        }
      }
      await this.report(batch, item, { step: 'tagged' });
    }
    if (item.state === 'tagged') {
      const present = await this.calibredb.book(login, item.calibreId);
      if (present) {
        // Right before the one step that can't be taken back by the cleanup alone: the copy
        // that stays must still be there with its EPUB.
        const keptProblem = keptCopyProblem(
          await this.calibredb.book(login, item.kept.calibreId),
          item.kept.uuid
        );
        if (keptProblem) {
          await this.report(batch, item, { step: 'skipped', detail: keptProblem });
          return;
        }
        try {
          await this.calibredb.ok('remove', login, [String(item.calibreId)]);
        } catch (err) {
          // The request can time out while Calibre still removes the book (seen on the NAS,
          // 2026-11-14): look whether it goes before calling the item failed, or the removal
          // would be missing from the records (no Undo, no handoff).
          if (this.stopped) throw err;
          this.log.info(
            `Remove ${item.calibreId}: ${shorten((err as Error).message, 200)}; waiting to see whether Calibre removes it`
          );
          if (!(await this.waitUntilGone(login, item))) throw err;
        }
      }
      if (await this.calibredb.book(login, item.calibreId)) {
        throw new Error('Calibre still lists the copy after remove');
      }
      await this.report(batch, item, { step: 'removed' });
      this.log.info(
        `Removed ${item.calibreId} (duplicate of ${item.kept.calibreId}): ${item.title}`
      );
    }
  }

  /** Exports one copy into a new folder of the batch (or finds an earlier complete export). */
  private async exportItem(batch: Batch, item: BatchItem, login: Login): Promise<string> {
    const earlier = await this.quarantine.findExport(batch.id, item.calibreId, item.sha256);
    if (earlier) return earlier;
    const dir = await this.quarantine.freshName(
      this.quarantine.batchDir(batch.id),
      String(item.calibreId)
    );
    await fsp.mkdir(dir);
    await this.calibredb.ok('export', login, [
      '--to-dir',
      dir,
      '--single-dir',
      '--dont-update-metadata',
      '--template',
      'book',
      String(item.calibreId)
    ]);
    return dir;
  }

  /**
   * Undo: the tags this removal added to the kept copy come off again (only those; other tags,
   * also ones the user added since, stay), then the item is reported as brought back.
   */
  private async restored(batch: Batch, item: BatchItem, report: StepReport): Promise<void> {
    if (item.addTags.length > 0) {
      const login = this.requireLogin();
      const kept = await this.calibredb.book(login, item.kept.calibreId);
      if (kept) {
        const off = new Set(item.addTags.map((t) => t.toLowerCase()));
        const left = kept.tags.filter((t) => !off.has(t.toLowerCase()));
        if (left.length !== kept.tags.length) await this.calibredb.setTags(login, kept.id, left);
      }
    }
    await this.report(batch, item, report);
  }

  /**
   * Undo, once per batch before its items: asks Calibre's trash for all the batch's books that
   * aren't back yet in ONE call. Calibre reads its whole trash on every call (minutes with
   * thousands of entries on the NAS) and keeps restoring after the request itself times out
   * (HTTP 408), so the items then wait for their books to reappear.
   *
   * Never two overlapping requests: the plan is written to the batch's quarantine folder
   * before asking, and after a restart a plan younger than the wait is waited on instead of
   * asking again. A book is re-added from the quarantine only when Calibre answered that it
   * isn't in its trash, so a book that is still coming back is never added a second time.
   */
  private async requestTrashRestore(batch: Batch): Promise<TrashRestorePlan> {
    const open = batch.items.filter((i) => !['restored', 'failed', 'skipped'].includes(i.state));
    const plan: TrashRestorePlan = { requested: [], notInTrash: [], requestedAt: Date.now() };
    if (open.length === 0) return plan;
    if (!this.trashRestore) {
      // Calibre older than 9.18 has no trash restore: re-add from the quarantine.
      plan.notInTrash = open.map((i) => i.calibreId);
      return plan;
    }
    const dir = this.quarantine.batchDir(batch.id);
    const earlier = await latestRestorePlan(dir);
    const waitMs = this.opts.config.trashRestoreWaitSeconds * 1000;
    if (earlier && Date.now() - earlier.requestedAt < waitMs) {
      this.log.info(`Undo ${batch.id}: waiting for the trash restore asked for earlier`);
      return earlier;
    }
    const login = this.requireLogin();
    let present = new Map<number, string>();
    try {
      present = await this.calibredb.presentUuids(
        login,
        open.map((i) => i.calibreId)
      );
    } catch (err) {
      // Calibre is busy: the trash is asked for every book; one already back is simply not
      // in the trash any more, and each item looks for its book before anything else.
      this.log.info(
        `Undo ${batch.id}: couldn't see which books are back yet: ${shorten((err as Error).message, 160)}`
      );
    }
    const notBack = open.filter((i) => present.get(i.calibreId) !== i.uuid);
    // Books the server saw are no longer in Calibre's trash folder go straight to re-adding:
    // on a big trash calibre answers HTTP 408 to every restore, which would also hide its
    // refusal of the whole request because of them (nothing would come back).
    plan.notInTrash.push(
      ...notBack.filter((i) => i.inCalibreTrash === false).map((i) => i.calibreId)
    );
    let ask = notBack.filter((i) => i.inCalibreTrash !== false).map((i) => i.calibreId);
    // Calibre refuses the whole call when any id isn't in its trash, naming those ids: they
    // are set aside (re-added later) and the rest is asked for again.
    for (let attempt = 0; attempt < 5 && ask.length > 0; attempt++) {
      plan.requestedAt = Date.now();
      await this.saveRestorePlan(dir, { ...plan, requested: [...plan.requested, ...ask] });
      let r: RunResult | null = null;
      try {
        r = await this.calibredb.run('trash_restore', login, ask.map(String));
      } catch (err) {
        // Our own time limit stopped calibredb; Calibre may still be working on it.
        this.log.info(`Undo ${batch.id}: ${(err as Error).message}`);
      }
      const missing = r && r.code !== 0 ? notInTrashIds(`${r.stderr}\n${r.stdout}`) : [];
      if (missing.length > 0) {
        plan.notInTrash.push(...ask.filter((id) => missing.includes(id)));
        ask = ask.filter((id) => !missing.includes(id));
        continue;
      }
      plan.requested.push(...ask);
      const said = r
        ? shorten(`${r.stderr}\n${r.stdout}`.trim().split(/\r?\n/).pop() ?? '', 200)
        : '';
      this.log.info(
        `Undo ${batch.id}: asked Calibre's trash for ${ask.length} books (${r ? `exit ${r.code}${said ? `: ${said}` : ''}` : 'no answer yet'})`
      );
      ask = [];
    }
    await this.saveRestorePlan(dir, plan);
    return plan;
  }

  private async saveRestorePlan(dir: string, plan: TrashRestorePlan): Promise<void> {
    // A new file each time: nothing in the quarantine is ever overwritten.
    const file = await this.quarantine.freshName(dir, `trash-restore-${Date.now()}`, '.json');
    await this.quarantine.createOnce(file, JSON.stringify(plan, null, 2));
  }

  /** True once the copy is gone from Calibre, waiting up to the configured time. */
  /**
   * Looks every WAIT_POLL_SECONDS until `check` gives a value or `until` (ms) passes. A look
   * that fails (calibre busy: HTTP 408, a network timeout) only means "not known yet".
   */
  private async pollUntil<T>(until: number, check: () => Promise<T | null>): Promise<T | null> {
    for (;;) {
      try {
        const found = await check();
        if (found !== null) return found;
      } catch (err) {
        if (err instanceof StopWaiting) throw err;
        this.log.info(`Calibre didn't answer yet: ${shorten((err as Error).message, 160)}`);
      }
      if (this.stopped) throw new Error('Stopping');
      if (Date.now() >= until) return null;
      await sleep(
        Math.min(this.opts.config.waitPollSeconds * 1000, Math.max(0, until - Date.now()))
      );
    }
  }

  /** True once the copy is gone from Calibre, waiting up to the configured time. */
  private async waitUntilGone(login: Login, item: BatchItem): Promise<boolean> {
    const until = Date.now() + this.opts.config.removeWaitSeconds * 1000;
    const gone = await this.pollUntil(until, async () => {
      const book = await this.calibredb.book(login, item.calibreId);
      return !book || book.uuid !== item.uuid ? true : null;
    });
    return gone === true;
  }

  /** The book back in Calibre with its UUID, waiting up to the configured time after asking. */
  private async waitForBook(
    login: Login,
    item: BatchItem,
    requestedAt: number
  ): Promise<{ id: number; uuid: string } | null> {
    const until = requestedAt + this.opts.config.trashRestoreWaitSeconds * 1000;
    return this.pollUntil(until, async () => {
      const back = await this.calibredb.book(login, item.calibreId);
      return back && back.uuid === item.uuid ? back : null;
    });
  }

  private async undoItem(batch: Batch, item: BatchItem, plan: TrashRestorePlan): Promise<void> {
    const login = this.requireLogin();
    // Already back (an earlier attempt's report was lost, or Calibre finished after a restart)?
    let present: Awaited<ReturnType<Calibredb['book']>> | undefined;
    try {
      present = await this.calibredb.book(login, item.calibreId);
    } catch (err) {
      present = undefined; // Calibre busy: not known yet
      this.log.info(`Calibre didn't answer yet: ${shorten((err as Error).message, 160)}`);
    }
    if (present && present.uuid === item.uuid) {
      await this.restored(batch, item, {
        step: 'restored',
        method: 'trash',
        calibreId: item.calibreId,
        uuid: item.uuid
      });
      return;
    }
    if (plan.requested.includes(item.calibreId)) {
      const back = await this.waitForBook(login, item, plan.requestedAt);
      if (!back) {
        const min = Math.round(this.opts.config.trashRestoreWaitSeconds / 60);
        throw new Error(
          `Calibre hasn't brought this book back from its trash within ${min} min of asking. It may still be working on it: Undo again later (books already back are recognized; nothing is added twice).`
        );
      }
      await this.restored(batch, item, {
        step: 'restored',
        method: 'trash',
        calibreId: back.id,
        uuid: back.uuid
      });
      this.log.info(`Restored ${item.calibreId} from Calibre's trash`);
      return;
    }
    if (!plan.notInTrash.includes(item.calibreId)) {
      throw new Error("Calibre's trash couldn't be asked for this book; Undo again");
    }
    // Not in Calibre's trash any more (expired or emptied): the quarantine copy below.
    // Re-add the quarantined export (new Calibre id and UUID).
    const dir = item.quarantineDir;
    if (!dir || !(await this.quarantine.epubIn(dir))) {
      await this.report(batch, item, {
        step: 'failed',
        detail: "Not in Calibre's trash and the quarantine copy is gone"
      });
      return;
    }
    if (present === undefined) {
      // Never re-add without a clear answer that the book isn't back.
      present = await this.pollUntil(
        Date.now() + this.opts.config.removeWaitSeconds * 1000,
        async () => ({ book: await this.calibredb.book(login, item.calibreId) })
      ).then((r) => (r ? r.book : undefined));
      if (present === undefined) throw new Error("Calibre didn't answer; Undo again later");
      if (present && present.uuid === item.uuid) {
        await this.restored(batch, item, {
          step: 'restored',
          method: 'trash',
          calibreId: item.calibreId,
          uuid: item.uuid
        });
        return;
      }
    }
    // The note sits beside the copy's export, so every Undo of this copy (also a later one
    // after a failure) finds an earlier re-add that Calibre finished after a timeout.
    const note = path.join(path.dirname(dir), `${item.calibreId}.readd.json`);
    const newSinceNote = async (before: number[]) => {
      const now = await this.calibredb.idsWithTitle(login, item.title);
      const added = now.filter((id) => !before.includes(id));
      if (added.length > 1)
        throw new StopWaiting('An earlier re-add left more than one copy; check Calibre');
      return added.length === 1 ? await this.calibredb.book(login, added[0]) : null;
    };
    let before: number[];
    if (await exists(note)) {
      before = (JSON.parse(await fsp.readFile(note, 'utf8')) as { idsBefore: number[] }).idsBefore;
      const earlier = await newSinceNote(before);
      if (earlier) {
        await this.restored(batch, item, {
          step: 'restored',
          method: 'readd',
          calibreId: earlier.id,
          uuid: earlier.uuid
        });
        return;
      }
    } else {
      before = await this.calibredb.idsWithTitle(login, item.title);
      await this.quarantine.createOnce(
        note,
        JSON.stringify({ idsBefore: before, at: new Date().toISOString() })
      );
    }
    let back: { id: number; uuid: string } | null = null;
    try {
      const r = await this.calibredb.ok('add', login, [
        '--duplicates',
        '--one-book-per-directory',
        dir
      ]);
      const m = /Added book ids?:\s*([\d,\s]+)/i.exec(r.stdout);
      const newId = m ? Number(m[1].split(',')[0].trim()) : NaN;
      back = Number.isInteger(newId) ? await this.calibredb.book(login, newId) : null;
      if (!back) {
        throw new Error(
          `calibredb add did not report the new book: ${r.stdout.trim().slice(-200)}`
        );
      }
    } catch (err) {
      // The request can time out while Calibre still adds the book: wait for it to appear.
      this.log.info(
        `Re-add ${item.calibreId}: ${shorten((err as Error).message, 200)}; waiting to see whether Calibre added it`
      );
      back = await this.pollUntil(
        Date.now() + this.opts.config.trashRestoreWaitSeconds * 1000,
        () => newSinceNote(before)
      );
      if (!back) throw err;
    }
    await this.restored(batch, item, {
      step: 'restored',
      method: 'readd',
      calibreId: back.id,
      uuid: back.uuid
    });
    this.log.info(`Re-added ${item.calibreId} from the quarantine as ${back.id}`);
  }
}

/**
 * `custom_columns --details` lists a multiple-value text column with this label.
 * calibre 9.18 prints the label, then the column's settings as a Python dict
 * ({'datatype': 'text', 'is_multiple': True, 'label': 'illustrator', ...}); older versions
 * printed "label (id)" with indented "key: value" lines and is_multiple as a dict.
 */
export function hasMultipleTextColumn(output: string, label: string): boolean {
  const block = firstBlock(output, label);
  if (!block) return false;
  const text = /['"]?datatype['"]?\s*:\s*['"]?text\b/i.test(block);
  const multiple =
    /['"]?is_multiple['"]?\s*:\s*(True\b|true\b|\{\s*['"])/.test(block) &&
    !/['"]?is_multiple['"]?\s*:\s*(False\b|false\b|None\b|\{\s*\})/.test(block);
  return text && multiple;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The part of `custom_columns --details` output that describes one column. */
export function firstBlock(output: string, label: string): string | null {
  const name = escapeRegExp(label);
  // calibre 9.x: a dict per column, with one level of nested dicts.
  const labelKey = new RegExp(`['"]label['"]\\s*:\\s*['"]${name}['"]`);
  for (const m of output.matchAll(/\{(?:[^{}]|\{[^{}]*\})*\}/g)) {
    if (labelKey.test(m[0])) return m[0];
  }
  // Older output: "label (id)" followed by indented lines.
  const lines = output.split(/\r?\n/);
  const head = new RegExp(`^${name}\\s*\\(\\d+\\)`);
  const start = lines.findIndex((l) => head.test(l.trim()));
  if (start === -1) return null;
  const out = [lines[start]];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '' || /^\S/.test(l)) break;
    out.push(l);
  }
  return out.join('\n');
}

/** The library ids in `calibredb list --with-library http://…/#-` output (one per line). */
export function parseLibraryIds(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/\s/.test(l) && !l.includes(':'));
}

/** EPUB among calibredb's format names. */
export function hasEpub(formats: string[]): boolean {
  return formats.some((f) => f.toUpperCase() === 'EPUB');
}

/** Why the copy that stays can't be relied on, or null when it is there with its EPUB. */
export function keptCopyProblem(
  kept: { uuid: string; formats: string[] } | null,
  uuid: string
): string | null {
  if (!kept || kept.uuid !== uuid) return 'The copy to keep is no longer in Calibre';
  if (!hasEpub(kept.formats)) return 'The copy to keep has no EPUB in Calibre any more';
  return null;
}

/**
 * The ids in calibre's refusal "No entries in the trash bin for the books: 3, 4" (it refuses
 * the whole `trash restore` call when any id isn't in its trash).
 */
export function notInTrashIds(output: string): number[] {
  const m = /No entries in the trash bin for the books:\s*([\d,\s]+)/i.exec(output);
  if (!m) return [];
  return m[1]
    .split(/[,\s]+/)
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
}

/** The newest trash-restore plan saved in a batch's quarantine folder, or null. */
export async function latestRestorePlan(dir: string): Promise<TrashRestorePlan | null> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const plans = names
    .map((n) => /^trash-restore-(\d+)(?:-\d+)?\.json$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || b[0].length - a[0].length);
  for (const m of plans) {
    try {
      const p = JSON.parse(await fsp.readFile(path.join(dir, m[0]), 'utf8')) as TrashRestorePlan;
      if (Array.isArray(p.requested) && Array.isArray(p.notInTrash) && p.requestedAt > 0) return p;
    } catch {
      // A half-written file (stopped while writing): try the one before.
    }
  }
  return null;
}
