/**
 * The series recaps stored in summaries.db (book summaries session 5): one current recap per
 * series (no versions), its points with the volume items they rest on, and the translations item
 * by item (as summaries' are: made from an item's digest, so a rebuilt recap is translated anew).
 *
 * Only summaries.db; nothing here asks a model or reads ttsu.db.
 */
import type Database from 'better-sqlite3';
import type { CoveredVolume, RecapDraft, RecapItem, RecapSectionKey, SourceItem } from './recap';
import { RECAP_SECTIONS } from './recap';
import { ALSO_REF, cleanLabel, itemDigest, type TranslationNeed } from './store';

export interface RecapMeta {
  id: number;
  series: string;
  lang: string;
  volumes: CoveredVolume[];
  setup: string | null;
  models: string[];
  alsoMentioned: string[];
  inputsDigest: string;
  generation: number;
  madeAt: number;
  jobId: number | null;
}

interface MetaRow {
  id: number;
  series: string;
  lang: string;
  volumes_json: string;
  setup: string | null;
  models_json: string;
  also_mentioned_json: string;
  inputs_digest: string;
  generation: number;
  made_at: number;
  job_id: number | null;
}

interface ItemRow {
  id: number;
  recap_id: number;
  section: RecapSectionKey;
  ord: number;
  volume: number | null;
  ref: string;
  heading: string | null;
  between_json: string | null;
  label: string | null;
  ruby_json: string | null;
  between_ruby_json: string | null;
  text: string;
  sources_json: string;
  since: number | null;
}

/** A recap point as the app shows it (the shape of a summary item, without quotes). */
export interface RecapViewItem {
  ref: string;
  text: string;
  heading?: string;
  between?: [string, string];
  label?: string;
  ruby?: { t: string; r?: string }[];
  betweenRuby?: [{ t: string; r?: string }[] | null, { t: string; r?: string }[] | null];
  /** Where it first appears: the volume's number (or title), and whether an earlier covered
   * volume has no summary (then it is "in the summaries from vol. N"). */
  since?: { label: string | null; title: string; gap: boolean };
  cites: string[];
  quote: null;
  position: null;
  showQuote: false;
}

export interface RecapVolumeView {
  n: number;
  bookId: string;
  label: string | null;
  title: string;
  /** The volume had no summary when the recap was made. */
  missing: boolean;
}

export interface RecapView {
  id: number;
  series: string;
  /** The summaries' language (the recap's own). */
  lang: string;
  viewLang: string;
  madeAt: number;
  setup: string | null;
  models: string[];
  volumes: RecapVolumeView[];
  sections: {
    key: RecapSectionKey;
    groups: { volume?: RecapVolumeView; items: RecapViewItem[] }[];
  }[];
  alsoMentioned: string[];
  untranslated: string[];
  languages: string[];
}

function meta(r: MetaRow): RecapMeta {
  return {
    id: r.id,
    series: r.series,
    lang: r.lang,
    volumes: JSON.parse(r.volumes_json) as CoveredVolume[],
    setup: r.setup,
    models: JSON.parse(r.models_json) as string[],
    alsoMentioned: JSON.parse(r.also_mentioned_json) as string[],
    inputsDigest: r.inputs_digest,
    generation: r.generation,
    madeAt: r.made_at,
    jobId: r.job_id,
  };
}

interface TrRow {
  ref: string;
  heading: string | null;
  between_json: string | null;
  label: string | null;
  text: string;
  source_digest: string;
}

const parse = <T>(s: string | null): T | null => (s ? (JSON.parse(s) as T) : null);

export class RecapStore {
  constructor(
    readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  current(series: string): RecapMeta | null {
    const r = this.db.prepare('SELECT * FROM series_recaps WHERE series = ?').get(series) as
      | MetaRow
      | undefined;
    return r ? meta(r) : null;
  }

  byId(id: number): RecapMeta | null {
    const r = this.db.prepare('SELECT * FROM series_recaps WHERE id = ?').get(id) as
      | MetaRow
      | undefined;
    return r ? meta(r) : null;
  }

  allSeries(): string[] {
    return (this.db.prepare('SELECT series FROM series_recaps').all() as { series: string }[]).map(
      (r) => r.series,
    );
  }

  private rows(recapId: number): ItemRow[] {
    return this.db
      .prepare('SELECT * FROM series_recap_items WHERE recap_id = ? ORDER BY ord, id')
      .all(recapId) as ItemRow[];
  }

  /** The points as translations see them (heading, people, label, text). */
  private translatable(r: ItemRow): {
    heading: string | null;
    between: [string, string] | null;
    label: string | null;
    text: string;
  } {
    return {
      heading: r.heading,
      between: parse<[string, string]>(r.between_json),
      label: r.label,
      text: r.text,
    };
  }

  languages(series: string, recapLang: string): string[] {
    const saved = (
      this.db
        .prepare('SELECT lang FROM series_recap_languages WHERE series = ? ORDER BY added_at')
        .all(series) as { lang: string }[]
    ).map((r) => r.lang);
    return [recapLang, ...saved.filter((l) => l !== recapLang)];
  }

  addLanguage(series: string, lang: string): void {
    this.db
      .prepare(
        `INSERT INTO series_recap_languages (series, lang, added_at) VALUES (?, ?, ?)
         ON CONFLICT(series, lang) DO NOTHING`,
      )
      .run(series, lang, this.now());
  }

  /** Replaces the series' recap (its translations go with it; the saved languages stay). */
  save(
    series: string,
    o: {
      lang: string;
      volumes: CoveredVolume[];
      draft: RecapDraft;
      sources: Map<string, SourceItem>;
      setup: string | null;
      models: string[];
      inputsDigest: string;
      generation: number;
      jobId: number | null;
      report?: unknown;
    },
  ): number {
    const now = this.now();
    return this.db.transaction(() => {
      const old = this.current(series);
      // The old recap's translations by what they were made from: a point the rebuild writes
      // the same keeps its translation (only new or changed points are translated again).
      const kept = old
        ? (this.db
            .prepare(
              `SELECT lang, ref, heading, between_json, label, text, source_digest, model, made_at
               FROM series_recap_translations WHERE recap_id = ?`,
            )
            .all(old.id) as (TrRow & { lang: string; model: string | null; made_at: number })[])
        : [];
      if (old) {
        this.db.prepare('DELETE FROM series_recap_translations WHERE recap_id = ?').run(old.id);
        this.db.prepare('DELETE FROM series_recap_items WHERE recap_id = ?').run(old.id);
        this.db.prepare('DELETE FROM series_recaps WHERE id = ?').run(old.id);
      }
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO series_recaps (series, lang, volumes_json, setup, models_json,
               also_mentioned_json, inputs_digest, generation, made_at, job_id, report_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            series,
            o.lang,
            JSON.stringify(o.volumes),
            o.setup,
            JSON.stringify(o.models),
            JSON.stringify(o.draft.alsoMentioned),
            o.inputsDigest,
            o.generation,
            now,
            o.jobId,
            o.report === undefined ? null : JSON.stringify(o.report),
          ).lastInsertRowid,
      );
      const ins = this.db.prepare(
        `INSERT INTO series_recap_items (recap_id, section, ord, volume, ref, heading, between_json,
           label, ruby_json, between_ruby_json, text, sources_json, since)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let ord = 0;
      const order = (it: RecapItem) => RECAP_SECTIONS.indexOf(it.section);
      for (const it of [...o.draft.items].sort((a, b) => order(a) - order(b))) {
        ins.run(
          id,
          it.section,
          ord++,
          it.volume,
          it.ref,
          it.heading ?? null,
          it.between ? JSON.stringify(it.between) : null,
          it.between ? cleanLabel(it.label) : null,
          it.ruby ? JSON.stringify(it.ruby) : null,
          it.betweenRuby ? JSON.stringify(it.betweenRuby) : null,
          it.text,
          JSON.stringify(
            it.cites.map((c) => {
              const s = o.sources.get(c)!;
              return { bookId: s.bookId, summaryId: s.summaryId, ref: s.ref };
            }),
          ),
          it.since,
        );
      }
      if (kept.length) {
        const copy = this.db.prepare(
          `INSERT OR IGNORE INTO series_recap_translations (recap_id, lang, ref, heading,
             between_json, label, text, source_digest, model, made_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const byDigest = new Map<string, (typeof kept)[number][]>();
        for (const t of kept) {
          const k = `${t.lang}|${t.source_digest}`;
          byDigest.set(k, [...(byDigest.get(k) ?? []), t]);
        }
        const langs = [...new Set(kept.map((t) => t.lang))];
        const take = (lang: string, ref: string, digest: string) => {
          const t = byDigest.get(`${lang}|${digest}`)?.[0];
          if (t)
            copy.run(
              id,
              lang,
              ref,
              t.heading,
              t.between_json,
              t.label,
              t.text,
              digest,
              t.model,
              t.made_at,
            );
        };
        for (const it of o.draft.items) {
          const digest = itemDigest({
            heading: it.heading ?? null,
            between: it.between ?? null,
            label: it.between ? cleanLabel(it.label) : null,
            text: it.text,
          });
          for (const lang of langs) take(lang, it.ref, digest);
        }
        if (o.draft.alsoMentioned.length) {
          const digest = itemDigest({ text: o.draft.alsoMentioned.join(String.fromCharCode(10)) });
          for (const lang of langs) take(lang, ALSO_REF, digest);
        }
      }
      return id;
    })();
  }

  /** The series' recap is gone (fewer than two volumes with a summary). */
  remove(series: string): boolean {
    const old = this.current(series);
    if (!old) return false;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM series_recap_translations WHERE recap_id = ?').run(old.id);
      this.db.prepare('DELETE FROM series_recap_items WHERE recap_id = ?').run(old.id);
      this.db.prepare('DELETE FROM series_recaps WHERE id = ?').run(old.id);
    })();
    return true;
  }

  private translations(recapId: number, lang: string): Map<string, TrRow> {
    const rows = this.db
      .prepare(
        `SELECT ref, heading, between_json, label, text, source_digest
         FROM series_recap_translations WHERE recap_id = ? AND lang = ?`,
      )
      .all(recapId, lang) as TrRow[];
    return new Map(rows.map((r) => [r.ref, r]));
  }

  /** The points a translation still needs (as summaries': missing or made from an older item). */
  translationNeeds(recapId: number, lang: string): TranslationNeed[] {
    const have = this.translations(recapId, lang);
    const out: TranslationNeed[] = [];
    for (const r of this.rows(recapId)) {
      const t = this.translatable(r);
      const digest = itemDigest(t);
      if (have.get(r.ref)?.source_digest === digest) continue;
      out.push({
        ref: r.ref,
        heading: t.heading ?? (t.between ? `${t.between[0]} / ${t.between[1]}` : null),
        label: t.label,
        text: t.text,
        digest,
      });
    }
    const m = this.byId(recapId);
    if (m?.alsoMentioned.length) {
      const digest = itemDigest({ text: m.alsoMentioned.join('\n') });
      if (have.get(ALSO_REF)?.source_digest !== digest)
        out.push({
          ref: ALSO_REF,
          heading: null,
          label: null,
          text: m.alsoMentioned.join('\n'),
          digest,
        });
    }
    return out;
  }

  /** Saves translated points (headings of Characters and Terms as "Translated (original)"). */
  saveTranslations(
    recapId: number,
    lang: string,
    model: string,
    made: { ref: string; heading: string; label?: string; text: string; digest: string }[],
  ): void {
    const rows = new Map(this.rows(recapId).map((r) => [r.ref, r]));
    const up = this.db.prepare(
      `INSERT INTO series_recap_translations (recap_id, lang, ref, heading, between_json, label,
         text, source_digest, model, made_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(recap_id, lang, ref) DO UPDATE SET heading = excluded.heading,
         between_json = excluded.between_json, label = excluded.label, text = excluded.text,
         source_digest = excluded.source_digest, model = excluded.model, made_at = excluded.made_at`,
    );
    const now = this.now();
    this.db.transaction(() => {
      for (const t of made) {
        if (t.ref === ALSO_REF) {
          up.run(recapId, lang, t.ref, null, null, null, t.text, t.digest, model, now);
          continue;
        }
        const r = rows.get(t.ref);
        if (!r) continue;
        const between = parse<[string, string]>(r.between_json);
        let heading: string | null = null;
        let pair: [string, string] | null = null;
        if (between) {
          const parts = t.heading.split(' / ');
          pair = parts.length === 2 ? [parts[0].trim(), parts[1].trim()] : between;
        } else if (r.heading) {
          heading =
            (r.section === 'characters' || r.section === 'terms') &&
            t.heading &&
            t.heading !== r.heading
              ? `${t.heading} (${r.heading})`
              : t.heading || r.heading;
        }
        up.run(
          recapId,
          lang,
          t.ref,
          heading,
          pair ? JSON.stringify(pair) : null,
          r.label ? (cleanLabel(t.label) ?? r.label) : null,
          t.text,
          t.digest,
          model,
          now,
        );
      }
    })();
  }

  /**
   * The recap as the app shows it, in its own language or a translation. `titles`: the volumes'
   * titles now (a title Calibre changed shows as it is now).
   */
  view(recapId: number, lang?: string, titles: Map<string, string> = new Map()): RecapView | null {
    const m = this.byId(recapId);
    if (!m) return null;
    const viewLang = lang && lang !== m.lang ? lang : m.lang;
    const tr = viewLang !== m.lang ? this.translations(m.id, viewLang) : null;
    const untranslated: string[] = [];
    const volumes: RecapVolumeView[] = m.volumes.map((v) => ({
      n: v.n,
      bookId: v.bookId,
      label: v.label,
      title: titles.get(v.bookId) ?? v.title,
      missing: v.summaryId === null,
    }));
    const byN = new Map(volumes.map((v) => [v.n, v]));
    const sinceOf = (n: number | null): RecapViewItem['since'] => {
      if (n === null) return undefined;
      const v = byN.get(n);
      if (!v) return undefined;
      const gap = volumes.some((x) => x.n < n && x.missing);
      return { label: v.label, title: v.title, gap };
    };
    const items = this.rows(m.id).map(
      (r): RecapViewItem & { section: RecapSectionKey; volume: number | null } => {
        const base = this.translatable(r);
        const t = tr?.get(r.ref);
        const fresh = !!t && t.source_digest === itemDigest(base);
        if (tr && !fresh) untranslated.push(r.ref);
        const ruby = parse<RecapViewItem['ruby']>(r.ruby_json);
        const betweenRuby = parse<RecapViewItem['betweenRuby']>(r.between_ruby_json);
        const between =
          fresh && t!.between_json ? parse<[string, string]>(t!.between_json) : base.between;
        const since =
          r.section === 'characters' || r.section === 'terms' || r.section === 'threads'
            ? sinceOf(r.since)
            : undefined;
        return {
          section: r.section,
          volume: r.volume,
          ref: r.ref,
          text: fresh ? t!.text : r.text,
          ...(r.heading !== null ? { heading: fresh ? (t!.heading ?? r.heading) : r.heading } : {}),
          ...(between ? { between } : {}),
          ...(r.label ? { label: fresh ? (t!.label ?? r.label) : r.label } : {}),
          // The book's furigana belongs to the original names only.
          ...(!fresh && ruby ? { ruby } : {}),
          ...(!fresh && betweenRuby ? { betweenRuby } : {}),
          ...(since ? { since } : {}),
          cites: (JSON.parse(r.sources_json) as { bookId: string; ref: string }[]).map(
            (s) => `${s.bookId}:${s.ref}`,
          ),
          quote: null,
          position: null,
          showQuote: false,
        };
      },
    );
    let also = m.alsoMentioned;
    if (tr && also.length) {
      const a = tr.get(ALSO_REF);
      if (a && a.source_digest === itemDigest({ text: also.join('\n') }))
        also = a.text.split('\n').filter(Boolean);
      else untranslated.push(ALSO_REF);
    }
    const sections: RecapView['sections'] = [];
    for (const key of RECAP_SECTIONS) {
      const its = items.filter((i) => i.section === key);
      const strip = (i: (typeof items)[number]): RecapViewItem => {
        const { section: _s, volume: _v, ...rest } = i;
        void _s;
        void _v;
        return rest;
      };
      if (key === 'volumes') {
        if (!its.length && !volumes.some((v) => v.missing)) continue;
        sections.push({
          key,
          groups: volumes.map((v) => ({
            volume: v,
            items: its.filter((i) => i.volume === v.n).map(strip),
          })),
        });
        continue;
      }
      if (its.length) sections.push({ key, groups: [{ items: its.map(strip) }] });
    }
    return {
      id: m.id,
      series: m.series,
      lang: m.lang,
      viewLang,
      madeAt: m.madeAt,
      setup: m.setup,
      models: m.models,
      volumes,
      sections,
      alsoMentioned: also,
      untranslated,
      languages: this.languages(m.series, m.lang),
    };
  }
}
