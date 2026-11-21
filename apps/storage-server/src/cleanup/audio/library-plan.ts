/**
 * WP21f-2: what changes for the books already in the library (plan section 9, decided with the
 * user 2026-11-21). Pure: the caller loads the ledger (what was built and last written), each
 * book's current plan (stage 6's plan code on the current analysis: folder layout, link names,
 * metadata.json), the metadata.json on disk now, and what Audiobookshelf has for the book.
 *
 * Per book:
 *  - metadata: our fields (absMetadata's keys) whose decided value changed since we wrote them.
 *    A field whose metadata.json value now differs from what we wrote is yours (ABS writes your
 *    edit there, proven at B0): it keeps your value; where your edit and our new value differ for
 *    the same field, that field goes to review ("write the rest, review conflicts": user).
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
}

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

export type ReviewKind = 'conflict' | 'rename_progress' | 'ai_path' | 'move_edited' | 'abs_unknown';

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
    const disk = parse(diskBytes) ?? last;
    const result: Record<string, unknown> = {};
    let write = false;
    for (const field of Object.keys(ours)) {
      const weChange = norm(field, ours[field]) !== norm(field, lastOurs[field]);
      const edited = norm(field, disk[field]) !== norm(field, last[field]);
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
