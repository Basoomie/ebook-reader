/**
 * Scoring stage 2 against the labeled books (gold800.json, plan sections 1 and 8): the
 * comparisons are rules_v3's (N for titles, NA for names, accepted alternative forms, '?'
 * unscored). Pure functions; stage2-gate.ts loads the labels and applies the bars.
 */
import { N, NA, cleanTitleV3 } from './title-rules';
import {
  type ApplyGroup,
  type CalibreFacts,
  type FieldProposal,
  authorGroup,
  fileIllustrators,
  titleGroup,
  valueAfterAuto,
  type FileFacts,
} from './stage2-rules';

/** One labeled book (gold800.json value). */
export interface GoldLabel {
  t: string;
  au: string[] | string;
  il?: string[] | string;
  alt_t?: unknown;
  alt_au?: unknown;
  alt_il?: unknown;
  [key: string]: unknown;
}

const asList = (x: unknown): unknown[] => (Array.isArray(x) ? x : x ? [x] : []);

/** The title is right when it equals the label or an accepted alternative under N. */
export function titleRight(value: unknown, g: GoldLabel): boolean {
  if (typeof value !== 'string') return false;
  const v = N(value);
  return [g.t, ...asList(g.alt_t)].some((a) => typeof a === 'string' && N(a) === v);
}

export function titleScored(g: GoldLabel): boolean {
  return typeof g.t === 'string' && g.t !== '?';
}

function nameSet(list: readonly unknown[]): Set<string> {
  return new Set(list.filter((x): x is string => typeof x === 'string').map((x) => NA(x)));
}
const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

/** Authors are right when the set of names equals the label's (or an alternative) under NA. */
export function authorsRight(value: unknown, g: GoldLabel): boolean {
  if (!Array.isArray(value)) return false;
  const v = nameSet(value);
  return [g.au, ...asList(g.alt_au)].some((a) => Array.isArray(a) && sameSet(v, nameSet(a)));
}

export function authorsScored(g: GoldLabel): boolean {
  return Array.isArray(g.au);
}

export function illustratorsRight(value: unknown, g: GoldLabel): boolean {
  if (!Array.isArray(value)) return false;
  const v = nameSet(value);
  return [g.il, ...asList(g.alt_il)].some((a) => Array.isArray(a) && sameSet(v, nameSet(a)));
}

export interface GroupScore {
  /** Labeled (scored) books in the group. */
  n: number;
  /** The value Calibre will have once the stage's auto changes are applied. */
  applied: number;
  /** Calibre's current value (titles: cleaned the way the measurement did). */
  calibre: number;
  /** The file's own value (titles: cleaned; authors: first author), as measured. */
  file: number;
  /** Books whose value for this field goes to review. */
  review: number;
}

const emptyGroup = (): GroupScore => ({ n: 0, applied: 0, calibre: 0, file: 0, review: 0 });
const GROUPS: ApplyGroup[] = ['unknown', 'processed', 'agree', 'conflict'];
const emptyGroups = () =>
  Object.fromEntries(GROUPS.map((g) => [g, emptyGroup()])) as Record<ApplyGroup, GroupScore>;

export interface Stage2Score {
  books: number;
  title: Record<ApplyGroup, GroupScore>;
  authors: Record<ApplyGroup, GroupScore>;
  /** Books whose auto proposals include illustrators, and how many are right. */
  illustrator: { n: number; applied: number };
  /** Wrong auto-applied titles/authors (labeled id, value, label) for the page and the report. */
  misses: {
    id: string;
    field: 'title' | 'authors';
    group: ApplyGroup;
    value: unknown;
    label: unknown;
  }[];
}

export interface ScoredBook {
  id: string;
  gold: GoldLabel;
  cal: CalibreFacts;
  file: FileFacts;
  proposals: FieldProposal[];
}

export function scoreStage2(books: Iterable<ScoredBook>): Stage2Score {
  const s: Stage2Score = {
    books: 0,
    title: emptyGroups(),
    authors: emptyGroups(),
    illustrator: { n: 0, applied: 0 },
    misses: [],
  };
  for (const b of books) {
    s.books += 1;
    const { gold: g, cal, file, proposals } = b;
    if (titleScored(g)) {
      const grp = titleGroup(cal, file);
      const t = s.title[grp];
      t.n += 1;
      const value = valueAfterAuto('title', cal, proposals);
      if (titleRight(value, g)) t.applied += 1;
      else if (grp !== 'conflict')
        s.misses.push({ id: b.id, field: 'title', group: grp, value, label: g.t });
      if (titleRight(cleanTitleV3(cal.title), g)) t.calibre += 1;
      if (titleRight(cleanTitleV3(file.title ?? ''), g)) t.file += 1;
      if (proposals.some((p) => p.field === 'title' && p.class === 'review')) t.review += 1;
    }
    if (authorsScored(g)) {
      const grp = authorGroup(cal, file);
      const a = s.authors[grp];
      a.n += 1;
      const value = valueAfterAuto('authors', cal, proposals);
      if (authorsRight(value, g)) a.applied += 1;
      else if (grp !== 'conflict')
        s.misses.push({ id: b.id, field: 'authors', group: grp, value, label: g.au });
      if (authorsRight(cal.authors, g)) a.calibre += 1;
      const first = file.creators
        .filter((c) => c.role === null || c.role === 'aut')
        .map((c) => c.name);
      if (authorsRight(first.slice(0, 1), g)) a.file += 1;
      if (proposals.some((p) => p.field === 'authors' && p.class === 'review')) a.review += 1;
    }
    const ill = proposals.find((p) => p.field === 'illustrator' && p.class === 'auto');
    if (ill && Array.isArray(g.il)) {
      s.illustrator.n += 1;
      if (illustratorsRight(ill.new, g)) s.illustrator.applied += 1;
    }
  }
  return s;
}

export const pct = (part: number, whole: number) => (whole > 0 ? (100 * part) / whole : null);

/** Every author-role creator of the file (for the "all creators" column of the measurement). */
export function allFileAuthorsRight(file: FileFacts, g: GoldLabel): boolean {
  return authorsRight(
    file.creators.filter((c) => c.role === null || c.role === 'aut').map((c) => c.name),
    g,
  );
}

export { fileIllustrators };
