/**
 * WP20g: the Calibre library's import (plan section 11, decided 2026-11-17: books are added with
 * Calibre's own add, through this sidecar, so Calibre keeps one writer). Add batches and their
 * Undo, from the server's /api/v1/cleanup-apply/arrivals/*:
 *
 *   add       per item: the server streams the source file (read only on its side) -> the file
 *             is kept in this sidecar's own temporary folder and its SHA-256 checked -> one
 *             `calibredb add --duplicates <that file>` -> the new id read back -> reported.
 *             Never added twice: a note in the quarantine (`<item>.add.json`, the ids with that
 *             title before the add) and a marker written right before the add is sent; after an
 *             error, a timeout or a restart with the marker there, the book is looked for (as
 *             Undo's re-add does) and never added again: not found = failed, for the user to look
 *             at in Calibre.
 *   undo_add  per item: the added book exported into the quarantine, then removed to Calibre's
 *             trash (one id), checked gone.
 *
 * `--duplicates` because Calibre would otherwise skip a book whose title and author it thinks it
 * has; whether a file is a copy is decided by the server's own check (stage 1's hashes and stage
 * 3's text). The quarantine is never deleted from; the temporary file is this sidecar's own.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { shorten, type Calibredb, type Login } from './calibredb';
import { exists, sha256File, type Quarantine } from './quarantine';

export interface ArrivalItem {
  itemId: number;
  fileId: number;
  state: 'pending' | 'fetched' | 'added' | 'exported' | 'removed' | 'failed' | 'skipped';
  /** add: the file's name (kept for Calibre), its size and SHA-256, its title as its OPF says. */
  name: string;
  size: number;
  sha256: string;
  title: string;
  /** undo_add: the book to take out again. */
  calibreId: number | null;
  uuid: string | null;
}

export interface ArrivalBatch {
  id: number;
  kind: 'add' | 'undo_add';
  leaseSeconds: number;
  items: ArrivalItem[];
}

export interface ArrivalReport {
  step: 'fetched' | 'adding' | 'added' | 'exported' | 'removed' | 'failed';
  calibreId?: number;
  uuid?: string;
  quarantineDir?: string;
  detail?: string;
}

export interface ArrivalApi {
  claimArrivals(): Promise<{ batch: ArrivalBatch | null }>;
  reportArrival(itemId: number, r: ArrivalReport): Promise<{ state: string }>;
  finishArrivals(batchId: number, error: string | null): Promise<unknown>;
  downloadArrival(itemId: number, file: string): Promise<{ sha256: string | null }>;
}

export interface ArrivalWorkerOptions {
  api: ArrivalApi;
  calibredb: Calibredb;
  quarantine: Quarantine;
  tmpDir: string;
  /** How long to look for a book after an add that failed or timed out (s). */
  addWaitSeconds: number;
  pollSeconds: number;
  isStopped: () => boolean;
  log: { info(m: string): void; error(m: string): void };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The only name a file to add may have in the temporary folder (an EPUB, one per item). */
export function arrivalTmpFile(tmpDir: string, itemId: number, name: string): string {
  const base = path.basename(name).replace(/[\\/\0]/g, '_');
  const safe = /\.epub$/i.test(base) ? base : `${base}.epub`;
  return path.join(
    tmpDir,
    `ttsu-arrival-${itemId}`,
    safe.length > 200 ? `book-${itemId}.epub` : safe
  );
}

export class ArrivalWorker {
  constructor(private readonly o: ArrivalWorkerOptions) {}

  private arrivalDir(batchId: number): string {
    if (!Number.isSafeInteger(batchId) || batchId <= 0) throw new Error('Bad batch id');
    return path.join(this.o.quarantine.root, `arrivals-${batchId}`);
  }

  /** One add or undo batch if the server has one. Returns whether there was one. */
  async cycle(login: Login): Promise<boolean> {
    const { batch } = await this.o.api.claimArrivals();
    if (!batch) return false;
    let error: string | null = null;
    try {
      await fsp.mkdir(this.arrivalDir(batch.id), { recursive: true });
      for (const item of batch.items) {
        if (this.o.isStopped()) break;
        if (item.state === 'added' || item.state === 'removed' || item.state === 'failed') continue;
        try {
          if (batch.kind === 'add') await this.add(login, batch, item);
          else await this.undo(login, batch, item);
        } catch (err) {
          const detail = shorten((err as Error).message, 500);
          this.o.log.error(`Arrival item ${item.itemId}: ${detail}`);
          await this.o.api.reportArrival(item.itemId, { step: 'failed', detail });
        }
      }
    } catch (err) {
      error = shorten((err as Error).message, 500);
    }
    if (!this.o.isStopped()) await this.o.api.finishArrivals(batch.id, error);
    return true;
  }

  /** The ids of Calibre's books with this title that appeared since `before`. */
  private async newSince(login: Login, title: string, before: number[]) {
    const now = await this.o.calibredb.idsWithTitle(login, title);
    const added = now.filter((id) => !before.includes(id));
    if (added.length > 1)
      throw new Error('More than one new book with this title; look in Calibre');
    return added.length === 1 ? await this.o.calibredb.book(login, added[0]) : null;
  }

  private async lookFor(login: Login, title: string, before: number[]) {
    const until = Date.now() + this.o.addWaitSeconds * 1000;
    for (;;) {
      try {
        const b = await this.newSince(login, title, before);
        if (b) return b;
      } catch (err) {
        if (/More than one/.test((err as Error).message)) throw err;
        // A failed lookup while Calibre is busy: asked again.
      }
      if (Date.now() >= until || this.o.isStopped()) return null;
      await sleep(this.o.pollSeconds * 1000);
    }
  }

  private async add(login: Login, batch: ArrivalBatch, item: ArrivalItem): Promise<void> {
    const dir = this.arrivalDir(batch.id);
    const note = path.join(dir, `${item.itemId}.add.json`);
    const sent = path.join(dir, `${item.itemId}.add-sent`);
    let before: number[];
    if (await exists(note)) {
      before = (JSON.parse(await fsp.readFile(note, 'utf8')) as { idsBefore: number[] }).idsBefore;
    } else {
      before = await this.o.calibredb.idsWithTitle(login, item.title);
      await this.o.quarantine.createOnce(
        note,
        JSON.stringify({
          fileId: item.fileId,
          sha256: item.sha256,
          title: item.title,
          idsBefore: before,
          at: new Date().toISOString()
        })
      );
    }
    if (await exists(sent)) {
      // An add was sent before (a restart or a lost answer): never sent again.
      const b = await this.lookFor(login, item.title, before);
      if (!b) {
        await this.o.api.reportArrival(item.itemId, {
          step: 'failed',
          detail:
            'An earlier add of this file did not show in Calibre; look in Calibre before adding it again'
        });
        return;
      }
      await this.o.api.reportArrival(item.itemId, { step: 'added', calibreId: b.id, uuid: b.uuid });
      return;
    }
    const tmp = arrivalTmpFile(this.o.tmpDir, item.itemId, item.name);
    await fsp.mkdir(path.dirname(tmp), { recursive: true });
    await fsp.rm(tmp, { force: true });
    try {
      await this.o.api.downloadArrival(item.itemId, tmp);
      const st = await fsp.stat(tmp);
      const sha = await sha256File(tmp);
      if (st.size !== item.size || sha !== item.sha256) {
        await this.o.api.reportArrival(item.itemId, {
          step: 'failed',
          detail:
            'The file changed since it was checked (size or SHA-256); it is checked again at the next run'
        });
        return;
      }
      await this.o.api.reportArrival(item.itemId, { step: 'fetched' });
      await this.o.quarantine.createOnce(sent, new Date().toISOString());
      await this.o.api.reportArrival(item.itemId, { step: 'adding' });
      let book: { id: number; uuid: string } | null = null;
      try {
        const r = await this.o.calibredb.ok('add', login, ['--duplicates', tmp]);
        const m = /Added book ids?:\s*([\d,\s]+)/i.exec(r.stdout);
        const id = m ? Number(m[1].split(',')[0].trim()) : NaN;
        book = Number.isInteger(id) ? await this.o.calibredb.book(login, id) : null;
        if (!book)
          throw new Error(
            `calibredb add did not report the new book: ${shorten(r.stdout.trim(), 200)}`
          );
      } catch (err) {
        // calibredb's errors and timeouts aren't proof: look whether Calibre added it.
        this.o.log.info(
          `Add ${item.itemId}: ${shorten((err as Error).message, 200)}; looking whether Calibre added it`
        );
        book = await this.lookFor(login, item.title, before);
        if (!book) throw err;
      }
      await this.o.api.reportArrival(item.itemId, {
        step: 'added',
        calibreId: book.id,
        uuid: book.uuid
      });
      this.o.log.info(`Added file ${item.fileId} as Calibre book ${book.id}`);
    } finally {
      await fsp.rm(path.dirname(tmp), { recursive: true, force: true });
    }
  }

  private async undo(login: Login, batch: ArrivalBatch, item: ArrivalItem): Promise<void> {
    if (!item.calibreId || !item.uuid) throw new Error('The book to take out is not known');
    const present = await this.o.calibredb.book(login, item.calibreId);
    if (!present || present.uuid !== item.uuid) {
      await this.o.api.reportArrival(item.itemId, {
        step: 'removed',
        detail: 'Not in Calibre any more'
      });
      return;
    }
    const dir = path.join(this.arrivalDir(batch.id), String(item.calibreId));
    if (item.state !== 'exported') {
      if (!(await exists(dir))) await fsp.mkdir(dir);
      await this.o.calibredb.ok('export', login, [
        '--to-dir',
        dir,
        '--single-dir',
        '--dont-update-metadata',
        '--template',
        'book',
        String(item.calibreId)
      ]);
      await this.o.api.reportArrival(item.itemId, { step: 'exported', quarantineDir: dir });
    }
    try {
      await this.o.calibredb.ok('remove', login, [String(item.calibreId)]);
    } catch (err) {
      this.o.log.info(
        `Undo add ${item.calibreId}: ${shorten((err as Error).message, 200)}; waiting to see whether Calibre removes it`
      );
      const until = Date.now() + this.o.addWaitSeconds * 1000;
      for (;;) {
        const b = await this.o.calibredb.book(login, item.calibreId).catch(() => undefined);
        if (b === null) break;
        if (Date.now() >= until || this.o.isStopped()) throw err;
        await sleep(this.o.pollSeconds * 1000);
      }
    }
    await this.o.api.reportArrival(item.itemId, { step: 'removed', quarantineDir: dir });
  }
}

/** The server calls of the arrivals (on the sidecar's ServerApi base URL and token). */
export function arrivalApi(
  call: <T>(method: string, p: string, body?: unknown) => Promise<T>,
  download: (p: string, file: string) => Promise<Response>
): ArrivalApi {
  return {
    claimArrivals: () => call('POST', '/arrivals/claim', {}),
    reportArrival: (itemId, r) => call('POST', `/arrivals/items/${itemId}`, r),
    finishArrivals: (batchId, error) =>
      call('POST', `/arrivals/batches/${batchId}/finish`, error ? { error } : {}),
    async downloadArrival(itemId, file) {
      const res = await download(`/arrivals/items/${itemId}/file`, file);
      if (!res.ok || !res.body)
        throw new Error(`The file could not be fetched (HTTP ${res.status})`);
      const out = fs.createWriteStream(file, { flags: 'wx' });
      await pipeline(Readable.fromWeb(res.body as never), out);
      return { sha256: res.headers.get('x-file-sha256') };
    }
  };
}
