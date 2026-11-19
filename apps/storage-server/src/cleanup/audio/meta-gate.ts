/**
 * Stage 5's gate (WP21d): every field scored against the labeled books (labels.json "books",
 * fields title, authors, narrators, series, drama, multi_narr). The target is the bar per field
 * (setting, 95 %) on the AUTOMATIC values (the rules', or both models agreeing); flagged values
 * (best guesses) are scored and shown separately. A miss is an automatic value that differs
 * from its label, listed with its evidence. Labels are never changed here. Pure.
 */
import { sameNames, seriesKey, titleKey } from './meta-prompt';
import type { SeriesEntry } from './meta-rules';

export const GATE_FIELDS = [
  'title',
  'authors',
  'narrators',
  'series',
  'drama',
  'multi_narr',
] as const;
export type MetaGateField = (typeof GATE_FIELDS)[number];

export interface MetaLabel {
  id: string;
  kind: string;
  torrent: string;
  title?: string | null;
  authors?: string[] | null;
  narrators?: string[] | null;
  /** [name, reading-order position, printed label]. */
  series?: [string, string | null, string | null][] | null;
  drama?: boolean | null;
  multi_narr?: boolean | null;
}

export interface GateValue {
  value: unknown;
  source: string;
  flagged: boolean;
  rules?: unknown;
  primary?: unknown;
  secondary?: unknown;
}

export interface MetaGateMiss {
  id: string;
  field: MetaGateField;
  expected: unknown;
  got: unknown;
  source: string;
  rules: unknown;
  primary: unknown;
  secondary: unknown;
  unitKey: string | null;
  name: string | null;
  record: string | null;
}

export interface MetaGateField_ {
  auto: number;
  autoRight: number;
  flagged: number;
  flaggedRight: number;
  percent: number | null;
  passed: boolean;
}

export interface MetaGateResult {
  passed: boolean;
  books: number;
  notFound: string[];
  fields: Record<MetaGateField, MetaGateField_>;
  misses: MetaGateMiss[];
  /** Flagged values that differ from their label (not misses: shown for the report). */
  flaggedWrong: MetaGateMiss[];
  error: string | null;
}

/** True when a value equals its label (undefined = the label has nothing to compare). */
export function labelAgrees(
  field: MetaGateField,
  label: MetaLabel,
  value: unknown,
): boolean | undefined {
  switch (field) {
    case 'title':
      if (!label.title) return undefined;
      return typeof value === 'string' && titleKey(value) === titleKey(label.title);
    case 'authors':
      if (!Array.isArray(label.authors)) return undefined;
      return Array.isArray(value) && sameNames(value as string[], label.authors);
    case 'narrators':
      if (!Array.isArray(label.narrators)) return undefined;
      return Array.isArray(value) && sameNames(value as string[], label.narrators);
    case 'series': {
      if (!Array.isArray(label.series)) return undefined;
      if (!Array.isArray(value)) return false;
      const want: SeriesEntry[] = label.series.map(([name, pos, lab]) => ({
        name,
        position: pos === null || pos === undefined || pos === '' ? null : Number(pos),
        label: lab,
      }));
      return seriesKey(value as SeriesEntry[]) === seriesKey(want);
    }
    case 'drama':
      if (typeof label.drama !== 'boolean') return undefined;
      return value === label.drama;
    case 'multi_narr':
      if (typeof label.multi_narr !== 'boolean') return undefined;
      return value === label.multi_narr;
  }
}

const AUTOMATIC = new Set(['rules', 'both_models', 'upgrade_models', 'user']);

export function scoreMetaGate(
  labels: MetaLabel[],
  unitOf: (torrent: string) => { unitKey: string; name: string; record: string | null } | null,
  valuesOf: (unitKey: string) => Partial<Record<MetaGateField, GateValue>>,
  barPercent: number,
  minBooks: number,
): MetaGateResult {
  const fields = Object.fromEntries(
    GATE_FIELDS.map((f) => [
      f,
      { auto: 0, autoRight: 0, flagged: 0, flaggedRight: 0, percent: null, passed: true },
    ]),
  ) as Record<MetaGateField, MetaGateField_>;
  const misses: MetaGateMiss[] = [];
  const flaggedWrong: MetaGateMiss[] = [];
  const notFound: string[] = [];
  for (const b of labels) {
    const u = unitOf(b.torrent);
    if (!u) {
      notFound.push(b.id);
      continue;
    }
    const vals = valuesOf(u.unitKey);
    for (const f of GATE_FIELDS) {
      const v = vals[f];
      if (!v) continue;
      const ok = labelAgrees(f, b, v.value);
      if (ok === undefined) continue;
      const auto = AUTOMATIC.has(v.source) && !v.flagged;
      const s = fields[f];
      if (auto) {
        s.auto++;
        if (ok) s.autoRight++;
      } else {
        s.flagged++;
        if (ok) s.flaggedRight++;
      }
      if (!ok) {
        const expected =
          f === 'title'
            ? b.title
            : f === 'multi_narr'
              ? b.multi_narr
              : (b as unknown as Record<string, unknown>)[f];
        const m: MetaGateMiss = {
          id: b.id,
          field: f,
          expected,
          got: v.value,
          source: v.source,
          rules: v.rules ?? null,
          primary: v.primary ?? null,
          secondary: v.secondary ?? null,
          unitKey: u.unitKey,
          name: u.name,
          record: u.record,
        };
        (auto ? misses : flaggedWrong).push(m);
      }
    }
  }
  let passed = true;
  for (const f of GATE_FIELDS) {
    const s = fields[f];
    s.percent = s.auto ? (100 * s.autoRight) / s.auto : null;
    s.passed = s.auto < minBooks || (s.percent ?? 0) >= barPercent;
    if (!s.passed) passed = false;
  }
  return { passed, books: labels.length, notFound, fields, misses, flaggedWrong, error: null };
}
