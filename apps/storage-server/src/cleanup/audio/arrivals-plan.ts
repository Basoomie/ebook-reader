/**
 * Stage 7's plan for the new books (WP21f-1, plan section 9 step 6). Pure. The books come from
 * stage 6's own plan (`planBuild` on today's stages 1-5: the same files, Disc folders, PDFs and
 * metadata.json); only their folders are chosen here, against the library as it is:
 *
 * - `<Author>/<Series>/Vol N - Title/` as the build, under media/audiobooks/japanese/ (AI books:
 *   japanese-generated/); an author or series folder that exists is used with its spelling.
 * - A folder that holds files directly is a book: it is never used as an author or series
 *   folder (its name gets the next free ` (N)` for the new series folder instead).
 * - A name collision with an existing folder (or another new book) follows the build's rule:
 *   ` {first narrator}` when the narrators differ, then ` (2)`, ` (3)`. Only the new book is
 *   named that way; an existing folder is never renamed (WP21f-2 renames).
 */
import { fitName, nameKey } from './build-names';
import type { BuildArea, BuildOpKind, PlannedBook } from './build-plan';

export const ARRIVAL_AREA_FOLDERS: Record<BuildArea, string> = {
  main: 'japanese',
  ai: 'japanese-generated',
};

export interface ExistingTree {
  /** Every folder under media/audiobooks (relative, e.g. `japanese/作者/本`). */
  dirs: Set<string>;
  /** Folders that hold a file directly (book folders). */
  bookDirs: Set<string>;
  /** A book folder's first narrator, when known (stage 6's or stage 7's metadata). */
  narrators: Map<string, string | null>;
}

export interface ArrivalBook {
  unitKey: string;
  copyKey: string;
  area: BuildArea;
  folder: string;
  baseFolder: string;
  author: string;
  series: string | null;
  title: string;
  notes: string[];
  files: { fileId: number; dst: string }[];
  pdfs: { fileId: number; dst: string }[];
  metadata: Buffer;
  narrator: string | null;
  /** Everything planned inside the book folder (relative to it): files, Disc folders, metadata. */
  planned: string[];
}

export interface ArrivalOp {
  kind: BuildOpKind;
  dst: string;
  book: number;
  srcFileId: number | null;
}

export interface ArrivalPlan {
  books: ArrivalBook[];
  ops: ArrivalOp[];
  counts: {
    books: number;
    main: number;
    ai: number;
    links: number;
    pdfs: number;
    folders: number;
    collisions: { narrator: number; number: number; series: number };
    newAuthors: number;
  };
}

function childrenOf(tree: ExistingTree, parent: string): Map<string, string> {
  const out = new Map<string, string>();
  const prefix = parent + '/';
  for (const d of tree.dirs) {
    if (!d.startsWith(prefix)) continue;
    const rest = d.slice(prefix.length);
    if (rest.includes('/')) continue;
    out.set(nameKey(rest), rest);
  }
  return out;
}

export function planArrivals(books: PlannedBook[], tree: ExistingTree): ArrivalPlan {
  const counts: ArrivalPlan['counts'] = {
    books: 0,
    main: 0,
    ai: 0,
    links: 0,
    pdfs: 0,
    folders: 0,
    collisions: { narrator: 0, number: 0, series: 0 },
    newAuthors: 0,
  };
  // Folders made by this plan (path -> true) and the names taken under each parent.
  const made = new Set<string>();
  const taken = new Map<string, Map<string, string | null>>(); // parent -> nameKey -> narrator
  const takenAt = (parent: string): Map<string, string | null> => {
    let t = taken.get(parent);
    if (!t) {
      t = new Map();
      for (const [k, name] of childrenOf(tree, parent))
        t.set(k, tree.narrators.get(`${parent}/${name}`) ?? null);
      taken.set(parent, t);
    }
    return t;
  };
  const isBookDir = (p: string) => tree.bookDirs.has(p);
  /** A parent folder (author or series) under `parent`: an existing one by its Windows name. */
  const folderIn = (parent: string, name: string): string => {
    const k = nameKey(name);
    const existing = childrenOf(tree, parent).get(k);
    if (existing && !isBookDir(`${parent}/${existing}`)) return `${parent}/${existing}`;
    for (const p of made)
      if (p.startsWith(parent + '/') && nameKey(p.slice(parent.length + 1)) === k) return p;
    if (!existing) {
      const t = takenAt(parent);
      if (!t.has(k)) {
        t.set(k, null);
        return `${parent}/${name}`;
      }
    }
    // The name is a book's folder: the series gets the next free number.
    counts.collisions.series++;
    const t = takenAt(parent);
    for (let n = 2; ; n++) {
      const cand = fitName(name, ` (${n})`).name;
      const ck = nameKey(cand);
      const there = childrenOf(tree, parent).get(ck);
      if (there && !isBookDir(`${parent}/${there}`)) return `${parent}/${there}`;
      if (!there && !t.has(ck)) {
        t.set(ck, null);
        return `${parent}/${cand}`;
      }
    }
  };

  const out: ArrivalBook[] = [];
  for (const b of books) {
    if (b.state !== 'build') continue;
    const root = ARRIVAL_AREA_FOLDERS[b.area];
    const hadAuthor = childrenOf(tree, root).has(nameKey(b.author));
    const authorPath = folderIn(root, b.author);
    if (!hadAuthor) counts.newAuthors++;
    const parent = b.series ? folderIn(authorPath, b.series) : authorPath;
    made.add(authorPath);
    made.add(parent);
    const base = b.baseFolder.split('/').pop() ?? b.title;
    const narrator = (b.values.narrators[0] ?? null) || null;
    const t = takenAt(parent);
    const notes = b.notes.filter((n) => n !== 'narrator' && n !== 'number');
    let suffix = '';
    const k0 = nameKey(fitName(base).name);
    if (t.has(k0)) {
      const theirs = t.get(k0) ?? null;
      if (narrator && theirs !== null && theirs !== narrator) {
        suffix = ` {${fitName(narrator).name}}`;
        notes.push('narrator');
        counts.collisions.narrator++;
      }
    }
    let fitted = fitName(base, suffix);
    if (t.has(nameKey(fitted.name))) {
      for (let n = 2; ; n++) {
        fitted = fitName(base, `${suffix} (${n})`);
        if (!t.has(nameKey(fitted.name))) break;
      }
      notes.push('number');
      counts.collisions.number++;
    }
    t.set(nameKey(fitted.name), narrator);
    const folder = `${parent}/${fitted.name}`;
    const move = (dst: string) => folder + dst.slice(b.folder.length);
    const files = b.files.map((f) => ({ fileId: f.fileId, dst: move(f.dst) }));
    const pdfs = b.pdfs.map((f) => ({ fileId: f.fileId, dst: move(f.dst) }));
    const inner = new Set<string>(['metadata.json']);
    for (const f of [...files, ...pdfs]) {
      const rel = f.dst.slice(folder.length + 1);
      const parts = rel.split('/');
      for (let i = 1; i <= parts.length; i++) inner.add(parts.slice(0, i).join('/'));
    }
    out.push({
      unitKey: b.unitKey,
      copyKey: b.copyKey,
      area: b.area,
      folder,
      baseFolder: `${parent}/${fitName(base).name}`,
      author: authorPath.split('/').pop()!,
      series: b.series ? parent.split('/').pop()! : null,
      title: b.title,
      notes: [...new Set(notes)],
      files,
      pdfs,
      metadata: b.metadata,
      narrator,
      planned: [...inner].sort(),
    });
    counts.books++;
    counts[b.area]++;
  }

  // Operations, in order: every missing folder before what goes in it; then each book's
  // metadata.json, its links and its PDFs (as the build).
  const ops: ArrivalOp[] = [];
  const folders = new Set<string>();
  const folder = (p: string, book: number) => {
    const parts = p.split('/');
    for (let i = 2; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      if (folders.has(sub) || tree.dirs.has(sub)) continue;
      folders.add(sub);
      ops.push({ kind: 'folder', dst: sub, book, srcFileId: null });
    }
  };
  out.forEach((b, i) => {
    folder(b.folder, i);
    for (const f of [...b.files, ...b.pdfs]) {
      const dir = f.dst.slice(0, f.dst.lastIndexOf('/'));
      if (dir !== b.folder) folder(dir, i);
    }
    ops.push({ kind: 'metadata', dst: `${b.folder}/metadata.json`, book: i, srcFileId: null });
    for (const f of b.files) ops.push({ kind: 'link', dst: f.dst, book: i, srcFileId: f.fileId });
    for (const f of b.pdfs) ops.push({ kind: 'pdf', dst: f.dst, book: i, srcFileId: f.fileId });
  });
  counts.folders = folders.size;
  counts.links = ops.filter((o) => o.kind === 'link').length;
  counts.pdfs = ops.filter((o) => o.kind === 'pdf').length;
  return { books: out, ops, counts };
}
