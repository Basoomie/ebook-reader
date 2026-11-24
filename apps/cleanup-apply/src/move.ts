/**
 * Manga part A (1.6.0): moving books from one Calibre library to another, through the running
 * content server only (calibredb --with-library http://…/#<library>), one book per item, each
 * step reported and acknowledged before the next:
 *
 *   pending  -> verified  the book is in the old library as selected (record, UUID, EPUB, last
 *                          modified within a second)
 *   verified -> exported  exported into the quarantine with stage 1's command (the book's files,
 *                          its OPF with every field, its cover): the quarantine copy, and what is
 *                          added to the new library
 *   exported -> tagged    added to the new library from that folder (the allowlisted re-add form
 *                          `add --duplicates --one-book-per-directory <folder>`; a note beside the
 *                          export: never added twice); every field listed on both copies and
 *                          compared; a field that didn't arrive written with set_fields and
 *                          compared again; the server compares the stored EPUB, the cover and the
 *                          title sort. Any difference left: the added copy is taken out again (to
 *                          the new library's trash) and the item fails; the old copy stays.
 *   tagged   -> removed   the added copy is still there with its EPUB; the old copy is removed to
 *                          Calibre's trash (stage 1's remove), never --permanent.
 *
 * Undo (one step, restored): the old copy comes back (Calibre's trash, asked once per batch by
 * the worker; else re-added from the quarantine export), the moved copy is exported into the undo
 * batch's quarantine folder, any field (or cover) changed on it since the move is written onto the
 * old copy, then the moved copy is removed to its library's trash.
 *
 * A write's error or timeout is never taken as "not done" (WP20 lessons 1): the sidecar looks at
 * Calibre's real state (the copy appeared, the copy is gone) before calling an item failed.
 */
import fsp from 'fs/promises';
import path from 'path';
import type { Batch, BatchItem, ServerApi, StepReport } from './api';
import { Calibredb, calibreTime, shorten, type Login } from './calibredb';
import { exists, Quarantine, sha256File } from './quarantine';

export const MOVE_STAGE = 11;

/** Every field the move carries, as `calibredb list` names them. */
export const MOVE_LIST_FIELDS =
  'uuid,title,authors,author_sort,series,series_index,identifiers,publisher,languages,pubdate,' +
  'rating,tags,comments,timestamp,cover,formats,last_modified,*illustrator,*characters';

/** The fields compared after the add (and their order in a detail line). */
export const COMPARED = [
  'title',
  'authors',
  'author_sort',
  'series',
  'series_index',
  'identifiers',
  'publisher',
  'languages',
  'pubdate',
  'rating',
  'tags',
  'comments',
  'timestamp',
  '*illustrator',
  '*characters',
  'cover',
  'formats'
] as const;
type Compared = (typeof COMPARED)[number];

type Listed = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => String(x))
    : typeof v === 'string' && v !== ''
      ? v.split(',').map((t) => t.trim())
      : [];
const toSecond = (v: unknown): number | null => {
  const t = calibreTime(str(v) || null);
  return t === null ? null : Math.floor(t / 1000);
};
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : v == null || v === '' ? null : Number(v);

/** One field of a listed book, normalized for comparing (same value = same string). */
export function normalizedField(field: Compared, b: Listed): string {
  const v = b[field];
  switch (field) {
    case 'authors':
      return JSON.stringify(
        str(v)
          .split(' & ')
          .map((a) => a.trim())
          .filter(Boolean)
      );
    case 'series':
      return str(v).trim();
    case 'series_index':
      // A number counts only with a series (Calibre keeps 1.0 on a book without one).
      return str(b.series).trim() ? String(num(v) ?? 1) : '';
    case 'identifiers': {
      const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      return JSON.stringify(
        Object.entries(o)
          .map(([k, x]) => [k.toLowerCase(), str(x)])
          .sort((a, c) => a[0].localeCompare(c[0]))
      );
    }
    case 'languages':
      return JSON.stringify(list(v));
    case 'tags':
      return JSON.stringify(
        list(v)
          .map((t) => t.toLowerCase())
          .sort()
      );
    case '*illustrator':
      return JSON.stringify(list(v));
    case 'formats':
      return JSON.stringify(
        list(v)
          .map((f) => path.basename(f).toUpperCase())
          .sort()
      );
    case 'pubdate':
    case 'timestamp':
      return String(toSecond(v));
    case 'rating':
    case '*characters':
    case 'cover': {
      const n = num(v);
      return n === null || n === 0 ? '' : String(n);
    }
    default:
      return str(v);
  }
}

/** The fields whose values differ between two listed books. */
export function differingFields(a: Listed, b: Listed): Compared[] {
  return COMPARED.filter((f) => normalizedField(f, a) !== normalizedField(f, b));
}

/**
 * The set_fields arguments that give a book `from`'s value of these fields (formats can't be
 * set: never in the list; a cover only from a file in the quarantine).
 */
export function fieldArgsFrom(
  fields: Compared[],
  from: Listed,
  illustratorNames: boolean,
  coverFile: string | null
): string[] {
  const out: string[] = [];
  const has = (f: Compared) => fields.includes(f);
  if (has('title')) out.push(`title:${str(from.title)}`);
  if (has('authors')) out.push(`authors:${str(from.authors)}`);
  if (has('author_sort')) out.push(`author_sort:${str(from.author_sort)}`);
  if (has('series') || has('series_index')) {
    out.push(`series:${str(from.series)}`);
    if (str(from.series)) out.push(`series_index:${num(from.series_index) ?? 1}`);
  }
  if (has('identifiers')) {
    const o = (
      from.identifiers && typeof from.identifiers === 'object' ? from.identifiers : {}
    ) as Record<string, unknown>;
    out.push(
      `identifiers:${Object.entries(o)
        .map(([k, v]) => `${k}:${str(v)}`)
        .join(',')}`
    );
  }
  if (has('publisher')) out.push(`publisher:${str(from.publisher)}`);
  if (has('languages')) out.push(`languages:${list(from.languages).join(',')}`);
  if (has('pubdate')) out.push(`pubdate:${str(from.pubdate)}`);
  // calibredb takes stars (list shows 0-10: 8 is four stars); 0 takes the rating off.
  if (has('rating')) out.push(`rating:${(num(from.rating) ?? 0) / 2}`);
  if (has('tags')) out.push(`tags:${list(from.tags).join(',')}`);
  if (has('comments')) out.push(`comments:${str(from.comments)}`);
  if (has('timestamp')) out.push(`timestamp:${str(from.timestamp)}`);
  if (has('*illustrator'))
    out.push(`#illustrator:${list(from['*illustrator']).join(illustratorNames ? ' & ' : ',')}`);
  if (has('*characters')) out.push(`#characters:${num(from['*characters']) ?? ''}`);
  if (has('cover') && coverFile) out.push(`cover:${coverFile}`);
  return out;
}

export interface MoveContext {
  calibredb: Calibredb;
  quarantine: Quarantine;
  api: ServerApi;
  log: { info(m: string): void; error(m: string): void };
  report(batch: Batch, item: BatchItem, report: StepReport): Promise<void>;
  pollUntil<T>(until: number, check: () => Promise<T | null>): Promise<T | null>;
  isStopped(): boolean;
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Whether the libraries' #illustrator is a names column (" & " separates its values). */
  illustratorNames(): boolean;
  waits: { removeWaitSeconds: number; trashRestoreWaitSeconds: number; writeWaitSeconds: number };
}

/** What the worker asked Calibre's trash for (its plan for the batch). */
export interface MovePlan {
  requested: number[];
  notInTrash: number[];
  requestedAt: number;
}

export class MoveWorker {
  constructor(private readonly ctx: MoveContext) {}

  private async listed(login: Login, id: number): Promise<Listed | null> {
    const m = await this.ctx.calibredb.listBooks(login, [id], MOVE_LIST_FIELDS);
    return m.get(id) ?? null;
  }

  /** A listed book, asking again while Calibre is busy (a 408 says nothing). */
  private async listedPatiently(login: Login, id: number): Promise<Listed | null> {
    const until = Date.now() + this.ctx.waits.writeWaitSeconds * 1000;
    const r = await this.ctx.pollUntil(until, async () => ({ b: await this.listed(login, id) }));
    if (!r) throw new Error("Calibre didn't answer a list of the book");
    return r.b;
  }

  private async gone(login: Login, id: number, uuid: string): Promise<boolean> {
    const until = Date.now() + this.ctx.waits.removeWaitSeconds * 1000;
    const r = await this.ctx.pollUntil(until, async () => {
      const b = await this.ctx.calibredb.book(login, id);
      return !b || b.uuid !== uuid ? true : null;
    });
    return r === true;
  }

  /** Removes a copy to its library's trash; true once Calibre no longer lists it. */
  private async removeCopy(login: Login, id: number, uuid: string): Promise<boolean> {
    const b = await this.ctx.calibredb.book(login, id);
    if (!b || b.uuid !== uuid) return true;
    try {
      await this.ctx.calibredb.ok('remove', login, [String(id)]);
    } catch (err) {
      if (this.ctx.isStopped()) throw err;
      this.ctx.log.info(
        `Remove ${id}: ${shorten((err as Error).message, 200)}; waiting to see whether Calibre removes it`
      );
    }
    return this.gone(login, id, uuid);
  }

  /** The copy a note (written before an add) finds: a new book with that title since. */
  private async addedSince(login: Login, title: string, before: number[]) {
    const now = await this.ctx.calibredb.idsWithTitle(login, title);
    const added = now.filter((id) => !before.includes(id));
    if (added.length > 1) throw new Error('An earlier add left more than one copy; check Calibre');
    return added.length === 1 ? await this.ctx.calibredb.book(login, added[0]) : null;
  }

  /**
   * Adds the export in `dir` to `login`'s library, once: a note beside the export records the
   * books with that title before the add, so a repeated step (a restart, a timeout after which
   * Calibre added it anyway) finds the earlier copy instead of adding a second one.
   */
  private async addOnce(
    login: Login,
    dir: string,
    title: string,
    noteName: string
  ): Promise<{ id: number; uuid: string }> {
    const note = path.join(path.dirname(dir), noteName);
    let before: number[];
    if (await exists(note)) {
      before = (JSON.parse(await fsp.readFile(note, 'utf8')) as { idsBefore: number[] }).idsBefore;
      const earlier = await this.addedSince(login, title, before);
      if (earlier) return { id: earlier.id, uuid: earlier.uuid };
    } else {
      before = await this.ctx.calibredb.idsWithTitle(login, title);
      await this.ctx.quarantine.createOnce(
        note,
        JSON.stringify({
          library: login.libraryId,
          idsBefore: before,
          at: new Date().toISOString()
        })
      );
    }
    try {
      const r = await this.ctx.step('calibre add', () =>
        this.ctx.calibredb.ok('add', login, ['--duplicates', '--one-book-per-directory', dir])
      );
      const m = /Added book ids?:\s*([\d,\s]+)/i.exec(r.stdout);
      const id = m ? Number(m[1].split(',')[0].trim()) : NaN;
      const b = Number.isInteger(id) ? await this.ctx.calibredb.book(login, id) : null;
      if (!b)
        throw new Error(
          `calibredb add did not report the new book: ${shorten(r.stdout.trim(), 200)}`
        );
      return { id: b.id, uuid: b.uuid };
    } catch (err) {
      if (this.ctx.isStopped()) throw err;
      this.ctx.log.info(
        `Add to ${login.libraryId}: ${shorten((err as Error).message, 200)}; waiting to see whether Calibre added it`
      );
      const b = await this.ctx.pollUntil(
        Date.now() + this.ctx.waits.trashRestoreWaitSeconds * 1000,
        () => this.addedSince(login, title, before)
      );
      if (!b) throw err;
      return { id: b.id, uuid: b.uuid };
    }
  }

  /** One item of a move batch (source: the old library's login, target: the new one's). */
  async applyItem(batch: Batch, item: BatchItem, source: Login, target: Login): Promise<void> {
    const { ctx } = this;
    if (item.state === 'pending') {
      const book = await ctx.calibredb.book(source, item.calibreId);
      const skip = (detail: string) => ctx.report(batch, item, { step: 'skipped', detail });
      if (!book) return skip('The book is no longer in Calibre');
      if (book.uuid !== item.uuid) return skip('The Calibre id now belongs to another book');
      if (!book.formats.some((f) => f.toUpperCase() === 'EPUB'))
        return skip('The book has no EPUB in Calibre any more');
      const then = calibreTime(item.lastModified);
      const now = calibreTime(book.last_modified);
      if (then !== null && now !== null && Math.abs(now - then) > 1000)
        return skip('The book was changed in Calibre since the selection');
      await ctx.report(batch, item, { step: 'verified' });
    }
    if (item.state === 'verified') {
      const dir = await ctx.quarantine.freshName(
        ctx.quarantine.batchDir(batch.id),
        String(item.calibreId)
      );
      await fsp.mkdir(dir);
      await ctx.calibredb.ok('export', source, [
        '--to-dir',
        dir,
        '--single-dir',
        '--dont-update-metadata',
        '--template',
        'book',
        String(item.calibreId)
      ]);
      const epub = await ctx.quarantine.epubIn(dir);
      if (!epub) throw new Error('The export has no EPUB');
      const sha = await ctx.step('hash export', () => sha256File(epub));
      await ctx.quarantine.createOnce(
        path.join(ctx.quarantine.batchDir(batch.id), `${item.calibreId}.json`),
        JSON.stringify(
          {
            moved: {
              calibreId: item.calibreId,
              uuid: item.uuid,
              title: item.title,
              formats: item.formats
            },
            from: source.libraryId,
            to: target.libraryId,
            sha256: sha,
            exportedTo: path.basename(dir),
            exportedAt: new Date().toISOString()
          },
          null,
          2
        )
      );
      await ctx.report(batch, item, { step: 'exported', quarantineDir: dir, exportSha256: sha });
      item.quarantineDir = dir;
    }
    if (item.state === 'exported') {
      const dir = item.quarantineDir;
      if (!dir || !(await ctx.quarantine.epubIn(dir))) throw new Error('The export is gone');
      const before = await this.listedPatiently(source, item.calibreId);
      if (!before || before.uuid !== item.uuid) {
        await ctx.report(batch, item, {
          step: 'skipped',
          detail: 'The book is no longer in Calibre'
        });
        return;
      }
      const copy = await this.addOnce(target, dir, str(before.title), `${item.calibreId}.add.json`);
      const takeOut = async (why: string) => {
        const out = await this.removeCopy(target, copy.id, copy.uuid);
        await ctx.report(batch, item, {
          step: 'failed',
          detail: `${why}. ${out ? `The copy added to ${target.libraryId} was taken out again` : `The copy added to ${target.libraryId} (id ${copy.id}) could not be taken out: check Calibre`}; the book stays where it was.`
        });
      };
      let after = await this.listedPatiently(target, copy.id);
      if (!after) throw new Error('The added copy is not listed');
      let diff = differingFields(before, after);
      const fixed = [...diff];
      if (diff.length > 0) {
        if (diff.includes('formats'))
          return takeOut(`Not every format arrived (${str(before.formats)})`);
        const cover = path.join(dir, 'book.jpg');
        const args = fieldArgsFrom(
          diff,
          before,
          ctx.illustratorNames(),
          (await exists(cover)) ? cover : null
        );
        if (args.length > 0) {
          try {
            await ctx.calibredb.setFields(target, copy.id, args, [dir]);
          } catch (err) {
            ctx.log.info(`Fields of ${copy.id}: ${shorten((err as Error).message, 200)}`);
          }
          after = await this.listedPatiently(target, copy.id);
          if (!after) throw new Error('The added copy is not listed');
          diff = differingFields(before, after);
        }
        if (diff.length > 0) return takeOut(`These fields did not arrive: ${diff.join(', ')}`);
      }
      // The server's half: the stored EPUB, the cover and the title sort (read from the mounts).
      let check: { ok: boolean; problems: string[] } = { ok: false, problems: [] };
      const until = Date.now() + 60_000;
      for (;;) {
        check = await ctx.api.moveCheck(batch.id, item.itemId, {
          calibreId: copy.id,
          uuid: copy.uuid
        });
        if (check.ok || !check.problems.every((p) => /does not show/.test(p)) || Date.now() > until)
          break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!check.ok) return takeOut(check.problems.join('; '));
      await ctx.report(batch, item, {
        step: 'tagged',
        calibreId: copy.id,
        uuid: copy.uuid,
        fields: after,
        fixed
      });
      item.move = {
        ...(item.move ?? { added: null }),
        added: { calibreId: copy.id, uuid: copy.uuid }
      };
    }
    if (item.state === 'tagged') {
      const added = item.move?.added;
      if (!added) throw new Error('The added copy is not known');
      const there = await ctx.calibredb.book(target, added.calibreId);
      if (
        !there ||
        there.uuid !== added.uuid ||
        !there.formats.some((f) => f.toUpperCase() === 'EPUB')
      ) {
        await ctx.report(batch, item, {
          step: 'failed',
          detail: `The copy in ${target.libraryId} is gone or has no EPUB: the book was not removed`
        });
        return;
      }
      if (!(await this.removeCopy(source, item.calibreId, item.uuid)))
        throw new Error('Calibre still lists the book after remove');
      await ctx.report(batch, item, { step: 'removed' });
      ctx.log.info(
        `Moved ${item.calibreId} to ${target.libraryId} as ${added.calibreId}: ${item.title}`
      );
    }
  }

  /**
   * Undo of one moved book: back into the old library, the moved copy's later changes written
   * onto it, the moved copy exported and removed. `plan`: what the worker asked the old
   * library's trash for (once per batch).
   */
  async undoItem(
    batch: Batch,
    item: BatchItem,
    source: Login,
    target: Login,
    plan: MovePlan
  ): Promise<void> {
    const { ctx } = this;
    const moved = item.move?.movedCopy ?? null;
    // 1. The old copy back.
    let back: { id: number; uuid: string } | null = null;
    let method: 'trash' | 'readd' = 'trash';
    const present = await ctx.calibredb.book(source, item.calibreId).catch(() => undefined);
    if (present && present.uuid === item.uuid) back = { id: present.id, uuid: present.uuid };
    else if (plan.requested.includes(item.calibreId)) {
      const until = plan.requestedAt + ctx.waits.trashRestoreWaitSeconds * 1000;
      back = await ctx.pollUntil(until, async () => {
        const b = await ctx.calibredb.book(source, item.calibreId);
        return b && b.uuid === item.uuid ? { id: b.id, uuid: b.uuid } : null;
      });
      if (!back)
        throw new Error(
          "Calibre hasn't brought this book back from its trash yet: Undo again later (nothing is added twice)"
        );
    } else if (plan.notInTrash.includes(item.calibreId)) {
      const dir = item.quarantineDir;
      if (!dir || !(await ctx.quarantine.epubIn(dir))) {
        await ctx.report(batch, item, {
          step: 'failed',
          detail: "Not in Calibre's trash and the quarantine copy is gone"
        });
        return;
      }
      back = await this.addOnce(source, dir, item.title, `${item.calibreId}.readd.json`);
      method = 'readd';
    } else throw new Error("Calibre's trash couldn't be asked for this book; Undo again");
    // 2. The moved copy: exported into this Undo's quarantine folder, its later changes carried.
    const copy = moved ? await ctx.calibredb.book(target, moved.calibreId) : null;
    if (moved && copy && copy.uuid === moved.uuid) {
      const dir = await ctx.quarantine.freshName(
        ctx.quarantine.batchDir(batch.id),
        `moved-${moved.calibreId}`
      );
      await fsp.mkdir(dir);
      await ctx.calibredb.ok('export', target, [
        '--to-dir',
        dir,
        '--single-dir',
        '--dont-update-metadata',
        '--template',
        'book',
        String(moved.calibreId)
      ]);
      const now = await this.listedPatiently(target, moved.calibreId);
      const atMove = item.move?.fieldsAtMove ?? null;
      if (now && atMove) {
        const changed = differingFields(atMove, now).filter(
          (f) => f !== 'formats' && f !== 'cover'
        );
        // A cover changed since the move: the exports' pictures differ.
        const coverNow = path.join(dir, 'book.jpg');
        const coverThen = item.quarantineDir ? path.join(item.quarantineDir, 'book.jpg') : null;
        let coverChanged = false;
        if ((await exists(coverNow)) && coverThen && (await exists(coverThen)))
          coverChanged = (await sha256File(coverNow)) !== (await sha256File(coverThen));
        else if ((await exists(coverNow)) && !(coverThen && (await exists(coverThen))))
          coverChanged = true;
        const fields = [...changed, ...(coverChanged ? (['cover'] as const) : [])] as Compared[];
        if (fields.length > 0) {
          const args = fieldArgsFrom(
            fields,
            now,
            ctx.illustratorNames(),
            coverChanged ? coverNow : null
          );
          await ctx.calibredb.setFields(source, back.id, args, [dir]);
          const after = await this.listedPatiently(source, back.id);
          const left = after
            ? differingFields(now, after).filter((f) => (changed as string[]).includes(f))
            : changed;
          if (left.length > 0)
            throw new Error(
              `The moved copy's later changes did not all reach the book: ${left.join(', ')}`
            );
          ctx.log.info(`Undo ${item.calibreId}: carried ${fields.join(', ')} from the moved copy`);
        }
      }
      // 3. The moved copy goes (to its library's trash).
      if (!(await this.removeCopy(target, moved.calibreId, moved.uuid)))
        throw new Error(`Calibre still lists the moved copy in ${target.libraryId}`);
    }
    await ctx.report(batch, item, {
      step: 'restored',
      method,
      calibreId: back.id,
      uuid: back.uuid
    });
    ctx.log.info(`Moved ${item.calibreId} back from ${target.libraryId} (${method})`);
  }
}

/** The shape of a custom column in `custom_columns --details` output (calibre 9.x dicts). */
export function columnShape(
  block: string | null
): { datatype: string; multiple: boolean; names: boolean } | null {
  if (!block) return null;
  const datatype = /['"]?datatype['"]?\s*:\s*['"]?(\w+)/i.exec(block)?.[1]?.toLowerCase() ?? '';
  const multiple =
    /['"]?is_multiple['"]?\s*:\s*(True\b|true\b|\{\s*['"])/.test(block) &&
    !/['"]?is_multiple['"]?\s*:\s*(False\b|false\b|None\b|\{\s*\})/.test(block);
  const names = /['"]?is_names['"]?\s*:\s*(True\b|true\b)/.test(block);
  return { datatype, multiple, names };
}
