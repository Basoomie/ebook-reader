/**
 * Stage 5's evidence for one book (WP20f), from what stage 4 stored: nothing is fetched or read
 * again. The genre test's fields (title, authors, format, the description, the store categories,
 * the opening text without a description) plus the store notes, and for the rules the accepted
 * RanobeDB match's series tags.
 */
import { N } from '../title-rules';
import type { Stage2Book } from '../stage2-snapshot';
import { chooseDescription, cleanDescription } from '../stage4/desc';
import type { RefRecord } from '../stage4/rules-v3';
import type { Stage4Decision } from '../stage4/stage4-rules';
import { STAGE5_EVIDENCE_VERSION, type Stage5Evidence } from './prompt';

/** Stage 5's evidence object: what the models see, plus what the rules use. */
export interface Stage5Item extends Stage5Evidence {
  /** The accepted RanobeDB match's series tags (null = no accepted match). Not in the prompt. */
  ranobedb_tags: { name: string; type: string | null }[] | null;
  /** The identified Amazon record's categories alone (the store rules read these). */
  amazon_categories: string[];
}

/** Store category lines that say nothing about the book (the test left them out too). */
const NOISE = (c: string) => c === '本' || /売れ筋ランキングを見る$/.test(c);

const uniq = (l: string[]) => [...new Set(l.map((x) => x.trim()).filter((x) => x !== ''))];

/** Calibre's description is HTML: plain text for the models. */
export function plainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface EvidenceInputs {
  book: Pick<Stage2Book, 'title' | 'authors'>;
  /** Stage 4's sources as fetched (Amazon's own page). */
  base: RefRecord;
  /** The record the rules read (BOOK☆WALKER standing in for Amazon where it settled the book). */
  record: RefRecord;
  decision: Stage4Decision;
  /** Calibre's description now (what stage 4 wrote, or kept). */
  comments: string | null;
  /** Stage 4's decided format. */
  format: string | null;
  /** Both models said Amazon's record is this book (stage 4's description case). */
  modelsSayAmazon: boolean;
}

export function stage5Evidence(i: EvidenceInputs): Stage5Item {
  const d = i.decision;
  const standin = (i.base.amazon as { standin?: string } | null | undefined)?.standin;
  const product = i.base.amazon?.product ?? null;
  const amazon =
    product && d.trace.amazonIdentified && !standin && !d.amazonRejected
      ? uniq([...(product.breadcrumbs ?? []), ...(product.rank_categories ?? [])]).filter(
          (c) => !NOISE(c),
        )
      : [];
  // BOOK☆WALKER's tags, where its page is this book (stage 4's identifier rule: its cleaned
  // title is the book's title).
  const bw = i.base.bookwalker?.detail as { tags?: unknown } | null | undefined;
  const bwOk = !!d.trace.cleaned.bookwalker && N(d.trace.cleaned.bookwalker) === N(i.book.title);
  const bwTags =
    bwOk && Array.isArray(bw?.tags)
      ? bw!.tags.filter((t): t is string => typeof t === 'string')
      : [];
  // The description stage 4 chose (cleaned), else Calibre's own; the removed lines as notes.
  const chosen = chooseDescription(i.record, i.modelsSayAmazon && !d.amazonRejected);
  let description: string | null = null;
  let notes: string[] = [];
  if (chosen.text) {
    const c = cleanDescription(chosen.text);
    description = c.text.trim() || null;
    notes = c.removed.map((r) => r.line.trim()).filter((l) => l !== '');
  }
  if (!description && i.comments) description = plainText(i.comments) || null;
  const front = (i.base.file?.front_text ?? '').trim();
  const rb = i.base.ranobedb as
    | { series?: { tags?: { name?: unknown; type?: unknown }[] } | null }
    | null
    | undefined;
  const ranobedbTags =
    d.trace.ranobedbIdentified && Array.isArray(rb?.series?.tags)
      ? rb!.series!.tags!.flatMap((t) =>
          typeof t.name === 'string'
            ? [{ name: t.name, type: typeof t.type === 'string' ? t.type : null }]
            : [],
        )
      : null;
  return {
    v: STAGE5_EVIDENCE_VERSION,
    title: i.book.title,
    authors: i.book.authors,
    format: i.format,
    description,
    store_categories: uniq([...amazon, ...bwTags]),
    opening_text: description ? null : front ? Array.from(front).slice(0, 600).join('') : null,
    store_notes: notes,
    ranobedb_tags: ranobedbTags,
    amazon_categories: amazon,
  };
}

/** Where an adaptation statement must be (description, store notes, categories). */
export function adaptationText(e: Stage5Item): string {
  return [e.description ?? '', ...e.store_notes, ...e.store_categories].join('\n');
}
