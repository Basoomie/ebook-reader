/**
 * What /cleanup shows of audiobook stage 4 (WP21c): each site's queue, pace and time left, the
 * units by state and class, and the lists (paged). Read-only. Every query here is on an index
 * (see the EXPLAIN test); the counts over the whole queue are limited to the audio sites.
 */
import type Database from 'better-sqlite3';
import { getSettings, AUDIO_FETCH_SITES, type AudioFetchSite } from '../settings';
import { paceSeconds } from '../stage4/eta';
import { backoffKey } from '../stage4/queue';
import { ungzRecord, type AudioStage4Progress, type UnitInputs } from './stage4-online';

/**
 * Requests per decided unit, per site, from the reference sample's stand-in run (stop 1): the
 * time left uses them until the live run has decided enough units to measure its own.
 */
export const REFERENCE_PER_UNIT: Record<AudioFetchSite, number> = {
  audible: 1.6,
  'audible-sample': 0.002,
  kikubon: 0.08,
  audiobookjp: 0.1,
  'audiobookjp-sample': 0.002,
};
/** Units decided before the live run's own ratios are used. */
const MEASURE_AFTER_UNITS = 200;

export interface AudioSiteLine {
  site: AudioFetchSite;
  enabled: boolean;
  intervalSeconds: number;
  queued: number;
  leased: number;
  done: number;
  gone: number;
  failed: number;
  attempts: number;
  refused: number;
  errors: number;
  busy: number;
  recent: { requests: number; errors: number; avgMs: number | null } | null;
  secondsPerRequest: number;
  /** Requests still expected (queued now + those the open units will still ask). */
  expected: number;
  secondsLeft: number;
  pausedReason: string | null;
  backoffUntil: number | null;
  backoffReason: string | null;
}

export function audioSiteLines(
  db: Database.Database,
  p: AudioStage4Progress | null,
  now = Date.now(),
): { sites: AudioSiteLine[]; secondsLeft: number | null; ratios: string } {
  const s = getSettings(db).fetch;
  const sites = AUDIO_FETCH_SITES as readonly AudioFetchSite[];
  const marks = sites.map(() => '?').join(', ');
  const counts = db
    .prepare(
      `SELECT site, state, COUNT(*) AS n FROM fetch_requests WHERE site IN (${marks}) GROUP BY site, state`,
    )
    .all(...sites) as { site: string; state: string; n: number }[];
  const recent = db.prepare(
    `SELECT COUNT(*) AS n, SUM(outcome = 'error') AS errors, AVG(ms) AS ms FROM fetch_attempts
     WHERE site = ? AND at >= ?`,
  );
  const totals = db.prepare(
    'SELECT attempts AS n, challenges, errors, busy FROM fetch_sites WHERE site = ?',
  );
  const lastAttempts = db.prepare(
    `SELECT a.at, r.created_at AS created FROM fetch_attempts a
     JOIN fetch_requests r ON r.id = a.request_id
     WHERE a.site = ? ORDER BY a.at DESC LIMIT 501`,
  );
  const oldestOpen = db.prepare(
    `SELECT MIN(created_at) AS m FROM fetch_requests WHERE site = ? AND state IN ('queued', 'leased')`,
  );
  const siteRow = db.prepare('SELECT * FROM fetch_sites WHERE site = ?');
  const idleMs = (s.challengeBackoffMaxSeconds + 60) * 1000;
  // Units still to decide, and the requests per decided unit (the live run's own once enough
  // units are decided; the stand-in run's before).
  const open = p
    ? (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM audio_online_units WHERE analysis_id = ? AND kind = 'lookup'
             AND state NOT IN ('decided', 'error')`,
          )
          .get(p.analysisId) as { n: number }
      ).n
    : 0;
  const decidedLookups = p
    ? (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM audio_online_units WHERE analysis_id = ? AND kind = 'lookup'
             AND state = 'decided'`,
          )
          .get(p.analysisId) as { n: number }
      ).n
    : 0;
  const own = decidedLookups >= MEASURE_AFTER_UNITS;
  const lines = sites.map((site): AudioSiteLine => {
    const by = (st: string) => counts.find((c) => c.site === site && c.state === st)?.n ?? 0;
    const r = recent.get(site, now - 20 * 60_000) as {
      n: number;
      errors: number | null;
      ms: number | null;
    };
    const t = totals.get(site) as
      | { n: number; challenges: number; errors: number; busy: number }
      | undefined;
    const row = siteRow.get(backoffKey(site)) as
      | {
          paused_reason: string | null;
          backoff_until: number | null;
          backoff_reason: string | null;
        }
      | undefined;
    const conf = s.sites[site];
    const pace = paceSeconds(
      lastAttempts.all(site) as { at: number; created: number }[],
      () => (oldestOpen.get(site) as { m: number | null }).m,
      idleMs,
    );
    const perRequest = Math.max(pace ?? conf.intervalSeconds, 0.1);
    const finished = by('done') + by('gone') + by('failed');
    const perUnit =
      own && decidedLookups > 0 ? finished / decidedLookups : REFERENCE_PER_UNIT[site];
    const queued = by('queued') + by('leased');
    const expected = Math.round(queued + perUnit * open);
    return {
      site,
      enabled: conf.enabled,
      intervalSeconds: conf.intervalSeconds,
      queued: by('queued'),
      leased: by('leased'),
      done: by('done'),
      gone: by('gone'),
      failed: by('failed'),
      attempts: t?.n ?? 0,
      refused: t?.challenges ?? 0,
      errors: t?.errors ?? 0,
      busy: t?.busy ?? 0,
      recent: r.n
        ? { requests: r.n, errors: r.errors ?? 0, avgMs: r.ms === null ? null : Math.round(r.ms) }
        : null,
      secondsPerRequest: Math.round(perRequest * 10) / 10,
      expected,
      secondsLeft: conf.enabled ? Math.round(expected * perRequest) : 0,
      pausedReason: row?.paused_reason ?? null,
      backoffUntil: row?.backoff_until && row.backoff_until > now ? row.backoff_until : null,
      backoffReason: row?.backoff_until && row.backoff_until > now ? row.backoff_reason : null,
    };
  });
  // The sites run side by side: the lookups take as long as the slowest.
  const secondsLeft =
    p && p.phase === 'lookups' ? Math.max(0, ...lines.map((l) => l.secondsLeft)) : null;
  return {
    sites: lines,
    secondsLeft,
    ratios: own ? `measured on ${decidedLookups} decided books` : 'from the reference sample',
  };
}

/** Units per state (for the progress line). */
export function unitStates(db: Database.Database, analysisId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db
    .prepare(
      `SELECT state, labeled, COUNT(*) AS n FROM audio_online_units WHERE analysis_id = ? GROUP BY state, labeled`,
    )
    .all(analysisId) as { state: string; labeled: number; n: number }[]) {
    out[r.state] = (out[r.state] ?? 0) + r.n;
    if (r.labeled) out[`labeled:${r.state}`] = (out[`labeled:${r.state}`] ?? 0) + r.n;
  }
  return out;
}

export type OnlineList =
  | 'auto'
  | 'review'
  | 'unknown'
  | 'none_expected'
  | 'error'
  | 'gate'
  | `auto:${string}`
  | `review:${string}`;

/** A list of units (paged) with the store record found and each candidate's checks. */
export function onlineList(
  db: Database.Database,
  p: AudioStage4Progress,
  list: string,
  { offset = 0, limit = 50 }: { offset?: number; limit?: number } = {},
): { total: number; items: Record<string, unknown>[] } {
  if (list === 'gate') {
    const results = p.gate?.results ?? [];
    return {
      total: results.length,
      items: results.slice(offset, offset + limit) as unknown as Record<string, unknown>[],
    };
  }
  let where: string;
  const params: unknown[] = [p.analysisId];
  if (list === 'auto' || list === 'review' || list === 'unknown' || list === 'none_expected') {
    where = `analysis_id = ? AND class = ?`;
    params.push(list);
  } else if (list === 'error') {
    where = `analysis_id = ? AND state = 'error'`;
  } else if (list.startsWith('auto:')) {
    where = `analysis_id = ? AND class = 'auto' AND source = ?`;
    params.push(list.slice(5));
  } else if (list.startsWith('review:')) {
    where = `analysis_id = ? AND class = 'review' AND review_reason = ?`;
    params.push(list.slice(7));
  } else throw new Error('No such list');
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM audio_online_units WHERE ${where}`).get(...params) as {
      n: number;
    }
  ).n;
  const rows = db
    .prepare(
      `SELECT id, unit_key, name, seconds, labeled, kind, state, class, source, store_id, review_reason,
         detail, error, inputs_json, copy_keys FROM audio_online_units WHERE ${where}
       ORDER BY labeled DESC, id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as {
    id: number;
    unit_key: string;
    name: string;
    seconds: number | null;
    labeled: number;
    kind: string;
    state: string;
    class: string | null;
    source: string | null;
    store_id: string | null;
    review_reason: string | null;
    detail: string | null;
    error: string | null;
    inputs_json: string;
    copy_keys: string;
  }[];
  const cands = db.prepare(
    `SELECT source, store_id, via, checks_json, verdict, sample_score FROM audio_online_candidates
     WHERE unit_id = ? ORDER BY id LIMIT 12`,
  );
  const record = db.prepare(
    'SELECT record FROM audio_online_records WHERE source = ? AND store_id = ?',
  );
  const brief = (source: string, id: string) => {
    const r = record.get(source, id) as { record: Buffer } | undefined;
    if (!r) return null;
    const rec = ungzRecord(r.record);
    return {
      title: rec.title,
      authors: rec.authors,
      narrators: rec.narrators,
      seconds: rec.seconds,
      publisher: rec.publisher,
      releaseDate: rec.releaseDate,
      series: rec.series,
    };
  };
  return {
    total,
    items: rows.map((r) => {
      const inputs = JSON.parse(r.inputs_json) as UnitInputs;
      return {
        id: r.id,
        name: r.name,
        seconds: r.seconds,
        labeled: r.labeled === 1,
        kind: r.kind,
        state: r.state,
        class: r.class,
        source: r.source,
        storeId: r.store_id,
        reason: r.review_reason,
        detail: r.detail,
        error: r.error,
        copies: (JSON.parse(r.copy_keys) as string[]).length,
        file: {
          title: inputs.facts.title,
          authors: inputs.facts.authors,
          narrators: inputs.facts.narrators,
          volume: inputs.facts.volume,
          drama: inputs.facts.drama,
          seconds: inputs.facts.seconds,
          files: inputs.facts.files,
          paths: inputs.paths.slice(0, 5),
          asins: inputs.asins,
          absAsins: inputs.absAsins,
          queries: inputs.queries,
        },
        record: r.source && r.store_id ? brief(r.source, r.store_id) : null,
        candidates: (
          cands.all(r.id) as {
            source: string;
            store_id: string;
            via: string;
            checks_json: string;
            verdict: string;
            sample_score: number | null;
          }[]
        ).map((c) => ({
          source: c.source,
          storeId: c.store_id,
          via: c.via,
          verdict: c.verdict,
          sampleScore: c.sample_score,
          checks: (JSON.parse(c.checks_json) as { checks: unknown }).checks,
          record: brief(c.source, c.store_id),
        })),
      };
    }),
  };
}
