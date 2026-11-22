/**
 * WP21f-2: what changes for the books already in the library (plan section 9, decided with the
 * user 2026-11-21). Pure: the caller loads the ledger (what was built and last written), each
 * book's current plan (stage 6's plan code on the current analysis: folder layout, link names,
 * metadata.json), the metadata.json on disk now, and what Audiobookshelf has for the book.
 *
 * Per book:
 *  - metadata: our fields (absMetadata's keys) whose decided value changed since we wrote them.
 *    A field whose metadata.json value now differs from what we wrote is yours (ABS writes your
 *    edit there, proven at B0) unless the evidence says Audiobookshelf changed it (`fieldState`:
 *    its own form or fill since its scan of our write, or an older value it kept, which goes to
 *    review); a field once yours stays yours. Yours keeps your value; where your edit and our new
 *    value differ for the same field, that field goes to review ("write the rest, review
 *    conflicts": user).
 *  - folder: the layout (author, series, volume, title) differs from the one built: the book
 *    moves, named against the library as it is (stage 7's own collision rules; never over a
 *    name). Only in japanese/ (an AI book's move goes to review), never when you edited a field
 *    the path comes from (author, series, title).
 *  - link names: the story order's numbered names (stage 3's order). Renaming changes ABS's
 *    track order, so the listening position moves (B0): only a book nobody started (no progress,
 *    no bookmark) or one finished without a bookmark is renamed; any other goes to review.
 *  - kept as built (`library-keep.ts`, the user's): never changed.
 */
import { createHash } from 'crypto';
import { planArrivals, type ExistingTree } from './arrivals-plan';
import type { PlannedBook } from './build-plan';

export interface LedgerFile {
  fileId: number;
  /** The link's name inside the book folder (`Disc 1/x.mp3`). */
  name: string;
  ino: number;
}

export interface LedgerBook {
  id: number;
  /** Relative to media/audiobooks: `japanese/…` or `japanese-generated/…`. */
  folder: string;
  /** The layout before collision suffixes, in the same form. */
  baseFolder: string;
  area: 'main' | 'ai';
  files: LedgerFile[];
  /** The metadata.json we last wrote (your kept fields included): your edits show against it. */
  metadata: Buffer;
  /**
   * Our decided values when we last wrote (stage 5's, before your fields were kept): our own
   * changes show against it, so a field you edited is never taken back to ours later.
   */
  decided: Buffer;
  /** The book folder's inode (null: not known yet). */
  folderIno: number | null;
  /** The metadata.json just before our last write (null or absent: none known). */
  before?: Buffer | null;
  /**
   * The metadata.json as Audiobookshelf left it after its scan of our last write, proven by
   * time (null or absent: not proven): its own form of our values and the values it kept.
   */
  seen?: Buffer | null;
  /** Fields that are yours since an earlier run: every later write keeps them. */
  yours?: Set<string>;
}

/**
 * What a field's value in metadata.json now is, against what we last wrote (item 6 of the
 * audiobook cleanup leftovers, approved by the user 2026-11-21: a field is yours only when no
 * evidence says Audiobookshelf changed it; your edits are never overwritten):
 *  - ours       the file holds what we wrote
 *  - abs_form   Audiobookshelf's own form of what we wrote, in the file since its scan of our
 *               write (`seen`): "&" as "&amp;", the authors in its order (the survey's 82 fields)
 *  - abs_fill   we wrote it empty and Audiobookshelf filled it from the file's tags or its
 *               placeholder (_Unknown)
 *  - abs_kept   Audiobookshelf kept the value the file had before our write (its scan of our
 *               write left it: ST 黄's `STシリーズ #6`): to review, never counted as yours
 *  - yours      anything else, and every field that was yours before
 */
export type FieldState = 'ours' | 'abs_form' | 'abs_fill' | 'abs_kept' | 'yours';

export interface AbsBookState {
  /** ABS has the book (found by its folder). */
  found: boolean;
  itemId: string | null;
  /** Someone has listening progress on it that is not finished. */
  inProgress: boolean;
  finished: boolean;
  bookmarks: number;
  /** For the review's steps: where each user is (seconds) and the file playing there. */
  places: { user: string; seconds: number; file: string | null }[];
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
  /** Your value in ABS (metadata.json), when you edited the field. */
  mine?: unknown;
}

export type ReviewKind =
  | 'conflict'
  | 'abs_kept'
  | 'rename_progress'
  | 'ai_path'
  | 'move_edited'
  | 'abs_unknown';

export interface PlannedChange {
  bookId: number;
  folderFrom: string;
  /** The new folder (null: stays). */
  folderTo: string | null;
  baseTo: string | null;
  /** Fields written with a new value. */
  fields: FieldChange[];
  /** Fields you edited, kept as yours. */
  userFields: string[];
  /** Fields where your edit and our new value differ (review). */
  conflicts: FieldChange[];
  /**
   * Fields where Audiobookshelf kept an older value after its scan of our write (review): `from`
   * what we wrote, `to` ours now, `mine` Audiobookshelf's value. Nothing changes until you choose.
   */
  absKept: FieldChange[];
  /** Fields set through Audiobookshelf's edit call after its scan (your "Use the cleanup's"). */
  absSet: string[];
  /** The metadata.json read now (the ledger's `before` once a write is applied). */
  metadataRead: Buffer | null;
  /** Link renames inside the book folder (applied or held). */
  renames: { from: string; to: string; ino: number }[];
  renamesHeld: boolean;
  /** The bytes to write (null: metadata.json stays). */
  metadataNew: Buffer | null;
  /** Our decided values now (the ledger's `decided` once applied). */
  decidedNew: Buffer;
  /** SHA-256 of the metadata.json read now (the sidecar replaces only that file). */
  metadataShaRead: string | null;
  reviews: { kind: ReviewKind; text: string }[];
  /** Why nothing changes although something differs (kept as built, …). */
  skipped: string | null;
}

export interface LibraryPlanInput {
  books: LedgerBook[];
  /** The book's current plan (stage 6's plan code), or null (no current decision for its files). */
  current: (b: LedgerBook) => PlannedBook | null;
  /** The metadata.json on disk now (null: missing or unreadable). */
  disk: (b: LedgerBook) => Buffer | null;
  /** What ABS has for the book (null: ABS not set up or not asked). */
  abs: (b: LedgerBook) => AbsBookState | null;
  /** Kept as built (the user's): the reason, else null. */
  keep: (b: LedgerBook) => string | null;
  /** The library as it is now (every folder, book folders, narrators). */
  tree: ExistingTree;
  /** Review choices recorded for the book: field -> 'mine' | 'ours'; 'rename' -> 'now'. */
  choices: (b: LedgerBook) => Record<string, string>;
  /** The book's first audio file's tags (stage 2's), to tell ABS's own fills from your edits. */
  fileTags?: (b: LedgerBook) => Record<string, string> | null;
}

/**
 * The fields stage 5 decides and metadata.json carries. The others (genres, subtitle, isbn, …)
 * we always leave as ABS has them: never written, never counted as yours.
 */
const OUR_FIELDS = new Set([
  'tags',
  'title',
  'authors',
  'narrators',
  'series',
  'publishedYear',
  'publisher',
  'description',
  'asin',
  'language',
]);

const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * ABS fills a field we left empty from the audio file's own tags on its scan (WP21f-1 stop 1),
 * and writes it into metadata.json: that is ABS's, not your edit, when it equals the tag.
 */
function absFilled(field: string, value: unknown, tags: Record<string, string> | null): boolean {
  // Its placeholder for a book without an author (the survey: 20 books under _Unknown/).
  if (field === 'authors' && Array.isArray(value) && value.length === 1 && value[0] === '_Unknown')
    return true;
  if (!tags) return false;
  const k = (s: unknown) => (typeof s === 'string' ? s.normalize('NFKC').trim() : '');
  const list = (s: string | undefined) =>
    (s ?? '')
      .split(/[,、，/／;；]/)
      .map((x) => x.normalize('NFKC').trim())
      .filter(Boolean)
      .sort()
      .join('|');
  switch (field) {
    case 'publisher':
      return k(value) !== '' && k(value) === k(tags.publisher);
    case 'publishedYear':
      // ABS takes the tag's whole date (`2024-12-17`, the survey's 5 books), or its year.
      return (
        k(value) !== '' &&
        (k(value) === k((tags.date ?? '').slice(0, 4)) || k(value) === k(tags.date))
      );
    case 'description':
      return k(value) !== '' && (k(value) === k(tags.comment) || k(value) === k(tags.description));
    case 'asin':
      return k(value) !== '' && (k(value) === k(tags.asin) || k(value) === k(tags.audible_asin));
    case 'authors':
      return (
        Array.isArray(value) && list(value.join(',')) === list(tags.artist ?? tags.album_artist)
      );
    case 'narrators':
      return Array.isArray(value) && list(value.join(',')) === list(tags.composer);
    case 'title':
      return k(value) !== '' && (k(value) === k(tags.album) || k(value) === k(tags.title));
    case 'language':
      return true;
    default:
      return false;
  }
}

/**
 * Audiobookshelf's own form of a value we wrote, as its scan writes it back (proven on a scratch
 * ABS 2.37.1 and seen on the live library, 2026-11-21): a description's "&" and "<" as HTML
 * entities and `<br>` as `<br />`; the authors or narrators in its own order.
 */
function absForm(field: string, value: unknown, written: unknown): boolean {
  if (field === 'description' && typeof value === 'string' && typeof written === 'string') {
    const plain = (s: string) =>
      s
        .replace(/<br\s*\/?>/gi, '<br>')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .normalize('NFC');
    return plain(value) === plain(written);
  }
  if (
    (field === 'authors' || field === 'narrators') &&
    Array.isArray(value) &&
    Array.isArray(written)
  )
    return norm('series', value) === norm('series', written);
  return false;
}

/** A field's state now (see FieldState): pure, also used by the leftovers survey and tests. */
export function fieldState(f: {
  field: string;
  disk: Record<string, unknown>;
  written: Record<string, unknown>;
  seen: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
  yours: boolean;
  tags: Record<string, string> | null;
}): FieldState {
  const { field } = f;
  if (f.yours) return 'yours';
  const d = f.disk[field];
  const w = f.written[field];
  if (norm(field, d) === norm(field, w)) return 'ours';
  if (f.seen && norm(field, d) === norm(field, f.seen[field])) {
    // Unchanged since Audiobookshelf's scan of our write: its doing, not yours.
    if (f.before && norm(field, f.seen[field]) === norm(field, f.before[field])) return 'abs_kept';
    if (absForm(field, d, w) || (isEmpty(w) && absFilled(field, d, f.tags))) return 'abs_form';
  }
  if (isEmpty(w) && absFilled(field, d, f.tags)) return 'abs_fill';
  return 'yours';
}

/**
 * Audiobookshelf kept an older value of one of our fields after its scan of our write: the
 * book is planned (and its field reviewed) even when nothing of ours changed since.
 */
export function absKeptSomething(b: LedgerBook): boolean {
  if (!b.seen || !b.before || b.seen.equals(b.metadata)) return false;
  const seen = parse(b.seen) ?? {};
  const before = parse(b.before) ?? {};
  const written = parse(b.metadata) ?? {};
  return [...OUR_FIELDS].some(
    (f) =>
      !b.yours?.has(f) &&
      norm(f, seen[f]) !== norm(f, written[f]) &&
      norm(f, seen[f]) === norm(f, before[f]),
  );
}

/** Stage 6's staging folders read as the library's (the switch renamed them). */
export function libraryFolder(folder: string): string {
  return folder
    .replace(/^japanese-new(?=\/|$)/, 'japanese')
    .replace(/^japanese-generated-new(?=\/|$)/, 'japanese-generated');
}

const PATH_FIELDS = new Set(['authors', 'series', 'title']);

function parse(b: Buffer | null): Record<string, unknown> | null {
  if (!b) return null;
  try {
    const v = JSON.parse(b.toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** How two values of one field are compared: ABS writes the series sorted by name (B0). */
function norm(field: string, v: unknown): string {
  if (v === undefined || v === '') v = null;
  if (Array.isArray(v)) {
    const a = v.map((x) => (typeof x === 'string' ? x.normalize('NFC') : x));
    return JSON.stringify(
      field === 'series' || field === 'tags' || field === 'genres' ? [...a].sort() : a,
    );
  }
  return JSON.stringify(typeof v === 'string' ? v.normalize('NFC') : v);
}

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** The metadata.json bytes of an object (two-space indent, final newline, as stage 6 writes). */
export function objectBytes(o: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(o, null, 2) + '\n', 'utf8');
}

/** The tree without one book folder (so a book never collides with itself). */
function without(tree: ExistingTree, folder: string): ExistingTree {
  const keep = (d: string) => d !== folder && !d.startsWith(folder + '/');
  return {
    dirs: new Set([...tree.dirs].filter(keep)),
    bookDirs: new Set([...tree.bookDirs].filter(keep)),
    narrators: new Map([...tree.narrators].filter(([d]) => keep(d))),
  };
}

export function planLibraryChanges(input: LibraryPlanInput): PlannedChange[] {
  const out: PlannedChange[] = [];
  // The library as the planned moves leave it (two books never take the same new name).
  const work: ExistingTree = {
    dirs: new Set(input.tree.dirs),
    bookDirs: new Set(input.tree.bookDirs),
    narrators: new Map(input.tree.narrators),
  };
  for (const b of input.books) {
    const cur = input.current(b);
    if (!cur) continue;
    const change: PlannedChange = {
      bookId: b.id,
      folderFrom: b.folder,
      folderTo: null,
      baseTo: null,
      fields: [],
      userFields: [],
      conflicts: [],
      absKept: [],
      absSet: [],
      metadataRead: null,
      renames: [],
      renamesHeld: false,
      metadataNew: null,
      decidedNew: cur.metadata,
      metadataShaRead: null,
      reviews: [],
      skipped: null,
    };
    const choices = input.choices(b);
    // ---- metadata.json
    const ours = parse(cur.metadata) ?? {};
    const last = parse(b.metadata) ?? {};
    const lastOurs = parse(b.decided) ?? last;
    const diskBytes = input.disk(b);
    change.metadataRead = diskBytes;
    const disk = parse(diskBytes) ?? last;
    const seen = b.seen ? parse(b.seen) : null;
    const before = b.before ? parse(b.before) : null;
    const result: Record<string, unknown> = {};
    let write = false;
    const tags = input.fileTags?.(b) ?? null;
    for (const field of Object.keys(ours)) {
      if (!OUR_FIELDS.has(field)) {
        // Never ours to decide: as ABS has it (ours when ABS has nothing).
        result[field] = field in disk ? disk[field] : ours[field];
        continue;
      }
      const weChange = norm(field, ours[field]) !== norm(field, lastOurs[field]);
      const state = fieldState({
        field,
        disk,
        written: last,
        seen,
        before,
        yours: b.yours?.has(field) === true,
        tags,
      });
      if (state === 'abs_kept') {
        // Audiobookshelf kept the file's older value: never yours; nothing changes until you
        // choose (user, 2026-11-21: a review list, not an automatic correction).
        const c: FieldChange = { field, from: last[field], to: ours[field], mine: disk[field] };
        if (norm(field, ours[field]) === norm(field, disk[field])) {
          // Our value now is the one ABS kept (ST 黄 with its #6 correction): ours, written once
          // so the ledger follows.
          result[field] = ours[field];
          if (weChange) {
            change.fields.push({ field, from: lastOurs[field], to: ours[field] });
            write = true;
          }
        } else if (choices[field] === 'ours') {
          result[field] = ours[field];
          change.fields.push(c);
          change.absSet.push(field);
          write = true;
        } else {
          result[field] = disk[field];
          if (choices[field] === 'mine') change.userFields.push(field);
          else change.absKept.push(c);
        }
        continue;
      }
      const edited = state === 'yours';
      if (edited) change.userFields.push(field);
      if (edited && weChange && norm(field, disk[field]) !== norm(field, ours[field])) {
        const c: FieldChange = { field, from: lastOurs[field], to: ours[field], mine: disk[field] };
        if (choices[field] === 'ours') {
          result[field] = ours[field];
          change.fields.push(c);
          write = true;
        } else {
          result[field] = disk[field];
          if (choices[field] !== 'mine') change.conflicts.push(c);
        }
        continue;
      }
      if (edited) {
        result[field] = disk[field];
        continue;
      }
      // Not edited: the file holds what we wrote; ours now goes there when it differs from it.
      result[field] = ours[field];
      if (weChange || norm(field, last[field]) !== norm(field, ours[field])) {
        if (weChange) change.fields.push({ field, from: lastOurs[field], to: ours[field] });
        write = write || weChange;
      }
    }
    if (change.conflicts.length)
      change.reviews.push({
        kind: 'conflict',
        text: `You edited ${change.conflicts.map((c) => c.field).join(', ')} in Audiobookshelf, and the cleanup's value changed too: yours is kept until you choose`,
      });
    if (change.absKept.length)
      change.reviews.push({
        kind: 'abs_kept',
        text: `Audiobookshelf kept an older value of ${change.absKept.map((c) => c.field).join(', ')} when it scanned the cleanup's metadata.json: it stays as it is until you choose`,
      });
    // ---- the folder
    const baseNow = libraryFolder(cur.baseFolder);
    if (baseNow !== b.baseFolder) {
      const edited = change.userFields.filter((f) => PATH_FIELDS.has(f));
      if (b.area !== 'main')
        change.reviews.push({
          kind: 'ai_path',
          text: `The decided path is ${baseNow}: AI books are not moved automatically (only japanese/)`,
        });
      else if (edited.length)
        change.reviews.push({
          kind: 'move_edited',
          text: `The decided path is ${baseNow}, but you edited ${edited.join(', ')} in Audiobookshelf: the folder stays`,
        });
      else {
        const placed = planArrivals([cur], without(work, b.folder)).books[0];
        if (placed && placed.folder !== b.folder) {
          change.folderTo = placed.folder;
          change.baseTo = placed.baseFolder;
          const left = without(work, b.folder);
          work.dirs = left.dirs;
          work.bookDirs = left.bookDirs;
          work.narrators = left.narrators;
          const parts = placed.folder.split('/');
          for (let i = 1; i <= parts.length; i++) work.dirs.add(parts.slice(0, i).join('/'));
          work.bookDirs.add(placed.folder);
          work.narrators.set(placed.folder, cur.values.narrators[0] ?? null);
        }
      }
    }
    // ---- link names (the story order's numbers)
    const prefix = cur.folder + '/';
    const wanted = new Map(cur.files.map((f) => [f.fileId, f.dst.slice(prefix.length)]));
    if (b.files.every((f) => wanted.has(f.fileId)) && wanted.size === b.files.length) {
      for (const f of b.files) {
        const to = wanted.get(f.fileId)!;
        if (to !== f.name) change.renames.push({ from: f.name, to, ino: f.ino });
      }
    }
    if (change.renames.length) {
      const abs = input.abs(b);
      const safe = abs !== null && (!abs.found || (!abs.inProgress && abs.bookmarks === 0));
      if (!safe && choices.rename !== 'now') {
        change.renamesHeld = true;
        change.reviews.push(
          abs === null
            ? {
                kind: 'abs_unknown',
                text: "Its files get numbered names in story order, but Audiobookshelf couldn't be asked whether anyone is listening to it: renamed only once that is known",
              }
            : {
                kind: 'rename_progress',
                text: `Its files get numbered names in story order (${change.renames.length}). Someone has ${abs.inProgress ? 'listening progress' : ''}${abs.inProgress && abs.bookmarks ? ' and ' : ''}${abs.bookmarks ? `${abs.bookmarks} bookmark(s)` : ''} on it, and renaming changes ABS's track order, so the place would move: renamed when you choose "Rename now"`,
              },
        );
      }
    }
    // ---- kept as built: nothing changes
    const keep = input.keep(b);
    if (keep) {
      change.skipped = keep;
      change.fields = [];
      change.conflicts = [];
      change.absKept = [];
      change.absSet = [];
      change.reviews = [];
      change.folderTo = null;
      change.baseTo = null;
      change.renames = [];
      write = false;
    }
    if (write) {
      change.metadataNew = objectBytes(result);
      change.metadataShaRead = diskBytes ? sha256(diskBytes) : null;
      if (!diskBytes) {
        change.metadataNew = null;
        change.reviews.push({
          kind: 'abs_unknown',
          text: 'Its metadata.json could not be read: nothing is written until it can',
        });
      }
    }
    const something =
      change.metadataNew !== null ||
      change.folderTo !== null ||
      change.renames.length > 0 ||
      change.reviews.length > 0 ||
      change.skipped !== null;
    if (something && (change.skipped === null || keepDiffers(b, cur, change))) out.push(change);
  }
  return out;
}

/** A kept-as-built book is listed only when its decided values would change it. */
function keepDiffers(b: LedgerBook, cur: PlannedBook, _c: PlannedChange): boolean {
  return !cur.metadata.equals(b.decided) || libraryFolder(cur.baseFolder) !== b.baseFolder;
}

/**
 * The moves in an order where no target exists when it is made: a move waits while another
 * move's source sits at its target; a cycle goes through a temporary name in the same folder
 * (`.ttsu-move-<n>`). Returns the steps.
 */
export function orderMoves(
  moves: { from: string; to: string; ino: number }[],
): { from: string; to: string; ino: number }[] {
  const steps: { from: string; to: string; ino: number }[] = [];
  const pending = moves.map((m) => ({ ...m }));
  const occupied = new Set(pending.map((m) => m.from));
  let temp = 0;
  while (pending.length) {
    const i = pending.findIndex((m) => !occupied.has(m.to));
    if (i >= 0) {
      const m = pending.splice(i, 1)[0];
      steps.push(m);
      occupied.delete(m.from);
      occupied.add(m.to);
      continue;
    }
    // A cycle: move the first one aside.
    const m = pending[0];
    const parent = m.from.split('/').slice(0, -1).join('/');
    const aside = `${parent}/.ttsu-move-${++temp}`;
    steps.push({ from: m.from, to: aside, ino: m.ino });
    occupied.delete(m.from);
    occupied.add(aside);
    m.from = aside;
  }
  return steps;
}

/** The folders a moved book leaves behind (its old parents, deepest first, never the root). */
export function leftBehind(moves: { from: string; to: string }[]): string[] {
  const out = new Set<string>();
  for (const m of moves) {
    const parts = m.from.split('/');
    for (let i = parts.length - 1; i >= 2; i--) out.add(parts.slice(0, i).join('/'));
  }
  return [...out].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1));
}
