/**
 * Book summaries stored as items (book summaries session 3; book-summaries.md "Summaries on the
 * server"): each version of a book's summary, its items with their evidence quote, position and
 * whether the quote is shown, the user's edits, and the translations item by item.
 *
 * Only summaries.db; nothing here asks a model or reads a book.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import type { Summary, SummaryItem, SummarySection } from './types';

export type SectionKey = SummarySection['key'];
export const SECTION_ORDER: SectionKey[] = [
  'overview',
  'chapters',
  'characters',
  'relationships',
  'terms',
  'threads',
];

export type Origin = 'ai' | 'user' | 'import';

export interface SummaryMeta {
  id: number;
  bookId: string;
  state: 'current' | 'earlier';
  origin: Origin;
  setup: string | null;
  models: string[];
  background: boolean;
  lang: string;
  bookTitle: string;
  madeAt: number;
  createdAt: number;
  replacedAt: number | null;
  editedAt: number | null;
  jobId: number | null;
  note: string | null;
}

/** An item as the app shows it: the engine's item plus its id and the user's marks. */
export interface StoredItem extends SummaryItem {
  id: number;
  section: SectionKey;
  chapter: number | null;
  chapterTitle: string | null;
  editedByUser: boolean;
  addedByUser: boolean;
}

/** A stored summary in one language (the book's or a translation). */
export interface StoredSummary extends SummaryMeta {
  /** The language of this view ("ja", "en", ...); `lang` is the book's. */
  viewLang: string;
  sections: {
    key: SectionKey;
    groups: { chapter?: number; title?: string; items: StoredItem[] }[];
  }[];
  alsoMentioned: string[];
  /** Items of a translation still waiting for theirs (shown in the original). */
  untranslated: string[];
  /** The languages saved for the book (the book's own is always there). */
  languages: string[];
}

interface MetaRow {
  id: number;
  book_id: string;
  state: 'current' | 'earlier';
  origin: Origin;
  setup: string | null;
  models_json: string;
  background: number;
  lang: string;
  book_title: string;
  also_mentioned_json: string;
  made_at: number;
  created_at: number;
  replaced_at: number | null;
  edited_at: number | null;
  job_id: number | null;
  note: string | null;
}

interface ItemRow {
  id: number;
  summary_id: number;
  section: SectionKey;
  ord: number;
  chapter: number | null;
  chapter_title: string | null;
  ref: string;
  heading: string | null;
  between_json: string | null;
  ruby_json: string | null;
  between_ruby_json: string | null;
  text: string;
  cites_json: string;
  quote: string | null;
  position: number | null;
  show_quote: number;
  edited_by_user: number;
  added_by_user: number;
  edited_at: number | null;
}

function meta(r: MetaRow): SummaryMeta {
  return {
    id: r.id,
    bookId: r.book_id,
    state: r.state,
    origin: r.origin,
    setup: r.setup,
    models: JSON.parse(r.models_json) as string[],
    background: r.background === 1,
    lang: r.lang,
    bookTitle: r.book_title,
    madeAt: r.made_at,
    createdAt: r.created_at,
    replacedAt: r.replaced_at,
    editedAt: r.edited_at,
    jobId: r.job_id,
    note: r.note,
  };
}

function item(r: ItemRow): StoredItem {
  return {
    id: r.id,
    ref: r.ref,
    section: r.section,
    chapter: r.chapter,
    chapterTitle: r.chapter_title,
    text: r.text,
    ...(r.heading !== null ? { heading: r.heading } : {}),
    ...(r.between_json ? { between: JSON.parse(r.between_json) as [string, string] } : {}),
    ...(r.ruby_json ? { ruby: JSON.parse(r.ruby_json) as SummaryItem['ruby'] } : {}),
    ...(r.between_ruby_json
      ? { betweenRuby: JSON.parse(r.between_ruby_json) as SummaryItem['betweenRuby'] }
      : {}),
    cites: JSON.parse(r.cites_json) as string[],
    quote: r.quote,
    position: r.position,
    showQuote: r.show_quote === 1,
    editedByUser: r.edited_by_user === 1,
    addedByUser: r.added_by_user === 1,
  };
}

/** What a translation is made from: an item's heading, people and text. */
export function itemDigest(x: {
  heading?: string | null;
  between?: [string, string] | null;
  text: string;
}): string {
  return createHash('sha1')
    .update(`${x.heading ?? ''}\u0001${x.between ? x.between.join('\u0002') : ''}\u0001${x.text}`)
    .digest('hex')
    .slice(0, 16);
}

/** The "also mentioned" line as one translatable item. */
export const ALSO_REF = '@also';

export class EditError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A new item the user adds or a changed one: only these fields come from the user. */
export interface ItemInput {
  text: string;
  heading?: string | null;
  between?: [string, string] | null;
  /** Chapter by chapter: the chapter the item belongs to. */
  chapter?: number | null;
  chapterTitle?: string | null;
}

const MAX_TEXT = 4000;

function cleanText(v: unknown, name = 'text'): string {
  if (typeof v !== 'string') throw new EditError(400, 'invalid', `${name} must be text`);
  const t = v.replace(/\r\n?/g, '\n').trim();
  if (!t) throw new EditError(400, 'invalid', `${name} can't be empty`);
  if (t.length > MAX_TEXT)
    throw new EditError(400, 'invalid', `${name} must be at most ${MAX_TEXT} characters`);
  return t;
}

function cleanOptional(v: unknown, name: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  return cleanText(v, name).slice(0, 300);
}

export class SummaryStore {
  constructor(
    readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  // ------------------------------------------------------------------------------------------
  // reading

  currentMeta(bookId: string): SummaryMeta | null {
    const r = this.db
      .prepare(`SELECT * FROM summaries WHERE book_id = ? AND state = 'current'`)
      .get(bookId) as MetaRow | undefined;
    return r ? meta(r) : null;
  }

  metaById(id: number): SummaryMeta | null {
    const r = this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as
      | MetaRow
      | undefined;
    return r ? meta(r) : null;
  }

  /** Every version of a book's summary, newest first (the current one included). */
  versions(bookId: string): SummaryMeta[] {
    return (
      this.db
        .prepare(`SELECT * FROM summaries WHERE book_id = ? ORDER BY created_at DESC, id DESC`)
        .all(bookId) as MetaRow[]
    ).map(meta);
  }

  items(summaryId: number): StoredItem[] {
    return (
      this.db
        .prepare(`SELECT * FROM summary_items WHERE summary_id = ? ORDER BY ord, id`)
        .all(summaryId) as ItemRow[]
    )
      .map(item)
      .sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section));
  }

  alsoMentioned(summaryId: number): string[] {
    const r = this.db
      .prepare('SELECT also_mentioned_json FROM summaries WHERE id = ?')
      .get(summaryId) as { also_mentioned_json: string } | undefined;
    return r ? (JSON.parse(r.also_mentioned_json) as string[]) : [];
  }

  languages(bookId: string, bookLang: string): string[] {
    const saved = (
      this.db
        .prepare('SELECT lang FROM summary_book_languages WHERE book_id = ? ORDER BY added_at')
        .all(bookId) as { lang: string }[]
    ).map((r) => r.lang);
    return [bookLang, ...saved.filter((l) => l !== bookLang)];
  }

  addLanguage(bookId: string, lang: string): void {
    this.db
      .prepare(
        `INSERT INTO summary_book_languages (book_id, lang, added_at) VALUES (?, ?, ?)
         ON CONFLICT(book_id, lang) DO NOTHING`,
      )
      .run(bookId, lang, this.now());
  }

  /** A summary as the app shows it, in the book's language or a translation. */
  view(summaryId: number, lang?: string): StoredSummary | null {
    const m = this.metaById(summaryId);
    if (!m) return null;
    const viewLang = lang && lang !== m.lang ? lang : m.lang;
    let items = this.items(summaryId);
    let also = this.alsoMentioned(summaryId);
    const untranslated: string[] = [];
    if (viewLang !== m.lang) {
      const t = this.translations(summaryId, viewLang);
      items = items.map((it) => {
        const tr = t.get(it.ref);
        if (!tr || tr.source_digest !== itemDigest(it)) {
          untranslated.push(it.ref);
          return it;
        }
        const { ruby: _r, betweenRuby: _b, ...rest } = it;
        void _r;
        void _b;
        return {
          ...rest,
          text: tr.text,
          ...(it.heading !== undefined ? { heading: tr.heading ?? it.heading } : {}),
          ...(it.between
            ? {
                between: tr.between_json
                  ? (JSON.parse(tr.between_json) as [string, string])
                  : it.between,
              }
            : {}),
        };
      });
      const a = t.get(ALSO_REF);
      if (also.length) {
        if (a && a.source_digest === itemDigest({ text: also.join('\n') }))
          also = a.text.split('\n').filter(Boolean);
        else untranslated.push(ALSO_REF);
      }
    }
    return {
      ...m,
      viewLang,
      sections: groupSections(items),
      alsoMentioned: also,
      untranslated,
      languages: this.languages(m.bookId, m.lang),
    };
  }

  /** The summary in the engine's own shape (book language): background, translation. */
  asSummary(summaryId: number): Summary | null {
    const v = this.view(summaryId);
    if (!v) return null;
    return {
      lang: v.lang,
      bookTitle: v.bookTitle,
      models: v.models,
      madeAt: v.madeAt,
      sections: v.sections,
      alsoMentioned: v.alsoMentioned,
    };
  }

  translations(
    summaryId: number,
    lang: string,
  ): Map<
    string,
    { heading: string | null; between_json: string | null; text: string; source_digest: string }
  > {
    const rows = this.db
      .prepare(
        `SELECT ref, heading, between_json, text, source_digest FROM summary_translations
         WHERE summary_id = ? AND lang = ?`,
      )
      .all(summaryId, lang) as {
      ref: string;
      heading: string | null;
      between_json: string | null;
      text: string;
      source_digest: string;
    }[];
    return new Map(rows.map((r) => [r.ref, r]));
  }

  /**
   * The items a translation still needs (missing, or made from an item since changed), and the
   * ones it has that no longer exist (deleted items), which are dropped.
   */
  translationNeeds(
    summaryId: number,
    lang: string,
  ): { ref: string; heading: string | null; text: string; digest: string }[] {
    const have = this.translations(summaryId, lang);
    const out: { ref: string; heading: string | null; text: string; digest: string }[] = [];
    const refs = new Set<string>();
    for (const it of this.items(summaryId)) {
      refs.add(it.ref);
      const digest = itemDigest(it);
      if (have.get(it.ref)?.source_digest === digest) continue;
      out.push({
        ref: it.ref,
        heading: it.heading ?? (it.between ? `${it.between[0]} / ${it.between[1]}` : null),
        text: it.text,
        digest,
      });
    }
    const also = this.alsoMentioned(summaryId);
    if (also.length) {
      refs.add(ALSO_REF);
      const digest = itemDigest({ text: also.join('\n') });
      if (have.get(ALSO_REF)?.source_digest !== digest)
        out.push({ ref: ALSO_REF, heading: null, text: also.join('\n'), digest });
    }
    const gone = [...have.keys()].filter((r) => !refs.has(r));
    if (gone.length) {
      const del = this.db.prepare(
        'DELETE FROM summary_translations WHERE summary_id = ? AND lang = ? AND ref = ?',
      );
      for (const r of gone) del.run(summaryId, lang, r);
    }
    return out;
  }

  /** Saves translated items (headings of Characters and Terms as "Translated (original)"). */
  saveTranslations(
    summaryId: number,
    lang: string,
    model: string,
    made: { ref: string; heading: string; text: string; digest: string }[],
  ): void {
    const items = new Map(this.items(summaryId).map((i) => [i.ref, i]));
    const up = this.db.prepare(
      `INSERT INTO summary_translations (summary_id, lang, ref, heading, between_json, text, source_digest, model, made_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(summary_id, lang, ref) DO UPDATE SET heading = excluded.heading,
         between_json = excluded.between_json, text = excluded.text,
         source_digest = excluded.source_digest, model = excluded.model, made_at = excluded.made_at`,
    );
    const now = this.now();
    this.db.transaction(() => {
      for (const t of made) {
        if (t.ref === ALSO_REF) {
          up.run(summaryId, lang, t.ref, null, null, t.text, t.digest, model, now);
          continue;
        }
        const it = items.get(t.ref);
        if (!it) continue;
        let heading: string | null = null;
        let between: [string, string] | null = null;
        if (it.between) {
          const parts = t.heading.split(' / ');
          between = parts.length === 2 ? [parts[0].trim(), parts[1].trim()] : it.between;
        } else if (it.heading) {
          // Proper nouns: the original spelling in brackets, only in these headings (user).
          heading =
            (it.section === 'characters' || it.section === 'terms') &&
            t.heading &&
            t.heading !== it.heading
              ? `${t.heading} (${it.heading})`
              : t.heading || it.heading;
        }
        up.run(
          summaryId,
          lang,
          t.ref,
          heading,
          between ? JSON.stringify(between) : null,
          t.text,
          t.digest,
          model,
          now,
        );
      }
    })();
  }

  // ------------------------------------------------------------------------------------------
  // writing

  /**
   * Stores a summary as a new version. `current`: it becomes the book's current summary (the
   * current one becomes an earlier version); else it is stored as an earlier version.
   */
  save(
    bookId: string,
    s: Summary,
    o: {
      origin: Origin;
      setup: string | null;
      background: boolean;
      current: boolean;
      jobId?: number | null;
      report?: unknown;
      note?: string | null;
      madeAt?: number;
      /** Items the user changed or added (Write my own: every item). */
      byUser?: boolean;
    },
  ): number {
    const now = this.now();
    return this.db.transaction(() => {
      if (o.current)
        this.db
          .prepare(
            `UPDATE summaries SET state = 'earlier', replaced_at = ? WHERE book_id = ? AND state = 'current'`,
          )
          .run(now, bookId);
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO summaries (book_id, state, origin, setup, models_json, background, lang,
               book_title, also_mentioned_json, made_at, created_at, replaced_at, job_id, report_json, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            bookId,
            o.current ? 'current' : 'earlier',
            o.origin,
            o.setup,
            JSON.stringify(s.models),
            o.background ? 1 : 0,
            s.lang,
            s.bookTitle,
            JSON.stringify(s.alsoMentioned ?? []),
            o.madeAt ?? s.madeAt ?? now,
            now,
            o.current ? null : now,
            o.jobId ?? null,
            o.report === undefined ? null : JSON.stringify(o.report),
            o.note ?? null,
          ).lastInsertRowid,
      );
      this.insertItems(id, s.sections, o.byUser === true);
      return id;
    })();
  }

  private insertItems(summaryId: number, sections: SummarySection[], byUser: boolean): void {
    const ins = this.db.prepare(
      `INSERT INTO summary_items (summary_id, section, ord, chapter, chapter_title, ref, heading,
         between_json, ruby_json, between_ruby_json, text, cites_json, quote, position, show_quote,
         edited_by_user, added_by_user, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    const seen = new Set<string>();
    let ord = 0;
    for (const sec of sections) {
      if (!SECTION_ORDER.includes(sec.key)) continue;
      for (const g of sec.groups)
        for (const it of g.items) {
          let ref = it.ref;
          while (seen.has(ref)) ref = `${it.ref}~${ord}`;
          seen.add(ref);
          ins.run(
            summaryId,
            sec.key,
            ord++,
            g.chapter ?? null,
            g.title ?? null,
            ref,
            it.heading ?? null,
            it.between ? JSON.stringify(it.between) : null,
            it.ruby ? JSON.stringify(it.ruby) : null,
            it.betweenRuby ? JSON.stringify(it.betweenRuby) : null,
            it.text,
            JSON.stringify(it.cites ?? []),
            it.quote ?? null,
            it.position ?? null,
            it.showQuote && it.quote ? 1 : 0,
            byUser ? 1 : 0,
            byUser ? this.now() : null,
          );
        }
    }
  }

  private requireCurrent(bookId: string): SummaryMeta {
    const m = this.currentMeta(bookId);
    if (!m) throw new EditError(404, 'no_summary', 'This book has no summary');
    return m;
  }

  private touch(summaryId: number): void {
    this.db.prepare('UPDATE summaries SET edited_at = ? WHERE id = ?').run(this.now(), summaryId);
  }

  /** Changes one item of the current summary (marked as changed by the user). */
  editItem(bookId: string, itemId: number, input: Partial<ItemInput>): StoredItem {
    const m = this.requireCurrent(bookId);
    const row = this.db
      .prepare('SELECT * FROM summary_items WHERE id = ? AND summary_id = ?')
      .get(itemId, m.id) as ItemRow | undefined;
    if (!row) throw new EditError(404, 'no_item', 'No such item in this summary');
    const text = cleanText(input.text);
    let heading = row.heading;
    let rubyJson = row.ruby_json;
    if (input.heading !== undefined && row.heading !== null) {
      const h = cleanOptional(input.heading, 'heading');
      if (!h) throw new EditError(400, 'invalid', 'This item needs its heading');
      if (h !== row.heading) {
        heading = h;
        // The book's furigana belonged to the old heading.
        rubyJson = null;
      }
    }
    let betweenJson = row.between_json;
    let betweenRubyJson = row.between_ruby_json;
    if (input.between !== undefined && row.between_json) {
      const b = input.between;
      if (!Array.isArray(b) || b.length !== 2)
        throw new EditError(400, 'invalid', 'A relationship is between two people');
      const pair: [string, string] = [
        cleanText(b[0], 'name').slice(0, 200),
        cleanText(b[1], 'name').slice(0, 200),
      ];
      if (JSON.stringify(pair) !== row.between_json) {
        betweenJson = JSON.stringify(pair);
        betweenRubyJson = null;
      }
    }
    if (text === row.text && heading === row.heading && betweenJson === row.between_json)
      return item(row);
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE summary_items SET text = ?, heading = ?, ruby_json = ?, between_json = ?,
             between_ruby_json = ?, edited_by_user = 1, edited_at = ? WHERE id = ?`,
        )
        .run(text, heading, rubyJson, betweenJson, betweenRubyJson, this.now(), itemId);
      this.touch(m.id);
    })();
    return item(this.db.prepare('SELECT * FROM summary_items WHERE id = ?').get(itemId) as ItemRow);
  }

  /** The overview is edited as one text. */
  editOverview(bookId: string, text: string): StoredItem {
    const m = this.requireCurrent(bookId);
    const row = this.db
      .prepare(`SELECT id FROM summary_items WHERE summary_id = ? AND section = 'overview'`)
      .get(m.id) as { id: number } | undefined;
    if (row) return this.editItem(bookId, row.id, { text });
    return this.addItem(bookId, 'overview', { text });
  }

  deleteItem(bookId: string, itemId: number): void {
    const m = this.requireCurrent(bookId);
    this.db.transaction(() => {
      const n = this.db
        .prepare('DELETE FROM summary_items WHERE id = ? AND summary_id = ?')
        .run(itemId, m.id).changes;
      if (!n) throw new EditError(404, 'no_item', 'No such item in this summary');
      this.touch(m.id);
    })();
  }

  /** Adds an item to a section (at its end, or the end of its chapter). */
  addItem(bookId: string, section: SectionKey, input: ItemInput): StoredItem {
    const m = this.requireCurrent(bookId);
    if (!SECTION_ORDER.includes(section)) throw new EditError(400, 'invalid', 'No such section');
    const text = cleanText(input.text);
    const now = this.now();
    let heading: string | null = null;
    let between: [string, string] | null = null;
    if (section === 'characters' || section === 'terms') {
      heading = cleanOptional(input.heading, 'heading');
      if (!heading) throw new EditError(400, 'invalid', 'Characters and terms need a heading');
    }
    if (section === 'relationships') {
      const b = input.between;
      if (!Array.isArray(b) || b.length !== 2)
        throw new EditError(400, 'invalid', 'A relationship is between two people');
      between = [cleanText(b[0], 'name').slice(0, 200), cleanText(b[1], 'name').slice(0, 200)];
    }
    if (section === 'overview') {
      const has = this.db
        .prepare(`SELECT 1 FROM summary_items WHERE summary_id = ? AND section = 'overview'`)
        .get(m.id);
      if (has) throw new EditError(409, 'exists', 'The overview is edited as one text');
    }
    let chapter: number | null = null;
    let chapterTitle: string | null = null;
    let ord: number;
    if (section === 'chapters') {
      if (typeof input.chapter !== 'number' || !Number.isInteger(input.chapter))
        throw new EditError(400, 'invalid', 'Chapter by chapter: which chapter');
      chapter = input.chapter;
      const same = this.db
        .prepare(
          `SELECT MAX(ord) AS o, MAX(chapter_title) AS t FROM summary_items
           WHERE summary_id = ? AND section = 'chapters' AND chapter = ?`,
        )
        .get(m.id, chapter) as { o: number | null; t: string | null };
      chapterTitle = cleanOptional(input.chapterTitle, 'chapter title') ?? same.t;
      if (same.o !== null) ord = same.o + 0.001;
      else {
        // A chapter of its own, in chapter order.
        const before = this.db
          .prepare(
            `SELECT MAX(ord) AS o FROM summary_items WHERE summary_id = ? AND section = 'chapters' AND chapter < ?`,
          )
          .get(m.id, chapter) as { o: number | null };
        ord = (before.o ?? -1) + 0.001;
      }
    } else {
      const last = this.db
        .prepare(`SELECT MAX(ord) AS o FROM summary_items WHERE summary_id = ? AND section = ?`)
        .get(m.id, section) as { o: number | null };
      ord = (last.o ?? 1e6) + 1;
    }
    const id = this.db.transaction(() => {
      const r = this.db
        .prepare(
          `INSERT INTO summary_items (summary_id, section, ord, chapter, chapter_title, ref, heading,
             between_json, text, cites_json, show_quote, added_by_user, edited_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, 1, ?)`,
        )
        .run(
          m.id,
          section,
          ord,
          chapter,
          chapterTitle,
          `u${now}${Math.random().toString(36).slice(2, 6)}`,
          heading,
          between ? JSON.stringify(between) : null,
          text,
          now,
        );
      this.touch(m.id);
      return Number(r.lastInsertRowid);
    })();
    return item(this.db.prepare('SELECT * FROM summary_items WHERE id = ?').get(id) as ItemRow);
  }

  /** The current summary becomes an earlier version (Delete: it can be restored). */
  retireCurrent(bookId: string): SummaryMeta {
    const m = this.requireCurrent(bookId);
    this.db
      .prepare(`UPDATE summaries SET state = 'earlier', replaced_at = ? WHERE id = ?`)
      .run(this.now(), m.id);
    return m;
  }

  /** An earlier version becomes the current one (the current one becomes earlier). */
  restore(bookId: string, summaryId: number): void {
    const m = this.metaById(summaryId);
    if (!m || m.bookId !== bookId) throw new EditError(404, 'no_version', 'No such version');
    if (m.state === 'current') return;
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE summaries SET state = 'earlier', replaced_at = ? WHERE book_id = ? AND state = 'current'`,
        )
        .run(now, bookId);
      this.db
        .prepare(`UPDATE summaries SET state = 'current', replaced_at = NULL WHERE id = ?`)
        .run(summaryId);
    })();
  }

  /** Deletes an earlier version for good (never the current one). */
  deleteVersion(bookId: string, summaryId: number): void {
    const m = this.metaById(summaryId);
    if (!m || m.bookId !== bookId) throw new EditError(404, 'no_version', 'No such version');
    if (m.state === 'current')
      throw new EditError(409, 'current', 'The current summary is deleted with Delete');
    this.db.prepare('DELETE FROM summaries WHERE id = ?').run(summaryId);
  }
}

/** Items in section order, chapters grouped by chapter. */
export function groupSections(items: StoredItem[]): StoredSummary['sections'] {
  const out: StoredSummary['sections'] = [];
  for (const key of SECTION_ORDER) {
    const its = items.filter((i) => i.section === key);
    if (!its.length) continue;
    if (key !== 'chapters') {
      out.push({ key, groups: [{ items: its }] });
      continue;
    }
    const groups: { chapter?: number; title?: string; items: StoredItem[] }[] = [];
    for (const it of [...its].sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0) || 0)) {
      const last = groups[groups.length - 1];
      if (last && last.chapter === (it.chapter ?? undefined)) last.items.push(it);
      else
        groups.push({
          ...(it.chapter !== null ? { chapter: it.chapter } : {}),
          ...(it.chapterTitle !== null ? { title: it.chapterTitle } : {}),
          items: [it],
        });
    }
    out.push({ key, groups });
  }
  return out;
}

/** Builds a summary the user wrote (Write my own) from sections of plain items. */
export function userSummary(
  input: unknown,
  o: { lang: string; bookTitle: string; now: number },
): Summary {
  if (typeof input !== 'object' || input === null)
    throw new EditError(400, 'invalid', 'A summary must be an object');
  const v = input as { overview?: unknown; sections?: unknown; alsoMentioned?: unknown };
  const sections: SummarySection[] = [];
  let n = 0;
  const overview =
    typeof v.overview === 'string' && v.overview.trim() ? cleanText(v.overview) : null;
  if (overview)
    sections.push({
      key: 'overview',
      groups: [{ items: [plain('overview', overview)] }],
    });
  const raw = Array.isArray(v.sections) ? (v.sections as unknown[]) : [];
  for (const key of SECTION_ORDER.slice(1)) {
    const sec = raw.find((s) => (s as { key?: unknown })?.key === key) as
      | { items?: unknown[] }
      | undefined;
    if (!sec || !Array.isArray(sec.items) || !sec.items.length) continue;
    if (sec.items.length > 2000) throw new EditError(400, 'invalid', 'Too many items');
    const groups: SummarySection['groups'] = [];
    for (const x of sec.items as Record<string, unknown>[]) {
      const ref = `u${n++}`;
      const it = plain(ref, cleanText(x?.text));
      if (key === 'characters' || key === 'terms') {
        const h = cleanOptional(x.heading, 'heading');
        if (!h) throw new EditError(400, 'invalid', 'Characters and terms need a heading');
        it.heading = h;
      }
      if (key === 'relationships') {
        const b = x.between;
        if (!Array.isArray(b) || b.length !== 2)
          throw new EditError(400, 'invalid', 'A relationship is between two people');
        it.between = [cleanText(b[0], 'name').slice(0, 200), cleanText(b[1], 'name').slice(0, 200)];
      }
      if (key === 'chapters') {
        const ch = typeof x.chapter === 'number' && Number.isInteger(x.chapter) ? x.chapter : 0;
        const title = cleanOptional(x.chapterTitle, 'chapter title') ?? undefined;
        const last = groups[groups.length - 1];
        if (last && last.chapter === ch) last.items.push(it);
        else groups.push({ chapter: ch, ...(title ? { title } : {}), items: [it] });
      } else if (groups.length) groups[0].items.push(it);
      else groups.push({ items: [it] });
    }
    sections.push({ key, groups });
  }
  if (!sections.length) throw new EditError(400, 'invalid', 'A summary needs at least one item');
  const also = Array.isArray(v.alsoMentioned)
    ? (v.alsoMentioned as unknown[])
        .filter((x): x is string => typeof x === 'string' && !!x.trim())
        .map((x) => x.trim().slice(0, 200))
    : [];
  return {
    lang: o.lang,
    bookTitle: o.bookTitle,
    models: [],
    madeAt: o.now,
    sections,
    alsoMentioned: also,
  };
}

function plain(ref: string, text: string): SummaryItem {
  return { ref, text, cites: [], quote: null, position: null, showQuote: false };
}
