/**
 * Stage 5 (genres and tags) on a new-arrivals run's books (WP20g): per book, as decided for the
 * library (2026-11-21), with stage 5's own code: the evidence from stage 4's stored sources
 * (stage5Evidence), the stronger pair asked (Sonnet AND Sol by default, the user's choice after
 * stop 1's measurement on the genre test's labels: tags found 74 % -> 90 % at 97 % right; the
 * tasks stage5.upgradePrimary/Secondary, Settings > AI), each book's own terms (ownTerms: both
 * models, its own RanobeDB
 * match, the store rules), and one `tags` change per book (tagChange: a custom tag never removed,
 * a tag the user removed never added again), proposed under the run's analysis id. A set the
 * library's stage-5 gate holds back (genres or tags) is held for the arrivals too.
 */
import type Database from 'better-sqlite3';
import type { AiRunner } from '../../ai/runner';
import { waitNeedsUser, waitText } from '../../ai/waits';
import { runSpend } from '../../ai/spend';
import { writeDecisions } from '../ai-decide/values';
import { getSettings } from '../settings';
import { getStage } from '../stages';
import { storedAiValues } from '../stage4/ai-decide';
import type { Stage4Analysis, Stage4Progress } from '../stage4/analysis';
import type { Format } from '../stage4/rules-v3';
import { STAGE5_RULES_VERSION, byKind, ownTerms, tagChange, type OwnTerms } from '../stage5/decide';
import { adaptationText, stage5Evidence, type Stage5Item } from '../stage5/evidence';
import { STAGE5_EVIDENCE_VERSION, stage5SpecFor, type Stage5Answer } from '../stage5/prompt';
import { effectiveVocab } from '../stage5/tag-list';

const OWN_FIELD = 'own';
const FORMATS = new Set(['light novel', 'novel', 'nonfiction', 'manga', 'image-only']);

export type Stage5PassPhase = 'evidence' | 'models' | 'decide' | 'propose' | 'done';

export interface Stage5PassProgress {
  phase: Stage5PassPhase;
  keys: string[];
  cursor: number;
  decided: number;
  /** Questions not answered yet (the run's bar while the models answer). */
  pending?: number;
  proposed: number;
  wait: string | null;
  cost: number;
  /** The "Tags you can pick" list the models were asked with (its hash). */
  listHash?: string;
}

export function emptyStage5Pass(): Stage5PassProgress {
  return { phase: 'evidence', keys: [], cursor: 0, decided: 0, proposed: 0, wait: null, cost: 0 };
}

export class ArrivalStage5 {
  constructor(
    private readonly deps: { db: Database.Database; runner: AiRunner; analysis: Stage4Analysis },
  ) {}

  private get db() {
    return this.deps.db;
  }

  /** Stage 4's decided format of the run's books (their format proposals under the run's id). */
  private formats(view: Stage4Progress): Map<string, Format> {
    const map = new Map<string, Format>();
    for (const r of this.db
      .prepare(
        `SELECT calibre_uuid, new_json FROM proposed_changes INDEXED BY proposed_changes_counts
         WHERE stage = 4 AND library_id = ? AND state = 'proposed' AND field = 'format' AND analysis_id = ?`,
      )
      .all(view.libraryId, view.analysisId) as { calibre_uuid: string; new_json: string }[]) {
      const v = JSON.parse(r.new_json) as unknown;
      if (typeof v === 'string' && FORMATS.has(v)) map.set(r.calibre_uuid, v as Format);
    }
    return map;
  }

  /** The sets the library's stage-5 gate holds back (its last result). */
  private held(libraryId: string): { genres: boolean; tags: boolean } {
    const p = getStage(this.db, libraryId, 5).progress as {
      gate?: { held?: { genres: boolean; tags: boolean } };
    };
    return p.gate?.held ?? { genres: false, tags: false };
  }

  async step(
    view: Stage4Progress,
    prog: Stage5PassProgress,
    uuids: string[],
    shouldStop: () => boolean,
  ): Promise<'more' | 'wait' | 'done'> {
    const runner = this.deps.runner;
    const runId = view.analysisId;
    // "Tags you can pick" (Settings › Library › Editing): new books are asked with the list as it
    // is now (tags added to it are used right away; the user's own tags never).
    const vocab = effectiveVocab(getSettings(this.db).tagList);
    const STAGE5_SPEC = stage5SpecFor(vocab);
    if (prog.phase === 'models' && prog.listHash !== undefined && prog.listHash !== vocab.hash) {
      // The list changed while the models were asked: asked again with the list as it is now.
      runner.enqueue(STAGE5_SPEC, 'upgradePrimary', prog.keys, runId);
      runner.enqueue(STAGE5_SPEC, 'upgradeSecondary', prog.keys, runId);
    }
    prog.listHash = vocab.hash;
    const key = (u: string) => `${view.libraryId}:${u}`;
    if (prog.phase === 'evidence') {
      const formats = this.formats(view);
      const items: { key: string; evidence: Stage5Item; labeled: boolean }[] = [];
      for (const uuid of uuids) {
        const inp = this.deps.analysis.aiInputs(view, uuid);
        if (!inp) continue;
        const s4 = storedAiValues(this.db, key(uuid));
        const ex = this.deps.analysis.extrasOf(view, inp.book.calibreId);
        items.push({
          key: key(uuid),
          evidence: stage5Evidence({
            book: inp.book,
            base: inp.base,
            record: inp.record,
            decision: inp.decision,
            comments: ex?.comments ?? null,
            format: formats.get(uuid) ?? null,
            modelsSayAmazon: !!s4?.asked && !!s4.amazonIsBook,
          }),
          labeled: false,
        });
      }
      runner.putItems(STAGE5_SPEC, items, STAGE5_EVIDENCE_VERSION);
      prog.keys = items.map((i) => i.key);
      runner.enqueue(STAGE5_SPEC, 'upgradePrimary', prog.keys, runId);
      runner.enqueue(STAGE5_SPEC, 'upgradeSecondary', prog.keys, runId);
      prog.phase = 'models';
      return 'more';
    }
    if (prog.phase === 'models') {
      const r = await runner.step(STAGE5_SPEC, runId, shouldStop);
      prog.cost = (runSpend(this.db, 'calibre5', runId) as { costUsd: number }).costUsd ?? 0;
      prog.pending = r.pending;
      if (r.wait) {
        prog.wait = waitText(r.wait);
        if (waitNeedsUser(r.wait)) return 'wait';
      } else prog.wait = null;
      if (r.pending > 0) return r.sent > 0 || r.answered > 0 ? 'more' : 'wait';
      prog.phase = 'decide';
      prog.cursor = 0;
      return 'more';
    }
    if (prog.phase === 'decide') {
      const out = [];
      for (const k of prog.keys) {
        const ev = runner.evidenceOf<Stage5Item>(STAGE5_SPEC, k);
        if (!ev) continue;
        const a = runner.answerOf(STAGE5_SPEC, 'upgradePrimary', k);
        const b = runner.answerOf(STAGE5_SPEC, 'upgradeSecondary', k);
        const pa = a?.state === 'answered' ? (a.answer as Stage5Answer) : null;
        const pb = b?.state === 'answered' ? (b.answer as Stage5Answer) : null;
        const own = ownTerms({
          primary: pa,
          secondary: pb,
          ranobedbTags: ev.evidence.ranobedb_tags,
          storeCategories: ev.evidence.amazon_categories,
          adaptationText: adaptationText(ev.evidence),
        });
        out.push({
          itemKey: k,
          field: OWN_FIELD,
          decision: {
            value: own,
            source: own.asked ? ('both_models' as const) : ('rules' as const),
            flagged: false,
            reason: own.asked ? null : 'Not asked (or a model gave no answer): rules only',
          },
          rules: null,
          primary: pa,
          secondary: pb,
          evidenceHash: ev.hash,
        });
        prog.decided++;
      }
      // The arrivals' setup J; for stage 5 the stronger pair alone (the user's choice).
      writeDecisions(this.db, 'calibre5', out, 'J', Date.now());
      prog.phase = 'propose';
      return 'more';
    }
    if (prog.phase === 'propose') {
      prog.proposed = this.propose(view, uuids);
      prog.phase = 'done';
      return 'done';
    }
    return 'done';
  }

  /** One `tags` change per book from its own terms (read back: a user value wins). */
  private propose(view: Stage4Progress, uuids: string[]): number {
    const settings = getSettings(this.db);
    const vocab = effectiveVocab(settings.tagList);
    const snap = this.deps.analysis.loadSnapshot(view.libraryId);
    const byUuid = new Map([...snap.books.values()].map((b) => [b.uuid, b]));
    const formats = this.formats(view);
    const held = this.held(view.libraryId);
    const ownOf = this.db.prepare(
      `SELECT value_json FROM ai_values WHERE stage = 'calibre5' AND item_key = ? AND field = ?`,
    );
    const appliedTags = this.db.prepare(
      `SELECT value_json FROM applied_values WHERE library_id = ? AND field = 'tags' AND calibre_uuid = ?`,
    );
    const del = this.db.prepare(
      `DELETE FROM proposed_changes INDEXED BY proposed_changes_book
       WHERE library_id = ? AND calibre_uuid = ? AND field = 'tags' AND stage = 5
         AND state IN ('proposed', 'skipped') AND analysis_id = ?`,
    );
    const ins = this.db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
         source, evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (5, ?, ?, ?, 'tags', ?, ?, 'stage5', ?, 'auto', NULL, 'proposed', ?, ?, ?)`,
    );
    const now = Date.now();
    let n = 0;
    this.db.transaction(() => {
      for (const uuid of uuids) {
        const b = byUuid.get(uuid);
        if (!b) continue;
        const r = ownOf.get(`${view.libraryId}:${uuid}`, OWN_FIELD) as
          | { value_json: string }
          | undefined;
        const own = r ? (JSON.parse(r.value_json) as OwnTerms) : null;
        const ids = own
          ? Object.keys(own.terms).filter((id) => {
              const k = vocab.byId.get(id)?.kind;
              if (!k) return false;
              if (held.genres && (k === 'genre' || k === 'subject')) return false;
              if (held.tags && k === 'tag') return false;
              return true;
            })
          : null;
        const a = appliedTags.get(view.libraryId, uuid) as { value_json: string } | undefined;
        const added = a ? ((JSON.parse(a.value_json) as { added?: string[] }).added ?? []) : [];
        const format = formats.get(uuid) ?? null;
        const ch = tagChange(ids, format, b.tags, settings.customTags, added, {
          label: (id) => vocab.byId.get(id)?.ja ?? null,
          format: (fm) => vocab.formats[fm]?.ja ?? null,
        });
        del.run(view.libraryId, uuid, view.analysisId);
        if (!ch.add.length && !ch.remove.length) continue;
        const sources: Record<string, unknown> = {};
        for (const id of ids ?? []) sources[id] = { from: own!.terms[id], books: 1, of: 1 };
        ins.run(
          view.libraryId,
          b.calibreId,
          uuid,
          JSON.stringify(b.tags),
          JSON.stringify(ch),
          JSON.stringify({
            title: b.title,
            lastModified: b.lastModified,
            ids: ids ? byKind(ids) : null,
            format,
            sources,
            arrival: true,
            rules: STAGE5_RULES_VERSION,
          }),
          view.analysisId,
          now,
          now,
        );
        n++;
      }
    })();
    return n;
  }
}
