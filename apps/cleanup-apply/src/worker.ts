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
  isFinal,
  ServerApi,
  ServerError,
  type StepReport
} from './api';
import { Calibredb, calibreTime, type Login, sameVersion, versionAtLeast } from './calibredb';
import type { SidecarConfig } from './config';
import { exists, Quarantine, sha256File } from './quarantine';

export const SIDECAR_VERSION = '1.0.0';
/** calibredb's `trash restore` exists from this version on. */
export const TRASH_RESTORE_VERSION = '9.18.0';

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
    while (!this.stopped) {
      try {
        await this.cycle();
      } catch (err) {
        this.log.error(`cycle: ${(err as Error).message}`);
      }
      if (!this.stopped) await sleep(this.pollMs);
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

  private async heartbeat(): Promise<void> {
    const answer = await this.retry(() =>
      this.api.heartbeat({
        version: SIDECAR_VERSION,
        calibredb: this.calibredbVersion ? `calibredb (calibre ${this.calibredbVersion})` : null,
        serverVersion: this.serverVersion ? `calibre ${this.serverVersion}` : null,
        trashRestore: this.trashRestore,
        problem: this.problem,
        checks: this.checks,
        libraries: this.libraries
      })
    );
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
    let trash = false;
    if (
      versionAtLeast(this.serverVersion, TRASH_RESTORE_VERSION) &&
      versionAtLeast(this.calibredbVersion, TRASH_RESTORE_VERSION)
    ) {
      try {
        const r = await this.calibredb.run('trash_list', lib);
        trash = r.code === 0;
      } catch {
        trash = false;
      }
    }
    this.trashRestore = trash;
    add(
      'trash_restore',
      trash,
      trash ? null : `needs calibre ${TRASH_RESTORE_VERSION} or newer on both sides`
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
    await this.retry(() => this.api.report(batch.id, item.itemId, report));
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
      for (const item of batch.items) {
        if (this.stopped) return;
        const final =
          batch.kind === 'apply'
            ? ['removed', 'failed', 'skipped']
            : ['restored', 'failed', 'skipped'];
        if (final.includes(item.state)) continue;
        try {
          if (batch.kind === 'apply') await this.applyItem(batch, item);
          else await this.undoItem(batch, item);
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
    await this.retry(() => this.api.finish(batch.id, error));
    this.log.info(`Batch ${batch.id} finished${error ? ` with an error: ${error}` : ''}`);
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
      if (!kept || kept.uuid !== item.kept.uuid) {
        await this.report(batch, item, {
          step: 'skipped',
          detail: 'The copy to keep is no longer in Calibre'
        });
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
      if (await this.calibredb.book(login, item.calibreId)) {
        await this.calibredb.ok('remove', login, [String(item.calibreId)]);
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

  private async undoItem(batch: Batch, item: BatchItem): Promise<void> {
    const login = this.requireLogin();
    // Already back (an earlier attempt's report was lost)?
    const present = await this.calibredb.book(login, item.calibreId);
    if (present && present.uuid === item.uuid) {
      await this.restored(batch, item, {
        step: 'restored',
        method: 'trash',
        calibreId: item.calibreId,
        uuid: item.uuid
      });
      return;
    }
    if (this.trashRestore) {
      const r = await this.calibredb.run('trash_list', login);
      if (r.code === 0 && trashHasBook(r.stdout, item.calibreId)) {
        await this.calibredb.ok('trash_restore', login, [String(item.calibreId)]);
        const back = await this.calibredb.book(login, item.calibreId);
        if (!back) throw new Error("Calibre's trash restore did not bring the book back");
        await this.restored(batch, item, {
          step: 'restored',
          method: 'trash',
          calibreId: back.id,
          uuid: back.uuid
        });
        this.log.info(`Restored ${item.calibreId} from Calibre's trash`);
        return;
      }
    }
    // Re-add the quarantined export (new Calibre id and UUID).
    const dir = item.quarantineDir;
    if (!dir || !(await this.quarantine.epubIn(dir))) {
      await this.report(batch, item, {
        step: 'failed',
        detail: "Not in Calibre's trash and the quarantine copy is gone"
      });
      return;
    }
    const noteDir = this.quarantine.batchDir(batch.id);
    const note = path.join(noteDir, `${item.calibreId}.readd.json`);
    let before: number[];
    if (await exists(note)) {
      before = (JSON.parse(await fsp.readFile(note, 'utf8')) as { idsBefore: number[] }).idsBefore;
      const now = await this.calibredb.idsWithTitle(login, item.title);
      const added = now.filter((id) => !before.includes(id));
      if (added.length === 1) {
        const back = await this.calibredb.book(login, added[0]);
        if (back) {
          await this.restored(batch, item, {
            step: 'restored',
            method: 'readd',
            calibreId: back.id,
            uuid: back.uuid
          });
          return;
        }
      }
      if (added.length > 1)
        throw new Error('An earlier re-add left more than one copy; check Calibre');
    } else {
      before = await this.calibredb.idsWithTitle(login, item.title);
      await this.quarantine.createOnce(
        note,
        JSON.stringify({ idsBefore: before, at: new Date().toISOString() })
      );
    }
    const r = await this.calibredb.ok('add', login, [
      '--duplicates',
      '--one-book-per-directory',
      dir
    ]);
    const m = /Added book ids?:\s*([\d,\s]+)/i.exec(r.stdout);
    const newId = m ? Number(m[1].split(',')[0].trim()) : NaN;
    const back = Number.isInteger(newId) ? await this.calibredb.book(login, newId) : null;
    if (!back)
      throw new Error(`calibredb add did not report the new book: ${r.stdout.trim().slice(-200)}`);
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

/** `trash list --for-machine` mentions this book id. */
export function trashHasBook(output: string, calibreId: number): boolean {
  try {
    const data = JSON.parse(output) as unknown;
    const items: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as { books?: unknown[] }).books)
        ? (data as { books: unknown[] }).books
        : [];
    return items.some((x) => {
      const o = x as { book_id?: unknown; id?: unknown };
      return o.book_id === calibreId || o.id === calibreId;
    });
  } catch {
    return new RegExp(`\\b${calibreId}\\b`).test(output);
  }
}
