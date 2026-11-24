/**
 * The series recap, "story so far" (book summaries session 5): the pure rules. Which volumes a
 * recap covers, what the writer gets, how its answer is checked and turned into the recap's
 * items, and the digests that say whether a recap is out of date.
 *
 * Nothing here reads a database or asks a model.
 */
import { createHash } from 'crypto';
import { namesIn } from './book-text';
import type { RecapAnswer, RecapCheckEvidence, RecapEvidence, RecapPoint } from './recap-specs';
import { RECAP_CHECK_SPEC, RECAP_SPEC } from './recap-specs';
import type { StoredItem } from './store';

export type RubyPieces = { t: string; r?: string }[];

/** One book of a series as the series page lists it, in its order. */
export interface SeriesBook {
  bookId: string;
  title: string;
  seriesIndex: number | null;
  /** Completed at least once (a finished read-through, or the status Completed now). */
  completed: boolean;
}

/** A volume the recap covers. */
export interface CoveredVolume {
  /** 1-based position among the covered volumes ("v<n>" for the models). */
  n: number;
  bookId: string;
  title: string;
  /** The series number as the page shows it ("2", "2.5"), or null. */
  label: string | null;
  /** The volume's current summary, or null (no summary). */
  summaryId: number | null;
  /** The digest of that summary's items (null without one). */
  digest: string | null;
}

/** "2" for 2, "2.5" for 2.5; null without a number. */
export function volumeLabel(index: number | null): string | null {
  if (index === null || !Number.isFinite(index)) return null;
  return Number.isInteger(index) ? String(index) : String(Math.round(index * 100) / 100);
}

/** "Vol. 2" for the models and the logs (the title when the volume has no number). */
export function volumeName(v: { label: string | null; title: string }): string {
  return v.label !== null ? `Vol. ${v.label}` : v.title;
}

/**
 * The books a recap covers: in the series page's order, up to and including the last one
 * completed at least once (a Start over never takes a volume out; nothing completed: none).
 */
export function coveredBooks(books: SeriesBook[]): SeriesBook[] {
  let last = -1;
  books.forEach((b, i) => {
    if (b.completed) last = i;
  });
  return books.slice(0, last + 1);
}

/**
 * The digest of a summary's items as the recap reads them: headings, people and texts (not the
 * relationships' diagram labels, which the recap doesn't read: the one-time label pass doesn't
 * make every recap out of date).
 */
export function summaryDigest(
  summaryId: number,
  items: StoredItem[],
  alsoMentioned: string[],
): string {
  return digestOf([
    summaryId,
    items.map((i) => [
      i.section,
      i.ref,
      i.chapterTitle ?? null,
      i.heading ?? null,
      i.between ?? null,
      i.text,
    ]),
    alsoMentioned,
  ]);
}

export function digestOf(v: unknown): string {
  return createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
}

/**
 * What a recap is made from: the series, its covered volumes in order and each one's summary.
 * The same digest: nothing to ask again.
 */
export function inputsDigest(series: string, volumes: CoveredVolume[]): string {
  return digestOf([
    series,
    volumes.map((v) => [v.bookId, v.label, v.digest]),
    RECAP_SPEC.promptVersion,
    RECAP_CHECK_SPEC.promptVersion,
  ]);
}

/** A covered volume's summary item, with where it came from. */
export interface SourceItem {
  id: string;
  n: number;
  bookId: string;
  summaryId: number;
  ref: string;
  section: string;
  heading: string | null;
  between: [string, string] | null;
  ruby: RubyPieces | null;
  betweenRuby: [RubyPieces | null, RubyPieces | null] | null;
  text: string;
}

export interface VolumeSummary {
  volume: CoveredVolume;
  items: StoredItem[];
  alsoMentioned: string[];
}

export interface RecapInput {
  evidence: RecapEvidence;
  sources: Map<string, SourceItem>;
  /** Every name and word the summaries write (headings, people, texts, also mentioned). */
  corpus: string;
}

/** The writer's evidence from the covered volumes (with and without a summary). */
export function recapInput(
  series: string,
  lang: string,
  volumes: CoveredVolume[],
  summaries: Map<string, VolumeSummary>,
): RecapInput {
  const sources = new Map<string, SourceItem>();
  const corpus: string[] = [];
  const evidence: RecapEvidence = { series, lang, volumes: [], missing: [] };
  for (const v of volumes) {
    const key = `v${v.n}`;
    const s = v.summaryId !== null ? summaries.get(v.bookId) : undefined;
    if (!s) {
      evidence.missing.push({ key, name: volumeName(v), title: v.title });
      continue;
    }
    const items = s.items.map((it) => {
      const id = `${key}:${it.ref}`;
      sources.set(id, {
        id,
        n: v.n,
        bookId: v.bookId,
        summaryId: v.summaryId!,
        ref: it.ref,
        section: it.section,
        heading: it.heading ?? null,
        between: it.between ?? null,
        ruby: it.ruby ?? null,
        betweenRuby: it.betweenRuby ?? null,
        text: it.text,
      });
      corpus.push(it.heading ?? '', ...(it.between ?? []), it.text);
      return {
        id,
        section: it.section,
        ...(it.heading ? { heading: it.heading } : {}),
        ...(it.between ? { between: it.between } : {}),
        ...(it.section === 'chapters' && it.chapterTitle ? { chapter: it.chapterTitle } : {}),
        text: it.text,
      };
    });
    corpus.push(...s.alsoMentioned);
    evidence.volumes.push({
      key,
      name: volumeName(v),
      title: v.title,
      items,
      alsoMentioned: s.alsoMentioned,
    });
  }
  return { evidence, sources, corpus: corpus.join('\n') };
}

export type RecapSectionKey =
  | 'overview'
  | 'volumes'
  | 'characters'
  | 'relationships'
  | 'terms'
  | 'threads';
export const RECAP_SECTIONS: RecapSectionKey[] = [
  'overview',
  'volumes',
  'characters',
  'relationships',
  'terms',
  'threads',
];

/** A recap point as it is stored. */
export interface RecapItem {
  ref: string;
  section: RecapSectionKey;
  /** Volume by volume: the covered volume's n. */
  volume: number | null;
  text: string;
  heading?: string;
  between?: [string, string];
  label?: string;
  ruby?: RubyPieces;
  betweenRuby?: [RubyPieces | null, RubyPieces | null];
  /** The volume summary items it rests on ("v<n>:<ref>"). */
  cites: string[];
  /** Characters, terms, threads: the covered volume it first appears in (n). */
  since: number | null;
}

export interface RecapDraft {
  items: RecapItem[];
  alsoMentioned: string[];
  dropped: { section: string; text: string; why: string }[];
}

const WORD_PART = /^(?:.{2,}|\p{Script=Han})$/u;

/**
 * Whether a name is the summaries' own (so never invented): written as it is somewhere in the
 * covered volumes' summaries, or a role built from their words (れな子の妹), as `inBook` does for
 * the book.
 */
export function inSummaries(name: string, corpus: string): boolean {
  if (!name) return false;
  if (corpus.includes(name)) return true;
  const plain = name.replace(/(?:たち|達)$/u, '');
  if (plain !== name && plain.length >= 2 && corpus.includes(plain)) return true;
  const parts = plain.split(/[のと]/u);
  return parts.length >= 2 && parts.every((p) => WORD_PART.test(p) && corpus.includes(p));
}

function clean(text: string, lang: string): string {
  let t = text.replace(/\\n/g, '\n');
  // Ids the writer left in the text: (v2:ch3.1, v3:char0) or [v2:rel1].
  t = t.replace(/\s*[（(［[]\s*(?:v\d+:[^\s,、，)）\]］]+\s*[,、，]?\s*)+[)）\]］]/g, '');
  t = t.replace(/\s*\n+\s*/g, lang === 'ja' ? '' : ' ');
  return t.trim();
}

/** The writer's answer checked and turned into the recap's items (before the check step). */
export function draftRecap(
  answer: RecapAnswer,
  input: RecapInput,
  volumes: CoveredVolume[],
): RecapDraft {
  const { sources, corpus } = input;
  const lang = input.evidence.lang;
  const dropped: RecapDraft['dropped'] = [];
  const items: RecapItem[] = [];
  const withSummary = new Set(volumes.filter((v) => v.summaryId !== null).map((v) => v.n));

  const make = (
    section: RecapSectionKey,
    ref: string,
    p: RecapPoint,
    o: { names?: string[]; volume?: number } = {},
  ): RecapItem | null => {
    let cites = [...new Set(p.cites)].filter((c) => sources.has(c));
    if (o.volume !== undefined) cites = cites.filter((c) => sources.get(c)!.n === o.volume);
    const text = clean(p.text, lang);
    if (!text || !cites.length) {
      dropped.push({ section, text: p.text, why: 'cites no item of the summaries' });
      return null;
    }
    const missing = (o.names ?? []).flatMap(namesIn).filter((n) => !inSummaries(n, corpus));
    if (missing.length) {
      dropped.push({ section, text: p.text, why: `not in the summaries: ${missing.join(', ')}` });
      return null;
    }
    return {
      ref,
      section,
      volume: o.volume ?? null,
      text,
      cites,
      since: Math.min(...cites.map((c) => sources.get(c)!.n)),
    };
  };

  const ov = make('overview', 'overview', answer.overview);
  if (ov) items.push({ ...ov, since: null });

  const byKey = new Map<string, number>(volumes.map((v) => [`v${v.n}`, v.n]));
  for (const g of answer.volumes) {
    const n = byKey.get(g.volume);
    if (n === undefined || !withSummary.has(n)) {
      for (const p of g.items)
        dropped.push({ section: 'volumes', text: p.text, why: `no summary for ${g.volume}` });
      continue;
    }
    g.items.forEach((p, i) => {
      const it = make('volumes', `vol${n}.${i}`, p, { volume: n });
      if (it) items.push({ ...it, since: null });
    });
  }

  /** The earliest volume whose own Characters or Terms entry is this heading. */
  const firstEntry = (section: 'characters' | 'terms', heading: string): number | null => {
    const names = new Set(namesIn(heading));
    let first: number | null = null;
    for (const s of sources.values()) {
      if (s.section !== section || !s.heading) continue;
      if (namesIn(s.heading).some((x) => names.has(x)) && (first === null || s.n < first))
        first = s.n;
    }
    return first;
  };
  const rubyOf = (name: string, cites: string[]): RubyPieces | null => {
    for (const c of cites) {
      const s = sources.get(c)!;
      if (s.heading === name && s.ruby) return s.ruby;
      if (s.between && s.betweenRuby) {
        if (s.between[0] === name && s.betweenRuby[0]) return s.betweenRuby[0];
        if (s.between[1] === name && s.betweenRuby[1]) return s.betweenRuby[1];
      }
    }
    // Any item of the summaries headed by that name (the cites may be events).
    for (const s of sources.values()) if (s.heading === name && s.ruby) return s.ruby;
    return null;
  };

  answer.characters.forEach((p, i) => {
    const it = make('characters', `char${i}`, p, { names: [p.name] });
    if (!it) return;
    const first = firstEntry('characters', p.name);
    const ruby = rubyOf(p.name, it.cites);
    items.push({
      ...it,
      heading: p.name,
      since: first !== null ? Math.min(first, it.since!) : it.since,
      ...(ruby ? { ruby } : {}),
    });
  });
  answer.relationships.forEach((p, i) => {
    const it = make('relationships', `rel${i}`, p, { names: [p.a, p.b] });
    if (!it) return;
    const ra = rubyOf(p.a, it.cites);
    const rb = rubyOf(p.b, it.cites);
    items.push({
      ...it,
      between: [p.a, p.b],
      since: null,
      ...(p.label ? { label: p.label.slice(0, 40) } : {}),
      ...(ra || rb ? { betweenRuby: [ra, rb] as [RubyPieces | null, RubyPieces | null] } : {}),
    });
  });
  answer.terms.forEach((p, i) => {
    const it = make('terms', `term${i}`, p, { names: [p.term] });
    if (!it) return;
    const first = firstEntry('terms', p.term);
    const ruby = rubyOf(p.term, it.cites);
    items.push({
      ...it,
      heading: p.term,
      since: first !== null ? Math.min(first, it.since!) : it.since,
      ...(ruby ? { ruby } : {}),
    });
  });
  answer.threads.forEach((p, i) => {
    const it = make('threads', `thread${i}`, p);
    if (it) items.push(it);
  });

  const alsoMentioned = answer.also_mentioned
    .map((n) => n.trim())
    .filter((n) => {
      if (!n) return false;
      if (namesIn(n).every((x) => inSummaries(x, corpus))) return true;
      dropped.push({ section: 'also_mentioned', text: n, why: 'not in the summaries' });
      return false;
    });
  return { items, alsoMentioned: [...new Set(alsoMentioned)], dropped };
}

/** Points per check question (each with its cited items). */
export const CHECK_CHUNK = 40;

/** The check step's questions: every point with the text of the items it cites. */
export function checkEvidence(
  series: string,
  draft: RecapDraft,
  sources: Map<string, SourceItem>,
  volumes: CoveredVolume[],
): { key: string; evidence: RecapCheckEvidence }[] {
  const name = new Map(volumes.map((v) => [v.n, volumeName(v)]));
  const points = draft.items.map((it) => ({
    id: it.ref,
    text: [
      it.heading ? `${it.heading}: ` : it.between ? `${it.between[0]} / ${it.between[1]}: ` : '',
      it.text,
    ].join(''),
    items: it.cites.map((c) => {
      const s = sources.get(c)!;
      const head = s.heading
        ? `${s.heading}: `
        : s.between
          ? `${s.between[0]} / ${s.between[1]}: `
          : '';
      return { id: `${c} (${name.get(s.n) ?? `v${s.n}`})`, text: `${head}${s.text}` };
    }),
  }));
  const out: { key: string; evidence: RecapCheckEvidence }[] = [];
  for (let i = 0; i < points.length; i += CHECK_CHUNK) {
    const part = points.slice(i, i + CHECK_CHUNK);
    out.push({ key: digestOf(part), evidence: { series, points: part } });
  }
  return out;
}

/**
 * Per covered volume, why the recap is out of date for it now (decision 8): the volume isn't in
 * the recap yet, it left the recap's volumes, its summary is new, gone or changed; and whether
 * the order changed.
 */
export type StaleWhy = 'not_in_recap' | 'left' | 'summary_added' | 'summary_deleted' | 'changed';
export function staleness(
  built: { bookId: string; digest: string | null }[],
  now: { bookId: string; digest: string | null }[],
): { volumes: { bookId: string; why: StaleWhy }[]; orderChanged: boolean } {
  const was = new Map(built.map((v) => [v.bookId, v.digest]));
  const is = new Map(now.map((v) => [v.bookId, v.digest]));
  const out: { bookId: string; why: StaleWhy }[] = [];
  for (const v of now) {
    if (!was.has(v.bookId)) {
      out.push({ bookId: v.bookId, why: 'not_in_recap' });
      continue;
    }
    const d = was.get(v.bookId) ?? null;
    if (d === v.digest) continue;
    out.push({
      bookId: v.bookId,
      why: d === null ? 'summary_added' : v.digest === null ? 'summary_deleted' : 'changed',
    });
  }
  for (const v of built) if (!is.has(v.bookId)) out.push({ bookId: v.bookId, why: 'left' });
  const common = now.filter((v) => was.has(v.bookId)).map((v) => v.bookId);
  const before = built.filter((v) => is.has(v.bookId)).map((v) => v.bookId);
  return { volumes: out, orderChanged: common.join('|') !== before.join('|') };
}
