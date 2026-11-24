/**
 * The series recap, "story so far" (book summaries session 5; book-summaries.md "Series recap"):
 * how the writer and the checkers are asked (the shared AI layer's `AiStageSpec`).
 *
 * Written only from the covered volumes' current summary items (never the books), each point
 * citing the items it rests on; then each point is checked against the items it cites. Prompt
 * changes raise the stage's own version suffix (`.r1`, `.k1`), so nothing before is asked again.
 */
import type { AiEffort, AiStageSpec } from '../ai/types';
import { PROMPT_VERSION, TASKS, type ModelRole } from './specs';

const EFFORT: AiEffort = 'high';

/** One volume summary item as the writer and the checkers see it. */
export interface RecapEvidenceItem {
  /** "v<n>:<ref>": the covered volume's position (1-based) and the item's ref. */
  id: string;
  section: string;
  heading?: string;
  between?: [string, string];
  label?: string;
  /** Chapter by chapter: the chapter's title. */
  chapter?: string | null;
  text: string;
}

export interface RecapEvidence {
  series: string;
  lang: string;
  volumes: {
    /** "v<n>". */
    key: string;
    /** "Vol. 2", or the title when the volume has no number. */
    name: string;
    title: string;
    items: RecapEvidenceItem[];
    alsoMentioned: string[];
  }[];
  /** Covered volumes without a summary: never filled. */
  missing: { key: string; name: string; title: string }[];
}

const pointSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'cites'],
  properties: {
    text: { type: 'string' },
    cites: { type: 'array', items: { type: 'string' } },
  },
};
function withFields(extra: Record<string, unknown>, required: string[]) {
  return {
    ...pointSchema,
    required: [...required, ...pointSchema.required],
    properties: { ...extra, ...pointSchema.properties },
  };
}

const recapSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'overview',
    'volumes',
    'characters',
    'also_mentioned',
    'relationships',
    'terms',
    'threads',
  ],
  properties: {
    overview: pointSchema,
    volumes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['volume', 'items'],
        properties: {
          volume: { type: 'string' },
          items: { type: 'array', items: pointSchema },
        },
      },
    },
    characters: { type: 'array', items: withFields({ name: { type: 'string' } }, ['name']) },
    also_mentioned: { type: 'array', items: { type: 'string' } },
    relationships: {
      type: 'array',
      items: withFields(
        { a: { type: 'string' }, b: { type: 'string' }, label: { type: 'string' } },
        ['a', 'b', 'label'],
      ),
    },
    terms: { type: 'array', items: withFields({ term: { type: 'string' } }, ['term']) },
    threads: { type: 'array', items: pointSchema },
  },
};

export interface RecapPoint {
  text: string;
  cites: string[];
}
export interface RecapAnswer {
  overview: RecapPoint;
  volumes: { volume: string; items: RecapPoint[] }[];
  characters: (RecapPoint & { name: string })[];
  also_mentioned: string[];
  relationships: (RecapPoint & { a: string; b: string; label: string })[];
  terms: (RecapPoint & { term: string })[];
  threads: RecapPoint[];
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? (x.filter((s) => typeof s === 'string') as string[]) : [];
}
function point(x: Record<string, unknown> | undefined | null): RecapPoint | null {
  if (!x || typeof x !== 'object' || typeof x.text !== 'string') return null;
  return { text: x.text.trim(), cites: strings(x.cites) };
}
function list<T>(x: unknown, f: (r: Record<string, unknown>) => T | null): T[] {
  return Array.isArray(x)
    ? (x as Record<string, unknown>[]).map((r) => f(r)).filter((v): v is T => v !== null)
    : [];
}

export function parseRecap(raw: unknown): Record<string, unknown> | null {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== 'object') return null;
  const ov = point(r.overview as Record<string, unknown>);
  if (!ov) return null;
  const ans: RecapAnswer = {
    overview: ov,
    volumes: list(r.volumes, (v) =>
      typeof v.volume === 'string'
        ? { volume: v.volume.trim(), items: list(v.items, (i) => point(i)) }
        : null,
    ),
    characters: list(r.characters, (c) => {
      const p = point(c);
      return p && typeof c.name === 'string' ? { ...p, name: c.name.trim() } : null;
    }),
    also_mentioned: strings(r.also_mentioned),
    relationships: list(r.relationships, (c) => {
      const p = point(c);
      return p && typeof c.a === 'string' && typeof c.b === 'string'
        ? {
            ...p,
            a: c.a.trim(),
            b: c.b.trim(),
            label: typeof c.label === 'string' ? c.label.trim() : '',
          }
        : null;
    }),
    terms: list(r.terms, (c) => {
      const p = point(c);
      return p && typeof c.term === 'string' ? { ...p, term: c.term.trim() } : null;
    }),
    threads: list(r.threads, (c) => point(c)),
  };
  return ans as unknown as Record<string, unknown>;
}

function itemLine(i: RecapEvidenceItem): string {
  const head = i.heading
    ? `${i.heading}: `
    : i.between
      ? `${i.between[0]} / ${i.between[1]}${i.label ? ` (${i.label})` : ''}: `
      : '';
  const where = i.chapter ? `, ${i.chapter}` : '';
  return `${i.id} [${i.section}${where}] ${head}${i.text}`;
}

export function recapUserText(e: RecapEvidence): string {
  const vols = e.volumes
    .map(
      (v) =>
        `=== ${v.key}: ${v.name} ${v.title} ===\n${v.items.map(itemLine).join('\n')}${
          v.alsoMentioned.length ? `\n(also mentioned: ${v.alsoMentioned.join('、')})` : ''
        }`,
    )
    .join('\n\n');
  const missing = e.missing.length
    ? `\n\nVOLUMES WITHOUT A SUMMARY (nothing is known about them here; never guess what happens in them):\n${e.missing
        .map((m) => `${m.key}: ${m.name} ${m.title}`)
        .join('\n')}`
    : '';
  return `SERIES: ${e.series}\nLANGUAGE: ${e.lang}\n\n${vols}${missing}`;
}

export const RECAP_SPEC: AiStageSpec<RecapEvidence, ModelRole> = {
  stage: 'sum.recap',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}.r1`,
  tasks: TASKS,
  system: `You write the "story so far" of a book series for a reader about to continue it after a long break. You get the checked summaries of the volumes read so far, in series order (each item has an id, its volume, its section and its text). Write only from them: never from the books, other volumes, adaptations or what you know of the series.
Sections (leave a section empty when nothing belongs in it):
- overview: the series so far in a few sentences: the setting, the main characters and the main line from the first volume to the end of the last one, ending with where things stand now.
- volumes: per volume (its key, e.g. "v2"), a short plot: the few events that matter for what comes next, in order, with who did them. Each volume's items cite only that volume's items. A volume without a summary gets nothing (never guess what happens in it).
- characters: who's who now, at the end of the last volume: the person (looks, age, personality, role, every name they go by) and where they stand now. The most important first. Characters only mentioned go into also_mentioned as names only. Cite the item where the character first appears too.
- relationships: only ties that matter, as they stand now and how they got there. label: one or two words naming the relationship as it stands at the end of the last volume (師弟, 幼なじみ, 敵対).
- terms: words of the series' own world a reader must know, and what they mean now. Cite the item where the term first appears too.
- threads: only questions, promises and dangers still open at the end of the last volume. Drop a thread a later volume answers or resolves. Cite the item where it was first raised.
- Where volumes disagree, the later volume is the state now (a later item wins over an earlier one); say how it changed only when that matters.
- Who says, tells, gives or does what to whom: keep the speaker, the listener, the giver and the doer exactly as the items have them; when the items don't say who, name no one.
- Never add a "first", "only", "all", "both" or "never" the items don't state, and never make a detail stronger or weaker than the items have it.
- Every point must serve the reader: no filler, no repetition across sections, no target number or length; never leave out a turning point (a vow, a confession, a betrayal, a reveal).
- Each point cites the ids of the items it rests on (at least one) and says nothing they don't support.
Write in the language given (the summaries' language). Use names exactly as the items write them. Plain text: no line breaks, no ids inside the text.`,
  userText: recapUserText,
  schema: recapSchema,
  schemaName: 'story_so_far',
  parseAnswer: parseRecap,
  evidenceText: () => '',
  onLimit: 'queue',
  request: {
    maxTokens: 64_000,
    timeoutSeconds: 1800,
    effort: EFFORT,
    stream: true,
    expectedOutputTokens: 15_000,
  },
};

/** Points of a written recap, each with the items it cites. */
export interface RecapCheckEvidence {
  series: string;
  points: { id: string; text: string; items: { id: string; text: string }[] }[];
}

export type RecapVerdict = 'supported' | 'not_supported';

export const RECAP_CHECK_SPEC: AiStageSpec<RecapCheckEvidence, ModelRole> = {
  stage: 'sum.recap-check',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}.k1`,
  tasks: TASKS,
  system: `Each point of a series recap comes with the summary items it cites (from the series' volumes, in series order). Do the cited items support the point? Check every detail: who does what to whom, in what order, how strongly (suspects or is sure, asks or orders), and in which volume. Where the items of different volumes disagree, the later volume's item is the state now. supported: the cited items show everything the point says, every detail as the point has it. not_supported: any detail is missing from the cited items, or they say otherwise. Judge only from the items given; don't use what you know about the series. Give a verdict for every point id.`,
  userText: (e) =>
    `SERIES: ${e.series}\n\n${e.points
      .map(
        (p) =>
          `POINT ${p.id}: ${p.text}\nCITED ITEMS:\n${p.items.map((i) => `${i.id}: ${i.text}`).join('\n')}`,
      )
      .join('\n\n---\n\n')}`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'verdict'],
          properties: {
            id: { type: 'string' },
            verdict: { type: 'string', enum: ['supported', 'not_supported'] },
          },
        },
      },
    },
  },
  schemaName: 'verdicts',
  parseAnswer: (raw) => {
    const r = raw as { verdicts?: unknown };
    if (!r || !Array.isArray(r.verdicts)) return null;
    const verdicts = (r.verdicts as Record<string, unknown>[])
      .filter(
        (v) =>
          v &&
          typeof v.id === 'string' &&
          (v.verdict === 'supported' || v.verdict === 'not_supported'),
      )
      .map((v) => ({ id: v.id as string, verdict: v.verdict as RecapVerdict }));
    return { verdicts };
  },
  evidenceText: () => '',
  onLimit: 'queue',
  request: {
    maxTokens: 32_000,
    timeoutSeconds: 1200,
    effort: EFFORT,
    stream: true,
    expectedOutputTokens: 4_000,
  },
};
