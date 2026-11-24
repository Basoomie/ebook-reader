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

export const PROMPT_VERSION = 's2.2';
const EFFORT: AiEffort = 'high';

/** The models of the test (checked against the providers' lists, 2026-11-21). */
export const MODELS = {
  sonnet: 'claude-sonnet-5-5',
  sol: 'gpt-6.1-sol',
  opus: 'claude-opus-5-5',
} as const;
/**
 * Who is asked: the test's short names (sonnet, sol, opus) or, since session 3, any model id
 * from the summaries' settings (the route of setups). A role's task is "summaries.<role>".
 */
export type ModelRole = string;
export type TestRole = keyof typeof MODELS;
/** The model a role names: the test's short names, else the role is the model id itself. */
export function modelOfRole(role: ModelRole): string {
  return Object.prototype.hasOwnProperty.call(MODELS, role) ? MODELS[role as TestRole] : role;
}
/** Every role's task ("summaries.<role>"), for any role (model ids of the settings included). */
export const TASKS: Record<ModelRole, string> = new Proxy({} as Record<ModelRole, string>, {
  get: (_t, role) => (typeof role === 'string' ? `summaries.${role}` : undefined),
});
export function modelForTask(task: string): string {
  return task.startsWith('summaries.') ? modelOfRole(task.slice('summaries.'.length)) : '';
}
export function roleOf(model: string): TestRole {
  const r = (Object.keys(MODELS) as TestRole[]).find((k) => MODELS[k] === model);
  if (!r) throw new Error(`not a test model: ${model}`);
  return r;
}

const COMMON_RULES = `Rules:
- Use only this book's text. Never add anything from other volumes, adaptations, reviews or general knowledge, even if you know the series.
- Write names, places and invented terms exactly as the book writes them.
- Every item must matter for remembering this book: something a reader would need after a long break, or when the book comes up in conversation. Skip filler. There is no target number or length; never pad and never leave out something important.
- Say who does what: name the person behind every action (who took it, who gave it to whom, who did it to whom).
- Keep the detail that gives an event its meaning (how, why, to whom), not only that it happened. Never make a detail stronger, weaker or different than the book has it.
- A character's guess, belief, plan or rumor is written as theirs ("X thinks…", "X plans…"), never as a fact.
- Each item reads on its own: no "there", "that place" or "it" pointing at something the item doesn't name.
- Plain text: no line breaks, no ids or brackets with ids inside the text.`;

const QUOTE_RULE = `- Each item has a quote: a short passage copied exactly, character for character, from the book (one continuous passage, about 10 to 60 characters, no ellipsis, no changes, no furigana in brackets). The quote must show what the item says.`;

const BACKGROUND_RULE = `- A BACKGROUND block may follow: summaries of earlier volumes of the series, given only so you know who is who. Never state anything from it. Every item must come from this book's text and quote this book.`;

// ---------------------------------------------------------------------------------------------
// Extract

export interface ExtractEvidence {
  title: string;
  chapters: { index: number; title: string; text: string }[];
  background: string | null;
}

const KIND_TEXT = `Kinds: event (what happens), character (who a character is and what changes for them: looks, age, personality, role or job, the names others call them and the names they go by, including online handles, and what they learn, decide, reveal or become), relationship (how two characters are connected and how they stand: family, classmates, living together, how each sees the other, and how that changes), reveal (a fact the book discloses: a secret, an identity, how something works), term (a word of this book's own world, and what it means: an invented word, or the name of a group, organization, company, place, power or rule of the story; not ordinary words or real-world things the book only mentions), thread (a question, promise or danger still open at the very end of the book, one the book does not answer later on).
- For every character who matters, include what the book says about their looks, age, personality and role, and every name they go by (nicknames, how others call them, online handles), each as its own character item, when the book says it. An online handle or alias belongs to the person behind it once the book reveals who that is.`;

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

const VERDICT_RULES = `Check every detail: who does what to whom, in what order, and how strongly (suspects or is sure, asks or orders, weakly or hard). supported: the text shows everything the claim says, every detail as the claim has it. partly: some of it isn't in the text you got (it may be elsewhere in the book), and nothing in the text says otherwise. not_supported: the text says otherwise about any detail, or shows none of it. Judge only from the text; don't use what you know about the book.`;

// The checks have their own version since 2026-11-23 (c2: every detail checked; a claim only
// partly shown by its passage is checked again against its whole chapter), so changing them asks
// nothing before them again.
export const SUPPORT_SPEC: AiStageSpec<SupportEvidence, ModelRole> = {
  stage: 'sum.support',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}.c2`,
  tasks: TASKS,
  system: `For each claim about a book, you get a passage from that book. Does the passage support the claim? ${VERDICT_RULES}`,
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

/** Claims the passage showed only partly: checked again against their whole chapter. */
export interface ChapterSupportEvidence {
  title: string;
  chapter: { index: number; title: string; text: string };
  claims: { id: string; text: string }[];
}

export const SUPPORT_CHAPTER_SPEC: AiStageSpec<ChapterSupportEvidence, ModelRole> = {
  stage: 'sum.support-chapter',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}.c2`,
  tasks: TASKS,
  system: `You get one whole chapter of a book and claims about it. Does the chapter support each claim? What a claim says may be spread over the chapter. ${VERDICT_RULES}`,
  userText: (e) =>
    `BOOK: ${e.title}\n\n=== Chapter ${e.chapter.index}: ${e.chapter.title} ===\n${e.chapter.text}\n\nCLAIMS:\n${e.claims.map((c) => `CLAIM ${c.id}: ${c.text}`).join('\n')}`,
  schema: SUPPORT_SPEC.schema,
  schemaName: 'verdicts',
  parseAnswer: SUPPORT_SPEC.parseAnswer,
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
      items: withFields(
        { a: { type: 'string' }, b: { type: 'string' }, label: { type: 'string' } },
        ['a', 'b', 'label'],
      ),
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
  /** label: one or two words naming it ('' when the answer had none). */
  relationships: (WrittenItem & { a: string; b: string; label: string })[];
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
        ? {
            ...w,
            a: c.a.trim(),
            b: c.b.trim(),
            label: typeof c.label === 'string' ? c.label.trim() : '',
          }
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
  // The writing has its own version since 2026-11-23 (w3: turning points kept, where things end
  // up, threads checked against later items; w4: who said what to whom, no unstated "first" or
  // "only", a thread the book points the answer to is not unknown, headings for unnamed
  // characters; w5, session 4: a short label per relationship for the diagram's lines), so
  // changing it asks nothing before it again.
  promptVersion: `${PROMPT_VERSION}.${EFFORT}.w5`,
  tasks: TASKS,
  system: `You write a book's summary for a reader who has read it and wants to remember it: when continuing the series after a long break, or when the book comes up in conversation. You get checked facts from the book (ITEMS, each with an id, its chapter and a quote). Write only from them.
Sections (leave a section empty when it isn't relevant to this book; nonfiction gets what fits it):
- overview: the book in a few sentences: the setting, the main characters, what happens from the beginning through the middle to the end, and how it ends. The main line only, no small details.
- chapters: per chapter, what happens, as short items in order. Complete: every event of the chapter that matters, with who did it and the detail that gives it its meaning. A small scene gets one short item at most.
- characters: one entry per character a reader needs to follow the book, the most important first. The entry is about the person: looks, age, personality, role, and every name they go by (nicknames, online handles: a handle goes into its owner's entry, never an entry of its own once the book reveals the owner), then only the few story facts that define them. Their story belongs in chapters and their ties in relationships: don't retell those here. No fixed fields; say what the items give for that character. Characters who are only mentioned go into also_mentioned as names only.
- relationships: only relationships that matter (they drive the plot or the feeling of scenes). How the two are connected (family, classmates, living together, ...), how each sees the other, and how it changed in this book. Don't repeat what a character entry already says. label: one or two words naming the relationship as it stands at the end of this book (師弟, 幼なじみ, 敵対), shown on a line between the two names.
- terms: words of this book's own world a reader must know (invented words, groups, organizations, companies, places, powers, rules of the story), and what they mean. Not ordinary words, not real-world things the book only mentions, not characters (a handle or alias goes into its owner's character entry).
- threads: only questions, promises and dangers still open when the book ends: never something the book resolves, never a plain statement of fact. When it matters for later volumes, say who doesn't know a key fact (e.g. a character unaware of where something is).
- Never leave out a turning point: a vow, a confession, a betrayal, a reveal of who someone really is or of what a character has found out. The last chapters often hold the book's biggest reveals (an epilogue, one character's monologue): they belong in chapters, and in the overview and threads when they change what a reader expects next.
- Where the items show how something develops (suspects, then becomes sure; plans, then does it), say where it ends up in this book.
- Before keeping a thread, check the later items: if one of them answers or resolves it, it isn't open. When the items show or plainly point to the answer (a character recognizes who did it, a scene shows who someone is), never call it unknown or unrevealed: say what the book shows, as a hint or a character's recognition when it isn't said outright.
- Who says, tells, asks, gives or does what to whom: keep the speaker, the listener, the giver and the doer exactly as the items have them. When the items don't say who, don't name anyone.
- Never add a "first", "only", "all", "both" or "never" the items don't state (a first kiss for both, the only one who knows).
- A character the book never names gets the role the book gives them as heading, in the book's own words (れな子の妹, 浄室の女性).
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
  items: { ref: string; heading: string | null; label?: string | null; text: string }[];
}

/** A translation's items; LABEL only on relationships that have one (session 4). */
function translateUserText(e: TranslateEvidence): string {
  return `BOOK: ${e.title}\nFROM: ${e.from}\nTO: ${e.to}\n\n${e.items
    .map(
      (i) =>
        `${i.ref}${i.heading ? ` HEADING: ${i.heading}` : ''}${i.label ? `\nLABEL: ${i.label}` : ''}\nTEXT: ${i.text}`,
    )
    .join('\n\n')}`;
}

export const TRANSLATE_SPEC: AiStageSpec<TranslateEvidence, ModelRole> = {
  stage: 'sum.translate',
  // t2 (session 4): relationships' labels translated too.
  promptVersion: `${PROMPT_VERSION}.${EFFORT}.t2`,
  tasks: TASKS,
  system: `Translate each item of a book summary. Translate every item on its own, keeping its meaning exactly: add nothing, leave nothing out. Keep each item's ref. A heading is a name or an invented term: give its usual reading or translation (romanize Japanese names in Hepburn with macrons, given order as the book uses it). A LABEL names a relationship in one or two words: translate it as one or two words; give label "" for an item without one. Quotes are not part of the text and are not translated.`,
  userText: translateUserText,
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
          required: ['ref', 'heading', 'label', 'text'],
          properties: {
            ref: { type: 'string' },
            heading: { type: 'string' },
            label: { type: 'string' },
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
          label: typeof x.label === 'string' ? x.label : '',
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
// Labels for relationships written before labels existed (session 4, `cli summaries label`)

export interface LabelEvidence {
  title: string;
  lang: string;
  items: { ref: string; between: [string, string]; text: string }[];
}

export const LABEL_SPEC: AiStageSpec<LabelEvidence, ModelRole> = {
  stage: 'sum.label',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}.l1`,
  tasks: TASKS,
  system: `Each item is one relationship from a book summary: the two people and what the summary says about them. Give each item a label: one or two words naming the relationship as it stands at the end of the book (師弟, 幼なじみ, 敵対), in the summary's language, taken only from what the item says. Keep each item's ref.`,
  userText: (e) =>
    `BOOK: ${e.title}\nLANGUAGE: ${e.lang}\n\n${e.items
      .map((i) => `${i.ref} BETWEEN: ${i.between[0]} / ${i.between[1]}\nTEXT: ${i.text}`)
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
          required: ['ref', 'label'],
          properties: { ref: { type: 'string' }, label: { type: 'string' } },
        },
      },
    },
  },
  schemaName: 'labels',
  parseAnswer: (raw) => {
    const r = raw as { items?: unknown };
    if (!r || !Array.isArray(r.items)) return null;
    return {
      items: (r.items as Record<string, unknown>[])
        .filter((x) => x && typeof x.ref === 'string' && typeof x.label === 'string')
        .map((x) => ({ ref: x.ref as string, label: (x.label as string).trim() })),
    };
  },
  evidenceText: () => '',
  onLimit: 'queue',
  request: {
    maxTokens: 8_000,
    timeoutSeconds: 600,
    effort: EFFORT,
    expectedOutputTokens: 1_000,
  },
};

// ---------------------------------------------------------------------------------------------
// A book's description, translated like a summary (session 4b): its paragraphs and lines kept

export interface DescriptionEvidence {
  from: string;
  to: string;
  title: string;
  /** The description as the book page shows it: paragraphs of lines. */
  paragraphs: string[][];
}

export interface DescriptionAnswer {
  paragraphs: string[][];
}

export const DESCRIPTION_SPEC: AiStageSpec<DescriptionEvidence, ModelRole> = {
  stage: 'sum.translate-desc',
  promptVersion: `${PROMPT_VERSION}.${EFFORT}.d1`,
  tasks: TASKS,
  system: `Translate a book's description (the publisher's text about the book). Keep its meaning exactly: add nothing, leave nothing out, explain nothing. Keep the layout: the same paragraphs in the same order, and in each paragraph one translated line for each original line, in order (a line that is only a mark or a symbol stays as it is). Names and invented terms get their usual reading or translation (romanize Japanese names in Hepburn with macrons, given order as the book uses it).`,
  userText: (e) =>
    `BOOK: ${e.title}\nFROM: ${e.from}\nTO: ${e.to}\n\n${e.paragraphs
      .map(
        (p, i) =>
          `PARAGRAPH ${i + 1} (${p.length} ${p.length === 1 ? 'line' : 'lines'}):\n${p.join('\n')}`,
      )
      .join('\n\n')}`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['paragraphs'],
    properties: {
      paragraphs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['lines'],
          properties: { lines: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  },
  schemaName: 'description',
  parseAnswer: (raw) => {
    const r = raw as { paragraphs?: unknown };
    if (!r || !Array.isArray(r.paragraphs)) return null;
    const out: string[][] = [];
    for (const p of r.paragraphs as unknown[]) {
      const lines = (p as { lines?: unknown })?.lines;
      if (!Array.isArray(lines) || lines.some((l) => typeof l !== 'string')) return null;
      out.push((lines as string[]).map((l) => l.replace(/\s*\n\s*/g, ' ').trim()));
    }
    return { paragraphs: out };
  },
  evidenceText: () => '',
  onLimit: 'queue',
  request: {
    // Asked while the user waits on the book page: one direct call (decided 2026-11-23).
    direct: true,
    maxTokens: 8_000,
    timeoutSeconds: 300,
    effort: EFFORT,
    expectedOutputTokens: 1_500,
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
  SUPPORT_CHAPTER_SPEC,
  WRITE_SPEC,
  TRANSLATE_SPEC,
  CLAIMS_SPEC,
  GROUP_SPEC,
] as AiStageSpec<unknown, ModelRole>[];
