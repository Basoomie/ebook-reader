/**
 * Book summaries: how each step asks the models (the shared AI layer's `AiStageSpec`).
 *
 * Every step's evidence is built only from the book and from answers already stored, in a fixed
 * order, so the same step always asks the same question (and the layer answers it from what is
 * stored). A prompt change raises `PROMPT_VERSION`.
 *
 * Rules every prompt follows (book-summaries.md "Goal", "Content", "Accuracy and completeness"):
 * nothing that isn't in this book; names as the book writes them; every item must matter for
 * remembering the book; no quotas, no template filling, no length targets.
 */
import type { AiEffort, AiStageSpec } from '../ai/types';
import { ITEM_KINDS, type ItemKind } from './types';

export const PROMPT_VERSION = 's2.1';
const EFFORT: AiEffort = 'high';

/** The models of the test (checked against the providers' lists, 2026-11-21). */
export const MODELS = {
  sonnet: 'claude-sonnet-5-5',
  sol: 'gpt-6.1-sol',
  opus: 'claude-opus-5-5',
} as const;
export type ModelRole = keyof typeof MODELS;
export const TASKS: Record<ModelRole, string> = {
  sonnet: `summaries.${MODELS.sonnet}`,
  sol: `summaries.${MODELS.sol}`,
  opus: `summaries.${MODELS.opus}`,
};
export function modelForTask(task: string): string {
  return task.startsWith('summaries.') ? task.slice('summaries.'.length) : '';
}
export function roleOf(model: string): ModelRole {
  const r = (Object.keys(MODELS) as ModelRole[]).find((k) => MODELS[k] === model);
  if (!r) throw new Error(`not a test model: ${model}`);
  return r;
}

const COMMON_RULES = `Rules:
- Use only this book's text. Never add anything from other volumes, adaptations, reviews or general knowledge, even if you know the series.
- Write names, places and invented terms exactly as the book writes them.
- Every item must matter for remembering this book: something a reader would need after a long break, or when the book comes up in conversation. Skip filler. There is no target number or length; never pad and never leave out something important.`;

const QUOTE_RULE = `- Each item has a quote: a short passage copied exactly, character for character, from the book (one continuous passage, about 10 to 60 characters, no ellipsis, no changes, no furigana in brackets). The quote must show what the item says.`;

const BACKGROUND_RULE = `- A BACKGROUND block may follow: summaries of earlier volumes of the series, given only so you know who is who. Never state anything from it. Every item must come from this book's text and quote this book.`;

// ---------------------------------------------------------------------------------------------
// Extract

export interface ExtractEvidence {
  title: string;
  chapters: { index: number; title: string; text: string }[];
  background: string | null;
}

const KIND_TEXT = `Kinds: event (what happens), character (what a character learns, decides, reveals about themselves or becomes), relationship (how two characters stand or how that changes), reveal (a fact the book discloses: a secret, an identity, how something works), term (an invented word or name of a thing, group or place, and what it means), thread (a question, promise or danger still open at the end of the book).`;

function backgroundBlock(bg: string | null): string {
  return bg ? `\n\nBACKGROUND (earlier volumes; for who is who only, never a source):\n${bg}` : '';
}

function chapterBlocks(chapters: ExtractEvidence['chapters']): string {
  return chapters.map((c) => `=== Chapter ${c.index}: ${c.title} ===\n${c.text}`).join('\n\n');
}

const itemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'text', 'quote', 'names'],
  properties: {
    kind: { type: 'string', enum: ITEM_KINDS },
    text: { type: 'string' },
    quote: { type: 'string' },
    names: { type: 'array', items: { type: 'string' } },
  },
};

const extractSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['chapters'],
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chapter', 'not_story', 'items'],
        properties: {
          chapter: { type: 'integer' },
          not_story: { type: 'boolean' },
          items: { type: 'array', items: itemSchema },
        },
      },
    },
  },
};

export interface RawItem {
  kind: ItemKind;
  text: string;
  quote: string;
  names: string[];
}
export interface ExtractAnswer {
  chapters: { chapter: number; not_story: boolean; items: RawItem[] }[];
}

function parseItems(raw: unknown): RawItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RawItem[] = [];
  for (const x of raw as Record<string, unknown>[]) {
    if (!x || typeof x !== 'object') continue;
    const kind = x.kind as ItemKind;
    if (!ITEM_KINDS.includes(kind) || typeof x.text !== 'string' || typeof x.quote !== 'string')
      continue;
    const names = Array.isArray(x.names) ? x.names.filter((n) => typeof n === 'string') : [];
    out.push({ kind, text: x.text.trim(), quote: x.quote.trim(), names: names as string[] });
  }
  return out;
}

function parseExtract(raw: unknown): Record<string, unknown> | null {
  const r = raw as { chapters?: unknown };
  if (!r || !Array.isArray(r.chapters)) return null;
  const chapters: ExtractAnswer['chapters'] = [];
  for (const c of r.chapters as Record<string, unknown>[]) {
    if (!c || typeof c.chapter !== 'number') continue;
    const items = parseItems(c.items) ?? [];
    chapters.push({ chapter: c.chapter, not_story: c.not_story === true, items });
  }
  return { chapters };
}

export const EXTRACT_SPEC: AiStageSpec<ExtractEvidence, ModelRole> = {
  stage: 'sum.extract',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}`,
  tasks: TASKS,
  system: `You read a whole book and list, chapter by chapter, what a reader needs to remember about it.
${KIND_TEXT}
Write the items in the book's language, each one fact a reader can check.
${COMMON_RULES}
${QUOTE_RULE}
${BACKGROUND_RULE}
- Cover every chapter. Set not_story to true only for a chapter that is not part of the story or the book's content (contents, an afterword, an advertisement), with no items.
- Use the chapter numbers given in the text.`,
  userText: (e) =>
    `BOOK: ${e.title}\n\n${chapterBlocks(e.chapters)}${backgroundBlock(e.background)}`,
  schema: extractSchema,
  schemaName: 'chapter_items',
  parseAnswer: parseExtract,
  evidenceText: () => '',
  onLimit: 'queue',
  request: {
    maxTokens: 100_000,
    timeoutSeconds: 3600,
    effort: EFFORT,
    stream: true,
    expectedOutputTokens: 40_000,
  },
};

/** A chapter the whole-book answer left without items: asked again with only its text. */
export interface ChapterEvidence {
  title: string;
  chapter: { index: number; title: string; text: string };
  background: string | null;
}

const chapterSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['not_story', 'items'],
  properties: {
    not_story: { type: 'boolean' },
    items: { type: 'array', items: itemSchema },
  },
};

export const EXTRACT_CHAPTER_SPEC: AiStageSpec<ChapterEvidence, ModelRole> = {
  stage: 'sum.extract-chapter',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}`,
  tasks: TASKS,
  system: `You read one chapter of a book and list what a reader needs to remember about it.
${KIND_TEXT}
Write the items in the book's language, each one fact a reader can check.
${COMMON_RULES}
${QUOTE_RULE}
${BACKGROUND_RULE}
- Set not_story to true only if the chapter is not part of the story or the book's content (contents, an afterword, an advertisement), with no items.`,
  userText: (e) =>
    `BOOK: ${e.title}\n\n=== Chapter ${e.chapter.index}: ${e.chapter.title} ===\n${e.chapter.text}${backgroundBlock(e.background)}`,
  schema: chapterSchema,
  schemaName: 'chapter_items',
  parseAnswer: (raw) => {
    const r = raw as { not_story?: unknown; items?: unknown };
    if (!r || typeof r !== 'object') return null;
    return { not_story: r.not_story === true, items: parseItems(r.items) ?? [] };
  },
  evidenceText: () => '',
  onLimit: 'queue',
  request: {
    maxTokens: 32_000,
    timeoutSeconds: 1200,
    effort: EFFORT,
    stream: true,
    expectedOutputTokens: 6_000,
  },
};

// ---------------------------------------------------------------------------------------------
// Cross-check: match the two models' items, then check single items against their passage

export interface MatchEvidence {
  title: string;
  a: { id: string; chapter: number; text: string }[];
  b: { id: string; chapter: number; text: string }[];
}

export const MATCH_SPEC: AiStageSpec<MatchEvidence, ModelRole> = {
  stage: 'sum.match',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}`,
  tasks: TASKS,
  system: `Two readers each listed facts from the same book. Pair every fact of list A with the fact of list B that states the same thing (the same event, change, reveal or term, perhaps worded differently or with more or less detail). A fact pairs with at most one fact of the other list. Facts that only overlap partly, or only share a topic, are not a pair. Return only the pairs.`,
  userText: (e) =>
    `BOOK: ${e.title}\n\nLIST A:\n${e.a.map((x) => `${x.id} [ch ${x.chapter}] ${x.text}`).join('\n')}\n\nLIST B:\n${e.b.map((x) => `${x.id} [ch ${x.chapter}] ${x.text}`).join('\n')}`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['pairs'],
    properties: {
      pairs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['a', 'b'],
          properties: { a: { type: 'string' }, b: { type: 'string' } },
        },
      },
    },
  },
  schemaName: 'pairs',
  parseAnswer: (raw) => {
    const r = raw as { pairs?: unknown };
    if (!r || !Array.isArray(r.pairs)) return null;
    const pairs = (r.pairs as Record<string, unknown>[])
      .filter((p) => p && typeof p.a === 'string' && typeof p.b === 'string')
      .map((p) => ({ a: p.a as string, b: p.b as string }));
    return { pairs };
  },
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

export interface SupportEvidence {
  title: string;
  claims: { id: string; text: string; passage: string }[];
}
export type Verdict = 'supported' | 'partly' | 'not_supported';

export const SUPPORT_SPEC: AiStageSpec<SupportEvidence, ModelRole> = {
  stage: 'sum.support',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}`,
  tasks: TASKS,
  system: `For each claim about a book, you get a passage from that book. Does the passage support the claim? supported: the passage shows everything the claim says. partly: it shows some of it, and the rest is not in the passage. not_supported: the passage doesn't show it or says otherwise. Judge only from the passage; don't use what you know about the book.`,
  userText: (e) =>
    `BOOK: ${e.title}\n\n${e.claims.map((c) => `CLAIM ${c.id}: ${c.text}\nPASSAGE:\n${c.passage}`).join('\n\n---\n\n')}`,
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
            verdict: { type: 'string', enum: ['supported', 'partly', 'not_supported'] },
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
          ['supported', 'partly', 'not_supported'].includes(v.verdict as string),
      )
      .map((v) => ({ id: v.id as string, verdict: v.verdict as Verdict }));
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

// ---------------------------------------------------------------------------------------------
// Write

export interface WriteEvidence {
  title: string;
  chapters: { index: number; title: string }[];
  items: { id: string; chapter: number; kind: ItemKind; text: string; quote: string }[];
  background: string | null;
}

const writtenItem = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'cites', 'quote_from', 'show_quote'],
  properties: {
    text: { type: 'string' },
    cites: { type: 'array', items: { type: 'string' } },
    quote_from: { type: 'string' },
    show_quote: { type: 'boolean' },
  },
};
function withFields(extra: Record<string, unknown>, required: string[]) {
  return {
    ...writtenItem,
    required: [...required, ...writtenItem.required],
    properties: { ...extra, ...writtenItem.properties },
  };
}

const writeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'overview',
    'chapters',
    'characters',
    'also_mentioned',
    'relationships',
    'terms',
    'threads',
  ],
  properties: {
    overview: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'cites'],
      properties: {
        text: { type: 'string' },
        cites: { type: 'array', items: { type: 'string' } },
      },
    },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chapter', 'items'],
        properties: {
          chapter: { type: 'integer' },
          items: { type: 'array', items: writtenItem },
        },
      },
    },
    characters: {
      type: 'array',
      items: withFields({ name: { type: 'string' } }, ['name']),
    },
    also_mentioned: { type: 'array', items: { type: 'string' } },
    relationships: {
      type: 'array',
      items: withFields({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']),
    },
    terms: { type: 'array', items: withFields({ term: { type: 'string' } }, ['term']) },
    threads: { type: 'array', items: writtenItem },
  },
};

export interface WrittenItem {
  text: string;
  cites: string[];
  quote_from: string;
  show_quote: boolean;
}
export interface WriteAnswer {
  overview: { text: string; cites: string[] };
  chapters: { chapter: number; items: WrittenItem[] }[];
  characters: (WrittenItem & { name: string })[];
  also_mentioned: string[];
  relationships: (WrittenItem & { a: string; b: string })[];
  terms: (WrittenItem & { term: string })[];
  threads: WrittenItem[];
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? (x.filter((s) => typeof s === 'string') as string[]) : [];
}
function written(x: Record<string, unknown>): WrittenItem | null {
  if (!x || typeof x.text !== 'string') return null;
  return {
    text: x.text.trim(),
    cites: strings(x.cites),
    quote_from: typeof x.quote_from === 'string' ? x.quote_from : '',
    show_quote: x.show_quote === true,
  };
}
function list<T>(x: unknown, f: (r: Record<string, unknown>) => T | null): T[] {
  return Array.isArray(x)
    ? (x as Record<string, unknown>[]).map((r) => f(r)).filter((v): v is T => v !== null)
    : [];
}

export function parseWrite(raw: unknown): Record<string, unknown> | null {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== 'object') return null;
  const ov = r.overview as Record<string, unknown> | undefined;
  if (!ov || typeof ov.text !== 'string') return null;
  const ans: WriteAnswer = {
    overview: { text: ov.text.trim(), cites: strings(ov.cites) },
    chapters: list(r.chapters, (c) =>
      typeof c.chapter === 'number'
        ? { chapter: c.chapter, items: list(c.items, (i) => written(i)) }
        : null,
    ),
    characters: list(r.characters, (c) => {
      const w = written(c);
      return w && typeof c.name === 'string' ? { ...w, name: c.name.trim() } : null;
    }),
    also_mentioned: strings(r.also_mentioned),
    relationships: list(r.relationships, (c) => {
      const w = written(c);
      return w && typeof c.a === 'string' && typeof c.b === 'string'
        ? { ...w, a: c.a.trim(), b: c.b.trim() }
        : null;
    }),
    terms: list(r.terms, (c) => {
      const w = written(c);
      return w && typeof c.term === 'string' ? { ...w, term: c.term.trim() } : null;
    }),
    threads: list(r.threads, (c) => written(c)),
  };
  return ans as unknown as Record<string, unknown>;
}

export const WRITE_SPEC: AiStageSpec<WriteEvidence, ModelRole> = {
  stage: 'sum.write',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}`,
  tasks: TASKS,
  system: `You write a book's summary for a reader who has read it and wants to remember it: when continuing the series after a long break, or when the book comes up in conversation. You get checked facts from the book (ITEMS, each with an id, its chapter and a quote). Write only from them.
Sections (leave a section empty when it isn't relevant to this book; nonfiction gets what fits it):
- overview: the book in a few sentences: what it is about and how it ends.
- chapters: per chapter, what happens, as short items in order.
- characters: one entry per character a reader needs to follow the book: who they are and what changed for them in this book. No fixed fields; say what matters for that character. Characters who are only mentioned go into also_mentioned as names only.
- relationships: only relationships that matter (they drive the plot or the feeling of scenes): who, why it matters, how it changed in this book.
- terms: invented words, groups, places or rules a reader must know, and what they mean.
- threads: questions, promises and dangers still open at the end.
Each item cites the ids of the ITEMS it rests on (at least one) and says nothing they don't support. quote_from is the id (one of its cites) whose quote best shows the item, or "" for none; show_quote is true only where showing that quote helps the reader (it supports a surprising claim, adds context, or a character explains a term), not on every item.
Write in the book's language. Use names exactly as the book writes them.
${COMMON_RULES}
${BACKGROUND_RULE}`,
  userText: (e) =>
    `BOOK: ${e.title}\nCHAPTERS:\n${e.chapters.map((c) => `${c.index}: ${c.title}`).join('\n')}\n\nITEMS:\n${e.items
      .map((i) => `${i.id} [ch ${i.chapter}, ${i.kind}] ${i.text} 「${i.quote}」`)
      .join('\n')}${backgroundBlock(e.background)}`,
  schema: writeSchema,
  schemaName: 'summary',
  parseAnswer: parseWrite,
  evidenceText: () => '',
  onLimit: 'queue',
  request: {
    maxTokens: 64_000,
    timeoutSeconds: 1800,
    effort: EFFORT,
    stream: true,
    expectedOutputTokens: 25_000,
  },
};

// ---------------------------------------------------------------------------------------------
// Translate a finished summary, item by item

export interface TranslateEvidence {
  from: string;
  to: string;
  title: string;
  items: { ref: string; heading: string | null; text: string }[];
}

export const TRANSLATE_SPEC: AiStageSpec<TranslateEvidence, ModelRole> = {
  stage: 'sum.translate',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}`,
  tasks: TASKS,
  system: `Translate each item of a book summary. Translate every item on its own, keeping its meaning exactly: add nothing, leave nothing out. Keep each item's ref. A heading is a name or an invented term: give its usual reading or translation (romanize Japanese names in Hepburn with macrons, given order as the book uses it). Quotes are not part of the text and are not translated.`,
  userText: (e) =>
    `BOOK: ${e.title}\nFROM: ${e.from}\nTO: ${e.to}\n\n${e.items
      .map((i) => `${i.ref}${i.heading ? ` HEADING: ${i.heading}` : ''}\nTEXT: ${i.text}`)
      .join('\n\n')}`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'heading', 'text'],
          properties: {
            ref: { type: 'string' },
            heading: { type: 'string' },
            text: { type: 'string' },
          },
        },
      },
    },
  },
  schemaName: 'translation',
  parseAnswer: (raw) => {
    const r = raw as { items?: unknown };
    if (!r || !Array.isArray(r.items)) return null;
    return {
      items: (r.items as Record<string, unknown>[])
        .filter((x) => x && typeof x.ref === 'string' && typeof x.text === 'string')
        .map((x) => ({
          ref: x.ref as string,
          heading: typeof x.heading === 'string' ? x.heading : '',
          text: x.text as string,
        })),
    };
  },
  evidenceText: () => '',
  onLimit: 'queue',
  request: {
    maxTokens: 64_000,
    timeoutSeconds: 1800,
    effort: EFFORT,
    stream: true,
    expectedOutputTokens: 20_000,
  },
};

// ---------------------------------------------------------------------------------------------
// Judging (the test only): single claims, then the same claim across setups grouped

export interface ClaimsEvidence {
  title: string;
  items: { ref: string; section: string; text: string }[];
}

export const CLAIMS_SPEC: AiStageSpec<ClaimsEvidence, ModelRole> = {
  stage: 'sum.claims',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}`,
  tasks: TASKS,
  system: `Split each item of a book summary into its single claims: each claim states one fact that a reader of the book could mark right or wrong. Keep the summary's wording and language as much as possible, make each claim understandable on its own (name who it is about), and add nothing. An item that states one fact is one claim. Keep each item's ref.`,
  userText: (e) =>
    `BOOK: ${e.title}\n\n${e.items.map((i) => `${i.ref} (${i.section}): ${i.text}`).join('\n')}`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'claims'],
          properties: {
            ref: { type: 'string' },
            claims: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  schemaName: 'claims',
  parseAnswer: (raw) => {
    const r = raw as { items?: unknown };
    if (!r || !Array.isArray(r.items)) return null;
    return {
      items: (r.items as Record<string, unknown>[])
        .filter((x) => x && typeof x.ref === 'string')
        .map((x) => ({ ref: x.ref as string, claims: strings(x.claims) })),
    };
  },
  evidenceText: () => '',
  onLimit: 'queue',
  request: {
    maxTokens: 64_000,
    timeoutSeconds: 1800,
    effort: EFFORT,
    stream: true,
    expectedOutputTokens: 20_000,
  },
};

export interface GroupEvidence {
  title: string;
  claims: { id: string; text: string }[];
}

export const GROUP_SPEC: AiStageSpec<GroupEvidence, ModelRole> = {
  stage: 'sum.group',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}`,
  tasks: TASKS,
  system: `Several summaries of the same book were split into claims. Group the claims that state the same fact, however differently worded. Claims that only share a topic, or where one says clearly more than the other, are separate groups. Every claim id goes into exactly one group; a claim nobody else made is a group of its own. For each group give one short wording of the fact, in the claims' language.`,
  userText: (e) => `BOOK: ${e.title}\n\n${e.claims.map((c) => `${c.id}: ${c.text}`).join('\n')}`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['groups'],
    properties: {
      groups: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'ids'],
          properties: {
            text: { type: 'string' },
            ids: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  schemaName: 'groups',
  parseAnswer: (raw) => {
    const r = raw as { groups?: unknown };
    if (!r || !Array.isArray(r.groups)) return null;
    return {
      groups: (r.groups as Record<string, unknown>[])
        .filter((g) => g && typeof g.text === 'string')
        .map((g) => ({ text: g.text as string, ids: strings(g.ids) })),
    };
  },
  evidenceText: () => '',
  onLimit: 'queue',
  request: {
    maxTokens: 100_000,
    timeoutSeconds: 3600,
    effort: EFFORT,
    stream: true,
    expectedOutputTokens: 40_000,
  },
};

export const ALL_SPECS = [
  EXTRACT_SPEC,
  EXTRACT_CHAPTER_SPEC,
  MATCH_SPEC,
  SUPPORT_SPEC,
  WRITE_SPEC,
  TRANSLATE_SPEC,
  CLAIMS_SPEC,
  GROUP_SPEC,
] as AiStageSpec<unknown, ModelRole>[];
