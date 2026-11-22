/**
 * Calibre stage 4's question to the models (WP20e, setup E on the shared framework): the
 * bake-off's prompt (`bake/bakeoff7.py`, measured on the 600 and check D) with the fixes the
 * plan lists "before production" (library-cleanup-plan.md section 6): the framework's shared
 * blocks (katakana names joined with ・, (上)/(下) never inside a long series, never invent,
 * confidence) plus Calibre's store-bonus N.1 and omnibus rules. The evidence text is the
 * bake-off's `evidence()` line for line, so the measured accuracy carries over.
 */
import { NA, N, lightNormalize, normalizeName, pyStrip } from '../title-rules';
import { evidenceForm } from '../../ai/evidence-check';
import { systemPrompt } from '../ai-decide/prompt-blocks';
import type { AiStageSpec } from '../../ai/types';
import type { AiField } from '../ai-decide/types';
import type { RefRecord } from './rules-v3';

/** Raised whenever the prompt, the evidence text or the schema changes. */
export const STAGE4_PROMPT_VERSION = 'calibre4-v1';
/** Raised when the evidence object's shape changes (the stored items are rebuilt). */
export const STAGE4_EVIDENCE_VERSION = 1;

const INTRO = `You fix metadata for a Japanese ebook library (light novels, novels, nonfiction, a few manga).
You get evidence about ONE EPUB file: its current Calibre record (often wrong), the file's own metadata,
text from the first and last pages (colophon / 奥付 / afterword), and lookup results from Amazon.co.jp,
RanobeDB and BookWalker. A lookup result may be another volume, the manga adaptation, a bonus item or an
unrelated book.`;

const RULES = [
  "- Title: the book's real title including volume number and subtitle. Remove store/edition markers that " +
    'are not part of the title (【電子特典付き】, 【電子限定SS付】, 【電子版限定特典付き】, 【書き下ろし…】), ' +
    'trailing imprint labels like (電撃文庫) (MF文庫J) (ベリーズ文庫), a leading [author] tag, an imprint ' +
    'prefix like "ディスカヴァー文庫 ", and a series name that Amazon appended after the title. Keep brackets ' +
    'that are part of the real title (【急募】, 【攻撃力】, 【…編】, （※…）).',
  '- Authors: writers only. Illustrators, translators, supervisors (監修), editors, original game/anime ' +
    'companies (TYPE-MOON, ニトロプラス, F.E.A.R.) are NOT authors. Files and Amazon often list the ' +
    'illustrator as a second author.',
  '- Illustrators: the people credited for cover or interior art made for this work (イラスト, 挿絵, 挿画, ' +
    '装画, カバーイラスト, 表紙イラスト), for every format (novels and nonfiction too). A reproduced existing ' +
    "artwork (a classic painting, a historic print or photo) or a company's design is not an illustrator. " +
    'Empty list if none is credited anywhere.',
  '- Series: the series name as published, or null for a standalone. A single published volume is a ' +
    'standalone unless the evidence shows more volumes. Imprints (…文庫, …ノベルス) and publisher collections ' +
    'are not series. Drop a trailing "シリーズ" only when the name without it starts the book\'s title ' +
    '(極地恋愛シリーズ -> 極地恋愛, but 物語シリーズ stays).',
  '- Series index: the printed volume number (1, 2, roman II, kanji 三, ①, その4; (上)/(下) only as the ' +
    'volume-marker rule above allows). Amazon/RanobeDB positions count side volumes, so prefer the printed ' +
    'number. A side volume without a printed number gets predecessor + 0.5. null when not in a series.',
  "- Store bonus short story (a separate file holding a store's bonus story: 特典SS, 購入特典, " +
    '…限定書き下ろし, edition kind "bonus"): keep the bonus item\'s own title (not the novel\'s); series: the ' +
    'series of the novel it belongs to; series index: the number of the volume it belongs to + 0.1 (a bonus ' +
    'for volume 3 is 3.1; several bonuses for the same volume all get N.1); illustrators: only those the ' +
    'bonus item itself credits.',
  '- Omnibus (合本版, 総集編, N巻セット, edition kind "omnibus"): its own book, never one of its volumes; ' +
    'series: the series of the volumes it contains; series index: right after the last volume it covers ' +
    '(volumes 1-5 -> 5.9); null when the volumes it covers are not known.',
  '- Format: "light novel" if Amazon\'s category is ライトノベル (includes 新文芸 web-novel books and romance ' +
    'labels Amazon files there); "novel" for 小説・文芸 / ボーイズラブ / children\'s fiction; "nonfiction"; ' +
    '"manga"; "image-only" for books with almost no text that are not manga.',
  '- Edition kind: "full", "sample" (free preview, trial set), "bonus" (store bonus short story), ' +
    '"special edition" (特装版, 電子特別版, 特別増量版), "omnibus" (合本版, 総集編).',
  '- amazon_is_this_book / ranobedb_is_this_book: true when that lookup result is this exact book (same ' +
    'work, same volume, same edition kind), false when it is another book, volume or item, null when there ' +
    'is no result.',
];

const ANSWER = `Answer with ONLY this JSON object, no prose:
{"title": str, "authors": [str], "illustrators": [str], "series": str|null, "series_index": number|null,
 "format": str, "edition_kind": str,
 "amazon_is_this_book": true|false|null, "ranobedb_is_this_book": true|false|null,
 "confidence": {"title": "high|low", "authors": "high|low", "illustrators": "high|low",
                "series": "high|low", "series_index": "high|low", "format": "high|low"}}`;

export const STAGE4_SYSTEM = systemPrompt({ intro: INTRO, rules: RULES, answerFormat: ANSWER });

export const FORMATS = ['light novel', 'novel', 'nonfiction', 'manga', 'image-only'] as const;
export const KINDS = ['full', 'sample', 'bonus', 'special edition', 'omnibus'] as const;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const conf = { type: 'string', enum: ['high', 'low'] };
const CONF_KEYS = ['title', 'authors', 'illustrators', 'series', 'series_index', 'format'];

export const STAGE4_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'authors',
    'illustrators',
    'series',
    'series_index',
    'format',
    'edition_kind',
    'amazon_is_this_book',
    'ranobedb_is_this_book',
    'confidence',
  ],
  properties: {
    title: nullable({ type: 'string' }),
    authors: nullable({ type: 'array', items: { type: 'string' } }),
    illustrators: nullable({ type: 'array', items: { type: 'string' } }),
    series: nullable({ type: 'string' }),
    series_index: nullable({ type: 'number' }),
    format: nullable({ type: 'string', enum: [...FORMATS] }),
    edition_kind: nullable({ type: 'string', enum: [...KINDS] }),
    amazon_is_this_book: nullable({ type: 'boolean' }),
    ranobedb_is_this_book: nullable({ type: 'boolean' }),
    confidence: {
      type: 'object',
      additionalProperties: false,
      required: CONF_KEYS,
      properties: Object.fromEntries(CONF_KEYS.map((k) => [k, conf])),
    },
  },
};

// ---------------------------------------------------------------------------------------------
// the evidence object (kept in ai_items, so an upgrade asks without reading anything again)

export interface Stage4AiEvidence {
  v: number;
  calibre: { title: string | null; authors: string | null };
  file: {
    title: string | null;
    creators: { name: string; role: string | null }[];
    publisher: string[];
    asin: string | null;
    chars: number | null;
    images: number | null;
    front: string;
    colophon: string;
  };
  amazon: {
    searched: boolean;
    title: string | null;
    people: { name: string; role: string }[];
    series: string | null;
    breadcrumbs: string[];
  } | null;
  ranobedb: {
    title: string | null;
    staff: { name: string; role: string | null }[];
    series: string | null;
    position: number | null;
    count: number;
    type: string | null;
  } | null;
  bookwalker: { title: string; keywords: string | null } | null;
}

/** Python's str slicing counts code points. */
const cp = (s: string) => Array.from(s);
const pyStr = (v: unknown) => (v === null || v === undefined ? 'None' : String(v));

/**
 * The evidence of one book, from the sources as stage 4 fetched them (`baseRecord`: Amazon's
 * own page, not BOOK☆WALKER standing in for it; the model sees BOOK☆WALKER in its own section).
 */
export function stage4Evidence(r: RefRecord): Stage4AiEvidence {
  const f = (r.file ?? {}) as RefRecord['file'] & { publisher?: string[]; asin?: string | null };
  const a = r.amazon?.product ?? null;
  const rb = r.ranobedb ?? null;
  const b = rb?.book ?? null;
  const books = rb?.series?.books ?? [];
  const me = books.find((x) => x.id === b?.id);
  const bw = r.bookwalker?.detail ?? null;
  return {
    v: STAGE4_EVIDENCE_VERSION,
    calibre: {
      title: (r.calibre?.cal_title as string | undefined) ?? null,
      authors: (r.calibre?.cal_authors as string | undefined) ?? null,
    },
    file: {
      title: f.opf_title ?? null,
      creators: (f.creators ?? []).map((x) => ({ name: x.name, role: x.role ?? null })),
      publisher: Array.isArray(f.publisher) ? f.publisher : [],
      asin: f.asin ?? null,
      chars: f.chars ?? null,
      images: f.images ?? null,
      front: cp((f.front_text ?? '').trim())
        .slice(0, 600)
        .join(''),
      colophon: cp((f.colophon_text ?? '').trim())
        .slice(-1500)
        .join(''),
    },
    amazon: a
      ? {
          searched: !!r.amazon?.picked_from_search,
          title: a.title ?? null,
          people: (a.authors ?? []).map((x) => ({ name: x.name, role: x.role })),
          series: a.series ?? null,
          breadcrumbs: a.breadcrumbs ?? [],
        }
      : null,
    ranobedb: b
      ? {
          title: b.title_orig ?? null,
          staff: (b.staff ?? []).map((x) => ({ name: x.name, role: x.role ?? null })),
          series: rb?.series?.title_orig ?? null,
          position: me?.sort_order ?? null,
          count: books.length,
          type: me?.type ?? null,
        }
      : null,
    bookwalker: bw?.title ? { title: bw.title, keywords: bw.keywords ?? null } : null,
  };
}

/** The user message: bakeoff7.py's evidence(), line for line. Labels are never in it. */
export function stage4UserText(e: Stage4AiEvidence): string {
  const lines = [
    '## Calibre record (unreliable)',
    `title: ${pyStr(e.calibre.title)}`,
    `authors: ${pyStr(e.calibre.authors)}`,
    '## EPUB file metadata',
    `title: ${pyStr(e.file.title)}`,
    'creators: ' + e.file.creators.map((x) => `${x.name} (${x.role || 'no role'})`).join(', '),
    `publisher: ${e.file.publisher.join(', ')}`,
    `asin in file: ${pyStr(e.file.asin)}`,
    `text characters: ${pyStr(e.file.chars)}, images: ${pyStr(e.file.images)}`,
    '## First pages (excerpt)',
    e.file.front,
    '## Last pages / colophon (excerpt)',
    e.file.colophon,
  ];
  const a = e.amazon;
  lines.push(
    '## Amazon.co.jp ' + (a ? (a.searched ? '(found by title search)' : '(by ASIN)') : ''),
  );
  if (a) {
    lines.push(
      `title: ${pyStr(a.title)}`,
      'people: ' + a.people.map((x) => `${x.name} (${x.role})`).join(', '),
      `series block: ${a.series || '(none)'}`,
      `category: ${a.breadcrumbs.join(' > ')}`,
    );
  } else lines.push('no result');
  lines.push('## RanobeDB');
  const rb = e.ranobedb;
  if (rb) {
    lines.push(
      `title: ${pyStr(rb.title)}`,
      'staff: ' + rb.staff.map((x) => `${x.name} (${pyStr(x.role)})`).join(', '),
      `series: ${pyStr(rb.series)} (position ${pyStr(rb.position)} of ${rb.count}, book type ${pyStr(rb.type)})`,
    );
  } else lines.push('no result');
  lines.push('## BookWalker');
  if (e.bookwalker)
    lines.push(`title: ${e.bookwalker.title}`, `keywords: ${pyStr(e.bookwalker.keywords)}`);
  else lines.push('no result');
  return lines.join('\n');
}

/** Everything a model may take values from (the never-invent check). */
export function stage4EvidenceText(e: Stage4AiEvidence): string {
  return evidenceForm(stage4UserText(e));
}

// ---------------------------------------------------------------------------------------------
// the answer

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.map(str).filter((x): x is string => x !== null) : null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : null;
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;

export function parseStage4Answer(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (!('title' in a) || !('series' in a)) return null;
  return {
    title: str(a.title),
    authors: a.authors === null ? null : strList(a.authors),
    illustrators: a.illustrators === null ? null : strList(a.illustrators),
    series: str(a.series),
    series_index: num(a.series_index),
    format: oneOf(a.format, FORMATS),
    edition_kind: oneOf(a.edition_kind, KINDS),
    amazon_is_this_book: typeof a.amazon_is_this_book === 'boolean' ? a.amazon_is_this_book : null,
    ranobedb_is_this_book:
      typeof a.ranobedb_is_this_book === 'boolean' ? a.ranobedb_is_this_book : null,
    confidence: a.confidence && typeof a.confidence === 'object' ? a.confidence : {},
  };
}

// ---------------------------------------------------------------------------------------------
// fields, compared the way the bake-off's designs compared them (designs2.py key())

/** The bake-off's title comparison (rules' N, also ignoring 〈〉《》 and similar). */
export function titleKey(t: string): string {
  return (N(t) ?? '').replace(/[〈〉《》<>─—–‒,、]/gu, '');
}
const nameKey = (l: string[]) => [...l.map((x) => NA(x))].sort().join('|');

/** A series value: { name: null } is a real answer, "no series" (the framework's null is "can't tell"). */
export interface SeriesValue {
  name: string | null;
}
/** A number value: { n: null } = no number. */
export interface NumberValue {
  n: number | null;
}

/** The six fields the gate scores, plus the description's "Amazon is this book". */
export const STAGE4_AI_FIELDS: {
  t: AiField<string>;
  au: AiField<string[]>;
  il: AiField<string[]>;
  se: AiField<SeriesValue>;
  ix: AiField<NumberValue>;
  fmt: AiField<string>;
  amazon: AiField<boolean>;
} = {
  t: {
    name: 'title',
    fromAnswer: (a) => {
      const t = str(a.title);
      return t ? pyStrip(lightNormalize(t)) : undefined;
    },
    same: (x, y) => titleKey(x) === titleKey(y),
    strings: (v) => [v],
  },
  au: {
    name: 'authors',
    // The bake-off counted a null list as an empty one (key() of None is ()).
    fromAnswer: (a) =>
      Array.isArray(a.authors) || a.authors === null
        ? ((a.authors as string[] | null) ?? []).map((x) => normalizeName(x)).filter(Boolean)
        : undefined,
    same: (x, y) => nameKey(x) === nameKey(y),
    strings: (v) => v,
  },
  il: {
    name: 'illustrators',
    fromAnswer: (a) =>
      Array.isArray(a.illustrators) || a.illustrators === null
        ? ((a.illustrators as string[] | null) ?? []).map((x) => normalizeName(x)).filter(Boolean)
        : undefined,
    same: (x, y) => nameKey(x) === nameKey(y),
    strings: (v) => v,
  },
  se: {
    name: 'series',
    fromAnswer: (a) => {
      const s = str(a.series);
      return { name: s ? pyStrip(lightNormalize(s)) : null };
    },
    same: (x, y) => (x.name ? N(x.name) : null) === (y.name ? N(y.name) : null),
    strings: (v) => (v.name ? [v.name] : []),
  },
  ix: {
    name: 'number',
    fromAnswer: (a) => ({ n: num(a.series_index) }),
    same: (x, y) => x.n === y.n,
  },
  fmt: {
    name: 'format',
    fromAnswer: (a) => oneOf(a.format, FORMATS) ?? undefined,
    same: (x, y) => x === y,
  },
  amazon: {
    name: 'amazon_is_this_book',
    fromAnswer: (a) =>
      typeof a.amazon_is_this_book === 'boolean' ? a.amazon_is_this_book : undefined,
    same: (x, y) => x === y,
  },
};

/** The stage as the AI framework asks it (task keys: settings.models stage4.*). */
export const STAGE4_SPEC: AiStageSpec<Stage4AiEvidence> = {
  stage: 'calibre4',
  promptVersion: STAGE4_PROMPT_VERSION,
  tasks: {
    primary: 'stage4.primary',
    secondary: 'stage4.secondary',
    upgradePrimary: 'stage4.upgradePrimary',
    upgradeSecondary: 'stage4.upgradeSecondary',
  },
  system: STAGE4_SYSTEM,
  userText: stage4UserText,
  schema: STAGE4_SCHEMA,
  schemaName: 'calibre_book_metadata',
  parseAnswer: parseStage4Answer,
  evidenceText: stage4EvidenceText,
};
