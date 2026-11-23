/**
 * Book summaries: the code checks between the model steps (pure; session 2's engine).
 *
 * 1. Every extracted item's quote is looked for in this book (QuoteIndex): an item whose quote
 *    isn't there is dropped and counted. This also catches content from other books or volumes.
 * 2. Chapters the answer left without items (and didn't call "not story") are asked again with
 *    only their text.
 * 3. Two models: items both found (paired by the match step) are confirmed; an item only one
 *    found goes to the other model's support check with its passage. One model: every item goes
 *    to its own support check.
 * 4. The written summary is checked: every item cites checked items that exist, its quote comes
 *    from a cited item, and every name in a heading is written in this book.
 */
import type { BookText, QuoteIndex, RubyIndex } from './book-text';
import { cleanWritten, namesIn, passageAt } from './book-text';
import type {
  ChapterEvidence,
  ChapterSupportEvidence,
  ExtractAnswer,
  ExtractEvidence,
  MatchEvidence,
  ModelRole,
  RawItem,
  SupportEvidence,
  Verdict,
  WriteAnswer,
  WriteEvidence,
  WrittenItem,
} from './specs';
import type { CheckedItem, Summary, SummaryItem, SummarySection } from './types';

export function extractEvidence(
  title: string,
  book: BookText,
  background: string | null,
): ExtractEvidence {
  return {
    title,
    chapters: book.chapters.map((c) => ({ index: c.index, title: c.title, text: c.text })),
    background,
  };
}

export function chapterEvidence(
  title: string,
  book: BookText,
  chapter: number,
  background: string | null,
): ChapterEvidence {
  const c = book.chapters[chapter];
  return { title, chapter: { index: c.index, title: c.title, text: c.text }, background };
}

export interface ExtractCheck {
  items: CheckedItem[];
  quoteNotFound: number;
  /** Extracted before the quote check. */
  extracted: number;
  /** Chapters the whole-book answer left empty (asked again). */
  emptyChapters: number[];
  notStory: number[];
  /** Quotes dropped, for the report: [chapter, quote]. */
  droppedQuotes: { chapter: number; text: string; quote: string }[];
}

/** Chapters of a whole-book answer that have no items and weren't called "not story". */
export function emptyChapters(book: BookText, answer: ExtractAnswer): number[] {
  const seen = new Map<number, { items: number; notStory: boolean }>();
  for (const c of answer.chapters) {
    const s = seen.get(c.chapter) ?? { items: 0, notStory: false };
    s.items += c.items.length;
    s.notStory ||= c.not_story;
    seen.set(c.chapter, s);
  }
  return book.chapters
    .filter((c) => {
      const s = seen.get(c.index);
      return !s || (s.items === 0 && !s.notStory);
    })
    .map((c) => c.index);
}

/**
 * The quote check of one model's answers (the whole-book answer plus the chapters asked again).
 * Item ids follow the answer's order, so the same answers give the same ids.
 */
export function checkExtraction(
  role: ModelRole,
  model: string,
  book: BookText,
  index: QuoteIndex,
  whole: ExtractAnswer,
  followUps: Map<number, { not_story: boolean; items: RawItem[] }>,
): ExtractCheck {
  const empty = emptyChapters(book, whole);
  const notStory = new Set<number>();
  const perChapter = new Map<number, RawItem[]>();
  for (const c of whole.chapters) {
    if (c.chapter < 0 || c.chapter >= book.chapters.length) continue;
    if (c.not_story) notStory.add(c.chapter);
    perChapter.set(c.chapter, [...(perChapter.get(c.chapter) ?? []), ...c.items]);
  }
  for (const ch of empty) {
    const f = followUps.get(ch);
    if (!f) continue;
    if (f.not_story) notStory.add(ch);
    perChapter.set(ch, f.items);
  }
  const out: ExtractCheck = {
    items: [],
    quoteNotFound: 0,
    extracted: 0,
    emptyChapters: empty,
    notStory: [...notStory].sort((a, b) => a - b),
    droppedQuotes: [],
  };
  for (const ch of [...perChapter.keys()].sort((a, b) => a - b)) {
    let n = 0;
    for (const raw of perChapter.get(ch)!) {
      out.extracted++;
      const id = `${role}:${ch}:${n++}`;
      const hit = index.find(raw.quote, ch);
      if (!hit) {
        out.quoteNotFound++;
        out.droppedQuotes.push({ chapter: ch, text: raw.text, quote: raw.quote });
        continue;
      }
      out.items.push({
        id,
        model,
        chapter: hit.chapter,
        kind: raw.kind,
        text: raw.text,
        quote: raw.quote,
        names: raw.names.filter((nm) => index.hasName(nm)),
        position: hit.position,
      });
    }
  }
  return out;
}

export function matchEvidence(title: string, a: CheckedItem[], b: CheckedItem[]): MatchEvidence {
  const short = (x: CheckedItem) => ({ id: x.id, chapter: x.chapter, text: x.text });
  return { title, a: a.map(short), b: b.map(short) };
}

/** Pairs as the match step gave them, kept only one-to-one and between existing items. */
export function cleanPairs(
  pairs: { a: string; b: string }[],
  a: CheckedItem[],
  b: CheckedItem[],
): { a: string; b: string }[] {
  const aIds = new Set(a.map((x) => x.id));
  const bIds = new Set(b.map((x) => x.id));
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  const out: { a: string; b: string }[] = [];
  for (const p of pairs) {
    if (!aIds.has(p.a) || !bIds.has(p.b) || usedA.has(p.a) || usedB.has(p.b)) continue;
    usedA.add(p.a);
    usedB.add(p.b);
    out.push(p);
  }
  return out;
}

/** Claims to check, grouped by chapter, at most `perRequest` per request. */
export function supportEvidence(
  title: string,
  book: BookText,
  items: CheckedItem[],
  perRequest = 40,
): { key: string; evidence: SupportEvidence }[] {
  const byChapter = new Map<number, CheckedItem[]>();
  for (const x of items) byChapter.set(x.chapter, [...(byChapter.get(x.chapter) ?? []), x]);
  const out: { key: string; evidence: SupportEvidence }[] = [];
  for (const ch of [...byChapter.keys()].sort((a, b) => a - b)) {
    const list = byChapter.get(ch)!;
    for (let i = 0; i < list.length; i += perRequest) {
      const part = list.slice(i, i + perRequest);
      out.push({
        key: `${ch}.${i / perRequest}`,
        evidence: {
          title,
          claims: part.map((x) => ({
            id: x.id,
            text: x.text,
            passage: passageAt(book, x.position),
          })),
        },
      });
    }
  }
  return out;
}

/** Claims to check again against their whole chapter, one request per chapter (sorted, stable). */
export function chapterSupportEvidence(
  title: string,
  book: BookText,
  items: CheckedItem[],
): { key: string; evidence: ChapterSupportEvidence }[] {
  const byChapter = new Map<number, CheckedItem[]>();
  for (const x of items) byChapter.set(x.chapter, [...(byChapter.get(x.chapter) ?? []), x]);
  return [...byChapter.keys()]
    .sort((a, b) => a - b)
    .map((ch) => {
      const c = book.chapters[ch];
      const list = [...byChapter.get(ch)!].sort((x, y) => cmp(x.id, y.id));
      return {
        key: `ch${ch}`,
        evidence: {
          title,
          chapter: { index: c.index, title: c.title, text: c.text },
          claims: list.map((x) => ({ id: x.id, text: x.text })),
        },
      };
    });
}

export interface CrossCheck {
  /** The items the writer gets. */
  items: CheckedItem[];
  confirmed: number;
  /** Items sent to the support check. */
  checked: number;
  supported: number;
  partly: number;
  notSupported: number;
  /** A verdict the check didn't give (left out, counted). */
  noVerdict: number;
}

/**
 * The items that pass. Two models: each pair once (model A's wording), plus single items the
 * other model's check supported. One model (b empty, pairs empty): its items its check supported.
 */
export function crossChecked(
  a: CheckedItem[],
  b: CheckedItem[],
  pairs: { a: string; b: string }[],
  verdicts: Map<string, Verdict>,
): CrossCheck {
  const pairedA = new Set(pairs.map((p) => p.a));
  const pairedB = new Set(pairs.map((p) => p.b));
  const out: CrossCheck = {
    items: [],
    confirmed: pairs.length,
    checked: 0,
    supported: 0,
    partly: 0,
    notSupported: 0,
    noVerdict: 0,
  };
  const single = [...a.filter((x) => !pairedA.has(x.id)), ...b.filter((x) => !pairedB.has(x.id))];
  for (const x of a) if (pairedA.has(x.id)) out.items.push(x);
  for (const x of single) {
    out.checked++;
    const v = verdicts.get(x.id);
    if (v === 'supported') {
      out.supported++;
      out.items.push(x);
    } else if (v === 'partly') out.partly++;
    else if (v === 'not_supported') out.notSupported++;
    else out.noVerdict++;
  }
  out.items.sort((x, y) => x.chapter - y.chapter || x.position - y.position || cmp(x.id, y.id));
  return out;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function writeEvidence(
  title: string,
  book: BookText,
  items: CheckedItem[],
  background: string | null,
): WriteEvidence {
  return {
    title,
    chapters: book.chapters.map((c) => ({ index: c.index, title: c.title })),
    items: items.map((x) => ({
      id: x.id,
      chapter: x.chapter,
      kind: x.kind,
      text: x.text,
      quote: x.quote,
    })),
    background,
  };
}

export interface WrittenCheck {
  summary: Summary;
  dropped: number;
  droppedItems: { section: string; text: string; why: string }[];
}

/** Checks the writer's answer and turns it into the summary the app shows. */
export function checkWritten(
  answer: WriteAnswer,
  items: CheckedItem[],
  book: BookText,
  index: QuoteIndex,
  meta: { lang: string; title: string; models: string[]; madeAt: number },
  ruby: RubyIndex | null = null,
): WrittenCheck {
  const byId = new Map(items.map((x) => [x.id, x]));
  const dropped: WrittenCheck['droppedItems'] = [];
  const make = (
    section: string,
    ref: string,
    w: WrittenItem,
    names: string[],
    extra: Partial<SummaryItem>,
  ): SummaryItem | null => {
    const cites = w.cites.filter((c) => byId.has(c));
    const text = cleanWritten(w.text, meta.lang, false);
    if (!text || cites.length === 0) {
      dropped.push({ section, text: w.text, why: 'cites no checked item' });
      return null;
    }
    const missing = names.flatMap(namesIn).filter((n) => !index.hasName(n));
    if (missing.length) {
      dropped.push({ section, text: w.text, why: `not in the book: ${missing.join(', ')}` });
      return null;
    }
    const from = cites.includes(w.quote_from) ? byId.get(w.quote_from)! : null;
    return {
      ref,
      text,
      cites,
      quote: from ? from.quote : null,
      position: from ? from.position : null,
      showQuote: !!from && w.show_quote,
      ...extra,
    };
  };
  const sections: SummarySection[] = [];
  const ovCites = answer.overview.cites.filter((c) => byId.has(c));
  const ovText = cleanWritten(answer.overview.text, meta.lang, true);
  if (ovText)
    sections.push({
      key: 'overview',
      groups: [
        {
          items: [
            {
              ref: 'overview',
              text: ovText,
              cites: ovCites,
              quote: null,
              position: null,
              showQuote: false,
            },
          ],
        },
      ],
    });
  const chGroups: SummarySection['groups'] = [];
  for (const c of [...answer.chapters].sort((x, y) => x.chapter - y.chapter)) {
    const ch = book.chapters[c.chapter];
    if (!ch) continue;
    const its = c.items
      .map((w, i) => make('chapters', `ch${c.chapter}.${i}`, w, [], {}))
      .filter((x): x is SummaryItem => !!x);
    if (its.length) chGroups.push({ chapter: c.chapter, title: ch.title, items: its });
  }
  if (chGroups.length) sections.push({ key: 'chapters', groups: chGroups });
  const one = (key: SummarySection['key'], its: (SummaryItem | null)[]) => {
    const ok = its.filter((x): x is SummaryItem => !!x);
    if (ok.length) sections.push({ key, groups: [{ items: ok }] });
  };
  one(
    'characters',
    answer.characters.map((w, i) =>
      make('characters', `char${i}`, w, [w.name], {
        heading: w.name,
        ...(ruby?.pieces(w.name) ? { ruby: ruby.pieces(w.name)! } : {}),
      }),
    ),
  );
  one(
    'relationships',
    answer.relationships.map((w, i) =>
      make('relationships', `rel${i}`, w, [w.a, w.b], {
        between: [w.a, w.b],
        ...(ruby && (ruby.pieces(w.a) || ruby.pieces(w.b))
          ? { betweenRuby: [ruby.pieces(w.a), ruby.pieces(w.b)] as SummaryItem['betweenRuby'] }
          : {}),
      }),
    ),
  );
  one(
    'terms',
    answer.terms.map((w, i) =>
      make('terms', `term${i}`, w, [w.term], {
        heading: w.term,
        // Terms may take the dictionary's reading; names never do (帝人 is みかど, not ていじん).
        ...(ruby?.pieces(w.term, { dictionary: true })
          ? { ruby: ruby.pieces(w.term, { dictionary: true })! }
          : {}),
      }),
    ),
  );
  one(
    'threads',
    answer.threads.map((w, i) => make('threads', `thread${i}`, w, [], {})),
  );
  const alsoMentioned = answer.also_mentioned.filter((n) => {
    if (index.hasName(n)) return true;
    dropped.push({ section: 'also_mentioned', text: n, why: 'not in the book' });
    return false;
  });
  return {
    summary: {
      lang: meta.lang,
      bookTitle: meta.title,
      models: meta.models,
      madeAt: meta.madeAt,
      sections,
      alsoMentioned,
    },
    dropped: dropped.length,
    droppedItems: dropped,
  };
}

/** What the translation step gets: each item's text and heading (relationships "A / B"). */
export function translationItems(
  s: Summary,
): { ref: string; heading: string | null; text: string }[] {
  return summaryItems(s).map(({ item }) => ({
    ref: item.ref,
    heading: item.heading ?? (item.between ? `${item.between[0]} / ${item.between[1]}` : null),
    text: item.text,
  }));
}

/** Every item of a summary in order (for translation, claims and the judging page). */
export function summaryItems(s: Summary): { section: string; item: SummaryItem }[] {
  const out: { section: string; item: SummaryItem }[] = [];
  for (const sec of s.sections)
    for (const g of sec.groups) for (const it of g.items) out.push({ section: sec.key, item: it });
  return out;
}

/**
 * A translation applied item by item: texts replaced, quotes kept as they are, and the headings
 * of Characters and Terms as "Translated (original)".
 */
export function applyTranslation(
  s: Summary,
  lang: string,
  items: { ref: string; heading: string; text: string }[],
): { summary: Summary; missing: string[] } {
  const by = new Map(items.map((x) => [x.ref, x]));
  const missing: string[] = [];
  const sections = s.sections.map((sec) => ({
    ...sec,
    groups: sec.groups.map((g) => ({
      ...g,
      items: g.items.map((it) => {
        const t = by.get(it.ref);
        if (!t) {
          missing.push(it.ref);
          return it;
        }
        const heading =
          it.heading && (sec.key === 'characters' || sec.key === 'terms')
            ? t.heading && t.heading !== it.heading
              ? `${t.heading} (${it.heading})`
              : it.heading
            : it.heading;
        const parts = t.heading.split(' / ');
        const between: [string, string] | undefined =
          it.between && parts.length === 2 ? [parts[0].trim(), parts[1].trim()] : it.between;
        const { ruby: _r, betweenRuby: _b, ...rest } = it;
        void _r;
        void _b;
        return { ...rest, text: t.text, heading, between };
      }),
    })),
  }));
  return { summary: { ...s, lang, sections }, missing };
}
