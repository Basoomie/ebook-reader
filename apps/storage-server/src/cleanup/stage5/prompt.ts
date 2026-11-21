/**
 * Stage 5's question to the models (WP20f): the genre test's prompt (`genre/genre_test.py`,
 * measured 2026-11-13 on 235 labeled books: Haiku AND Luna found 91.3 % of the required genres
 * with 99.3 % right, tags 77.1 % / 99.0 %), with スポーツ added (approved after the test), a
 * closed schema (structured outputs) and store notes for the adaptation question (the lines
 * stage 4 removed from the description as promotion, where アニメ化 / コミカライズ are stated).
 *
 * The answer's terms are ids or labels (Luna answered with the Japanese labels in 174 of 235
 * books of the test): both are accepted; anything not on the lists is dropped and counted.
 */
import type { AiStageSpec } from '../ai/types';
import {
  GENRES,
  GENRE_IDS,
  SUBJECTS,
  SUBJECT_IDS,
  TAGS,
  TAG_IDS,
  termId,
  type Term,
} from './vocab';

/** Raised whenever the prompt, the evidence text or the schema changes. */
export const STAGE5_PROMPT_VERSION = 'calibre5-v1';
/** Raised when the evidence object's shape changes (the stored items are rebuilt). */
export const STAGE5_EVIDENCE_VERSION = 1;

const list = (terms: readonly Term[]) =>
  terms.map((t) => `  ${t.id}: ${t.ja}${t.hint ? ` (${t.hint})` : ''}`).join('\n');

export const STAGE5_SYSTEM = `You classify ONE Japanese book for a personal library's filters. You get its title, authors, format, the publisher's
description (synopsis) and store categories, or the opening text when there is no description.

Choose only ids from these lists. Pick every genre and tag that clearly applies, none that are doubtful. Base it on the
evidence given; do not rely on what you may remember about the title unless the evidence agrees.

Fiction genres (several allowed; for novels, light novels and manga):
${list(GENRES)}

Nonfiction subjects (several allowed; for nonfiction only):
${list(SUBJECTS)}

Tags (several allowed; fiction only):
${list(TAGS)}

Adaptations: set anime_adaptation / manga_adaptation to true ONLY when the description, the store notes or the
categories say so (アニメ化, TVアニメ, コミカライズ, 漫画化 …); otherwise false. Never guess.

Answer with ONLY this JSON object:
{"genres": [ids], "nonfiction_subjects": [ids], "tags": [ids], "anime_adaptation": bool, "manga_adaptation": bool,
 "confidence": "high"|"low", "basis": "description"|"opening_text"|"title_only"}`;

export const STAGE5_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'genres',
    'nonfiction_subjects',
    'tags',
    'anime_adaptation',
    'manga_adaptation',
    'confidence',
    'basis',
  ],
  properties: {
    genres: { type: 'array', items: { type: 'string', enum: GENRES.map((t) => t.id) } },
    nonfiction_subjects: {
      type: 'array',
      items: { type: 'string', enum: SUBJECTS.map((t) => t.id) },
    },
    tags: { type: 'array', items: { type: 'string', enum: TAGS.map((t) => t.id) } },
    anime_adaptation: { type: 'boolean' },
    manga_adaptation: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'low'] },
    basis: { type: 'string', enum: ['description', 'opening_text', 'title_only'] },
  },
};

/** What a model is shown about one book (kept in ai_items). */
export interface Stage5Evidence {
  v: number;
  title: string;
  authors: string[];
  format: string | null;
  description: string | null;
  store_categories: string[];
  /** Only without a description, as in the test. */
  opening_text: string | null;
  /** The promotional lines stage 4 removed from the description (for the adaptation question). */
  store_notes: string[];
}

/** The user message: the test's `user_msg` (present keys only, indented by one). */
export function stage5UserText(e: Stage5Evidence): string {
  const x: Record<string, unknown> = {};
  if (e.title) x.title = e.title;
  if (e.authors.length) x.authors = e.authors;
  if (e.format) x.format = e.format;
  if (e.description) x.description = e.description;
  if (e.store_categories.length) x.store_categories = e.store_categories;
  if (e.opening_text) x.opening_text = e.opening_text;
  if (e.store_notes.length) x.store_notes = e.store_notes;
  return JSON.stringify(x, null, 1);
}

/** A parsed answer: ids only, and how many terms were dropped (not on the lists). */
export interface Stage5Answer {
  genres: string[];
  subjects: string[];
  tags: string[];
  anime: boolean;
  manga: boolean;
  dropped: number;
  [k: string]: unknown;
}

function ids(raw: unknown, allowed: ReadonlySet<string>, out: { dropped: number }): string[] {
  if (!Array.isArray(raw)) return [];
  const got = new Set<string>();
  for (const r of raw) {
    const id = termId(r, allowed);
    if (id) got.add(id);
    else out.dropped += 1;
  }
  return [...got].sort();
}

/**
 * Validates an answer. A genre given in the subjects list (or the other way round) is kept where
 * it belongs: the test scored genres and subjects together.
 */
export function parseStage5Answer(raw: unknown): Stage5Answer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (!Array.isArray(a.genres) && !Array.isArray(a.tags) && !Array.isArray(a.nonfiction_subjects))
    return null;
  const both = new Set([...GENRE_IDS, ...SUBJECT_IDS]);
  const c = { dropped: 0 };
  const mixed = [...ids(a.genres, both, c), ...ids(a.nonfiction_subjects, both, c)];
  return {
    genres: [...new Set(mixed.filter((x) => GENRE_IDS.has(x)))].sort(),
    subjects: [...new Set(mixed.filter((x) => SUBJECT_IDS.has(x)))].sort(),
    tags: ids(a.tags, TAG_IDS, c),
    anime: a.anime_adaptation === true,
    manga: a.manga_adaptation === true,
    dropped: c.dropped,
  };
}

export const STAGE5_SPEC: AiStageSpec<Stage5Evidence> = {
  stage: 'calibre5',
  promptVersion: STAGE5_PROMPT_VERSION,
  tasks: {
    primary: 'stage5.primary',
    secondary: 'stage5.secondary',
    upgradePrimary: 'stage5.primary',
    upgradeSecondary: 'stage5.secondary',
  },
  system: STAGE5_SYSTEM,
  userText: stage5UserText,
  schema: STAGE5_SCHEMA,
  schemaName: 'genres_and_tags',
  parseAnswer: parseStage5Answer,
  // Ids are never in the evidence text: no never-invent check (the vocabulary is closed instead).
  evidenceText: () => '',
};
