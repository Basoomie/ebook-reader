/**
 * Looks for the events of notifications-design.md in what already exists, without changing
 * it (verified in code while planning, 2026-11-18):
 *
 * - PC jobs (worker_jobs) and NAS merges (audio_merge_jobs): every 'failed' row is final (a
 *   retry puts a job back to 'queued'; a user's Stop ends 'cancelled'). New rows are found by
 *   their finish time with an overlap and a list of ids already seen.
 * - The PC: worker_status (problem, paused, last heartbeat) and the jobs waiting.
 * - The cleanup (cleanup.db, read only): stage and audiobook stage pauses, field pauses,
 *   the apply and fetch helpers (CleanupService.sidecar() / fetcher()), stage 4's requests.
 * - The Calibre indexer: library_index_state.last_warning (only the mass-missing guard
 *   writes it; the next successful index clears it).
 * - Refused changes: reported by the sync route (service.syncRefused); here only their
 *   quiet time is checked.
 *
 * Every part runs on its own: one failing part is logged, the others go on.
 */
import type Database from 'better-sqlite3';
import { AI_LIMIT_EVENT } from '../ai/limit-event';
import { AI_BATCHES_EVENT } from '../ai/batch-event';
import { BATCH_HEALTH_KEY, type ModelBatchHealth } from '../ai/batch-health';
import { AUDIO_STAGE_NAMES } from '../cleanup/audio/audio-stages';
import { STAGE_NAMES } from '../cleanup/stages';
import {
  clip,
  hoursText,
  JOB_KIND_LABEL,
  LINKS,
  listItems,
  Message,
  plural,
  stagePauseText,
} from './messages';
import type { NotificationService } from './service';
import type { NotificationSettings } from './settings';

/** Failures of these kinds alert (user 2026-11-18: not previews or voice samples). */
export const ALERT_JOB_KINDS = [
  'sync_subtitles',
  'generate_audiobook',
  'sentence_audio',
  'attribute_speakers',
];
/** Finished jobs (the design: PC subtitles and audiobooks; NAS merges). */
export const FINISHED_JOB_KINDS = ['sync_subtitles', 'generate_audiobook'];

/** A row finished this long before it was written is still found (see fresh()). */
const OVERLAP_MS = 10 * 60_000;

export interface WatcherSources {
  db: Database.Database;
  cleanupDb?: Database.Database | null;
  cleanup?: {
    sidecar(now?: number): { online: boolean; lastSeenAt: number | null };
    fetcher(now?: number): { online: boolean; lastSeenAt: number | null; problem: string | null };
  } | null;
  /** The PC's job queue (null: audiobooks off, no PC events). */
  jobs?: { expireLeases(): void } | null;
  /** WORKER_OFFLINE_SECONDS: the PC counts as off after this long without a heartbeat. */
  workerOfflineSeconds?: number;
  now?: () => number;
  logError?: (message: string, err?: unknown) => void;
}

const FIELD_PAUSE_TEXT: Record<string, string> = {
  gate: 'below its accuracy bar on the labeled books',
  no_labels: 'no labeled books to check it against',
  review_alarm: 'too many books sent to review',
};

interface ArrivalReport {
  added: number;
  planned: number;
  newReview: number;
  outcomes?: Record<string, number>;
}

interface FinishedRow {
  id: number;
  kind?: string;
  state: string;
  book_id: string | null;
  error: string | null;
  title: string | null;
  folder?: string | null;
}

export class NotificationWatcher {
  private readonly now: () => number;
  private readonly logError: (message: string, err?: unknown) => void;
  private messages: Message[] = [];

  constructor(
    private readonly service: NotificationService,
    private readonly s: WatcherSources,
  ) {
    this.now = s.now ?? Date.now;
    this.logError = s.logError ?? ((m, err) => console.error(m, err ?? ''));
  }

  /** One look at everything; alerts that are due go to the service. */
  check(settings: NotificationSettings): void {
    this.messages = [];
    const now = this.now();
    this.part('PC jobs', () => this.jobs(settings));
    this.part('merges', () => this.merges(settings));
    this.part('the PC', () => this.pc(settings, now));
    const index = this.part('the Calibre index', () => this.index());
    this.part('cleanup stages', () => this.stages(index ?? null));
    this.part('audiobook cleanup stages', () => this.audioStages());
    this.part('the cleanup helpers', () => this.helpers(settings, now));
    this.part('field pauses', () => this.fieldPauses());
    this.part('new audiobooks', () => this.arrivalRuns());
    this.part('new books', () => this.bookArrivalRuns());
    this.part('best guesses', () => this.stage4Guesses());
    this.part('refused changes', () => this.refusalsQuiet(settings, now));
    this.part('the AI spending limit', () => this.aiLimit());
    this.part('failing AI batches', () => this.aiBatches());
    for (const m of this.messages) this.service.notify(m, settings);
  }

  private part<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.logError(`Notifications: checking ${what} failed:`, err);
      return undefined;
    }
  }

  /** Rows not seen before; the first look only remembers what is there. */
  private fresh<T extends { id: number }>(name: string, query: (since: number) => T[]): T[] {
    const now = this.now();
    const key = `seen:${name}`;
    const st = this.service.store.getState<{ mark: number; ids: number[] }>(key);
    const rows = query((st?.mark ?? now) - OVERLAP_MS);
    this.service.store.setState(key, { mark: now, ids: rows.map((r) => r.id) });
    if (!st) return [];
    const seen = new Set(st.ids);
    return rows.filter((r) => !seen.has(r.id));
  }

  // ---- jobs and merges ----

  private jobs(settings: NotificationSettings): void {
    if (this.s.jobs) {
      // Lease expiry is lazy (it runs inside requests); a PC that went away mid-job would
      // otherwise stay 'running' until someone opens a page. Same logic, just on time.
      try {
        this.s.jobs.expireLeases();
      } catch (err) {
        this.logError('Notifications: expiring PC job leases failed:', err);
      }
    }
    const rows = this.fresh<FinishedRow>(
      'worker_jobs',
      (since) =>
        this.s.db
          .prepare(
            `SELECT j.id, j.kind, j.state, j.book_id, j.error, b.title
           FROM worker_jobs j LEFT JOIN books b ON b.id = j.book_id
           WHERE j.state IN ('done', 'failed') AND COALESCE(j.finished_at, j.updated_at) > ?
           ORDER BY j.id`,
          )
          .all(since) as FinishedRow[],
    );
    const failed = rows.filter(
      (r) => r.state === 'failed' && ALERT_JOB_KINDS.includes(r.kind ?? ''),
    );
    // Many failing for one cause: one message.
    const byCause = new Map<string, FinishedRow[]>();
    for (const r of failed) {
      const cause = clip(r.error ?? 'The job failed', 160);
      byCause.set(cause, [...(byCause.get(cause) ?? []), r]);
    }
    for (const [cause, list] of byCause) {
      const kinds = [...new Set(list.map((r) => JOB_KIND_LABEL[r.kind ?? ''] ?? 'A job'))];
      const what =
        list.length === 1
          ? `${kinds[0]} failed on the PC: ${cause}`
          : `${list.length} PC jobs failed (${kinds.join(', ')}): ${cause}`;
      this.messages.push({
        event: 'job_failed',
        lines: [what, listItems(list.map((r) => r.title ?? ''))],
        link: list.length === 1 && list[0].book_id ? LINKS.book(list[0].book_id) : LINKS.pc,
      });
    }
    for (const r of rows) {
      if (r.state !== 'done' || !FINISHED_JOB_KINDS.includes(r.kind ?? '')) continue;
      this.service.finishedJob(
        `${JOB_KIND_LABEL[r.kind ?? ''] ?? 'Job'} finished`,
        r.title ?? '',
        r.book_id ? LINKS.book(r.book_id) : null,
        settings,
      );
    }
  }

  private merges(settings: NotificationSettings): void {
    const rows = this.fresh<FinishedRow>(
      'audio_merge_jobs',
      (since) =>
        this.s.db
          .prepare(
            `SELECT m.id, m.state, m.book_id, m.error, m.folder_rel_path AS folder, b.title
           FROM audio_merge_jobs m LEFT JOIN books b ON b.id = m.book_id
           WHERE m.state IN ('done', 'failed') AND COALESCE(m.finished_at, m.updated_at) > ?
           ORDER BY m.id`,
          )
          .all(since) as FinishedRow[],
    );
    const name = (r: FinishedRow) => r.title ?? r.folder?.split('/').pop() ?? '';
    const failed = rows.filter((r) => r.state === 'failed');
    const byCause = new Map<string, FinishedRow[]>();
    for (const r of failed) {
      const cause = clip(r.error ?? 'The merge failed', 160);
      byCause.set(cause, [...(byCause.get(cause) ?? []), r]);
    }
    for (const [cause, list] of byCause) {
      this.messages.push({
        event: 'merge_failed',
        lines: [
          list.length === 1
            ? `Audiobook merge failed: ${cause}`
            : `${list.length} audiobook merges failed: ${cause}`,
          listItems(list.map(name)),
        ],
        link: list[0].book_id ? LINKS.book(list[0].book_id) : LINKS.pc,
      });
    }
    for (const r of rows) {
      if (r.state !== 'done') continue;
      this.service.finishedJob(
        'Audiobook merge finished',
        name(r),
        r.book_id ? LINKS.book(r.book_id) : null,
        settings,
      );
    }
  }

  // ---- the PC ----

  private pc(settings: NotificationSettings, now: number): void {
    if (!this.s.jobs || this.s.workerOfflineSeconds === undefined) {
      this.service.clear('pc_problem');
      this.service.clear('pc_waiting');
      return;
    }
    const s = this.s.db
      .prepare('SELECT paused, last_seen_at, problem FROM worker_status WHERE id = 1')
      .get() as { paused: number; last_seen_at: number | null; problem: string | null } | undefined;
    const online =
      !!s && s.last_seen_at !== null && now - s.last_seen_at <= this.s.workerOfflineSeconds * 1000;
    const paused = s?.paused === 1;

    // A problem only counts while the PC is on, and only after its wait: at sign-in the
    // worker reports Docker as not running until Docker Desktop is up (user 2026-11-18).
    if (online && s?.problem) {
      const summary = `Problem on the PC: ${clip(s.problem, 160)}`;
      if (
        this.service.observe('pc_problem', 'pc_problem', {
          waitMs: settings.waits.pcProblemMinutes * 60_000,
          summary,
        })
      ) {
        this.messages.push({
          event: 'pc_problem',
          lines: [summary, 'Jobs that need it wait until it is fixed.'],
          link: LINKS.pc,
        });
      }
    } else {
      this.service.clear('pc_problem');
    }

    const w = this.s.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(created_at) AS first FROM worker_jobs
         WHERE state IN ('queued', 'running')`,
      )
      .get() as { n: number; first: number | null };
    if ((!online || paused) && w.n > 0) {
      const why = paused ? 'the PC is paused' : 'the PC is off';
      const startAt = paused ? undefined : Math.max(s?.last_seen_at ?? 0, w.first ?? now);
      const waitMs = settings.waits.pcWaitingHours * 3_600_000;
      const summary = `PC jobs waiting: ${why}`;
      if (this.service.observe('pc_waiting', 'pc_waiting', { startAt, waitMs, summary })) {
        const titles = (
          this.s.db
            .prepare(
              `SELECT b.title FROM worker_jobs j LEFT JOIN books b ON b.id = j.book_id
               WHERE j.state IN ('queued', 'running') ORDER BY j.id LIMIT 3`,
            )
            .all() as { title: string | null }[]
        ).map((r) => r.title ?? '');
        const since = this.service.store.getProblem('pc_waiting')?.first_seen_at ?? now;
        this.messages.push({
          event: 'pc_waiting',
          lines: [
            `${w.n} PC ${plural(w.n, 'job has', 'jobs have')} waited ${hoursText(now - since)}: ${why}`,
            w.n > titles.length ? `${listItems(titles, 3)} and more` : listItems(titles, 3),
          ],
          link: LINKS.pc,
        });
      }
    } else {
      this.service.clear('pc_waiting');
    }
  }

  // ---- the Calibre index ----

  /** Returns the libraries whose refusal alerts in this round (for one message with the cleanup). */
  private index(): Message | null {
    const rows = this.s.db
      .prepare(
        `SELECT s.library_id AS id, s.last_warning AS warning, l.name
         FROM library_index_state s JOIN libraries l ON l.id = s.library_id
         WHERE s.last_warning IS NOT NULL`,
      )
      .all() as { id: string; warning: string; name: string }[];
    const active = new Set<string>();
    let alert: Message | null = null;
    for (const r of rows) {
      const key = `index_refused:${r.id}`;
      active.add(key);
      // "3700 of 65000 books (5.7%) are no longer in metadata.db, more than … NOT flagged …"
      const gone = r.warning.split(', more than')[0];
      const summary = `The Calibre index of "${r.name}" was not updated: ${clip(gone, 140)}`;
      if (this.service.observe(key, 'index_refused', { waitMs: 0, summary, detail: r.warning })) {
        alert = {
          event: 'index_refused',
          lines: [summary, 'No book was marked missing. If this is intended, see Diagnostics.'],
          link: LINKS.diagnostics,
        };
        this.messages.push(alert);
      }
    }
    this.service.clearOthers('index_refused', active);
    return alert;
  }

  // ---- the AI layer ----

  /**
   * Features waiting in their queue for room under the monthly AI spending limit (ttsu.db
   * ai_waits; the cleanup's stages pause and alert on their own instead). One alert per
   * feature; "Resolved" in the digest once it goes on.
   */
  private aiLimit(): void {
    const rows = this.s.db.prepare('SELECT feature, label, detail FROM ai_waits').all() as {
      feature: string;
      label: string;
      detail: string;
    }[];
    const active = new Set<string>();
    for (const r of rows) {
      const key = `ai_limit_waiting:${r.feature}`;
      active.add(key);
      const summary = `${r.label} waits for the monthly AI spending limit`;
      if (this.service.observe(key, AI_LIMIT_EVENT, { waitMs: 0, summary, detail: r.detail }))
        this.messages.push({
          event: AI_LIMIT_EVENT,
          lines: [summary, clip(r.detail, 200)],
          link: LINKS.ai,
        });
    }
    this.service.clearOthers(AI_LIMIT_EVENT, active);
  }

  /**
   * Models whose batches the provider keeps refusing (ttsu.db ai_state batchHealth): one alert
   * per model while its batches are paused; "Resolved" once a batch is accepted again.
   */
  private aiBatches(): void {
    const row = this.s.db
      .prepare('SELECT value_json FROM ai_state WHERE key = ?')
      .get(BATCH_HEALTH_KEY) as { value_json: string } | undefined;
    const all = row ? (JSON.parse(row.value_json) as Record<string, ModelBatchHealth>) : {};
    const active = new Set<string>();
    for (const h of Object.values(all)) {
      if (h.pausedSince === null) continue;
      const key = `${AI_BATCHES_EVENT}:${h.model}`;
      active.add(key);
      const who = h.provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
      const summary = `${who} refused ${h.failures} ${h.model} batches in a row: its batches are paused`;
      if (this.service.observe(key, AI_BATCHES_EVENT, { waitMs: 0, summary, detail: h.reason }))
        this.messages.push({
          event: AI_BATCHES_EVENT,
          lines: [summary, clip(h.reason, 200)],
          link: LINKS.ai,
        });
    }
    this.service.clearOthers(AI_BATCHES_EVENT, active);
  }

  // ---- the cleanup ----

  private stages(indexAlert: Message | null): void {
    const db = this.s.cleanupDb;
    if (!db) return;
    const rows = db
      .prepare(
        'SELECT stage, pause_reason, pause_detail FROM stages WHERE pause_reason IS NOT NULL',
      )
      .all() as { stage: number; pause_reason: string; pause_detail: string | null }[];
    const active = new Set<string>();
    const alerts: typeof rows = [];
    for (const r of rows) {
      const key = `stage_paused:${r.stage}`;
      active.add(key);
      const summary = `Calibre cleanup stage ${r.stage} (${STAGE_NAMES[r.stage] ?? 'stage'}) paused: ${stagePauseText(r.pause_reason)}`;
      if (
        this.service.observe(key, 'stage_paused', { waitMs: 0, summary, detail: r.pause_detail })
      ) {
        alerts.push(r);
      }
    }
    // WP20g: the Calibre new arrivals' pause (its own row), one alert per pause.
    try {
      const a = db
        .prepare('SELECT pause_reason, pause_detail FROM calibre_arrivals_state WHERE id = 1')
        .get() as { pause_reason: string | null; pause_detail: string | null } | undefined;
      if (a?.pause_reason) {
        const key = 'stage_paused:arrivals';
        active.add(key);
        const summary = `Calibre new arrivals paused: ${stagePauseText(a.pause_reason)}`;
        if (
          this.service.observe(key, 'stage_paused', { waitMs: 0, summary, detail: a.pause_detail })
        )
          this.messages.push({
            event: 'stage_paused',
            lines: [summary, clip(a.pause_detail ?? '', 200)],
            link: LINKS.cleanup,
          });
      }
    } catch {
      // cleanup.db before WP20g
    }
    this.service.clearOthers('stage_paused', active);

    const byReason = new Map<string, typeof rows>();
    for (const r of alerts)
      byReason.set(r.pause_reason, [...(byReason.get(r.pause_reason) ?? []), r]);
    for (const [reason, list] of byReason) {
      const nums = list.map((r) => r.stage);
      const stagesText =
        nums.length === 1 ? `stage ${nums[0]}` : `stages ${listItems(nums.map(String), 5)}`;
      // One cause, one message: the indexer's refusal that paused them was just reported.
      if (indexAlert && reason === 'mass_missing') {
        indexAlert.lines[1] = `The Calibre cleanup's ${stagesText} paused because of it. No book was marked missing.`;
        continue;
      }
      this.messages.push({
        event: 'stage_paused',
        lines: [
          nums.length === 1
            ? `Calibre cleanup stage ${nums[0]} (${STAGE_NAMES[nums[0]] ?? 'stage'}) paused: ${stagePauseText(reason)}`
            : `Calibre cleanup ${stagesText} paused: ${stagePauseText(reason)}`,
          clip(list[0].pause_detail ?? '', 200),
        ],
        link: LINKS.cleanup,
      });
    }
  }

  private audioStages(): void {
    const db = this.s.cleanupDb;
    if (!db) return;
    const rows = db
      .prepare(
        'SELECT stage, pause_reason, pause_detail FROM audio_stages WHERE pause_reason IS NOT NULL',
      )
      .all() as { stage: number; pause_reason: string; pause_detail: string | null }[];
    const active = new Set<string>();
    for (const r of rows) {
      const key = `audio_stage_paused:${r.stage}`;
      active.add(key);
      const summary = `Audiobook cleanup stage ${r.stage} (${AUDIO_STAGE_NAMES[r.stage] ?? 'stage'}) paused: ${r.pause_reason.replace(/_/g, ' ')}`;
      if (
        this.service.observe(key, 'audio_stage_paused', {
          waitMs: 0,
          summary,
          detail: r.pause_detail,
        })
      ) {
        this.messages.push({
          event: 'audio_stage_paused',
          lines: [summary, clip(r.pause_detail ?? '', 200)],
          link: LINKS.audioCleanup,
        });
      }
    }
    this.service.clearOthers('audio_stage_paused', active);
  }

  private helpers(settings: NotificationSettings, now: number): void {
    const cleanup = this.s.cleanup;
    if (!cleanup) {
      this.service.clear('apply_offline');
      this.service.clear('fetch_offline');
      return;
    }
    // The apply helper: never seen = not set up, no alert.
    const a = cleanup.sidecar(now);
    if (!a.online && a.lastSeenAt !== null) {
      const summary = "The cleanup's apply helper is offline";
      if (
        this.service.observe('apply_offline', 'apply_offline', {
          startAt: a.lastSeenAt,
          waitMs: settings.waits.applyHelperMinutes * 60_000,
          summary,
        })
      ) {
        this.messages.push({
          event: 'apply_offline',
          lines: [
            `${summary} (last seen ${hoursText(now - a.lastSeenAt)} ago)`,
            'Calibre cleanup batches wait until it is back.',
          ],
          link: LINKS.cleanup,
        });
      }
    } else {
      this.service.clear('apply_offline');
    }

    // The fetch helper matters only while stage 4 has requests waiting.
    const f = cleanup.fetcher(now);
    if ((!f.online || f.problem) && this.stage4HasWork()) {
      const summary = !f.online
        ? "The cleanup's fetch helper is offline while stage 4 has requests waiting"
        : `The cleanup's fetch helper reports a problem: ${clip(f.problem ?? '', 140)}`;
      if (
        this.service.observe('fetch_offline', 'fetch_offline', {
          startAt: !f.online && f.lastSeenAt !== null ? f.lastSeenAt : undefined,
          waitMs: settings.waits.fetchHelperMinutes * 60_000,
          summary,
        })
      ) {
        this.messages.push({
          event: 'fetch_offline',
          lines: [summary, 'Online sources (stage 4) wait until it is back.'],
          link: LINKS.cleanup,
        });
      }
    } else {
      this.service.clear('fetch_offline');
    }
  }

  /**
   * A stage 4 is not off (the Calibre cleanup's, or the audiobook cleanup's, WP21c: both ask
   * through the one fetch helper) and fetch requests are queued or out (index
   * fetch_requests_lease).
   */
  private stage4HasWork(): boolean {
    const db = this.s.cleanupDb;
    if (!db) return false;
    const st = db.prepare('SELECT mode FROM stages WHERE stage = 4').get() as
      | { mode: string }
      | undefined;
    let audio: { mode: string } | undefined;
    try {
      audio = db.prepare('SELECT mode FROM audio_stages WHERE stage = 4').get() as
        | { mode: string }
        | undefined;
    } catch {
      audio = undefined;
    }
    if ((!st || st.mode === 'off') && (!audio || audio.mode === 'off')) return false;
    return !!db
      .prepare("SELECT 1 FROM fetch_requests WHERE state IN ('queued', 'leased') LIMIT 1")
      .get();
  }

  /** Automatic field pauses of stages 2 and 4: a digest line when one starts or ends. */
  private fieldPauses(): void {
    const db = this.s.cleanupDb;
    if (!db) return;
    const rows = db
      .prepare(
        'SELECT stage, field, reason, paused_at FROM stage_field_pauses WHERE stage IN (2, 4)',
      )
      .all() as { stage: number; field: string; reason: string; paused_at: number }[];
    type Seen = { key: string; stage: number; field: string; reason: string };
    const current: Seen[] = rows.map((r) => ({
      key: `${r.stage}|${r.field}|${r.reason}|${r.paused_at}`,
      stage: r.stage,
      field: r.field,
      reason: r.reason,
    }));
    const before = this.service.store.getState<Seen[]>('field_pauses');
    this.service.store.setState('field_pauses', current);
    if (!before) return;
    const was = new Set(before.map((p) => p.key));
    const is = new Set(current.map((p) => p.key));
    for (const p of current) {
      if (was.has(p.key)) continue;
      this.service.addDigestLine(
        'field_pauses',
        `Calibre cleanup stage ${p.stage}: "${p.field}" paused (${FIELD_PAUSE_TEXT[p.reason] ?? p.reason.replace(/_/g, ' ')})`,
        LINKS.cleanup,
      );
    }
    for (const p of before) {
      if (is.has(p.key)) continue;
      // Paused again for another reason right away: only the new pause is worth a line.
      if (current.some((c) => c.stage === p.stage && c.field === p.field)) continue;
      this.service.addDigestLine(
        'field_pauses',
        `Calibre cleanup stage ${p.stage}: "${p.field}" resumed`,
        LINKS.cleanup,
      );
    }
  }

  /**
   * Series-order follow-up (the user, 2026-11-22: "I should know which items were a best guess
   * so an issue like this doesn't go unnoticed again"): the values stage 4 writes as best guesses
   * give one digest line per check, counted from each newly applied stage-4 batch (field_undo by
   * its batch key, then each change by its id). The first look only remembers where it is.
   */
  private stage4Guesses(): void {
    const db = this.s.cleanupDb;
    if (!db) return;
    const last = this.service.store.getState<number>('stage4_guess_batches');
    let batches: { id: string; finished_at: number }[];
    try {
      batches = db
        .prepare(
          `SELECT id, finished_at FROM batches
           WHERE stage = 4 AND kind = 'apply' AND state IN ('applied', 'partial') AND finished_at > ?
           ORDER BY finished_at`,
        )
        .all(last ?? 0) as typeof batches;
    } catch {
      return;
    }
    if (batches.length)
      this.service.store.setState('stage4_guess_batches', batches[batches.length - 1].finished_at);
    else if (last === undefined) this.service.store.setState('stage4_guess_batches', 0);
    if (last === undefined || !batches.length) return;
    let values = 0;
    let numbers = 0;
    const count = db.prepare(
      `SELECT p.field AS field, COUNT(*) AS n FROM field_undo f JOIN proposed_changes p ON p.id = f.change_id
       WHERE f.batch_id = ? AND json_extract(p.evidence_json, '$.unconfirmed') = 1 GROUP BY p.field`,
    );
    for (const b of batches)
      for (const r of count.all(b.id) as { field: string; n: number }[]) {
        values += r.n;
        if (r.field === 'series') numbers += r.n;
      }
    if (values === 0) return;
    this.service.addDigestLine(
      'cleanup_best_guesses',
      `Calibre cleanup stage 4: ${values} ${plural(values, 'value', 'values')} written as best guesses${
        numbers ? ` (${numbers} series ${plural(numbers, 'number', 'numbers')})` : ''
      }: listed under Best guesses`,
      LINKS.cleanup,
    );
  }

  /**
   * WP21f-1: each finished run of the audiobook cleanup's daily new arrivals (stage 7) gives
   * one digest line (the audiobook daily summary) and, when it added new review items, one
   * alert. The first look only remembers the last run.
   */
  private arrivalRuns(): void {
    const db = this.s.cleanupDb;
    if (!db) return;
    let rows: { id: number; mode: string; report_json: string | null }[];
    try {
      rows = db
        .prepare(
          `SELECT id, mode, report_json FROM audio_arrival_runs WHERE state = 'done' AND id > ? ORDER BY id`,
        )
        .all(this.service.store.getState<number>('arrival_runs') ?? 0) as typeof rows;
    } catch {
      return; // cleanup.db before WP21f-1
    }
    const first = this.service.store.getState<number>('arrival_runs') === undefined;
    if (rows.length) this.service.store.setState('arrival_runs', rows[rows.length - 1].id);
    else if (first) this.service.store.setState('arrival_runs', 0);
    if (first) return;
    for (const r of rows) {
      const rep = r.report_json ? (JSON.parse(r.report_json) as ArrivalReport) : null;
      if (!rep) continue;
      const o = rep.outcomes ?? {};
      const parts = [
        r.mode === 'on' ? `${rep.added} added` : `${rep.planned} would be added (Preview)`,
        o.duplicate || o.identical
          ? `${(o.duplicate ?? 0) + (o.identical ?? 0)} copies recorded`
          : null,
        o.waiting ? `${o.waiting} waiting` : null,
        o.held ? `${o.held} held` : null,
        rep.newReview ? `${rep.newReview} new to look at` : null,
      ].filter((x): x is string => x !== null);
      this.service.addDigestLine(
        'audio_arrivals_summary',
        `New audiobooks: ${parts.join(', ')}`,
        LINKS.audioCleanup,
      );
      if (rep.newReview > 0)
        this.messages.push({
          event: 'audio_arrivals_review',
          lines: [
            `New audiobooks: ${rep.newReview} ${plural(rep.newReview, 'item', 'items')} to look at (better copies, held files, archives)`,
            r.mode === 'on' ? `${rep.added} added in this run` : 'Preview run: nothing was added',
          ],
          link: LINKS.audioCleanup,
        });
    }
  }

  /**
   * WP20g: each finished run of the Calibre library's new arrivals gives one digest line and,
   * when it found new review items, one alert. The first look only remembers the last run.
   */
  private bookArrivalRuns(): void {
    const db = this.s.cleanupDb;
    if (!db) return;
    let rows: { id: number; mode: string; report_json: string | null }[];
    try {
      rows = db
        .prepare(
          `SELECT id, mode, report_json FROM calibre_arrival_runs WHERE state = 'done' AND id > ? ORDER BY id`,
        )
        .all(this.service.store.getState<number>('book_arrival_runs') ?? 0) as typeof rows;
    } catch {
      return; // cleanup.db before WP20g
    }
    const first = this.service.store.getState<number>('book_arrival_runs') === undefined;
    if (rows.length) this.service.store.setState('book_arrival_runs', rows[rows.length - 1].id);
    else if (first) this.service.store.setState('book_arrival_runs', 0);
    if (first) return;
    for (const r of rows) {
      const rep = r.report_json
        ? (JSON.parse(r.report_json) as {
            added: number;
            hand: number;
            outcomes: Record<string, number>;
            newReview: number;
            aiCost: number;
            bestGuesses: number;
            estimate: { books: number } | null;
          })
        : null;
      if (!rep) continue;
      const o = rep.outcomes ?? {};
      const copies = (o.identical ?? 0) + (o.duplicate ?? 0);
      const notImported = (o.not_imported ?? 0) + (o.unreadable ?? 0);
      const parts = [
        r.mode === 'on'
          ? `${rep.added} added`
          : `${rep.estimate?.books ?? 0} would be added (Preview)`,
        rep.hand ? `${rep.hand} added in Calibre checked` : null,
        copies ? `${copies} copies of library books not added` : null,
        notImported ? `${notImported} not imported` : null,
        rep.bestGuesses ? `${rep.bestGuesses} series numbers best guesses` : null,
        rep.aiCost ? `AI $${rep.aiCost.toFixed(2)}` : null,
        rep.newReview ? `${rep.newReview} new to look at` : null,
      ].filter((x): x is string => x !== null);
      if (parts.length === 1 && rep.added === 0 && !rep.estimate?.books) continue;
      this.service.addDigestLine(
        'calibre_arrivals_summary',
        `New books: ${parts.join(', ')}`,
        LINKS.cleanup,
      );
      if (rep.newReview > 0)
        this.messages.push({
          event: 'calibre_arrivals_review',
          lines: [
            `New books: ${rep.newReview} ${plural(rep.newReview, 'item', 'items')} to look at (better copies, archives, adds that failed)`,
            r.mode === 'on' ? `${rep.added} added in this run` : 'Preview run: nothing was added',
          ],
          link: LINKS.cleanup,
        });
    }
  }

  // ---- refused changes ----

  private refusalsQuiet(settings: NotificationSettings, now: number): void {
    const quiet = settings.waits.refusalQuietHours * 3_600_000;
    for (const p of this.service.store.problemsOf('sync_refused')) {
      if (p.resolved_at === null && now - p.last_active_at >= quiet) this.service.clear(p.key);
    }
  }
}
