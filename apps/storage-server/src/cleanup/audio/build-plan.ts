/**
 * Stage 6's plan (WP21e-1, plan section 8 step 1): from the decisions in cleanup.db, every book
 * folder of the new library, every hard link, PDF and metadata file in it, and the move list of
 * the live library. Pure: the inputs are loaded by `build-inputs.ts`; nothing here reads a file.
 *
 * - One book per linked copy of a recording (stage 4/5's unit). Proven groups link only the copy
 *   stage 3 keeps; unproven groups and unsure pairs keep every copy (user, 2026-11-18: "I'd rather
 *   have a duplicate than be missing a unique recording"). A choice made on the review page
 *   (`audio_dup_decisions`) is applied.
 * - Layout: `<Author>/<Series>/Vol <N> - <Title>/` or `<Author>/<Title>/`; first author only;
 *   `_Unknown` without one; a series without a position anywhere: `<Author>/<Series>/<Title>/`.
 * - Collisions (user, 2026-11-20): `{first narrator}` when the colliding recordings' narrators
 *   differ; when they'd still collide, ` (2)`, ` (3)` in stage 3's best-guess order.
 * - AI books go to `japanese-generated-new/` (user, 2026-11-20: renamed to japanese-generated at
 *   the switch); everything else to `japanese-new/`.
 * - Library-only files (no torrent original) are planned but not linked: they move into
 *   `torrents/…/_from-library/` at the switch (WP21e-2), state `pending`.
 * - Files keep their own names (the decoded name of a garbled one), Disc/CD subfolders kept.
 * - PDFs: those of the book's own folder (one-file books: the same base name or ASIN), from the
 *   kept copy, else from the recording's other copies; the same name and size once.
 */
import { metadataBytes, bookValues, type BookValues } from './build-metadata';
import {
  cleanSegment,
  fitFileName,
  fitName,
  formatPosition,
  nameKey,
  withFileSuffix,
} from './build-names';
import type { SeriesEntry } from './meta-rules';

export const BUILD_PLAN_VERSION = 1;

export type BuildArea = 'main' | 'ai';
export const AREA_FOLDERS: Record<BuildArea, string> = {
  main: 'japanese-new',
  ai: 'japanese-generated-new',
};
export const UNKNOWN_AUTHOR = '_Unknown';

export interface PlanFile {
  id: number;
  root: 'torrents' | 'library';
  rel: string;
  raw: string | null;
  decoded: string | null;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  /** Embedded cover (stage 2), null when unknown. */
  cover: boolean | null;
}

export interface PlanCopyGroup {
  id: number;
  key: string;
  kind: 'group' | 'unsure';
  outcome: 'auto' | 'review';
  role: 'keep' | 'drop' | 'review';
  rank: number;
}

export interface PlanCopy {
  id: number;
  key: string;
  bookKey: string;
  kind: 'file' | 'parts' | 'library_only';
  fileIds: number[];
  ai: boolean;
  excluded: boolean;
  group: PlanCopyGroup | null;
}

/** A stage-2 book unit (torrents): a folder (with Disc subfolders) or one file. */
export interface PlanBookUnit {
  key: string;
  rel: string;
  kind: 'folder' | 'file';
}

export interface PlanUnit {
  key: string;
  kind: 'record' | 'no_record' | 'ai' | 'radio';
  name: string;
  copyKeys: string[];
  /** Stage 5's values (field -> value), best guesses included. */
  values: Record<string, unknown>;
}

export interface PlanIdentity {
  cls: string;
  originals: number[];
}

export interface PlanInputs {
  units: PlanUnit[];
  copies: Map<string, PlanCopy>;
  files: Map<number, PlanFile>;
  books: Map<string, PlanBookUnit>;
  /** Library audio file id -> stage 1's identity. */
  identity: Map<number, PlanIdentity>;
  /** The live library's audio files (ids into `files`). */
  libraryAudio: number[];
  /** PDFs under the torrents (ids into `files`). */
  pdfs: number[];
  /** Stage 3's review-page choices: group key -> keep_all | keep:<copy key>. */
  decisions: Map<string, string>;
  /** Library paths of audio files the reader wrote (merges). */
  readerWritten: Set<string>;
  /** The live library's folder under media/audiobooks (e.g. japanese). */
  libraryFolder: string;
}

export interface PlannedFile {
  fileId: number;
  /** Relative to media/audiobooks. */
  dst: string;
}

export interface PlannedBook {
  unitKey: string;
  copyKey: string;
  area: BuildArea;
  state: 'build' | 'pending';
  /** Relative to media/audiobooks. */
  folder: string;
  /** The folder the layout gives before any collision suffix. */
  baseFolder: string;
  author: string;
  series: string | null;
  title: string;
  notes: string[];
  files: PlannedFile[];
  pdfs: PlannedFile[];
  /** The first audio file has an embedded cover (ABS shows it). */
  cover: boolean;
  metadata: Buffer;
  values: BookValues;
  rank: number;
}

export type BuildOpKind = 'folder' | 'link' | 'pdf' | 'metadata';

export interface PlannedOp {
  kind: BuildOpKind;
  dst: string;
  /** Index into books (null for shared folders). */
  book: number | null;
  srcFileId: number | null;
}

export type MoveOutcome =
  | 'moved'
  | 'ai'
  | 'dropped'
  | 'library_only_pending'
  | 'reader_written'
  | 'unaccounted';

export interface PlannedMove {
  fileId: number;
  /** Relative to media/audiobooks (the reader's paths), e.g. japanese/_Unknown/…/x.m4b. */
  oldPath: string;
  outcome: MoveOutcome;
  newPath: string | null;
  keptPath: string | null;
  detail: string | null;
}

export interface PlanCounts {
  units: number;
  books: { main: number; ai: number; pending: number };
  shapes: { seriesVol: number; seriesNoVol: number; standalone: number };
  unknownAuthor: number;
  links: number;
  pdfLinks: number;
  /**
   * PDFs placed next to a book; not placed because another copy of the same recording brought
   * its booklet (a dropped copy's PDF); not placed because no book's folder or name matches.
   */
  pdfs: { placed: number; unplaced: number; otherCopy: number; noBook: number; total: number };
  folders: number;
  metadata: number;
  ops: number;
  collisions: { narrator: number; number: number };
  namesCut: number;
  namesReplaced: number;
  noCover: number;
  noValues: number;
  droppedCopies: number;
  keptReview: number;
  moves: Record<MoveOutcome, number>;
}

export interface PlanResult {
  books: PlannedBook[];
  ops: PlannedOp[];
  moves: PlannedMove[];
  unplacedPdfs: number[];
  counts: PlanCounts;
}

// ---------------------------------------------------------------------------------------------
// layout

export interface Layout {
  author: string;
  series: string | null;
  /** The book folder's name without a collision suffix (`Vol 3 - Title` or `Title`). */
  base: string;
  position: number | null;
  replaced: number;
}

/** The series a folder is named after: the first with a position, else the first. */
export function folderSeries(series: SeriesEntry[] | null): SeriesEntry | null {
  const s = series ?? [];
  return s.find((e) => e.position !== null) ?? s[0] ?? null;
}

/** The folders a recording's values give (before collisions). */
export function layoutOf(v: {
  title: string;
  authors: string[];
  series: SeriesEntry[] | null;
}): Layout {
  const author = cleanSegment(v.authors[0] ?? UNKNOWN_AUTHOR);
  const s = folderSeries(v.series);
  const series = s ? cleanSegment(s.name) : null;
  const title = cleanSegment(v.title);
  const prefix = s && s.position !== null ? `Vol ${formatPosition(s.position)} - ` : '';
  return {
    author: fitName(author.name).name,
    series: series ? fitName(series.name).name : null,
    base: prefix + title.name,
    position: s?.position ?? null,
    replaced: author.replaced + (series?.replaced ?? 0) + title.replaced,
  };
}

/** `<area>/<Author>[/<Series>]/<book>` for a layout (the base name, cut to 255 bytes). */
export function layoutFolder(area: BuildArea, l: Layout): string {
  return [AREA_FOLDERS[area], l.author, ...(l.series ? [l.series] : []), fitName(l.base).name].join(
    '/',
  );
}

// ---------------------------------------------------------------------------------------------
// the plan

interface Draft {
  unit: PlanUnit;
  copy: PlanCopy;
  values: BookValues;
  layout: Layout;
  narrator: string | null;
  rank: number;
  noValues: boolean;
  area: BuildArea;
}

const ASIN_RE = /B0[0-9A-Z]{8}/g;

function segments(f: PlanFile): string[] {
  const rel = f.rel.split('/');
  const dec = f.decoded ? f.decoded.split('/') : null;
  return dec && dec.length === rel.length ? dec : rel;
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

function baseOf(name: string): string {
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(0, i) : name).normalize('NFKC').toLowerCase().trim();
}

/** The plan in one go (tests, scripts). */
export function planBuild(inputs: PlanInputs): PlanResult {
  const g = planSteps(inputs);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** The plan in slices (the server: never more than a short stretch without answering). */
export async function planBuildSliced(inputs: PlanInputs): Promise<PlanResult> {
  const g = planSteps(inputs);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    await new Promise((res) => setImmediate(res));
  }
}

const SLICE = 300;

function* planSteps(inputs: PlanInputs): Generator<void, PlanResult> {
  let n = 0;
  const counts: PlanCounts = {
    units: inputs.units.length,
    books: { main: 0, ai: 0, pending: 0 },
    shapes: { seriesVol: 0, seriesNoVol: 0, standalone: 0 },
    unknownAuthor: 0,
    links: 0,
    pdfLinks: 0,
    pdfs: { placed: 0, unplaced: 0, otherCopy: 0, noBook: 0, total: inputs.pdfs.length },
    folders: 0,
    metadata: 0,
    ops: 0,
    collisions: { narrator: 0, number: 0 },
    namesCut: 0,
    namesReplaced: 0,
    noCover: 0,
    noValues: 0,
    droppedCopies: 0,
    keptReview: 0,
    moves: {
      moved: 0,
      ai: 0,
      dropped: 0,
      library_only_pending: 0,
      reader_written: 0,
      unaccounted: 0,
    },
  };

  // 1. Which copies are linked, and which copy each dropped one gives way to.
  const groups = new Map<number, { g: PlanCopyGroup; members: PlanCopy[] }>();
  for (const c of inputs.copies.values()) {
    if (!c.group) continue;
    const e = groups.get(c.group.id) ?? { g: c.group, members: [] };
    e.members.push(c);
    groups.set(c.group.id, e);
  }
  const droppedBy = new Map<string, { kept: string; why: string }>();
  for (const { g, members } of groups.values()) {
    const decision = inputs.decisions.get(g.key) ?? null;
    const chosen = decision?.startsWith('keep:') ? decision.slice(5) : null;
    const chosenCopy = chosen ? members.find((m) => m.key === chosen) : undefined;
    let kept: PlanCopy[];
    let why: string;
    if (chosenCopy) {
      kept = [chosenCopy];
      why = 'your choice on the review page';
    } else if (decision === 'keep_all' || g.kind !== 'group' || g.outcome !== 'auto') {
      kept = members;
      why = '';
    } else {
      kept = members.filter((m) => m.group?.role === 'keep');
      why = 'proven duplicate';
      if (kept.length === 0) kept = members; // never lose every copy
    }
    const keptKeys = new Set(kept.map((k) => k.key));
    const first = [...kept].sort((a, b) => (a.group?.rank ?? 0) - (b.group?.rank ?? 0))[0];
    for (const m of members)
      if (!keptKeys.has(m.key)) droppedBy.set(m.key, { kept: first.key, why });
  }
  counts.droppedCopies = droppedBy.size;

  // 2. One draft per linked copy.
  const drafts: Draft[] = [];
  for (const unit of inputs.units) {
    if (++n % SLICE === 0) yield;
    const copies = unit.copyKeys
      .map((k) => inputs.copies.get(k))
      .filter((c): c is PlanCopy => !!c && !c.excluded);
    const linked = copies.filter((c) => !droppedBy.has(c.key));
    const noValues = Object.keys(unit.values).length === 0;
    const values = bookValues(unit.values, unit.name);
    const layout = layoutOf(values);
    const area: BuildArea =
      unit.kind === 'ai' || (copies.length > 0 && copies.every((c) => c.ai)) ? 'ai' : 'main';
    for (const copy of linked) {
      if (copy.group && copy.group.outcome === 'review') counts.keptReview++;
      drafts.push({
        unit,
        copy,
        values,
        layout,
        narrator: values.narrators[0] ? cleanSegment(values.narrators[0]).name : null,
        rank: copy.group?.rank ?? 0,
        noValues,
        area,
      });
    }
  }

  // 3. Folders: the author and series folders (one spelling per Windows name), then the book
  // folders with their collision suffixes, per parent folder.
  const authorName = new Map<string, string>();
  const seriesName = new Map<string, string>();
  const parentOf = (d: Draft): { key: string; path: string } => {
    const ak = `${d.area}/${nameKey(d.layout.author)}`;
    if (!authorName.has(ak)) authorName.set(ak, d.layout.author);
    const aPath = `${AREA_FOLDERS[d.area]}/${authorName.get(ak)!}`;
    if (!d.layout.series) return { key: ak, path: aPath };
    const sk = `${ak}/${nameKey(d.layout.series)}`;
    if (!seriesName.has(sk)) seriesName.set(sk, d.layout.series);
    return { key: sk, path: `${aPath}/${seriesName.get(sk)!}` };
  };
  const byParent = new Map<string, { path: string; drafts: Draft[] }>();
  for (const d of drafts) {
    const p = parentOf(d);
    const e = byParent.get(p.key) ?? { path: p.path, drafts: [] };
    e.drafts.push(d);
    byParent.set(p.key, e);
  }
  // Series folder names under each author: a standalone book folder must not take one.
  const reservedAt = new Map<string, Set<string>>();
  for (const sk of seriesName.keys()) {
    const ak = sk.slice(0, sk.lastIndexOf('/'));
    const set = reservedAt.get(ak) ?? new Set<string>();
    set.add(nameKey(seriesName.get(sk)!));
    reservedAt.set(ak, set);
  }
  const folderOf = new Map<Draft, { folder: string; base: string; notes: string[] }>();
  for (const [pk, { path, drafts: ds }] of byParent) {
    if (++n % SLICE === 0) yield;
    const reserved = reservedAt.get(pk) ?? new Set<string>();
    const byBase = new Map<string, Draft[]>();
    for (const d of ds) {
      const k = nameKey(fitName(d.layout.base).name);
      byBase.set(k, [...(byBase.get(k) ?? []), d]);
    }
    const suffix = new Map<Draft, string>();
    const notes = new Map<Draft, string[]>();
    for (const [k, group] of byBase) {
      const narrators = new Set(group.map((d) => d.narrator ?? ''));
      const collide = group.length > 1 || reserved.has(k);
      if (collide && (narrators.size > 1 || (group.length === 1 && reserved.has(k)))) {
        for (const d of group) {
          if (!d.narrator) continue;
          suffix.set(d, ` {${d.narrator}}`);
          notes.set(d, ['narrator']);
          counts.collisions.narrator++;
        }
      }
    }
    const taken = new Set(reserved);
    const order = [...ds].sort(
      (a, b) => a.rank - b.rank || (a.copy.key < b.copy.key ? -1 : a.copy.key > b.copy.key ? 1 : 0),
    );
    for (const d of order) {
      const s = suffix.get(d) ?? '';
      let fitted = fitName(d.layout.base, s);
      const n0 = notes.get(d) ?? [];
      if (taken.has(nameKey(fitted.name))) {
        for (let n = 2; ; n++) {
          fitted = fitName(d.layout.base, `${s} (${n})`);
          if (!taken.has(nameKey(fitted.name))) break;
        }
        n0.push('number');
        counts.collisions.number++;
      }
      if (fitted.cut) n0.push('cut');
      taken.add(nameKey(fitted.name));
      folderOf.set(d, {
        folder: `${path}/${fitted.name}`,
        base: `${path}/${fitName(d.layout.base).name}`,
        notes: n0,
      });
    }
  }

  // 4. Files and PDFs of each book.
  const pdfsByDir = new Map<string, PlanFile[]>();
  const pdfFiles: PlanFile[] = [];
  for (const id of inputs.pdfs) {
    const f = inputs.files.get(id);
    if (!f) continue;
    pdfFiles.push(f);
    const d = dirOf(f.rel);
    pdfsByDir.set(d, [...(pdfsByDir.get(d) ?? []), f]);
  }
  const placed = new Set<number>();
  const pdfsOfCopy = (copy: PlanCopy): { f: PlanFile; sub: string[] }[] => {
    if (copy.kind === 'library_only') return [];
    const unit = inputs.books.get(copy.bookKey);
    if (!unit) return [];
    if (unit.kind === 'folder') {
      const n = unit.rel.split('/').length;
      return pdfFiles
        .filter((f) => f.rel.startsWith(unit.rel + '/'))
        .map((f) => ({ f, sub: segments(f).slice(n) }));
    }
    const audio = inputs.files.get(copy.fileIds[0]);
    if (!audio) return [];
    const aSeg = segments(audio);
    const aBase = baseOf(aSeg[aSeg.length - 1]);
    const asins = new Set(audio.rel.match(ASIN_RE) ?? []);
    return (pdfsByDir.get(dirOf(audio.rel)) ?? [])
      .filter((f) => {
        const s = segments(f);
        if (baseOf(s[s.length - 1]) === aBase) return true;
        return (f.rel.match(ASIN_RE) ?? []).some((a) => asins.has(a));
      })
      .map((f) => ({ f, sub: [segments(f).slice(-1)[0]] }));
  };

  const books: PlannedBook[] = [];
  for (const d of drafts) {
    if (++n % SLICE === 0) yield;
    const fo = folderOf.get(d)!;
    const notes = [...fo.notes];
    const state: PlannedBook['state'] = d.copy.kind === 'library_only' ? 'pending' : 'build';
    const used = new Set<string>();
    const place = (sub: string[]): string => {
      const parts = sub.map((s, i) => {
        const c = cleanSegment(s);
        if (c.replaced) counts.namesReplaced++;
        const fit = i === sub.length - 1 ? fitFileName(c.name) : fitName(c.name);
        if (fit.cut) notes.push('file name cut');
        return fit.name;
      });
      let rel = parts.join('/');
      while (used.has(nameKey(rel))) {
        let n = 2;
        let cand = '';
        do {
          cand = [...parts.slice(0, -1), withFileSuffix(parts[parts.length - 1], ` (${n})`)].join(
            '/',
          );
          n++;
        } while (used.has(nameKey(cand)));
        rel = cand;
      }
      used.add(nameKey(rel));
      return `${fo.folder}/${rel}`;
    };
    const unitBook = inputs.books.get(d.copy.bookKey);
    const files: PlannedFile[] = [];
    for (const id of d.copy.fileIds) {
      const f = inputs.files.get(id);
      if (!f) continue;
      const seg = segments(f);
      const sub =
        unitBook && unitBook.kind === 'folder' && d.copy.kind !== 'library_only'
          ? seg.slice(unitBook.rel.split('/').length)
          : [seg[seg.length - 1]];
      files.push({ fileId: id, dst: place(sub.length ? sub : [seg[seg.length - 1]]) });
    }
    // PDFs: the linked copy's, else the recording's other copies' (same name and size once).
    const pdfs: PlannedFile[] = [];
    if (state === 'build') {
      const others = d.unit.copyKeys
        .map((k) => inputs.copies.get(k))
        .filter((c): c is PlanCopy => !!c && c.key !== d.copy.key);
      for (const c of [d.copy, ...others]) {
        const found = pdfsOfCopy(c);
        if (found.length === 0) continue;
        const seen = new Set<string>();
        for (const { f, sub } of found) {
          const k = `${nameKey(sub.join('/'))}|${f.size}`;
          if (seen.has(k)) continue;
          seen.add(k);
          pdfs.push({ fileId: f.id, dst: place(sub) });
          placed.add(f.id);
        }
        break;
      }
    }
    const first = inputs.files.get(d.copy.fileIds[0]);
    const cover = first?.cover === true;
    if (fo.notes.includes('cut') || d.layout.base.length === 0) counts.namesCut++;
    if (d.layout.replaced) counts.namesReplaced++;
    books.push({
      unitKey: d.unit.key,
      copyKey: d.copy.key,
      area: d.area,
      state,
      folder: fo.folder,
      baseFolder: fo.base,
      author: d.layout.author,
      series: d.layout.series,
      title: d.values.title,
      notes: [...new Set(notes)],
      files,
      pdfs,
      cover,
      metadata: metadataBytes(d.values),
      values: d.values,
      rank: d.rank,
    });
    if (state === 'pending') counts.books.pending++;
    else counts.books[d.area]++;
    if (!d.layout.series) counts.shapes.standalone++;
    else if (d.layout.position === null) counts.shapes.seriesNoVol++;
    else counts.shapes.seriesVol++;
    if (d.layout.author === UNKNOWN_AUTHOR) counts.unknownAuthor++;
    if (!cover && state === 'build') counts.noCover++;
    if (d.noValues) counts.noValues++;
  }
  counts.pdfs.placed = placed.size;
  const unplacedPdfs = pdfFiles.filter((f) => !placed.has(f.id)).map((f) => f.id);
  counts.pdfs.unplaced = unplacedPdfs.length;
  const owned = new Set<number>();
  for (const c of inputs.copies.values()) for (const { f } of pdfsOfCopy(c)) owned.add(f.id);
  counts.pdfs.otherCopy = unplacedPdfs.filter((id) => owned.has(id)).length;
  counts.pdfs.noBook = unplacedPdfs.length - counts.pdfs.otherCopy;

  // 5. Operations, in order: every folder before what goes in it.
  const ops: PlannedOp[] = [];
  const folders = new Set<string>();
  const folder = (p: string, book: number | null) => {
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      if (folders.has(sub)) continue;
      folders.add(sub);
      ops.push({
        kind: 'folder',
        dst: sub,
        book: i === parts.length ? book : null,
        srcFileId: null,
      });
    }
  };
  books.forEach((b, i) => {
    if (b.state !== 'build') return;
    folder(b.folder, i);
    for (const f of [...b.files, ...b.pdfs]) {
      const dir = dirOf(f.dst);
      if (dir !== b.folder) folder(dir, i);
    }
    ops.push({ kind: 'metadata', dst: `${b.folder}/metadata.json`, book: i, srcFileId: null });
    for (const f of b.files) ops.push({ kind: 'link', dst: f.dst, book: i, srcFileId: f.fileId });
    for (const f of b.pdfs) ops.push({ kind: 'pdf', dst: f.dst, book: i, srcFileId: f.fileId });
  });
  counts.folders = folders.size;
  counts.links = ops.filter((o) => o.kind === 'link').length;
  counts.pdfLinks = ops.filter((o) => o.kind === 'pdf').length;
  counts.metadata = ops.filter((o) => o.kind === 'metadata').length;
  counts.ops = ops.length;

  // 6. The move list: every audio file of the live library.
  const dstByFile = new Map<number, { path: string; area: BuildArea }>();
  const bookByCopy = new Map<string, PlannedBook>();
  for (const b of books) {
    bookByCopy.set(b.copyKey, b);
    if (b.state !== 'build') continue;
    for (const f of b.files)
      if (!dstByFile.has(f.fileId)) dstByFile.set(f.fileId, { path: f.dst, area: b.area });
  }
  const copyByFile = new Map<number, PlanCopy>();
  for (const c of inputs.copies.values())
    for (const id of c.fileIds) if (!copyByFile.has(id)) copyByFile.set(id, c);
  const keptPathFor = (copy: PlanCopy, fileId: number): string | null => {
    const d = droppedBy.get(copy.key);
    const keptKey = d ? d.kept : copy.key;
    const kept = bookByCopy.get(keptKey);
    if (!kept) return null;
    const i = copy.fileIds.indexOf(fileId);
    return kept.files.length === copy.fileIds.length && i >= 0 ? kept.files[i].dst : kept.folder;
  };
  const moves: PlannedMove[] = [];
  for (const id of inputs.libraryAudio) {
    if (++n % SLICE === 0) yield;
    const f = inputs.files.get(id);
    if (!f) continue;
    const oldPath = `${inputs.libraryFolder}/${f.rel}`;
    const move = (
      outcome: MoveOutcome,
      newPath: string | null,
      keptPath: string | null,
      detail: string | null,
    ) => moves.push({ fileId: id, oldPath, outcome, newPath, keptPath, detail });
    if (inputs.readerWritten.has(f.rel)) {
      move('reader_written', null, null, 'written by the reader (a merge)');
      continue;
    }
    const ident = inputs.identity.get(id);
    if (!ident) {
      move('unaccounted', null, null, 'no stage-1 identity');
      continue;
    }
    if (ident.cls === 'library_only') {
      const copy = copyByFile.get(id);
      if (!copy) {
        move('unaccounted', null, null, 'library-only file in no copy');
        continue;
      }
      const d = droppedBy.get(copy.key);
      if (d) {
        move('dropped', null, keptPathFor(copy, id), d.why);
        continue;
      }
      const b = bookByCopy.get(copy.key);
      const pf = b?.files.find((x) => x.fileId === id);
      if (!b || !pf) move('unaccounted', null, null, 'library-only file in no planned book');
      else move('library_only_pending', pf.dst, null, 'moves into _from-library at the switch');
      continue;
    }
    if (ident.cls !== 'copy' && ident.cls !== 'linked') {
      move('unaccounted', null, null, `stage 1 class ${ident.cls}`);
      continue;
    }
    const linked = ident.originals.map((o) => dstByFile.get(o)).find((x) => !!x);
    if (linked) {
      move(linked.area === 'ai' ? 'ai' : 'moved', linked.path, null, null);
      continue;
    }
    let done = false;
    for (const o of ident.originals) {
      const copy = copyByFile.get(o);
      if (!copy) continue;
      const d = droppedBy.get(copy.key);
      if (d) {
        move('dropped', null, keptPathFor(copy, o), d.why);
        done = true;
        break;
      }
    }
    if (!done) move('unaccounted', null, null, 'its torrent original is in no planned book');
  }
  for (const m of moves) counts.moves[m.outcome]++;
  return { books, ops, moves, unplacedPdfs, counts };
}
