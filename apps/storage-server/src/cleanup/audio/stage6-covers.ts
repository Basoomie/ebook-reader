/**
 * Covers for the books without embedded art (WP21e-2, stop 3; checklist 1.5 and section 4).
 * After the switch and Audiobookshelf's first scan of the fresh library, run only on the user's
 * word ("Set the covers" asks first):
 *
 *   find  Audiobookshelf's library on /…/japanese (and one on /…/japanese-generated, if the user
 *         made it) and its items, read with the GET-only client; each book of stage 6 whose first
 *         file has no embedded cover gets its item. A book ABS already shows a cover for is left
 *         alone (never replaced).
 *   set   one call per book through the cover-only writer (abs-cover-writer.ts): stage 5's store
 *         cover URL (confirmed values only), else the old library's ABS cover file (cover.jpg or
 *         .png in the book's old folder, read through the read-only view of japanese-old; decided
 *         2026-11-20), else none (listed). Paced (setting coverPaceMs).
 *   done  the report, with the old library's cover.png files counted against these books.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import { getSettings } from '../settings';
import { AbsClient, AbsError } from './abs-client';
import { AbsCoverWriter } from './abs-cover-writer';
import { insideRoot, lstatEntry, readSmall } from './audio-source-fs';
import { AREA_FOLDERS } from './build-plan';
import type { AudioStage6 } from './stage6-build';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const MAX_COVER_BYTES = 20 * 1024 * 1024;

export interface CoversProgress {
  runId: string;
  phase: 'find' | 'set' | 'done';
  startedAt: number;
  finishedAt: number | null;
  libraries: { main: string | null; ai: string | null };
  current: { step: string; done: number; total: number; startedAt: number } | null;
  counts: Record<string, number>;
  /** The old library's cover.png files, and how many belong to the books without art. */
  coverPng: { total: number; ofTheseBooks: number; used: number } | null;
  error: string | null;
}

export interface CoversDeps {
  db: Database.Database;
  stage6: AudioStage6;
  media: string | null;
  /** The switch's state ('switched' or 'deleted' allow covers). */
  switchState: () => string;
  /** Audiobookshelf's address and key, or null when not set. */
  abs: () => { baseUrl: string; apiKey: string; timeoutMs: number } | null;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

interface AbsItem {
  id: string;
  relPath?: string;
  media?: { coverPath?: string | null };
}

export class AudioCovers {
  private readonly db: Database.Database;

  constructor(private readonly deps: CoversDeps) {
    this.db = deps.db;
  }

  private row(): {
    state: string;
    progress_json: string;
    pause_reason: string | null;
    pause_detail: string | null;
  } {
    return this.db
      .prepare(
        'SELECT state, progress_json, pause_reason, pause_detail FROM audio_covers_state WHERE id = 1',
      )
      .get() as {
      state: string;
      progress_json: string;
      pause_reason: string | null;
      pause_detail: string | null;
    };
  }

  progress(): CoversProgress | null {
    const p = JSON.parse(this.row().progress_json) as Partial<CoversProgress>;
    return p.runId ? (p as CoversProgress) : null;
  }

  isRunning(): boolean {
    return this.row().state === 'running';
  }

  pause(): { reason: string; detail: string | null } | null {
    const r = this.row();
    return r.pause_reason ? { reason: r.pause_reason, detail: r.pause_detail } : null;
  }

  private save(p: CoversProgress, state?: string): void {
    if (state)
      this.db
        .prepare(
          'UPDATE audio_covers_state SET state = ?, progress_json = ?, updated_at = ? WHERE id = 1',
        )
        .run(state, JSON.stringify(p), Date.now());
    else
      this.db
        .prepare('UPDATE audio_covers_state SET progress_json = ?, updated_at = ? WHERE id = 1')
        .run(JSON.stringify(p), Date.now());
  }

  private setPause(reason: string | null, detail: string | null = null): void {
    this.db
      .prepare(
        'UPDATE audio_covers_state SET pause_reason = ?, pause_detail = ?, updated_at = ? WHERE id = 1',
      )
      .run(reason, detail, Date.now());
    if (reason) this.deps.log?.(`Audiobooks covers: paused (${reason}): ${detail ?? ''}`);
  }

  refusals(): string[] {
    const out: string[] = [];
    const st = this.deps.switchState();
    if (st !== 'switched' && st !== 'deleted') out.push('Not switched yet');
    if (this.isRunning()) out.push('Covers are being set (or paused)');
    if (!this.deps.abs()) out.push('Fill in the Audiobookshelf address and API key (Settings tab)');
    return out;
  }

  start(): void {
    const r = this.refusals();
    if (r.length) throw new Error(r.join('; '));
    const p: CoversProgress = {
      runId: randomUUID(),
      phase: 'find',
      startedAt: Date.now(),
      finishedAt: null,
      libraries: { main: null, ai: null },
      current: null,
      counts: {},
      coverPng: null,
      error: null,
    };
    this.setPause(null);
    this.save(p, 'running');
    this.deps.log?.('Audiobooks covers: started');
  }

  resume(): void {
    if (!this.isRunning()) throw new Error('Nothing is paused');
    this.setPause(null);
  }

  private bar(p: CoversProgress, step: string, done: number, total: number): void {
    p.current =
      p.current?.step === step
        ? { ...p.current, done, total }
        : { step, done, total, startedAt: Date.now() };
    this.save(p);
  }

  private client(): AbsClient {
    const a = this.deps.abs()!;
    return new AbsClient({ ...a, fetchImpl: this.deps.fetchImpl });
  }

  /** One step. True: nothing more now. */
  async step(stop: () => boolean): Promise<boolean> {
    const p = this.progress();
    if (!p || !this.isRunning() || this.pause()) return true;
    try {
      if (p.phase === 'find') {
        await this.find(p);
        p.phase = 'set';
        p.current = null;
        this.save(p);
        return false;
      }
      if (p.phase === 'set') {
        const more = await this.setSome(p, stop);
        if (more) return stop();
        this.finish(p);
        return true;
      }
      return true;
    } catch (err) {
      const e = err as Error;
      p.error = e.message.slice(0, 500);
      this.save(p);
      this.setPause(
        err instanceof AbsError && (e as AbsError).status === 403 ? 'not_allowed' : 'failed',
        p.error,
      );
      return true;
    }
  }

  private async find(p: CoversProgress): Promise<void> {
    const client = this.client();
    const libs =
      (
        await client.get<{
          libraries?: { id: string; name?: string; folders?: { fullPath?: string }[] }[];
        }>('/libraries')
      )?.libraries ?? [];
    const on = (name: string) =>
      libs.find((l) =>
        (l.folders ?? []).some(
          (f) => (f.fullPath ?? '').replace(/\/+$/, '').split('/').pop() === name,
        ),
      );
    const main = on('japanese');
    if (!main)
      throw new Error(
        'Audiobookshelf has no library on the folder …/japanese yet (make it first, then let its first scan finish)',
      );
    const ai = on('japanese-generated');
    p.libraries = { main: main.name ?? main.id, ai: ai ? (ai.name ?? ai.id) : null };
    const items = new Map<string, AbsItem>();
    for (const [lib, prefix] of [
      [main, AREA_FOLDERS.main],
      [ai, AREA_FOLDERS.ai],
    ] as const) {
      if (!lib) continue;
      for (let page = 0; ; page++) {
        const r = await client.get<{ results?: AbsItem[]; total?: number }>(
          `/libraries/${encodeURIComponent(lib.id)}/items?limit=200&page=${page}&minified=1`,
        );
        const res = r?.results ?? [];
        for (const it of res)
          if (it.relPath) items.set(`${prefix}/${it.relPath.replace(/\\/g, '/')}`, it);
        this.bar(p, 'reading Audiobookshelf’s items', items.size, r?.total ?? items.size);
        if (res.length < 200) break;
      }
    }
    const a = this.deps.stage6.progress()?.analysisId;
    const books = this.db
      .prepare(
        `SELECT id, folder, unit_key, area FROM audio_build_books
         WHERE analysis_id = ? AND cover = 0 AND state IN ('build', 'pending') ORDER BY folder`,
      )
      .all(a) as { id: number; folder: string; unit_key: string; area: string }[];
    const urlOf = this.db.prepare(
      `SELECT value_json FROM ai_values WHERE stage = 'audio5' AND field = 'cover' AND item_key = ? AND source = 'rules'`,
    );
    // The old library's folders of each new folder (through the move list).
    const oldDirs = new Map<string, Set<string>>();
    for (const m of this.db
      .prepare(`SELECT old_path, new_path, kept_path FROM audio_build_moves WHERE analysis_id = ?`)
      .all(a) as { old_path: string; new_path: string | null; kept_path: string | null }[]) {
      const target = m.new_path ? dirOf(m.new_path) : m.kept_path;
      if (!target) continue;
      for (const t of [target, dirOf(target)]) {
        const set = oldDirs.get(t) ?? new Set<string>();
        set.add(dirOf(m.old_path));
        oldDirs.set(t, set);
      }
    }
    const libFile = this.db.prepare(
      `SELECT rel_path FROM audio_files WHERE root = 'library' AND gone_at IS NULL AND rel_path = ?`,
    );
    const oldThere =
      !!this.deps.media && !!(await lstatEntry(path.join(this.deps.media, 'japanese-old')));
    const pngTotal = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM audio_files WHERE root = 'library' AND gone_at IS NULL AND rel_path LIKE '%cover.png'`,
        )
        .get() as { n: number }
    ).n;
    let pngOfThese = 0;
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO audio_covers (run_id, book_id, folder, item_id, source, url, file_rel, state, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const b of books) {
        if (b.area === 'ai' && !ai) continue;
        const item = items.get(b.folder);
        const raw = (urlOf.get(b.unit_key) as { value_json: string } | undefined)?.value_json;
        const url = raw ? (JSON.parse(raw) as unknown) : null;
        let file: string | null = null;
        for (const d of oldDirs.get(b.folder) ?? []) {
          const lib = d.replace(/^japanese\//, '');
          for (const name of ['cover.jpg', 'cover.png']) {
            const hit = libFile.get(`${lib}/${name}`) as { rel_path: string } | undefined;
            if (hit) {
              if (name === 'cover.png') pngOfThese++;
              file ??= hit.rel_path;
            }
          }
        }
        const source =
          typeof url === 'string' && /^https?:\/\//.test(url)
            ? 'url'
            : file && oldThere
              ? 'file'
              : 'none';
        const state = !item
          ? 'no_item'
          : item.media?.coverPath
            ? 'has_cover'
            : source === 'none'
              ? 'no_source'
              : 'planned';
        ins.run(
          p.runId,
          b.id,
          b.folder,
          item?.id ?? null,
          source,
          source === 'url' ? url : null,
          source === 'file' ? file : null,
          state,
          state === 'has_cover'
            ? `Audiobookshelf shows a cover already (${item!.media!.coverPath})`
            : null,
        );
      }
    })();
    p.coverPng = { total: pngTotal, ofTheseBooks: pngOfThese, used: 0 };
    p.counts = this.counts(p);
    this.save(p);
  }

  private counts(p: CoversProgress): Record<string, number> {
    return Object.fromEntries(
      (
        this.db
          .prepare(
            `SELECT state || ':' || source AS k, COUNT(*) AS n FROM audio_covers WHERE run_id = ? GROUP BY k`,
          )
          .all(p.runId) as { k: string; n: number }[]
      ).map((r) => [r.k, r.n]),
    );
  }

  /** Sets the next covers (one at a time, paced). True while some are left. */
  private async setSome(p: CoversProgress, stop: () => boolean): Promise<boolean> {
    const writer = new AbsCoverWriter({ ...this.deps.abs()!, fetchImpl: this.deps.fetchImpl });
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM audio_covers WHERE run_id = ? AND source <> 'none' AND state IN ('planned', 'set', 'failed')`,
        )
        .get(p.runId) as { n: number }
    ).n;
    const pace = getSettings(this.db).audiobooks.coverPaceMs;
    for (;;) {
      if (stop() || this.pause()) return true;
      const next = this.db
        .prepare(
          `SELECT * FROM audio_covers WHERE run_id = ? AND state = 'planned' ORDER BY book_id LIMIT 1`,
        )
        .get(p.runId) as
        | {
            book_id: number;
            item_id: string;
            source: 'url' | 'file';
            url: string | null;
            file_rel: string | null;
          }
        | undefined;
      const done = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM audio_covers WHERE run_id = ? AND state IN ('set', 'failed')`,
          )
          .get(p.runId) as { n: number }
      ).n;
      this.bar(p, 'setting covers in Audiobookshelf', done, total);
      if (!next) return false;
      let state = 'set';
      let detail: string | null = null;
      try {
        if (next.source === 'url') await writer.setCoverFromUrl(next.item_id, next.url!);
        else {
          const bytes = await readSmall(
            insideRoot(path.join(this.deps.media!, 'japanese-old'), next.file_rel!),
            MAX_COVER_BYTES,
          );
          if (!bytes) throw new Error(`The old cover file is not there: ${next.file_rel}`);
          await writer.setCoverFromFile(next.item_id, bytes, path.posix.basename(next.file_rel!));
          if (/cover\.png$/i.test(next.file_rel!) && p.coverPng) p.coverPng.used++;
        }
      } catch (err) {
        if (err instanceof AbsError && (err.status === 401 || err.status === 403)) throw err;
        state = 'failed';
        detail = (err as Error).message.slice(0, 300);
      }
      this.db
        .prepare(
          `UPDATE audio_covers SET state = ?, detail = ?, done_at = ? WHERE run_id = ? AND book_id = ?`,
        )
        .run(state, detail, Date.now(), p.runId, next.book_id);
      if (pace > 0) await sleep(pace);
    }
  }

  private finish(p: CoversProgress): void {
    p.phase = 'done';
    p.finishedAt = Date.now();
    p.current = null;
    p.counts = this.counts(p);
    this.save(p, 'done');
    this.deps.log?.(`Audiobooks covers: done (${JSON.stringify(p.counts)})`);
  }

  status() {
    return {
      state: this.row().state,
      pause: this.pause(),
      progress: this.progress(),
      refusals: this.refusals(),
    };
  }

  list(opts: { offset?: number; limit?: number } = {}) {
    const p = this.progress();
    if (!p) return { total: 0, items: [] };
    const total = (
      this.db.prepare('SELECT COUNT(*) AS n FROM audio_covers WHERE run_id = ?').get(p.runId) as {
        n: number;
      }
    ).n;
    const items = this.db
      .prepare(
        `SELECT * FROM audio_covers WHERE run_id = ? ORDER BY state, folder LIMIT ? OFFSET ?`,
      )
      .all(p.runId, Math.min(opts.limit ?? 100, 500), opts.offset ?? 0);
    return { total, items };
  }
}
