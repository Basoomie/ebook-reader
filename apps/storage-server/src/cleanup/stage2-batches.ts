/**
 * Stage 2 batches (WP20b): writing the files' metadata and covers into Calibre through the
 * apply sidecar, and Undo.
 *
 * A batch holds up to `batchSize` books (all their auto fields, except paused fields). The
 * sidecar works one book at a time and the server decides everything:
 *
 * - verify: the sidecar sends what Calibre shows now (`calibredb list`); per field the server
 *   answers write (Calibre still has the analysed value), already done (it has the new value),
 *   or skip ("changed in Calibre since the analysis": never overwrite a user's edit). It also
 *   gives the exact `--field` arguments, whether a cover goes with them and whether Calibre's
 *   old cover must be saved in the quarantine first (D1).
 * - written: after the write the sidecar sends what Calibre shows. A field showing the new
 *   value is written (undo record, applied value with its source and last_modified after);
 *   when the write errored or timed out the sidecar keeps asking until Calibre shows it or the
 *   wait is over (`final`), and a write that may have happened is never sent twice.
 * - Undo writes the old values back where Calibre still holds what was written. A cover added
 *   where Calibre had none stays: the content server can't remove a cover (D3).
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { snapshotFile } from '../calibre/indexer';
import { parseCalibreDate } from '../calibre/ingest';
import { currentCalibreEpub, liveTitleSort } from '../calibre/live-lookup';
import { getLibrary } from '../calibre/libraries';
import { readSourceFile, resolveInside, statFile } from '../calibre/source-fs';
import { BatchError, type BatchRow, type BatchService, type ItemState } from './batches';
import { coverForCalibre, readCoverBytes } from './file-metadata';
import { presentBookCount } from './handoff';
import { getSettings } from './settings';
import { listFieldPauses } from './stage2-gate';
import { titleSort } from './title-rules';
import { illustratorIsNames, readStage2Snapshot, type Stage2Book } from './stage2-snapshot';
import { readStage4Extras, type Stage4Extras } from './stage4/snapshot4';
import { LONG_AUTHOR_REASON, NAME_MAX_BYTES, calibreNameBytes } from './stage2-rules';
import { fitTitle } from './title-fit';
import { CALIBRE_AUTHOR_WORDS } from './calibre-names';
import { currentAnalysisId, pauseStage } from './stages';
import { movedFrom } from './move/rekey';
import { EDIT_STAGE } from './field-stages';
import type { CoverArchive } from './edits/cover-archive';
import { aiYoursAfterWrite } from './edits/yours';
import { applyTagChange, sameTags, undoTagChange, type TagChange } from './stage5/decide';

export const STAGE2_TERMINAL_APPLY: ItemState[] = ['written', 'failed', 'skipped'];

/** What `calibredb list --for-machine` shows for one book (the fields stage 2 reads). */
export interface ListedBook {
  id?: unknown;
  uuid?: unknown;
  title?: unknown;
  authors?: unknown;
  author_sort?: unknown;
  identifiers?: unknown;
  publisher?: unknown;
  languages?: unknown;
  cover?: unknown;
  last_modified?: unknown;
  '*illustrator'?: unknown;
  series?: unknown;
  series_index?: unknown;
  comments?: unknown;
  tags?: unknown;
  pubdate?: unknown;
  rating?: unknown;
  /** The title sort, through `--template {sort}` (it can't be listed as a field). */
  template?: unknown;
}

/** Also series, series_index and comments (stage 4, WP20e) and tags (stage 5, WP20f). */
export const LIST_FIELDS =
  'uuid,title,authors,author_sort,identifiers,publisher,languages,cover,last_modified,*illustrator,series,series_index,comments,tags';

/**
 * The user's edits also read the published date and the rating (1.5.0). The title sort can't be
 * listed through the content server: it is read from the live metadata.db (withLiveSort).
 */
export const EDIT_LIST_FIELDS = `${LIST_FIELDS},pubdate,rating`;

interface Current {
  uuid: string | null;
  title: string;
  authors: string[];
  identifiers: Record<string, string>;
  publisher: string;
  languages: string[];
  illustrators: string[];
  hasCover: boolean;
  lastModified: string | null;
  authorSort?: string;
  series?: string | null;
  seriesIndex?: number | null;
  comments?: string;
  tags?: string[];
  /** Only when listed (the user's edits): the title sort, published date (ms) and rating (0-10). */
  titleSort?: string;
  pubdate?: number | null;
  rating?: number | null;
}

const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : typeof v === 'string' && v !== ''
      ? v.split(',').map((x) => x.trim())
      : [];

export function parseListed(b: ListedBook): Current {
  const ids: Record<string, string> = {};
  if (b.identifiers && typeof b.identifiers === 'object' && !Array.isArray(b.identifiers)) {
    for (const [k, v] of Object.entries(b.identifiers as Record<string, unknown>)) {
      if (typeof v === 'string') ids[k.toLowerCase()] = v;
    }
  }
  return {
    uuid: typeof b.uuid === 'string' ? b.uuid : null,
    title: typeof b.title === 'string' ? b.title : '',
    authors:
      typeof b.authors === 'string'
        ? b.authors
            .split(' & ')
            .map((a) => a.trim())
            .filter((a) => a !== '')
        : strList(b.authors),
    identifiers: ids,
    publisher: typeof b.publisher === 'string' ? b.publisher : '',
    languages: strList(b.languages),
    illustrators: strList(b['*illustrator']),
    hasCover: b.cover === 1 || b.cover === true || b.cover === '1',
    lastModified: typeof b.last_modified === 'string' ? b.last_modified : null,
    authorSort: typeof b.author_sort === 'string' ? b.author_sort : '',
    series: typeof b.series === 'string' && b.series !== '' ? b.series : null,
    seriesIndex:
      typeof b.series_index === 'number'
        ? b.series_index
        : typeof b.series_index === 'string' && b.series_index !== ''
          ? Number(b.series_index)
          : null,
    comments: typeof b.comments === 'string' ? b.comments : '',
    tags: strList(b.tags),
    ...(typeof b.template === 'string' ? { titleSort: b.template } : {}),
    ...('pubdate' in b ? { pubdate: parseCalibreDate(b.pubdate ?? null) } : {}),
    ...('pubdate' in b || 'rating' in b ? { rating: listedRating(b.rating) } : {}),
  };
}

/** Calibre's rating as `list` shows it (0-10; absent or 0 = none). */
function listedRating(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(10, Math.round(n)) : null;
}

const tagKey = (l: string[]) => [...new Set(l.map((x) => x.toLowerCase()))].sort().join('|');

/** A published date as calibredb takes it (an exact time with its zone; '' = none). */
export function calibreDate(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

const lowerList = (l: string[]) => l.map((x) => x.toLowerCase());
const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const sameDict = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return sameList(ka, kb) && ka.every((k) => a[k] === b[k]);
};

/**
 * Whether Calibre's current value of a field equals `value`. Shared names (authors,
 * illustrators) compare ignoring case: Calibre may spell a name the way it already knows it.
 */
export function fieldEquals(
  field: string,
  current: Current,
  value: unknown,
  strictCase = true,
): boolean {
  switch (field) {
    case 'title':
      return current.title === value;
    case 'authors': {
      const v = Array.isArray(value) ? (value as string[]) : [];
      return strictCase
        ? sameList(current.authors, v)
        : sameList(lowerList(current.authors), lowerList(v));
    }
    case 'identifiers':
      return sameDict(current.identifiers, (value ?? {}) as Record<string, string>);
    case 'publisher':
      return (current.publisher ?? '') === ((value as string | null) ?? '');
    case 'languages':
      return sameList(current.languages, Array.isArray(value) ? (value as string[]) : []);
    case 'illustrator':
      return sameList(
        lowerList(current.illustrators),
        lowerList(Array.isArray(value) ? (value as string[]) : []),
      );
    case 'series': {
      // Calibre keeps a series_index without a series: the number counts only with a name.
      const v = (value ?? {}) as { name?: string | null; index?: number | null };
      const name = v.name ?? null;
      if ((current.series ?? null) !== name) return false;
      return name === null || v.index === null || v.index === undefined
        ? true
        : current.seriesIndex === v.index;
    }
    case 'description':
      return (current.comments ?? '').trim() === ((value as string | null) ?? '').trim();
    case 'author_sort':
      return (current.authorSort ?? '') === ((value as string | null) ?? '');
    // The user's edits (calibre metadata editing).
    case 'sort':
      return current.titleSort !== undefined && current.titleSort === ((value as string) ?? '');
    case 'pubdate': {
      // Compared to the second; no date is Calibre's undefined date (null).
      if (current.pubdate === undefined) return false;
      const v = typeof value === 'number' ? Math.floor(value / 1000) : null;
      const c = current.pubdate === null ? null : Math.floor(current.pubdate / 1000);
      return c === v;
    }
    case 'rating':
      return (
        current.rating !== undefined &&
        (current.rating ?? null) === (typeof value === 'number' && value > 0 ? value : null)
      );
    case 'tags':
      return tagKey(current.tags ?? []) === tagKey(Array.isArray(value) ? (value as string[]) : []);
    default:
      return false;
  }
}

/** The `--field` arguments that set a field to `value` (extra: the sort written alongside). */
export function fieldArgs(
  field: string,
  value: unknown,
  extra: Record<string, unknown> = {},
  /** " & " for a names column (see illustratorIsNames), "," otherwise. */
  illustratorSeparator = ',',
): string[] {
  switch (field) {
    case 'title':
      return [
        `title:${value as string}`,
        `sort:${typeof extra.sort === 'string' ? extra.sort : titleSort(value as string)}`,
      ];
    case 'authors':
      return [
        `authors:${(value as string[]).join(' & ')}`,
        `author_sort:${typeof extra.author_sort === 'string' ? extra.author_sort : ''}`,
      ];
    case 'identifiers':
      return [
        `identifiers:${Object.entries((value ?? {}) as Record<string, string>)
          .map(([k, v]) => `${k}:${v}`)
          .join(',')}`,
      ];
    case 'publisher':
      return [`publisher:${(value as string | null) ?? ''}`];
    case 'languages':
      return [`languages:${((value as string[] | null) ?? []).join(',')}`];
    case 'illustrator':
      return [`#illustrator:${((value as string[] | null) ?? []).join(illustratorSeparator)}`];
    case 'series': {
      const v = (value ?? {}) as { name?: string | null; index?: number | null };
      return v.name && v.index !== null && v.index !== undefined
        ? [`series:${v.name}`, `series_index:${v.index}`]
        : [`series:${v.name ?? ''}`];
    }
    case 'description':
      return [`comments:${(value as string | null) ?? ''}`];
    case 'author_sort':
      return [`author_sort:${(value as string | null) ?? ''}`];
    case 'sort':
      return [`sort:${(value as string | null) ?? ''}`];
    case 'pubdate':
      return [`pubdate:${calibreDate(typeof value === 'number' ? value : null)}`];
    case 'rating':
      // calibredb takes stars (4.5 is stored as 9); 0 takes the rating off (calibre 9.18).
      return [`rating:${typeof value === 'number' && value > 0 ? value / 2 : 0}`];
    case 'tags':
      return [`tags:${((value as string[] | null) ?? []).join(',')}`];
    default:
      throw new BatchError(500, 'bad_field', `No such field: ${field}`);
  }
}

interface ItemRow {
  item_id: number;
  change_id: number;
  state: ItemState;
  field: string;
  calibre_id: number;
  calibre_uuid: string;
  old_json: string;
  new_json: string;
  source: string;
  evidence_json: string;
  stage2_json: string | null;
}

interface Evidence2 {
  title?: string;
  lastModified?: string | null;
  extra?: Record<string, { old: unknown; new: unknown }> | null;
  epub?: { path: string; size: number | null; mtimeMs: number | null };
  cover?: { entry: string; sha256: string; hadCover: boolean };
}

export interface Stage2SidecarBook {
  calibreId: number;
  uuid: string;
  title: string;
  state: ItemState;
  fields: { itemId: number; field: string; state: ItemState }[];
  /** undo: Calibre's old cover saved in the quarantine before it was replaced. */
  oldCoverPath: string | null;
}

export interface VerifyAnswer {
  action: 'write' | 'none';
  /** `--field` arguments (cover excluded). */
  fields: string[];
  /** Download the cover (apply) or write the saved one back (undo: oldCoverPath). */
  cover: boolean;
  /** apply: save Calibre's current cover into the quarantine before writing. */
  saveOldCover: boolean;
  oldCoverPath: string | null;
  /**
   * apply (the user's Undo of a cover, sidecar 1.5.0): write this picture from the quarantine
   * instead of downloading one.
   */
  coverFrom?: string | null;
  /** Per field: write / done / skip and why. */
  items: { itemId: number; field: string; state: ItemState; detail: string | null }[];
}

/** Book covers: whether Calibre's current picture was kept in the cover archive before a write. */
export interface CoverKept {
  kept: boolean | null;
  error: string | null;
}

export interface WrittenReport {
  current: ListedBook | null;
  error?: string | null;
  final?: boolean;
  oldCoverPath?: string | null;
  /** The cover was left out of the write (its old cover couldn't be saved, or no download). */
  coverSkipped?: string | null;
}

const EDITED = 'Changed in Calibre since the analysis (left as it is)';
const EDITED_AFTER = 'Changed in Calibre since the cleanup wrote it (left as it is)';
/** The user's edit: Calibre no longer had the value the form showed. */
export const EDITED_FORM = 'Changed in Calibre since you opened the form (left as it is)';
/** A field that is the user's (edited, confirmed or changed in Calibre's own program). */
export const YOURS_REASON =
  'Yours: you edited or confirmed this field (the cleanup never changes it)';

/**
 * The user's fields a cleanup write of `field` would change: a title write also writes the title
 * sort, an author write the author sort, a series write its number.
 */
export function fieldsWritten(field: string): string[] {
  switch (field) {
    case 'title':
      return ['title', 'sort'];
    case 'authors':
      return ['authors', 'author_sort'];
    case 'series':
      return ['series', 'series_index'];
    default:
      return [field];
  }
}

/** Whether a cleanup write of `field` would change a field that is the user's. */
export function isYours(
  db: Database.Database,
  libraryId: string,
  uuid: string,
  field: string,
): boolean {
  return yoursRow(db, libraryId, uuid, field) !== null;
}

/** The user's field a cleanup write of `field` would change (the latest), or null. */
export function yoursRow(
  db: Database.Database,
  libraryId: string,
  uuid: string,
  field: string,
): { source: string; since: number } | null {
  const keys = fieldsWritten(field);
  return (
    (db
      .prepare(
        `SELECT source, since FROM user_fields WHERE library_id = ? AND calibre_uuid = ?
           AND field IN (${keys.map(() => '?').join(', ')}) ORDER BY since DESC LIMIT 1`,
      )
      .get(libraryId, uuid, ...keys) as { source: string; since: number } | undefined) ?? null
  );
}

/**
 * Calibre's times: the snapshot says "2026-11-14 13:57:11.479076+00:00", `list` says ISO, and
 * (real calibre 9.18, seen in the e2e) `list` drops the fraction of a book it hasn't written in
 * this server session ("2026-11-14T14:45:31+00:00" for "14:45:31.864916"): compared to the
 * whole second.
 */
export function sameTime(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = parseCalibreDate(a ?? null);
  const tb = parseCalibreDate(b ?? null);
  return ta !== null && tb !== null
    ? Math.floor(ta / 1000) === Math.floor(tb / 1000)
    : (a ?? null) === (b ?? null);
}

/** When the reader last copied Calibre's metadata.db (0 when there is no copy). */
function snapshotTime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Whether a folder is there (a name too long for the disk, or none: false). */
async function folderExists(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export const NO_FOLDER_REASON =
  "The book has no folder in Calibre's library (a record without files)";
export const SPLIT_NAME_REASON = 'A name contains &, which Calibre splits into two names';
export const SPLIT_WORD_REASON =
  'A name contains "and" or "with", which Calibre splits into two names';
export const LONG_NAME_REASON = "Too long for a folder name in Calibre's library";
export const PROPOSED_TWICE_REASON = 'The same change was proposed twice; it is written once';
export const TWO_VALUES_REASON =
  'Two different changes were proposed for this field; run the analysis again';

/** The fields stage 4 writes to Calibre (format and edition kind wait for stage 5). */
export const STAGE4_WRITTEN_FIELDS = [
  'title',
  'authors',
  'author_sort',
  'illustrator',
  'series',
  'description',
  'identifiers',
  'cover',
] as const;

/** The field stage 5 writes: the book's tags, as a change (add / remove) applied to Calibre's own. */
export const STAGE5_WRITTEN_FIELDS = ['tags'] as const;

/** The stage-4 gate pauses by its field names; the proposals' fields they hold back. */
const STAGE4_PAUSED_FIELDS: Record<string, string[]> = {
  title: ['title'],
  authors: ['authors'],
  illustrators: ['illustrator'],
  series: ['series'],
  number: ['series'],
};

export class Stage2Batches {
  /** Stage 4's cover pictures come from the fetch cache (the store's image by its address). */
  private storeCover: ((url: string) => Buffer | null) | null = null;
  /** Book covers: where Calibre's picture is kept before a cover write (edits/cover-archive.ts). */
  private archive: CoverArchive | null = null;

  constructor(
    private readonly batches: BatchService,
    private readonly deps: {
      cleanup: Database.Database;
      main: Database.Database;
      calibreDir: string | null;
      cacheDir: string;
    },
    /** 2: the files' metadata; 4: the online sources (WP20e); 5: genres and tags (WP20f). */
    readonly stage: 2 | 4 | 5 | 10 = 2,
  ) {}

  /** Stage 4: where the store covers are read (the fetch queue's cached answers). */
  setStoreCover(read: (url: string) => Buffer | null): void {
    this.storeCover = read;
  }

  /** Book covers: the archive every cover write keeps Calibre's current picture in first. */
  setCoverArchive(archive: CoverArchive): void {
    this.archive = archive;
  }

  private get db() {
    return this.deps.cleanup;
  }

  private namesColumn: { file: string; mtimeMs: number; sep: string } | null = null;

  /** How #illustrator values are joined for Calibre (from the indexer's latest snapshot). */
  private illustratorSeparator(libraryId: string): string {
    const file = snapshotFile(this.deps.cacheDir, libraryId);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return ',';
    }
    if (this.namesColumn?.file !== file || this.namesColumn.mtimeMs !== mtimeMs) {
      this.namesColumn = { file, mtimeMs, sep: illustratorIsNames(file) ? ' & ' : ',' };
    }
    return this.namesColumn.sep;
  }

  private libDir(libraryId: string): string {
    const lib = getLibrary(this.deps.main, libraryId);
    if (!lib || !this.deps.calibreDir)
      throw new BatchError(503, 'no_library', 'The library is not available');
    return path.join(this.deps.calibreDir, lib.folder);
  }

  /** Plans the next stage-2 batch (the caller checked mode, pauses and the safety checks). */
  /**
   * Calibre splits a name on "&" into two authors (seen on the NAS 2026-11-15: the change then
   * never shows and the book fails). Such author or illustrator changes go to review.
   */
  private reviewSplitNames(libraryId: string, now = Date.now()): void {
    // " and " / " with " too (calibre's string_to_authors), but not in your own edits: what you
    // typed is yours (the editor handles its names itself).
    const words = this.stage !== EDIT_STAGE;
    const rows = this.db
      .prepare(
        `SELECT id, new_json FROM proposed_changes
         WHERE stage = ${this.stage} AND library_id = ? AND state = 'proposed' AND class = 'auto'
           AND field IN ('authors', 'illustrator')
           AND (new_json LIKE '%&%'${words ? " OR new_json LIKE '%and%' OR new_json LIKE '%with%'" : ''})`,
      )
      .all(libraryId) as { id: number; new_json: string }[];
    const mark = this.db.prepare(
      `UPDATE proposed_changes SET class = 'review', review_reason = ?, updated_at = ? WHERE id = ?`,
    );
    for (const r of rows) {
      const v = JSON.parse(r.new_json) as unknown;
      if (!Array.isArray(v)) continue;
      const names = v.filter((n): n is string => typeof n === 'string');
      if (names.some((n) => n.includes('&'))) mark.run(SPLIT_NAME_REASON, now, r.id);
      else if (words && names.some((n) => CALIBRE_AUTHOR_WORDS.test(n)))
        mark.run(SPLIT_WORD_REASON, now, r.id);
    }
  }

  /**
   * `analysisId` (WP20g): plan the proposals of a new-arrivals run (arrivals:<run>) instead of the
   * stage's current analysis; then only that run's own proposals (no decided ones of the library).
   */
  async plan(
    libraryId: string,
    opts: { analysisId?: string } = {},
  ): Promise<{ batch: BatchRow | null; reason: string | null }> {
    if (this.batches.open()) return { batch: null, reason: 'A batch is being applied' };
    this.reviewSplitNames(libraryId);
    this.liftNameHolds(libraryId);
    const settings = getSettings(this.db);
    const paused = new Set(
      listFieldPauses(this.db, libraryId, this.stage).flatMap((p) =>
        this.stage === 4 ? (STAGE4_PAUSED_FIELDS[p.field] ?? [p.field]) : [p.field],
      ),
    );
    const written: ReadonlySet<string> | null =
      this.stage === 4
        ? new Set<string>(STAGE4_WRITTEN_FIELDS)
        : this.stage === 5
          ? new Set<string>(STAGE5_WRITTEN_FIELDS)
          : null;
    const rows = this.db
      .prepare(
        `SELECT id, calibre_id, calibre_uuid, field, old_json, new_json, evidence_json, created_at FROM proposed_changes
         WHERE stage = ${this.stage} AND library_id = ? AND state = 'proposed' AND class = 'auto'
           AND ${opts.analysisId ? 'analysis_id = ?' : '(analysis_id = ? OR decided_by IS NOT NULL)'}${
             // Stage 4: only the fields it writes (format and edition wait for stage 5), so a stage
             // with only those left says Done, not that its fields are paused.
             this.stage === 4
               ? ` AND field IN (${STAGE4_WRITTEN_FIELDS.map((x) => `'${x}'`).join(', ')})`
               : this.stage === 5
                 ? ` AND field = 'tags'`
                 : ''
           }
         ORDER BY calibre_id, id`,
      )
      .all(libraryId, opts.analysisId ?? currentAnalysisId(this.db, libraryId, this.stage)) as {
      id: number;
      calibre_id: number;
      calibre_uuid: string;
      field: string;
      old_json: string;
      new_json: string;
      evidence_json: string;
      created_at?: number;
    }[];
    // Counted only when something is left: this plan runs every round while other stages
    // apply, and the count reads 60,000+ rows (it blocked the server between stage 3's batches).
    const present = rows.length > 0 ? presentBookCount(this.deps.main, libraryId) : 0;
    const cap = Math.max(
      1,
      Math.min(
        settings.pacing.batchSize,
        Math.floor((present * settings.pacing.maxBatchPercent) / 100),
      ),
    );
    const byBook = new Map<string, typeof rows>();
    // A book's field goes to Calibre once per write (the sidecar refuses a field given twice:
    // on the NAS 2026-11-15 a chunk the analysis proposed twice failed 75 books this way).
    const twice: { id: number; reason: string }[] = [];
    const twoValues = new Set<string>();
    for (const r of rows) {
      if (paused.has(r.field)) continue;
      if (written && !written.has(r.field)) continue;
      const key = `${r.calibre_uuid}|${r.field}`;
      if (twoValues.has(key)) {
        twice.push({ id: r.id, reason: TWO_VALUES_REASON });
        continue;
      }
      const items = byBook.get(r.calibre_uuid);
      const first = items?.find((x) => x.field === r.field);
      if (items && first) {
        if (first.new_json === r.new_json) {
          twice.push({ id: r.id, reason: PROPOSED_TWICE_REASON });
        } else {
          // Two different values: neither is clearly the one; the field waits for a new analysis.
          twoValues.add(key);
          twice.push(
            { id: first.id, reason: TWO_VALUES_REASON },
            { id: r.id, reason: TWO_VALUES_REASON },
          );
          items.splice(items.indexOf(first), 1);
        }
        continue;
      }
      if (!items) {
        if (byBook.size >= cap) break;
        byBook.set(r.calibre_uuid, []);
      }
      byBook.get(r.calibre_uuid)!.push(r);
    }
    for (const [uuid, items] of byBook) if (items.length === 0) byBook.delete(uuid);
    const setAsideTwice = () => {
      if (twice.length === 0) return;
      const mark = this.db.prepare(
        `UPDATE proposed_changes SET state = 'skipped', review_reason = ?, updated_at = ?
         WHERE id = ? AND state = 'proposed'`,
      );
      const now = Date.now();
      this.db.transaction(() => {
        for (const s of twice) mark.run(s.reason, now, s.id);
      })();
    };
    if (byBook.size === 0) {
      setAsideTwice();
      return {
        batch: null,
        reason: rows.length > 0 ? 'Every field left to apply is paused' : null,
      };
    }
    // Check every book against Calibre now (the indexer's latest snapshot).
    const snapFile = snapshotFile(this.deps.cacheDir, libraryId);
    const snap = readStage2Snapshot(snapFile);
    const byUuid = new Map([...snap.books.values()].map((b) => [b.uuid, b]));
    // Stage 4 also checks series, number and description against Calibre now.
    const extras = this.stage === 4 ? readStage4Extras(snapFile) : null;
    // Every write makes Calibre rebuild the folder and file names (lessons 2): a title too long
    // for them is fitted now, with Calibre's current values, in every stage's batch.
    const needsTitle = this.fitLongNames(
      libraryId,
      opts.analysisId ?? currentAnalysisId(this.db, libraryId, this.stage),
      byBook,
      byUuid,
      snapshotTime(snapFile),
    );
    const libDir = this.libDir(libraryId);
    const skip: { id: number; reason: string }[] = [];
    const keep: number[] = [];
    const hold: number[] = [];
    let changedBooks = 0;
    for (const [uuid, items] of byBook) {
      const book = byUuid.get(uuid);
      let changed = false;
      const kept: number[] = [];
      let titleSkipped = false;
      for (const r of items) {
        const ev = JSON.parse(r.evidence_json) as Evidence2;
        // A field that is the user's is never written by the cleanup. One changed in Calibre's
        // own program after the analysis is what it always was here: "changed in Calibre since
        // the analysis", counted for the pause (a mass change under a stage pauses it, lessons
        // 1); after a new analysis it is set aside as theirs when proposed.
        const yours = yoursRow(this.db, libraryId, uuid, r.field);
        if (yours) {
          const sinceAnalysis = yours.source === 'calibre' && yours.since >= (r.created_at ?? 0);
          skip.push({ id: r.id, reason: sinceAnalysis ? EDITED : YOURS_REASON });
          if (sinceAnalysis) changed = true;
          if (r.field === 'title') titleSkipped = true;
          continue;
        }
        const reason = await this.planCheck(book, r, ev, libDir, extras, libraryId);
        if (reason) {
          skip.push({ id: r.id, reason });
          // A record without files is no change in Calibre (never pauses the stage).
          if (reason !== NO_FOLDER_REASON) changed = true;
          if (r.field === 'title') titleSkipped = true;
        } else kept.push(r.id);
      }
      // The fitted title is what lets the other fields be written at all: without it, they wait.
      if (titleSkipped && needsTitle.has(uuid)) hold.push(...kept);
      else keep.push(...kept);
      if (changed) changedBooks += 1;
    }
    if (hold.length > 0) {
      const mark = this.db.prepare(
        `UPDATE proposed_changes SET class = 'review', review_reason = ?, updated_at = ? WHERE id = ?`,
      );
      const now = Date.now();
      this.db.transaction(() => {
        for (const id of hold) mark.run(LONG_NAME_REASON, now, id);
      })();
    }
    const share = (100 * changedBooks) / Math.max(cap, byBook.size);
    if (changedBooks > 0 && share > settings.libraryChangedPausePercent) {
      pauseStage(
        this.db,
        libraryId,
        this.stage,
        'library_changed',
        `${changedBooks} of the next ${byBook.size} books changed in Calibre since the analysis. Nothing was written or skipped. Run the analysis again: writing goes on by itself after it.`,
      );
      return { batch: null, reason: 'Calibre changed since the analysis' };
    }
    setAsideTwice();
    if (skip.length > 0) {
      const mark = this.db.prepare(
        `UPDATE proposed_changes SET state = 'skipped', review_reason = ?, updated_at = ? WHERE id = ?`,
      );
      const now = Date.now();
      this.db.transaction(() => {
        for (const s of skip) mark.run(s.reason, now, s.id);
      })();
    }
    if (keep.length === 0) return { batch: null, reason: null };
    return {
      batch: this.batches.createBatch(this.stage, libraryId, 'apply', null, keep),
      reason: null,
    };
  }

  /** The snapshot time liftNameHolds last looked at (it reads the snapshot only when it changed). */
  private nameHoldsCheckedAt = -1;

  /**
   * Only the planner's own holds carry this reason (they were automatic when held); a best guess
   * (evidence "unconfirmed") is never lifted, whatever its reason says (live 2026-11-22: a stage-4
   * best guess whose reason the old proposal-time hold had replaced was lifted and written).
   * A change held for "Too long for a folder name" goes back to automatic once the book's names
   * fit in Calibre as it is now (another stage wrote a shorter title: found live 2026-11-22, the
   * stage-5 tags of 6 books held while stage 2's titles were being written). A held title change
   * goes back only when its own value fits. Your decisions are never touched. Reads the reader's
   * snapshot only when there are such holds and the snapshot changed since the last look.
   */
  private liftNameHolds(libraryId: string): void {
    const held = this.db
      .prepare(
        `SELECT id, calibre_uuid, field, new_json FROM proposed_changes
         WHERE stage = ? AND state = 'proposed' AND class = 'review' AND library_id = ?
           AND review_reason = ? AND decided_by IS NULL
           AND COALESCE(json_extract(evidence_json, '$.unconfirmed'), 0) = 0`,
      )
      .all(this.stage, libraryId, LONG_NAME_REASON) as {
      id: number;
      calibre_uuid: string;
      field: string;
      new_json: string;
    }[];
    if (held.length === 0) return;
    const snapFile = snapshotFile(this.deps.cacheDir, libraryId);
    const at = snapshotTime(snapFile);
    if (at === this.nameHoldsCheckedAt) return;
    this.nameHoldsCheckedAt = at;
    const snap = readStage2Snapshot(snapFile);
    const byUuid = new Map([...snap.books.values()].map((b) => [b.uuid, b]));
    const lift = this.db.prepare(
      `UPDATE proposed_changes SET class = 'auto', review_reason = NULL, updated_at = ? WHERE id = ?`,
    );
    const now = Date.now();
    this.db.transaction(() => {
      for (const r of held) {
        const book = byUuid.get(r.calibre_uuid);
        if (!book) continue;
        const first = book.authors[0] ?? 'Unknown';
        const title = r.field === 'title' ? (JSON.parse(r.new_json) as string) : book.title;
        if (calibreNameBytes(book.calibreId, title, first) <= NAME_MAX_BYTES) lift.run(now, r.id);
      }
    })();
  }

  /**
   * Every write makes Calibre rebuild the book's folder and file names from its title and first
   * author (lessons 2). Checked now with Calibre's current values: when the names would not fit
   * in 255 bytes, the title is fitted (title-fit.ts; decided with the user 2026-11-22): the
   * batch's own title change gets the fitted value, or a title change fitted from Calibre's own
   * title joins the batch (any stage; the only field such a change writes besides the sort).
   * Review instead, as before, when a first author is too long on its own (bad data; an author
   * change alone goes to review and the book goes on with Calibre's author), or when Calibre's
   * title is one the user set after the cleanup wrote one (their correction is never replaced).
   * Returns the books whose other fields need that title written with them.
   */
  private fitLongNames(
    libraryId: string,
    analysisId: string | null,
    byBook: Map<
      string,
      {
        id: number;
        calibre_id: number;
        calibre_uuid: string;
        field: string;
        old_json: string;
        new_json: string;
        evidence_json: string;
      }[]
    >,
    byUuid: Map<string, Stage2Book>,
    /** When the reader last copied Calibre's metadata.db (the snapshot's mtime). */
    snapshotAt = Number.POSITIVE_INFINITY,
  ): Set<string> {
    const needs = new Set<string>();
    const now = Date.now();
    const mark = this.db.prepare(
      `UPDATE proposed_changes SET class = 'review', review_reason = ?, updated_at = ? WHERE id = ?`,
    );
    const setTitle = this.db.prepare(
      `UPDATE proposed_changes SET new_json = ?, evidence_json = ?, updated_at = ? WHERE id = ?`,
    );
    const ownTitle = this.db.prepare(
      `SELECT value_json, applied_at FROM applied_values WHERE library_id = ? AND calibre_uuid = ? AND field = 'title'`,
    );
    const openFit = this.db.prepare(
      `SELECT id FROM proposed_changes INDEXED BY proposed_changes_book
       WHERE library_id = ? AND calibre_uuid = ? AND stage = ? AND field = 'title'
         AND state = 'proposed' AND source = 'title-fit' LIMIT 1`,
    );
    const insert = this.db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
         source, evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'title', ?, ?, 'title-fit', ?, 'auto', NULL, 'proposed', ?, ?, ?)`,
    );
    const STEPS = ['cleaned', 'shortened', 'cut'];
    for (const [uuid, items] of [...byBook]) {
      const book = byUuid.get(uuid);
      if (!book) continue;
      const t = items.find((x) => x.field === 'title');
      const a = items.find((x) => x.field === 'authors');
      const title = t ? (JSON.parse(t.new_json) as string) : book.title;
      const calFirst = book.authors[0] ?? 'Unknown';
      let first = a ? ((JSON.parse(a.new_json) as string[])[0] ?? 'Unknown') : calFirst;
      if (calibreNameBytes(book.calibreId, title, first) <= NAME_MAX_BYTES) continue;
      const holdAll = () => {
        this.db.transaction(() => {
          for (const x of items) mark.run(LONG_NAME_REASON, now, x.id);
        })();
        byBook.delete(uuid);
      };
      if (calibreNameBytes(book.calibreId, '', first) > NAME_MAX_BYTES) {
        if (!a || calibreNameBytes(book.calibreId, '', calFirst) > NAME_MAX_BYTES) {
          holdAll();
          continue;
        }
        mark.run(LONG_AUTHOR_REASON, now, a.id);
        items.splice(items.indexOf(a), 1);
        first = calFirst;
        if (calibreNameBytes(book.calibreId, title, first) <= NAME_MAX_BYTES) continue;
      }
      const authors = [
        ...new Set([...book.authors, ...(a ? (JSON.parse(a.new_json) as string[]) : [])]),
      ];
      const f = fitTitle(title, { calibreId: book.calibreId, firstAuthor: first, authors });
      if (f.step === 'none' || f.step === 'author_too_long') {
        holdAll();
        continue;
      }
      if (t) {
        const ev = JSON.parse(t.evidence_json) as Evidence2 & {
          fit?: { from: string; step: string; rules: string[] };
        };
        const step =
          ev.fit && STEPS.indexOf(ev.fit.step) > STEPS.indexOf(f.step) ? ev.fit.step : f.step;
        ev.fit = {
          from: ev.fit?.from ?? title,
          step,
          rules: [...(ev.fit?.rules ?? []), ...f.rules],
        };
        if (ev.extra?.sort) ev.extra.sort = { ...ev.extra.sort, new: titleSort(f.title) };
        t.new_json = JSON.stringify(f.title);
        t.evidence_json = JSON.stringify(ev);
        setTitle.run(t.new_json, t.evidence_json, now, t.id);
        needs.add(uuid);
        continue;
      }
      // Calibre's own title. One the user set after the cleanup wrote a title is theirs.
      const own = ownTitle.get(libraryId, uuid) as
        | { value_json: string; applied_at: number }
        | undefined;
      if (own && (JSON.parse(own.value_json) as string) !== book.title) {
        // Written by the cleanup after the reader last copied Calibre (another stage's batch a
        // moment ago, found live 2026-11-22): the copy is behind, not your edit. Left for a
        // later round, once the reader's index has the title.
        if (own.applied_at > snapshotAt) {
          byBook.delete(uuid);
          continue;
        }
        holdAll();
        continue;
      }
      const ev = {
        title: book.title,
        authors: book.authors,
        lastModified: book.lastModified,
        titleFit: true,
        reason: null,
        fit: { from: book.title, step: f.step, rules: f.rules },
        extra: { sort: { old: book.titleSort, new: titleSort(f.title) } },
      };
      const row = {
        calibre_id: book.calibreId,
        calibre_uuid: uuid,
        field: 'title',
        old_json: JSON.stringify(book.title),
        new_json: JSON.stringify(f.title),
        evidence_json: JSON.stringify(ev),
      };
      const open = openFit.get(libraryId, uuid, this.stage) as { id: number } | undefined;
      let id: number;
      if (open) {
        id = open.id;
        this.db
          .prepare(
            `UPDATE proposed_changes SET old_json = ?, new_json = ?, evidence_json = ?, class = 'auto',
               review_reason = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(row.old_json, row.new_json, row.evidence_json, now, id);
      } else {
        id = Number(
          insert.run(
            this.stage,
            libraryId,
            book.calibreId,
            uuid,
            row.old_json,
            row.new_json,
            row.evidence_json,
            analysisId,
            now,
            now,
          ).lastInsertRowid,
        );
      }
      items.unshift({ id, ...row });
      needs.add(uuid);
    }
    return needs;
  }

  private async planCheck(
    book: Stage2Book | undefined,
    r: { calibre_id: number; field: string; old_json: string },
    ev: Evidence2,
    libDir: string,
    extras: Map<number, Stage4Extras> | null = null,
    libraryId = '',
  ): Promise<string | null> {
    if (!book || book.calibreId !== r.calibre_id) return 'The book is no longer in Calibre';
    // Stage 5's tags: a change applied to what Calibre holds at the write (a tag added since
    // stays), also on books without an EPUB (removals only): nothing to compare here.
    if (r.field === 'tags') return null;
    // A title fitted for Calibre's names (from Calibre's own title) doesn't read the file either.
    const fromCalibre = r.field === 'title' && (ev as { titleFit?: boolean }).titleFit === true;
    if (!book.filePath && !fromCalibre) return 'The book has no EPUB in Calibre any more';
    // Calibre renames the book's folder with the title: a record whose folder was never made
    // (its name was too long at the import: 11 records without files) is left alone.
    if (fromCalibre && !(await folderExists(resolveInside(libDir, book.path))))
      return NO_FOLDER_REASON;
    const old = JSON.parse(r.old_json) as unknown;
    const ex = extras?.get(book.calibreId);
    const current: Current = {
      authorSort: book.authorSort ?? '',
      series: ex?.series ?? null,
      seriesIndex: ex?.seriesIndex ?? null,
      comments: ex?.comments ?? '',
      uuid: book.uuid,
      title: book.title,
      authors: book.authors,
      identifiers: book.identifiers,
      publisher: book.publisher ?? '',
      languages: book.languages,
      illustrators: book.illustrators ?? [],
      hasCover: book.hasCover,
      lastModified: book.lastModified,
    };
    if (r.field === 'cover' && this.stage === 4) {
      // The store's picture: Calibre's cover as the analysis saw it (has one or not, untouched).
      if (book.hasCover !== old) return EDITED;
      if (book.hasCover && ev.lastModified && !sameTime(book.lastModified, ev.lastModified))
        return EDITED;
      return null;
    }
    if (r.field === 'cover') {
      if (!ev.epub || !ev.cover) return 'No cover facts';
      const st = book.filePath ? await statFile(resolveInside(libDir, book.filePath)) : null;
      if (!st || st.size !== ev.epub.size || st.mtimeMs !== ev.epub.mtimeMs)
        return 'The EPUB changed since the analysis';
      if (book.hasCover !== ev.cover.hadCover) return EDITED;
      if (book.hasCover && !sameTime(book.lastModified, ev.lastModified)) return EDITED;
      return null;
    }
    if (r.field === 'illustrator' && book.illustrators === null)
      return 'The library has no #illustrator column';
    return this.matchingOld(libraryId, book.uuid, r.field, current, old) ? null : EDITED;
  }

  /**
   * Calibre still has the analysed value, or a value stage 2 itself wrote since (a review
   * decision after the normalization was applied): that is not a user's edit. Returns the
   * value Calibre has (it becomes the undo record's old value), or null.
   */
  private matchingOld(
    libraryId: string,
    uuid: string,
    field: string,
    current: Current,
    old: unknown,
  ): { value: unknown } | null {
    if (fieldEquals(field, current, old)) return { value: old };
    const own = this.db
      .prepare(
        'SELECT value_json FROM applied_values WHERE library_id = ? AND calibre_uuid = ? AND field = ?',
      )
      .get(libraryId, uuid, field) as { value_json: string } | undefined;
    if (own) {
      const v = JSON.parse(own.value_json) as unknown;
      if (fieldEquals(field, current, v, false)) return { value: v };
    }
    return null;
  }

  private rows(batchId: string, calibreId?: number): ItemRow[] {
    return this.db
      .prepare(
        `SELECT i.id AS item_id, i.change_id, i.state, i.stage2_json, c.field, c.calibre_id, c.calibre_uuid,
                c.old_json, c.new_json, c.source, c.evidence_json
         FROM batch_items i JOIN proposed_changes c ON c.id = i.change_id
         WHERE i.batch_id = ? ${calibreId !== undefined ? 'AND c.calibre_id = ?' : ''} ORDER BY i.position`,
      )
      .all(...(calibreId !== undefined ? [batchId, calibreId] : [batchId])) as ItemRow[];
  }

  private undoRecord(batch: BatchRow, changeId: number) {
    return this.db
      .prepare('SELECT * FROM field_undo WHERE batch_id = ? AND change_id = ?')
      .get(batch.undoOf ?? batch.id, changeId) as
      | {
          old_json: string;
          new_json: string;
          extra_json: string;
          last_modified_after: string | null;
          old_cover_path: string | null;
          restored_at: number | null;
        }
      | undefined;
  }

  sidecarBooks(batch: BatchRow): Stage2SidecarBook[] {
    const books = new Map<number, Stage2SidecarBook>();
    for (const r of this.rows(batch.id)) {
      const ev = JSON.parse(r.evidence_json) as Evidence2;
      let b = books.get(r.calibre_id);
      if (!b) {
        b = {
          calibreId: r.calibre_id,
          uuid: r.calibre_uuid,
          title: ev.title ?? '',
          state: 'pending',
          fields: [],
          oldCoverPath: null,
        };
        books.set(r.calibre_id, b);
      }
      b.fields.push({ itemId: r.item_id, field: r.field, state: r.state });
      if (batch.kind === 'undo' && r.field === 'cover')
        b.oldCoverPath = this.undoRecord(batch, r.change_id)?.old_cover_path ?? null;
    }
    const terminal: ItemState[] =
      batch.kind === 'apply' ? STAGE2_TERMINAL_APPLY : ['restored', 'failed', 'skipped'];
    for (const b of books.values()) {
      const states = b.fields.map((f) => f.state);
      if (states.every((s) => terminal.includes(s)))
        b.state = states.some((s) => s === 'failed')
          ? 'failed'
          : states.every((s) => s === 'skipped')
            ? 'skipped'
            : batch.kind === 'apply'
              ? 'written'
              : 'restored';
      else b.state = states.some((s) => s === 'verified') ? 'verified' : 'pending';
    }
    return [...books.values()];
  }

  private setItem(
    itemId: number,
    state: ItemState,
    detail: string | null,
    stage2: Record<string, unknown> | null,
    now: number,
  ) {
    this.db
      .prepare(
        `UPDATE batch_items SET state = ?, detail = ?, stage2_json = COALESCE(?, stage2_json), updated_at = ? WHERE id = ?`,
      )
      .run(
        state,
        detail ? detail.slice(0, 2000) : null,
        stage2 ? JSON.stringify(stage2) : null,
        now,
        itemId,
      );
  }

  private skipChange(changeId: number, reason: string, now: number) {
    this.db
      .prepare(
        `UPDATE proposed_changes SET state = 'skipped', review_reason = ?, updated_at = ? WHERE id = ?`,
      )
      .run(reason.slice(0, 500), now, changeId);
  }

  private requireBook(batchId: string, calibreId: number): { batch: BatchRow; rows: ItemRow[] } {
    const batch = this.batches.requireClaimed(batchId);
    if (batch.stage !== this.stage)
      throw new BatchError(409, 'bad_batch', `Not a stage ${this.stage} batch`);
    if (batch.kind === 'apply' && !batch.snapshotSaved) {
      throw new BatchError(
        409,
        'snapshot_first',
        'Save the metadata.db snapshot before the first book',
      );
    }
    const rows = this.rows(batchId, calibreId);
    if (rows.length === 0) throw new BatchError(404, 'not_found', 'No such book in this batch');
    this.batches.progress(batchId);
    return { batch, rows };
  }

  /**
   * The user's edit of the title sort: Calibre's sort read from its live metadata.db (read only),
   * since calibredb can't list it through the content server (calibre 9.18 refuses --template
   * for a remote library; found in the real-calibre e2e).
   */
  private withLiveSort(batch: BatchRow, current: Current, rows: ItemRow[]): Current {
    if (this.stage !== EDIT_STAGE || !rows.some((r) => r.field === 'sort')) return current;
    if (!current.uuid) return current;
    let dir: string;
    try {
      dir = this.libDir(batch.libraryId);
    } catch {
      return current;
    }
    const sort = liveTitleSort(dir, current.uuid);
    return sort === null ? current : { ...current, titleSort: sort };
  }

  /**
   * Book covers: before a cover write, Calibre's current picture goes into the cover archive
   * (once per item: an item verified already was kept by its first verify). kept: true = kept,
   * false = Calibre has a cover that couldn't be kept (the cover is then not written), null =
   * nothing to keep (no archive, no cover item, or Calibre has no cover).
   */
  async keepCurrentCover(
    batchId: string,
    calibreId: number,
    listed: ListedBook | null,
    now = Date.now(),
  ): Promise<CoverKept> {
    if (!this.archive) return { kept: null, error: null };
    const { batch, rows } = this.requireBook(batchId, calibreId);
    if (batch.kind !== 'apply') return { kept: null, error: null };
    const r = rows.find(
      (x) =>
        x.field === 'cover' && !STAGE2_TERMINAL_APPLY.includes(x.state) && x.state !== 'verified',
    );
    if (!r) return { kept: null, error: null };
    const current = listed ? parseListed(listed) : null;
    if (!current || current.uuid !== r.calibre_uuid || !current.hasCover)
      return { kept: null, error: null };
    const bytes = await this.readCalibreCover(batch.libraryId, calibreId, r.calibre_uuid);
    if (!bytes) return { kept: false, error: "Calibre's cover.jpg can't be read" };
    try {
      await this.archive.keep(
        { libraryId: batch.libraryId, uuid: r.calibre_uuid, calibreId },
        bytes,
        'before',
        r.change_id,
        now,
      );
      return { kept: true, error: null };
    } catch (err) {
      return { kept: false, error: (err as Error).message };
    }
  }

  /** The sidecar shows what Calibre has now; the server says what to write. */
  verify(
    batchId: string,
    calibreId: number,
    listed: ListedBook | null,
    oldCoverPath: string | null = null,
    now = Date.now(),
    coverKept: CoverKept = { kept: null, error: null },
  ): VerifyAnswer {
    const { batch, rows } = this.requireBook(batchId, calibreId);
    const current = listed ? this.withLiveSort(batch, parseListed(listed), rows) : null;
    const answer: VerifyAnswer = {
      action: 'none',
      fields: [],
      cover: false,
      saveOldCover: false,
      oldCoverPath: null,
      items: [],
    };
    const terminal: ItemState[] =
      batch.kind === 'apply' ? STAGE2_TERMINAL_APPLY : ['restored', 'failed', 'skipped'];
    this.db.transaction(() => {
      for (const r of rows) {
        if (terminal.includes(r.state)) {
          answer.items.push({ itemId: r.item_id, field: r.field, state: r.state, detail: null });
          continue;
        }
        const gone = !current || current.uuid !== r.calibre_uuid;
        if (batch.kind === 'apply')
          this.verifyApply(batch, r, current, gone, answer, oldCoverPath, now, rows, coverKept);
        else this.verifyUndo(batch, r, current, gone, answer, now, rows);
      }
    })();
    answer.action = answer.fields.length > 0 || answer.cover ? 'write' : 'none';
    return answer;
  }

  private verifyApply(
    batch: BatchRow,
    r: ItemRow,
    current: Current | null,
    gone: boolean,
    answer: VerifyAnswer,
    oldCoverPath: string | null,
    now: number,
    siblings: ItemRow[] = [],
    coverKept: CoverKept = { kept: null, error: null },
  ) {
    const push = (state: ItemState, detail: string | null) =>
      answer.items.push({ itemId: r.item_id, field: r.field, state, detail });
    if (gone) {
      this.setItem(r.item_id, 'skipped', 'The book is no longer in Calibre', null, now);
      this.skipChange(r.change_id, 'The book is no longer in Calibre', now);
      return push('skipped', 'The book is no longer in Calibre');
    }
    // Book covers: a cover is never replaced unless Calibre's current picture was kept first.
    if (r.field === 'cover' && coverKept.kept === false && current?.hasCover) {
      const why = `Calibre's current cover couldn't be kept, so it wasn't replaced: ${coverKept.error ?? 'unknown error'}`;
      this.setItem(r.item_id, 'skipped', why, null, now);
      this.skipChange(r.change_id, why, now);
      return push('skipped', why);
    }
    const open = (field: string) =>
      siblings.find(
        (x) =>
          x.field === field &&
          x.state !== 'written' &&
          x.state !== 'skipped' &&
          x.state !== 'failed',
      );
    const cur = current!;
    const ev = JSON.parse(r.evidence_json) as Evidence2;
    const oldV = JSON.parse(r.old_json) as unknown;
    const newV = JSON.parse(r.new_json) as unknown;
    const seen = { lastModified: cur.lastModified, hasCover: cur.hasCover };
    const edit = this.stage === EDIT_STAGE;
    if (!edit && isYours(this.db, batch.libraryId, r.calibre_uuid, r.field)) {
      // Became the user's after the batch was planned (an edit written between two chunks).
      this.setItem(r.item_id, 'skipped', YOURS_REASON, null, now);
      this.skipChange(r.change_id, YOURS_REASON, now);
      return push('skipped', YOURS_REASON);
    }
    if (r.field === 'cover' && edit) {
      // The user's own picture: written whatever cover Calibre has now (their explicit choice);
      // Calibre's current cover is kept in the quarantine first, for Undo.
      const before =
        r.state === 'verified'
          ? (JSON.parse(r.stage2_json ?? '{}') as { lastModified?: string | null })
          : null;
      if (before && cur.hasCover && !sameTime(cur.lastModified, before.lastModified)) {
        this.written(batch, r, cur, oldCoverPath, now);
        return push('written', null);
      }
      this.setItem(r.item_id, 'verified', null, { ...seen, oldValue: cur.hasCover }, now);
      answer.cover = true;
      // Book covers: the server's cover archive keeps Calibre's picture (keepCurrentCover); the
      // sidecar's quarantine only when the server runs without one.
      answer.saveOldCover = cur.hasCover && !this.archive;
      // Undo of a cover made before the archive: the earlier picture from the quarantine (1.5.0).
      const q = (ev as { cover?: { quarantine?: string } }).cover?.quarantine;
      if (q) answer.coverFrom = q;
      return push('verified', null);
    }
    if (r.field === 'tags' && !edit) {
      // Stage 5 (WP20f): the change is applied to the tags Calibre holds now, so a tag added in
      // Calibre since the proposal stays; a custom tag is never removed.
      const before = cur.tags ?? [];
      const prior =
        r.state === 'verified' ? (JSON.parse(r.stage2_json ?? '{}') as { final?: string[] }) : null;
      if (prior?.final && sameTags(before, prior.final)) {
        // Written before the sidecar restarted: the record verified then stands.
        this.written(batch, r, cur, oldCoverPath, now);
        return push('written', null);
      }
      const final = applyTagChange(before, newV as TagChange, getSettings(this.db).customTags);
      const verified = { ...seen, oldValue: before, final };
      this.setItem(r.item_id, 'verified', null, verified, now);
      r.stage2_json = JSON.stringify(verified);
      if (sameTags(final, before)) {
        this.written(batch, r, cur, oldCoverPath, now);
        return push('written', null);
      }
      answer.fields.push(`tags:${final.join(',')}`);
      return push('verified', null);
    }
    if (r.field === 'cover') {
      // Stage 4's evidence holds hadCover itself (the store's picture, not the EPUB's).
      const cv =
        this.stage === 4
          ? { hadCover: (ev as { hadCover?: boolean }).hadCover === true }
          : ev.cover;
      // A cover can't be compared through `list`: a book that had one and changed since the
      // analysis is left alone; one that had none must still have none.
      // Verified before (the sidecar restarted): a write since then shows as a new last_modified.
      const before =
        r.state === 'verified'
          ? (JSON.parse(r.stage2_json ?? '{}') as { lastModified?: string | null })
          : null;
      if (before && cur.hasCover && !sameTime(cur.lastModified, before.lastModified)) {
        this.written(batch, r, cur, oldCoverPath, now);
        return push('written', null);
      }
      if (
        !cv ||
        cur.hasCover !== cv.hadCover ||
        (cv.hadCover && !sameTime(cur.lastModified, ev.lastModified))
      ) {
        this.setItem(r.item_id, 'skipped', EDITED, null, now);
        this.skipChange(r.change_id, EDITED, now);
        return push('skipped', EDITED);
      }
      this.setItem(r.item_id, 'verified', null, seen, now);
      answer.cover = true;
      answer.saveOldCover = cv.hadCover;
      return push('verified', null);
    }
    if (fieldEquals(r.field, cur, newV, false)) {
      this.written(batch, r, cur, oldCoverPath, now);
      return push('written', null);
    }
    const matched = this.matchingOld(batch.libraryId, r.calibre_uuid, r.field, cur, oldV);
    if (!matched) {
      const why = edit ? EDITED_FORM : EDITED;
      this.setItem(r.item_id, 'skipped', why, null, now);
      this.skipChange(r.change_id, why, now);
      return push('skipped', why);
    }
    const extra = Object.fromEntries(Object.entries(ev.extra ?? {}).map(([k, v]) => [k, v.new]));
    if (edit) {
      // calibredb takes a field once per write: a sort edited with its title goes with the
      // title (as the reading goes with the authors just below).
      if (r.field === 'sort' && open('title')) {
        this.setItem(r.item_id, 'verified', null, { ...seen, oldValue: matched.value }, now);
        return push('verified', null);
      }
      if (r.field === 'title') {
        const s = open('sort');
        if (s) extra.sort = JSON.parse(s.new_json) as string;
      }
    }
    if (this.stage === 4 || edit) {
      // calibredb takes a field once per write: the reading goes with the authors (sent empty
      // without one, so Calibre computes its own instead of keeping a stale sort: lessons 2).
      if (r.field === 'author_sort' && open('authors')) {
        this.setItem(r.item_id, 'verified', null, { ...seen, oldValue: matched.value }, now);
        return push('verified', null);
      }
      if (r.field === 'authors') {
        const s = open('author_sort');
        extra.author_sort = s ? (JSON.parse(s.new_json) as string) : '';
      }
    }
    answer.fields.push(
      ...fieldArgs(r.field, newV, extra, this.illustratorSeparator(batch.libraryId)),
    );
    this.setItem(r.item_id, 'verified', null, { ...seen, oldValue: matched.value }, now);
    push('verified', null);
  }

  private verifyUndo(
    batch: BatchRow,
    r: ItemRow,
    current: Current | null,
    gone: boolean,
    answer: VerifyAnswer,
    now: number,
    siblings: ItemRow[] = [],
  ) {
    const push = (state: ItemState, detail: string | null) =>
      answer.items.push({ itemId: r.item_id, field: r.field, state, detail });
    const rec = this.undoRecord(batch, r.change_id);
    if (!rec) throw new BatchError(404, 'not_found', 'No undo record for this item');
    if (gone) {
      this.setItem(r.item_id, 'skipped', 'The book is no longer in Calibre', null, now);
      return push('skipped', 'The book is no longer in Calibre');
    }
    const cur = current!;
    if (r.field === 'tags') {
      // Stage 5: the cleanup's additions taken off and its removals put back, whatever else the
      // book's tags hold now (the user's later tags stay).
      const prior =
        r.state === 'verified'
          ? (JSON.parse(r.stage2_json ?? '{}') as { target?: string[] })
          : null;
      const now0 = cur.tags ?? [];
      if (prior?.target && sameTags(now0, prior.target)) {
        this.restored(batch, r, cur, null, now);
        return push('restored', null);
      }
      const target = undoTagChange(
        now0,
        JSON.parse(rec.new_json) as { added: string[]; removed: string[] },
      );
      if (sameTags(target, now0)) {
        this.restored(batch, r, cur, null, now);
        return push('restored', null);
      }
      answer.fields.push(`tags:${target.join(',')}`);
      this.setItem(r.item_id, 'verified', null, { lastModified: cur.lastModified, target }, now);
      return push('verified', null);
    }
    const oldV = JSON.parse(rec.old_json) as unknown;
    const newV = JSON.parse(rec.new_json) as unknown;
    const extraOld = Object.fromEntries(
      Object.entries(JSON.parse(rec.extra_json) as Record<string, { old: unknown }>).map(
        ([k, v]) => [k, v.old],
      ),
    );
    // A title fitted for Calibre's names: the original would make a name the disk refuses (the
    // rename fails and leaves the book half-written, lessons 2), so it stays, like a cover the
    // content server can't remove; the book's other fields are put back.
    if (
      r.field === 'title' &&
      typeof oldV === 'string' &&
      calibreNameBytes(r.calibre_id, oldV, cur.authors[0] ?? 'Unknown') > NAME_MAX_BYTES
    ) {
      const detail =
        "The shortened title stays: the original is too long for Calibre's folder names";
      this.restored(batch, r, cur, detail, now);
      return push('restored', detail);
    }
    if (r.field === 'cover') {
      if (!rec.old_cover_path) {
        const detail =
          this.stage === 4
            ? "The store's cover stays: the content server can't remove a cover"
            : "The cover from the book's own file stays: the content server can't remove a cover";
        this.restored(batch, r, cur, detail, now);
        return push('restored', detail);
      }
      const before =
        r.state === 'verified'
          ? (JSON.parse(r.stage2_json ?? '{}') as { lastModified?: string | null })
          : null;
      if (before && cur.hasCover && !sameTime(cur.lastModified, before.lastModified)) {
        this.restored(batch, r, cur, null, now);
        return push('restored', null);
      }
      if (!cur.hasCover || !sameTime(cur.lastModified, rec.last_modified_after)) {
        this.setItem(r.item_id, 'skipped', EDITED_AFTER, null, now);
        return push('skipped', EDITED_AFTER);
      }
      this.setItem(r.item_id, 'verified', null, { lastModified: cur.lastModified }, now);
      answer.cover = true;
      answer.oldCoverPath = rec.old_cover_path;
      return push('verified', null);
    }
    // Already the old value (an earlier write of this Undo, or put back by hand).
    if (fieldEquals(r.field, cur, oldV ?? (r.field === 'identifiers' ? {} : null), false)) {
      this.restored(batch, r, cur, null, now);
      return push('restored', null);
    }
    if (!fieldEquals(r.field, cur, newV, false)) {
      this.setItem(r.item_id, 'skipped', EDITED_AFTER, null, now);
      return push('skipped', EDITED_AFTER);
    }
    if (this.stage === 4) {
      // As on the way in: the old reading goes back with the old authors, in one argument.
      const open = (field: string) =>
        siblings.find(
          (x) =>
            x.field === field &&
            x.state !== 'restored' &&
            x.state !== 'skipped' &&
            x.state !== 'failed',
        );
      if (r.field === 'author_sort' && open('authors')) {
        this.setItem(r.item_id, 'verified', null, { lastModified: cur.lastModified }, now);
        return push('verified', null);
      }
      if (r.field === 'authors') {
        const s = open('author_sort');
        const sortRec = s ? this.undoRecord(batch, s.change_id) : undefined;
        extraOld.author_sort = sortRec
          ? ((JSON.parse(sortRec.old_json) as string | null) ?? '')
          : '';
      }
    }
    answer.fields.push(
      ...fieldArgs(
        r.field,
        oldV ?? (r.field === 'identifiers' ? {} : null),
        { ...extraOld },
        this.illustratorSeparator(batch.libraryId),
      ),
    );
    this.setItem(r.item_id, 'verified', null, { lastModified: cur.lastModified }, now);
    push('verified', null);
  }

  /** After the write: what Calibre shows decides each field. */
  writtenReport(batchId: string, calibreId: number, report: WrittenReport, now = Date.now()) {
    const { batch, rows } = this.requireBook(batchId, calibreId);
    const current = report.current
      ? this.withLiveSort(batch, parseListed(report.current), rows)
      : null;
    const pending: string[] = [];
    const out: { itemId: number; field: string; state: ItemState }[] = [];
    this.db.transaction(() => {
      for (const r of rows) {
        if (r.state !== 'verified') {
          out.push({ itemId: r.item_id, field: r.field, state: r.state });
          continue;
        }
        const before = JSON.parse(r.stage2_json ?? '{}') as {
          lastModified?: string | null;
          final?: string[];
          target?: string[];
        };
        let ok = false;
        if (
          current &&
          current.uuid === r.calibre_uuid &&
          r.field === 'tags' &&
          this.stage !== EDIT_STAGE
        ) {
          const want = batch.kind === 'apply' ? before.final : before.target;
          ok = !!want && sameTags(current.tags ?? [], want);
        } else if (current && current.uuid === r.calibre_uuid) {
          if (batch.kind === 'apply') {
            ok =
              r.field === 'cover'
                ? !report.coverSkipped &&
                  current.hasCover &&
                  !sameTime(current.lastModified, before.lastModified)
                : fieldEquals(r.field, current, JSON.parse(r.new_json), false);
          } else {
            const rec = this.undoRecord(batch, r.change_id)!;
            ok =
              r.field === 'cover'
                ? current.hasCover && !sameTime(current.lastModified, before.lastModified)
                : fieldEquals(
                    r.field,
                    current,
                    JSON.parse(rec.old_json) ?? (r.field === 'identifiers' ? {} : null),
                    false,
                  );
          }
        }
        if (r.field === 'cover' && report.coverSkipped) {
          // The cover was left out of the write: never counted as written or put back.
          this.setItem(r.item_id, 'skipped', report.coverSkipped, null, now);
          if (batch.kind === 'apply') this.skipChange(r.change_id, report.coverSkipped, now);
          out.push({ itemId: r.item_id, field: r.field, state: 'skipped' });
          continue;
        }
        if (ok) {
          if (batch.kind === 'apply')
            this.written(batch, r, current!, report.oldCoverPath ?? null, now);
          else this.restored(batch, r, current!, null, now);
          out.push({
            itemId: r.item_id,
            field: r.field,
            state: batch.kind === 'apply' ? 'written' : 'restored',
          });
        } else if (report.final) {
          const detail = report.error
            ? `Calibre didn't take the change: ${report.error}`
            : "Calibre doesn't show the new value after the write";
          this.setItem(r.item_id, 'failed', detail, null, now);
          if (batch.kind === 'apply') this.skipChange(r.change_id, detail, now);
          out.push({ itemId: r.item_id, field: r.field, state: 'failed' });
        } else {
          pending.push(r.field);
          out.push({ itemId: r.item_id, field: r.field, state: 'verified' });
        }
      }
    })();
    return { done: pending.length === 0, pending, items: out };
  }

  private written(
    batch: BatchRow,
    r: ItemRow,
    current: Current,
    oldCoverPath: string | null,
    now: number,
  ) {
    if (this.stage === EDIT_STAGE) return this.writtenEdit(batch, r, current, oldCoverPath, now);
    const ev = JSON.parse(r.evidence_json) as Evidence2;
    // The value Calibre had when the sidecar verified the book (normally the analysed one).
    const seen = JSON.parse(r.stage2_json ?? '{}') as { oldValue?: unknown; final?: string[] };
    const oldJson = 'oldValue' in seen ? JSON.stringify(seen.oldValue ?? null) : r.old_json;
    // Stage 5: the undo record is exactly what this write added and removed, and the applied
    // value every tag the cleanup has added to the book (one gone later was removed by the user).
    let undoNew = r.new_json;
    let appliedNew = r.new_json;
    if (r.field === 'tags') {
      const before = (seen.oldValue as string[] | undefined) ?? [];
      const final = seen.final ?? before;
      const low = (l: string[]) => new Set(l.map((t) => t.toLowerCase()));
      const b = low(before);
      const f = low(final);
      const added = final.filter((t) => !b.has(t.toLowerCase()));
      const removed = before.filter((t) => !f.has(t.toLowerCase()));
      undoNew = JSON.stringify({ added, removed });
      const prev = this.db
        .prepare(
          `SELECT value_json FROM applied_values WHERE library_id = ? AND calibre_uuid = ? AND field = 'tags'`,
        )
        .get(batch.libraryId, r.calibre_uuid) as { value_json: string } | undefined;
      const prevAdded = prev
        ? ((JSON.parse(prev.value_json) as { added?: string[] }).added ?? [])
        : [];
      const all = [...prevAdded];
      const seenAll = low(all);
      for (const t of added) if (!seenAll.has(t.toLowerCase())) all.push(t);
      appliedNew = JSON.stringify({ added: all });
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO field_undo (batch_id, change_id, library_id, calibre_id, calibre_uuid, field,
           old_json, new_json, extra_json, last_modified_after, old_cover_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batch.id,
        r.change_id,
        batch.libraryId,
        r.calibre_id,
        r.calibre_uuid,
        r.field,
        oldJson,
        undoNew,
        JSON.stringify(ev.extra ?? {}),
        current.lastModified,
        r.field === 'cover' ? oldCoverPath : null,
        now,
      );
    this.db
      .prepare(
        `INSERT INTO applied_values (library_id, calibre_uuid, field, value_json, source, batch_id, applied_at,
           change_id, last_modified_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(library_id, calibre_uuid, field) DO UPDATE SET value_json = excluded.value_json,
           source = excluded.source, batch_id = excluded.batch_id, applied_at = excluded.applied_at,
           change_id = excluded.change_id, last_modified_after = excluded.last_modified_after`,
      )
      .run(
        batch.libraryId,
        r.calibre_uuid,
        r.field,
        appliedNew,
        r.source,
        batch.id,
        now,
        r.change_id,
        current.lastModified,
      );
    this.setItem(r.item_id, 'written', null, null, now);
    this.db
      .prepare(
        `UPDATE proposed_changes SET state = 'applied', decided_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, r.change_id);
  }

  /**
   * The user's edit is written: its undo record (the value Calibre had at the write) and the
   * change marked applied. Never an applied value: those are the cleanup's own writes (a value
   * the user set is theirs in user_fields, from the moment they saved).
   */
  private writtenEdit(
    batch: BatchRow,
    r: ItemRow,
    current: Current,
    oldCoverPath: string | null,
    now: number,
  ) {
    const ev = JSON.parse(r.evidence_json) as Evidence2;
    const seen = JSON.parse(r.stage2_json ?? '{}') as { oldValue?: unknown };
    const oldJson = 'oldValue' in seen ? JSON.stringify(seen.oldValue ?? null) : r.old_json;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO field_undo (batch_id, change_id, library_id, calibre_id, calibre_uuid, field,
           old_json, new_json, extra_json, last_modified_after, old_cover_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batch.id,
        r.change_id,
        batch.libraryId,
        r.calibre_id,
        r.calibre_uuid,
        r.field,
        oldJson,
        r.new_json,
        JSON.stringify(ev.extra ?? {}),
        current.lastModified,
        r.field === 'cover' ? oldCoverPath : null,
        now,
      );
    this.setItem(r.item_id, 'written', null, null, now);
    this.db
      .prepare(
        `UPDATE proposed_changes SET state = 'applied', decided_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, r.change_id);
    if (r.field !== 'cover')
      aiYoursAfterWrite(
        this.db,
        { libraryId: batch.libraryId, uuid: r.calibre_uuid },
        r.field,
        JSON.parse(oldJson) as unknown,
        JSON.parse(r.new_json) as unknown,
        now,
      );
  }

  private restored(
    batch: BatchRow,
    r: ItemRow,
    current: Current,
    detail: string | null,
    now: number,
  ) {
    this.db
      .prepare(
        `UPDATE field_undo SET restored_at = ?, restored_last_modified = ?, restore_detail = ?
         WHERE batch_id = ? AND change_id = ?`,
      )
      .run(now, current.lastModified, detail, batch.undoOf, r.change_id);
    this.db
      .prepare(
        'DELETE FROM applied_values WHERE library_id = ? AND calibre_uuid = ? AND field = ? AND change_id = ?',
      )
      .run(batch.libraryId, r.calibre_uuid, r.field, r.change_id);
    this.setItem(r.item_id, 'restored', detail, null, now);
    this.db
      .prepare(`UPDATE proposed_changes SET state = 'undone', updated_at = ? WHERE id = ?`)
      .run(now, r.change_id);
  }

  /** The cover the sidecar hands to calibre (D1), checked against the analysed file. */
  async coverFor(
    batchId: string,
    calibreId: number,
  ): Promise<{ bytes: Buffer; ext: string; sha256: string }> {
    const { batch, rows } = this.requireBook(batchId, calibreId);
    const r = rows.find((x) => x.field === 'cover');
    if (!r || batch.kind !== 'apply')
      throw new BatchError(404, 'not_found', 'No cover for this book in this batch');
    if (this.stage === EDIT_STAGE) {
      // The user's picture, kept in the server's cache when they saved (uploaded, dropped or one
      // of the book's illustrations), made ready for Calibre as every cover is.
      const c = (JSON.parse(r.evidence_json) as { cover?: { file?: string } }).cover;
      const bytes = c?.file ? await fs.promises.readFile(c.file).catch(() => null) : null;
      if (!bytes)
        throw new BatchError(409, 'cover_gone', 'The picture is not in the cache any more');
      const se = getSettings(this.db).covers;
      const outE = await coverForCalibre(bytes, {
        maxBytes: se.maxMb * 1024 * 1024,
        maxSide: se.maxSide,
      });
      return { bytes: outE.bytes, ext: outE.ext, sha256: outE.sha256 };
    }
    if (this.stage === 4) {
      const url = (JSON.parse(r.new_json) as { url?: string } | null)?.url;
      const bytes = url && this.storeCover ? this.storeCover(url) : null;
      if (!bytes) throw new BatchError(409, 'cover_gone', "The store's cover is not in the cache");
      const s4 = getSettings(this.db).covers;
      const out4 = await coverForCalibre(bytes, {
        maxBytes: s4.maxMb * 1024 * 1024,
        maxSide: s4.maxSide,
      });
      // What Calibre will hold: the check "changed in Calibre after the cleanup wrote it"
      // compares cover.jpg with it later (applied_values takes the proposal's new value).
      const nv = { ...(JSON.parse(r.new_json) as Record<string, unknown>) };
      nv.sha256 = out4.sha256;
      nv.mediaType = out4.ext === 'jpg' ? 'image/jpeg' : 'image/png';
      this.db
        .prepare('UPDATE proposed_changes SET new_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(nv), Date.now(), r.change_id);
      return { bytes: out4.bytes, ext: out4.ext, sha256: out4.sha256 };
    }
    const ev = JSON.parse(r.evidence_json) as Evidence2;
    if (!ev.cover || !ev.epub) throw new BatchError(404, 'not_found', 'No cover facts');
    const libDir = this.libDir(batch.libraryId);
    // Where the analysis read the EPUB, else where the book is now: every Calibre write can
    // move its folder (seen 2026-11-15: 38253, 38349, 38350 lost their covers this way). The
    // picture's SHA-256 below proves it is the analysed cover either way.
    const read = (rel: string) =>
      readCoverBytes(resolveInside(libDir, rel), ev.cover!.entry).catch(() => null);
    let bytes = await read(ev.epub.path);
    if (!bytes) {
      const now = await currentCalibreEpub(libDir, r.calibre_uuid);
      if (now && now !== ev.epub.path) bytes = await read(now);
    }
    if (!bytes) throw new BatchError(409, 'cover_gone', "The EPUB's cover can't be read any more");
    if (createHash('sha256').update(bytes).digest('hex') !== ev.cover.sha256) {
      throw new BatchError(409, 'cover_changed', "The EPUB's cover changed since the analysis");
    }
    const s = getSettings(this.db).covers;
    const out = await coverForCalibre(bytes, {
      maxBytes: s.maxMb * 1024 * 1024,
      maxSide: s.maxSide,
    });
    return { bytes: out.bytes, ext: out.ext, sha256: out.sha256 };
  }

  /** Calibre's current cover.jpg (read-only), for the quarantine before it is replaced. */
  async oldCover(batchId: string, calibreId: number): Promise<Buffer> {
    const { batch, rows } = this.requireBook(batchId, calibreId);
    if (batch.kind !== 'apply' || !rows.some((x) => x.field === 'cover')) {
      throw new BatchError(404, 'not_found', 'No cover for this book in this batch');
    }
    const snap = readStage2Snapshot(snapshotFile(this.deps.cacheDir, batch.libraryId));
    const book = snap.books.get(calibreId);
    if (!book || !book.hasCover)
      throw new BatchError(404, 'not_found', 'Calibre lists no cover for this book');
    const bytes = await this.readCalibreCover(batch.libraryId, calibreId, book.uuid, book.path);
    if (!bytes) throw new BatchError(404, 'not_found', "Calibre's cover.jpg can't be read");
    return bytes;
  }

  /**
   * A book's cover.jpg as Calibre holds it now (read only): from the folder the reader's index
   * knows, else the book's folder now (every write can move it), by its UUID in the live
   * metadata.db. Null when there is none.
   */
  private async readCalibreCover(
    libraryId: string,
    calibreId: number,
    uuid: string,
    knownPath?: string | null,
  ): Promise<Buffer | null> {
    const libDir = this.libDir(libraryId);
    const read = (folder: string) =>
      readSourceFile(resolveInside(libDir, `${folder}/cover.jpg`)).catch(() => null);
    // The reader's index (one row by its key; never the whole snapshot per book).
    const folder =
      knownPath ??
      (
        this.deps.main
          .prepare(
            `SELECT calibre_path FROM book_sources
             WHERE library_id = ? AND calibre_uuid = ? AND kind = 'calibre' LIMIT 1`,
          )
          .get(libraryId, uuid) as { calibre_path: string | null } | undefined
      )?.calibre_path ??
      null;
    void calibreId;
    let bytes = folder ? await read(folder) : null;
    if (!bytes) {
      const now = await currentCalibreEpub(libDir, uuid);
      const live = now ? path.posix.dirname(now) : null;
      if (live && live !== folder) bytes = await read(live);
    }
    return bytes;
  }

  /** Taken in when the reader's index shows each written book's new last_modified. */
  ingested(batch: BatchRow): boolean {
    const rows = this.db
      .prepare(
        `SELECT f.calibre_uuid, f.last_modified_after, f.restored_last_modified, i.state FROM batch_items i
         JOIN field_undo f ON f.change_id = i.change_id AND f.batch_id = ?
         WHERE i.batch_id = ? AND i.state IN ('written', 'restored')`,
      )
      .all(batch.undoOf ?? batch.id, batch.id) as {
      calibre_uuid: string;
      last_modified_after: string | null;
      restored_last_modified: string | null;
      state: ItemState;
    }[];
    for (const r of rows) {
      const want = parseCalibreDate(
        batch.kind === 'apply' ? r.last_modified_after : r.restored_last_modified,
      );
      if (want === null) continue;
      const src = this.deps.main
        .prepare(
          `SELECT calibre_last_modified FROM book_sources WHERE library_id = ? AND kind = 'calibre' AND calibre_uuid = ?`,
        )
        .get(batch.libraryId, r.calibre_uuid) as
        | { calibre_last_modified: number | string | null }
        | undefined;
      if (!src) continue;
      // The reader stores Calibre's last_modified as milliseconds.
      const have =
        typeof src.calibre_last_modified === 'number'
          ? src.calibre_last_modified
          : parseCalibreDate(src.calibre_last_modified);
      if (have === null || have + 1 < want) return false;
    }
    return true;
  }

  /** Undo of an applied stage-2 batch (the newest batch touching those books first). */
  undo(batch: BatchRow, now = Date.now()): BatchRow {
    const all = this.db
      .prepare(
        `SELECT change_id, calibre_uuid FROM field_undo WHERE batch_id = ? AND restored_at IS NULL`,
      )
      .all(batch.id) as { change_id: number; calibre_uuid: string }[];
    // Manga part A: a book that has since moved to another library is not in this batch's library
    // any more (its Calibre id there is gone): its fields stay as they are, the others go back.
    const records = all.filter((r) => !movedFrom(this.db, batch.libraryId, r.calibre_uuid));
    if (records.length === 0 && all.length > 0)
      throw new BatchError(
        409,
        'moved',
        'The books of this batch have moved to another library since; their fields stay as written there',
      );
    if (records.length === 0)
      throw new BatchError(409, 'nothing_to_undo', 'Nothing in this batch to put back');
    const uuids = new Set(records.map((r) => r.calibre_uuid));
    const later = this.db
      .prepare(
        `SELECT f.calibre_uuid FROM field_undo f JOIN batches b ON b.id = f.batch_id
         WHERE b.created_at > ? AND b.kind = 'apply' AND b.library_id = ? AND f.restored_at IS NULL`,
      )
      .all(batch.createdAt, batch.libraryId) as { calibre_uuid: string }[];
    if (later.some((r) => uuids.has(r.calibre_uuid))) {
      throw new BatchError(
        409,
        'later_batch',
        'A later batch changed some of these books; undo that one first',
      );
    }
    return this.batches.createBatch(
      this.stage,
      batch.libraryId,
      'undo',
      batch.id,
      records.map((r) => r.change_id),
      now,
    );
  }
}
