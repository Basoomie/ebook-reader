/**
 * Stage 5's lists for /cleanup (WP21d), paged: each recording with its fields' values, sources
 * and the unconfirmed mark. List only (no editing in WP21d, decided with the user 2026-11-19).
 *
 *   flagged          recordings with at least one unconfirmed field (most first)
 *   all              every recording
 *   labeled          the labeled books
 *   no_record        no store record (fields from the tags and names)
 *   ai               AI audiobooks and the radio clips
 *   gate             the labeled books whose automatic value differs from the label
 *   field:<f>:<src>  recordings whose field f came from source src (e.g. field:authors:both_models)
 */
import type Database from 'better-sqlite3';
import { valuesOf } from '../ai-decide/values';
import type { AudioStage5, AudioStage5Progress } from './stage5-meta';

const LONG = new Set(['description']);

interface MetaUnitRow {
  unit_key: string;
  name: string;
  labeled: number;
  kind: string;
  stage4_class: string | null;
  record: string | null;
  state: string;
  flagged: number;
  error: string | null;
}

export function metaList(
  db: Database.Database,
  p: AudioStage5Progress,
  list: string,
  opts: { offset?: number; limit?: number },
  stage: AudioStage5,
): { total: number; items: Record<string, unknown>[] } {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const cols =
    'm.unit_key, m.name, m.labeled, m.kind, m.stage4_class, m.record, m.state, m.flagged, m.error';
  let rows: MetaUnitRow[] = [];
  let total = 0;
  const page = (where: string, order: string, ...args: unknown[]) => {
    total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM audio_meta_units m WHERE m.analysis_id = ? AND ${where}`,
        )
        .get(p.analysisId, ...args) as { n: number }
    ).n;
    rows = db
      .prepare(
        `SELECT ${cols} FROM audio_meta_units m WHERE m.analysis_id = ? AND ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(p.analysisId, ...args, limit, offset) as MetaUnitRow[];
  };
  const field = /^field:([a-z_]+):([a-z_]+)$/.exec(list);
  if (list === 'flagged') page('m.flagged > 0', 'm.flagged DESC, m.unit_key');
  else if (list === 'all') page('1 = 1', 'm.unit_key');
  else if (list === 'labeled') page('m.labeled = 1', 'm.unit_key');
  else if (list === 'no_record') page(`m.kind = 'no_record'`, 'm.unit_key');
  else if (list === 'ai') page(`m.kind IN ('ai', 'radio')`, 'm.unit_key');
  else if (list === 'gate') {
    const keys = [
      ...new Set((p.gate?.misses ?? []).map((m) => m.unitKey).filter((k): k is string => !!k)),
    ];
    total = keys.length;
    const slice = keys.slice(offset, offset + limit);
    rows = slice.length
      ? (db
          .prepare(
            `SELECT ${cols} FROM audio_meta_units m WHERE m.analysis_id = ? AND m.unit_key IN (${slice.map(() => '?').join(',')})`,
          )
          .all(p.analysisId, ...slice) as MetaUnitRow[])
      : [];
  } else if (field) {
    const where = `m.unit_key IN (SELECT item_key FROM ai_values WHERE stage = 'audio5' AND field = ? AND source = ?)`;
    page(where, 'm.unit_key', field[1], field[2]);
  } else throw new Error('No such list');
  const misses = new Map<string, unknown[]>();
  for (const m of p.gate?.misses ?? []) {
    if (!m.unitKey) continue;
    const l = misses.get(m.unitKey) ?? [];
    l.push({ id: m.id, field: m.field, expected: m.expected, got: m.got, source: m.source });
    misses.set(m.unitKey, l);
  }
  void stage;
  return {
    total,
    items: rows.map((r) => ({
      unitKey: r.unit_key,
      name: r.name,
      labeled: r.labeled === 1,
      kind: r.kind,
      stage4Class: r.stage4_class,
      record: r.record,
      state: r.state,
      flagged: r.flagged,
      error: r.error,
      gateMisses: misses.get(r.unit_key) ?? [],
      fields: valuesOf(db, 'audio5', r.unit_key).map((v) => ({
        field: v.field,
        value: LONG.has(v.field) && typeof v.value === 'string' ? v.value.slice(0, 400) : v.value,
        source: v.source,
        flagged: v.flagged,
        reason: v.reason,
        rules: LONG.has(v.field) ? null : v.rules,
        primary: v.primary,
        secondary: v.secondary,
      })),
    })),
  };
}
