/**
 * Audiobook stage 5's question to the models (WP21d): the system prompt (the framework's shared
 * rules plus the audiobook rules the user confirmed), the evidence as text, the answer format,
 * and the fields as the framework compares them.
 */
import { NA, N, lightNormalize, normalizeName } from '../title-rules';
import { evidenceForm } from '../ai/combine';
import { systemPrompt } from '../ai/prompt-blocks';
import type { AiField, AiStageSpec } from '../ai/types';
import type { CandidateBrief, MetaEvidence, RecordBrief } from './meta-evidence';
import type { SeriesEntry } from './meta-rules';

/** Raised whenever the prompt, the evidence text or the schema changes. */
export const META_PROMPT_VERSION = 'audio5-v1';

const INTRO = `You fix metadata for a Japanese audiobook library (Audible, audiobook.jp and kikubon
recordings, drama CDs, some AI-read audiobooks and radio clips). You get evidence about ONE
recording: its file and folder names, the file's tags, its length, and the store record(s) an
earlier lookup found (Audible's catalog, kikubon or audiobook.jp). Decide what is true for THIS
recording.`;

const RULES = [
  '- record: when "Store records to choose from" are listed, the id of the one that is this ' +
    'recording (same work, same volume, same reading: title, authors, narrators and length must ' +
    'fit), or null if none is. When only "Store record" is given, answer its id if it is this ' +
    'recording, else null. With no store record, null.',
  "- title: the work's real title with its volume number and a real subtitle. Remove " +
    "Audible's prefixes ([17巻], [5.5巻], [9巻・短編集], [CD9]), store and edition markers " +
    '(【電子特典付き】), imprint and label names (ガガガ文庫, HJ文庫(ホビージャパン), 幻冬舎新書, ' +
    '(小学館ジュニア文庫), (KADOKAWA)), a publisher after a colon, and a collection name in ＜…＞. ' +
    "Audible's subtitle is usually a publisher, label or series name: include it only when it is " +
    'a real subtitle printed with the title.',
  '- authors: every real author, in the order the source lists them. The original author (原作) ' +
    'counts. Translators (訳, 翻訳, the modern-language translator of a classic), supervisors ' +
    '(監修), editors, illustrators, narrators, publishers and companies are NEVER authors, even ' +
    'when the store lists them as authors without a role (ホモ・デウス: 柴田裕之 is the ' +
    'translator; 源氏物語: 与謝野晶子 is the translator; the author is 紫式部). Use the ' +
    'description and the original author to tell. [] when no real author is credited.',
  '- narrators: the people who read this recording, from the store record (the composer tag of ' +
    'the file is often wrong).',
  "- series: every series the recording belongs to, with its reading-order position. Audible's " +
    '"position" is usually right but not always: the position follows the real reading order ' +
    '(a sequel is not 1). Imprints and labels (…文庫, …新書) are never series. A drama CD (Audible ' +
    'series "[CD] X" or "X ドラマCD") is in "X ドラマCD" with its number AND in "X" with ' +
    'position null. Keep an anthology series as an extra series. Side volumes (外伝, 番外編, ' +
    '短編集) take the position the reading order gives them, or null when it is not clear. [] ' +
    'when the recording is in no series; null when it cannot be told.',
  '- drama: true for a drama CD / audio drama (several voice actors performing a script), false ' +
    'for a reading.',
];

const ANSWER = `Answer with ONLY this JSON object, no prose:
{"record": str|null, "title": str|null, "authors": [str]|null, "narrators": [str]|null,
 "series": [{"name": str, "position": number|null, "label": str|null}]|null, "drama": bool|null,
 "confidence": {"record": "high|low", "title": "high|low", "authors": "high|low",
                "narrators": "high|low", "series": "high|low", "drama": "high|low"}}`;

export const META_SYSTEM = systemPrompt({ intro: INTRO, rules: RULES, answerFormat: ANSWER });

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const conf = { type: 'string', enum: ['high', 'low'] };

export const META_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['record', 'title', 'authors', 'narrators', 'series', 'drama', 'confidence'],
  properties: {
    record: nullable({ type: 'string' }),
    title: nullable({ type: 'string' }),
    authors: nullable({ type: 'array', items: { type: 'string' } }),
    narrators: nullable({ type: 'array', items: { type: 'string' } }),
    series: nullable({
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'position', 'label'],
        properties: {
          name: { type: 'string' },
          position: nullable({ type: 'number' }),
          label: nullable({ type: 'string' }),
        },
      },
    }),
    drama: nullable({ type: 'boolean' }),
    confidence: {
      type: 'object',
      additionalProperties: false,
      required: ['record', 'title', 'authors', 'narrators', 'series', 'drama'],
      properties: {
        record: conf,
        title: conf,
        authors: conf,
        narrators: conf,
        series: conf,
        drama: conf,
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
// evidence as text

const DESC_CHARS = 1500;

function recordLines(r: RecordBrief, withDescription: boolean): string[] {
  const lines = [
    `id: ${r.id}`,
    `title: ${r.title}`,
    `subtitle: ${r.subtitle ?? '(none)'}`,
    `authors as listed: ${r.authors.length ? r.authors.join(' / ') : '(none)'}`,
    `narrators: ${r.narrators.length ? r.narrators.join(' / ') : '(none)'}`,
    `length: ${r.minutes ?? '?'} min`,
    `publisher: ${r.publisher ?? '?'}`,
    `release date: ${r.releaseDate ?? '?'}`,
  ];
  if (r.format) lines.push(`format: ${r.format}`);
  if (r.categories.length) lines.push(`categories: ${r.categories.join(' | ')}`);
  lines.push(
    `series: ${
      r.series.length
        ? r.series
            .map((s) => `${s.name} (printed "${s.sequence ?? '-'}", position ${s.sort ?? '?'})`)
            .join('; ')
        : r.source === 'audible'
          ? '(none)'
          : '(this store has no series data)'
    }`,
  );
  if (r.fromSearchPage) lines.push('(only the search result line was read)');
  if (withDescription && r.description)
    lines.push(`description: ${r.description.replace(/\s+/g, ' ').slice(0, DESC_CHARS)}`);
  return lines;
}

function candidateLines(c: CandidateBrief): string[] {
  return [
    ...recordLines(c.record, true),
    `lookup checks: ${c.verdict === 'pass' ? 'all passed' : c.verdict.replace(/^fail:/, 'failed: ')}`,
    ...(c.sampleScore !== null ? [`sample audio score: ${c.sampleScore.toFixed(2)}`] : []),
  ];
}

export function metaUserText(ev: MetaEvidence): string {
  const lines: string[] = ['## The recording'];
  lines.push(`name: ${ev.name}`);
  lines.push(`paths: ${ev.paths.join(' | ')}`);
  if (ev.otherTitles.length) lines.push(`other names: ${ev.otherTitles.join(' | ')}`);
  lines.push(`length: ${ev.minutes ?? '?'} min in ${ev.files} file(s); copies of it: ${ev.copies}`);
  if (ev.tags)
    lines.push(
      'file tags: ' +
        Object.entries(ev.tags)
          .map(([k, v]) => `${k}=${v.replace(/\s+/g, ' ').slice(0, 300)}`)
          .join('; '),
    );
  else lines.push('file tags: (none)');
  if (ev.kind === 'ai') lines.push('kind: an AI-read audiobook (no store record exists)');
  if (ev.kind === 'radio') lines.push('kind: a radio bonus clip (no store record exists)');
  if (ev.record && ev.stage4.class === 'auto') {
    lines.push('', '## Store record (found by the lookup; all its checks passed)');
    lines.push(...recordLines(ev.record, true));
  } else if (ev.candidates.length) {
    lines.push(
      '',
      `## Store records to choose from (the lookup was unsure: ${ev.stage4.reason ?? 'review'})`,
    );
    for (const c of ev.candidates) lines.push('', ...candidateLines(c));
  } else if (ev.kind === 'no_record') {
    lines.push('', '## Store record', '(none found)');
  }
  return lines.join('\n');
}

/** Everything a model may take values from (the never-invent check). */
export function metaEvidenceText(ev: MetaEvidence): string {
  return evidenceForm(metaUserText(ev));
}

// ---------------------------------------------------------------------------------------------
// the answer

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.map(str).filter((x): x is string => x !== null) : null;

export function parseMetaAnswer(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const series = Array.isArray(a.series)
    ? (a.series as unknown[])
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .map((s) => ({
          name: str(s.name) ?? '',
          position:
            typeof s.position === 'number' && Number.isFinite(s.position)
              ? s.position
              : typeof s.position === 'string' && Number.isFinite(Number(s.position))
                ? Number(s.position)
                : null,
          label: str(s.label),
        }))
        .filter((s) => s.name)
    : a.series === null
      ? null
      : undefined;
  if (series === undefined && 'series' in a) return null;
  return {
    record: str(a.record),
    title: str(a.title),
    authors: a.authors === null ? null : strList(a.authors),
    narrators: a.narrators === null ? null : strList(a.narrators),
    series: series ?? null,
    drama: typeof a.drama === 'boolean' ? a.drama : null,
    confidence: a.confidence && typeof a.confidence === 'object' ? a.confidence : {},
  };
}

// ---------------------------------------------------------------------------------------------
// fields

/** The bake-off's title comparison (rules' N, also ignoring 〈〉《》 and similar). */
export function titleKey(t: string): string {
  return (N(t) ?? '').replace(/[〈〉《》<>─—–‒,、]/gu, '');
}

const nameSet = (l: string[]) =>
  [...new Set(l.map((x) => NA(x).replace(/[・･=＝]/gu, '')))].sort().join('|');

export function sameNames(a: string[], b: string[]): boolean {
  return nameSet(a) === nameSet(b);
}

export function seriesKey(l: SeriesEntry[]): string {
  return [...new Set(l.map((s) => `${titleKey(s.name)}#${s.position ?? '-'}`))].sort().join('|');
}

/** A series name without the " ドラマCD" the rules add (the evidence holds "[CD] X"). */
const seriesBase = (n: string) => n.replace(/\s*ドラマ\s*CD\s*$/iu, '');

export const META_FIELDS: {
  record: AiField<string>;
  title: AiField<string>;
  authors: AiField<string[]>;
  narrators: AiField<string[]>;
  series: AiField<SeriesEntry[]>;
  drama: AiField<boolean>;
} = {
  record: {
    name: 'record',
    fromAnswer: (a) => str(a.record) ?? undefined,
    same: (x, y) => x === y,
    strings: (v) => [v],
  },
  title: {
    name: 'title',
    fromAnswer: (a) => {
      const t = str(a.title);
      return t ? lightNormalize(t) : undefined;
    },
    same: (x, y) => titleKey(x) === titleKey(y),
    strings: (v) => [v],
  },
  authors: {
    name: 'authors',
    fromAnswer: (a) =>
      Array.isArray(a.authors) ? (a.authors as string[]).map((x) => normalizeName(x)) : undefined,
    same: sameNames,
    strings: (v) => v,
  },
  narrators: {
    name: 'narrators',
    fromAnswer: (a) =>
      Array.isArray(a.narrators) && (a.narrators as string[]).length
        ? (a.narrators as string[]).map((x) => normalizeName(x))
        : undefined,
    same: sameNames,
    strings: (v) => v,
  },
  series: {
    name: 'series',
    fromAnswer: (a) =>
      Array.isArray(a.series)
        ? (a.series as SeriesEntry[]).map((s) => ({ ...s, name: lightNormalize(s.name) }))
        : undefined,
    same: (x, y) => seriesKey(x) === seriesKey(y),
    strings: (v) => v.map((s) => seriesBase(s.name)).filter(Boolean),
  },
  drama: {
    name: 'drama',
    fromAnswer: (a) => (typeof a.drama === 'boolean' ? a.drama : undefined),
    same: (x, y) => x === y,
  },
};

/** The stage as the AI framework asks it. */
export const META_SPEC: AiStageSpec<MetaEvidence> = {
  stage: 'audio5',
  promptVersion: META_PROMPT_VERSION,
  tasks: {
    primary: 'audio5.primary',
    secondary: 'audio5.secondary',
    upgradePrimary: 'audio5.upgradePrimary',
    upgradeSecondary: 'audio5.upgradeSecondary',
  },
  system: META_SYSTEM,
  userText: metaUserText,
  schema: META_SCHEMA,
  schemaName: 'audiobook_metadata',
  parseAnswer: parseMetaAnswer,
  evidenceText: metaEvidenceText,
};
