/**
 * Book summaries session 2: the local model (gemma-4-26B-A4B through llama.cpp's llama-server on
 * the PC, started with the PC worker's settings), the last-resort fallback.
 *
 * Its context is small (16,384 tokens, or what the test measured to fit), so it reads the book
 * in windows of about 5,000 characters inside each chapter, its items go through the same quote
 * check, and it writes the summary section by section: each chapter from that chapter's items,
 * then characters, relationships, terms and open threads from the items of those kinds, then
 * the overview from the written chapters. No cross-check (it runs alone).
 *
 * Its answers are stored like the cloud models' (local_answers: one per step, model, prompt
 * version and evidence), so a stopped run asks nothing twice.
 */
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import http from 'node:http';
import { prepared, type BookInput } from './engine';
import { checkExtraction, checkWritten } from './pipeline';
import {
  EXTRACT_CHAPTER_SPEC,
  PROMPT_VERSION,
  WRITE_SPEC,
  type ExtractAnswer,
  type RawItem,
  type WriteAnswer,
  type WrittenItem,
} from './specs';
import type { RunMetrics } from './test-service';
import type { CheckedItem, Summary } from './types';
import type { TextChapter } from './book-text';

export const LOCAL_MODEL = 'gemma-4-26B-A4B';
export const WINDOW_CHARS = 5000;

export interface LocalEngine {
  run(
    inp: BookInput,
    onPhase: (phase: string) => void,
  ): Promise<{ summary: Summary; metrics: RunMetrics }>;
}

interface Answer {
  content: string;
  promptTokens: number | null;
  outputTokens: number | null;
  ms: number;
}

/** A JSON request to llama-server (node:http: no time limit of fetch's). */
function post(
  base: string,
  route: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(route, base);
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) });
          } catch {
            resolve({
              status: res.statusCode ?? 0,
              json: { error: { message: text.slice(0, 300) } },
            });
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('the local model took too long')));
    req.on('error', reject);
    req.end(data);
  });
}

/** Windows of a chapter: about WINDOW_CHARS each, cut at line ends. */
export function windowsOf(ch: TextChapter, size = WINDOW_CHARS): string[] {
  const lines = ch.text.split('\n');
  const out: string[] = [];
  let cur = '';
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > size) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${l}` : l;
    while (cur.length > size * 1.5) {
      out.push(cur.slice(0, size));
      cur = cur.slice(size);
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const sectionSchema = (extra: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...required, 'text', 'cites', 'quote_from', 'show_quote'],
        properties: {
          ...extra,
          text: { type: 'string' },
          cites: { type: 'array', items: { type: 'string' } },
          quote_from: { type: 'string' },
          show_quote: { type: 'boolean' },
        },
      },
    },
  },
});

export class LlamaServerEngine implements LocalEngine {
  readonly promptVersion = `${PROMPT_VERSION}.local`;
  /** Requests and their times (the report). */
  readonly timings: {
    stage: string;
    ms: number;
    promptTokens: number | null;
    outputTokens: number | null;
  }[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly base: string,
    private readonly o: { contextTokens: number; requestTimeoutMs?: number; now?: () => number } = {
      contextTokens: 16384,
    },
  ) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** One request, or its stored answer. */
  private async ask(
    stage: string,
    key: string,
    system: string,
    user: string,
    schema: unknown,
    nPredict: number,
  ): Promise<unknown | null> {
    const hash = createHash('sha1')
      .update(`${system}\n${user}\n${JSON.stringify(schema)}\n${nPredict}`)
      .digest('hex')
      .slice(0, 20);
    const got = this.db
      .prepare(
        `SELECT state, answer_json FROM local_answers WHERE stage = ? AND item_key = ? AND model = ? AND prompt_version = ? AND evidence_hash = ?`,
      )
      .get(stage, key, LOCAL_MODEL, this.promptVersion, hash) as
      | { state: string; answer_json: string | null }
      | undefined;
    if (got)
      return got.state === 'answered' && got.answer_json ? JSON.parse(got.answer_json) : null;
    const t0 = this.now();
    const tpl = await post(
      this.base,
      '/apply-template',
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      60_000,
    );
    const prompt = (tpl.json as { prompt?: unknown })?.prompt;
    if (tpl.status !== 200 || typeof prompt !== 'string')
      throw new Error(`llama-server could not format a request (HTTP ${tpl.status})`);
    const out = await post(
      this.base,
      '/completion',
      { prompt, n_predict: nPredict, temperature: 0, cache_prompt: true, json_schema: schema },
      this.o.requestTimeoutMs ?? 30 * 60_000,
    );
    const j = out.json as {
      content?: unknown;
      tokens_evaluated?: number;
      tokens_predicted?: number;
      error?: { message?: string };
    };
    if (out.status !== 200 || typeof j.content !== 'string')
      throw new Error(`the local model failed: ${j.error?.message ?? `HTTP ${out.status}`}`);
    const a: Answer = {
      content: j.content,
      promptTokens: j.tokens_evaluated ?? null,
      outputTokens: j.tokens_predicted ?? null,
      ms: this.now() - t0,
    };
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(a.content);
    } catch {
      parsed = null;
    }
    this.db
      .prepare(
        `INSERT INTO local_answers (stage, item_key, model, prompt_version, evidence_hash, state, answer_json, raw_text, prompt_tokens, output_tokens, ms, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stage,
        key,
        LOCAL_MODEL,
        this.promptVersion,
        hash,
        parsed ? 'answered' : 'invalid',
        parsed ? JSON.stringify(parsed) : null,
        a.content.slice(0, 8000),
        a.promptTokens,
        a.outputTokens,
        a.ms,
        this.now(),
      );
    this.timings.push({
      stage,
      ms: a.ms,
      promptTokens: a.promptTokens,
      outputTokens: a.outputTokens,
    });
    return parsed;
  }

  /** Output tokens left for an answer after the prompt (rough: 1.2 tokens a character). */
  private room(promptChars: number): number {
    return Math.max(
      1024,
      Math.min(8192, this.o.contextTokens - Math.ceil(promptChars * 1.2) - 256),
    );
  }

  async run(
    inp: BookInput,
    onPhase: (phase: string) => void,
  ): Promise<{ summary: Summary; metrics: RunMetrics }> {
    const started = this.now();
    const t0 = this.timings.length;
    const { book, index } = prepared(inp);
    onPhase('extract');
    // 1. Extract per window.
    const whole: ExtractAnswer = { chapters: [] };
    for (const ch of book.chapters) {
      const items: RawItem[] = [];
      let notStory = true;
      const wins = windowsOf(ch);
      for (let w = 0; w < wins.length; w++) {
        const user = `BOOK: ${inp.title}\n\n=== Chapter ${ch.index}: ${ch.title} (part ${w + 1} of ${wins.length}) ===\n${wins[w]}`;
        const a = (await this.ask(
          'local.extract',
          `${inp.key}#${ch.index}.${w}`,
          EXTRACT_CHAPTER_SPEC.system,
          user,
          EXTRACT_CHAPTER_SPEC.schema,
          this.room(EXTRACT_CHAPTER_SPEC.system.length + user.length),
        )) as { not_story?: boolean; items?: RawItem[] } | null;
        if (!a) continue;
        if (!a.not_story) notStory = false;
        for (const it of a.items ?? [])
          if (it && typeof it.quote === 'string' && typeof it.text === 'string')
            items.push({
              kind: it.kind,
              text: it.text,
              quote: it.quote,
              names: Array.isArray(it.names) ? it.names : [],
            });
      }
      whole.chapters.push({ chapter: ch.index, not_story: notStory && items.length === 0, items });
    }
    const ex = checkExtraction('sonnet', LOCAL_MODEL, book, index, whole, new Map());
    // The ids say who made them.
    const items: CheckedItem[] = ex.items.map((x) => ({
      ...x,
      id: x.id.replace(/^sonnet:/, 'gemma:'),
    }));

    // 2. Write section by section.
    onPhase('write');
    const line = (x: CheckedItem, quote: boolean) =>
      `${x.id} [ch ${x.chapter}, ${x.kind}] ${x.text}${quote ? ` 「${x.quote}」` : ''}`;
    const sys = WRITE_SPEC.system;
    const answer: WriteAnswer = {
      overview: { text: '', cites: [] },
      chapters: [],
      characters: [],
      also_mentioned: [],
      relationships: [],
      terms: [],
      threads: [],
    };
    for (const ch of book.chapters) {
      const its = items.filter((x) => x.chapter === ch.index);
      if (!its.length) continue;
      const user = `BOOK: ${inp.title}\nWrite only the chapters section, for chapter ${ch.index}: ${ch.title}.\n\nITEMS:\n${its.map((x) => line(x, true)).join('\n')}`;
      const a = (await this.ask(
        'local.write.chapter',
        `${inp.key}#${ch.index}`,
        sys,
        user,
        sectionSchema({}, []),
        this.room(sys.length + user.length),
      )) as { items?: WrittenItem[] } | null;
      if (a?.items?.length) answer.chapters.push({ chapter: ch.index, items: a.items });
    }
    const pick = (kinds: string[]) => items.filter((x) => kinds.includes(x.kind));
    const fit = (list: CheckedItem[], budgetChars: number) => {
      const out: CheckedItem[] = [];
      let n = 0;
      for (const x of list) {
        const l = line(x, false).length + 1;
        if (n + l > budgetChars) break;
        out.push(x);
        n += l;
      }
      return out;
    };
    const budget = Math.floor((this.o.contextTokens - 3000) / 1.2) - sys.length;
    const sections: {
      key: 'characters' | 'relationships' | 'terms' | 'threads';
      kinds: string[];
      schema: unknown;
    }[] = [
      {
        key: 'characters',
        kinds: ['character', 'relationship', 'event'],
        schema: sectionSchema({ name: { type: 'string' } }, ['name']),
      },
      {
        key: 'relationships',
        kinds: ['relationship', 'character'],
        schema: sectionSchema({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']),
      },
      {
        key: 'terms',
        kinds: ['term', 'reveal'],
        schema: sectionSchema({ term: { type: 'string' } }, ['term']),
      },
      { key: 'threads', kinds: ['thread', 'reveal', 'event'], schema: sectionSchema({}, []) },
    ];
    let leftOut = 0;
    for (const s of sections) {
      const all = pick(s.kinds);
      const its = fit(all, budget);
      leftOut += all.length - its.length;
      if (!its.length) continue;
      const user = `BOOK: ${inp.title}\nWrite only the ${s.key} section.\n\nITEMS:\n${its.map((x) => line(x, false)).join('\n')}`;
      const a = (await this.ask(
        `local.write.${s.key}`,
        inp.key,
        sys,
        user,
        s.schema,
        this.room(sys.length + user.length),
      )) as { items?: never[] } | null;
      if (a?.items) (answer[s.key] as unknown[]) = a.items;
    }
    // The overview from the written chapters.
    const chText = answer.chapters
      .map((c) => `Chapter ${c.chapter}: ${c.items.map((i) => i.text).join(' ')}`)
      .join('\n');
    const ovUser = `BOOK: ${inp.title}\nWrite only the overview from these chapter summaries (cite nothing).\n\n${chText.slice(0, budget)}`;
    const ov = (await this.ask(
      'local.write.overview',
      inp.key,
      "You write the overview of a book summary: the book in a few sentences, what it is about and how it ends, only from the chapter summaries given. Write in the book's language.",
      ovUser,
      {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      1500,
    )) as { text?: string } | null;
    answer.overview = { text: ov?.text ?? '', cites: [] };

    const checked = checkWritten(answer, items, book, index, {
      lang: inp.lang,
      title: inp.title,
      models: [LOCAL_MODEL],
      madeAt: this.now(),
    });
    const mine = this.timings.slice(t0);
    const ms = mine.reduce((a, x) => a + x.ms, 0);
    const metrics: RunMetrics = {
      costUsd: 0,
      requests: mine.length,
      inputTokens: mine.reduce((a, x) => a + (x.promptTokens ?? 0), 0),
      outputTokens: mine.reduce((a, x) => a + (x.outputTokens ?? 0), 0),
      seconds: (this.now() - started) / 1000,
      modelSeconds: ms / 1000,
      byStage: {},
      extracted: {
        gemma: {
          extracted: ex.extracted,
          quoteNotFound: ex.quoteNotFound,
          kept: items.length,
          emptyChapters: ex.emptyChapters.length,
          notStory: ex.notStory.length,
        },
      },
      confirmed: 0,
      crossChecked: 0,
      supported: 0,
      partly: 0,
      notSupported: 0,
      writtenDropped: checked.dropped,
      refusals: [],
      droppedQuotes: ex.droppedQuotes.map((q) => ({ model: 'gemma', ...q })),
      droppedItems: checked.droppedItems,
      local: { contextTokens: this.o.contextTokens, itemsLeftOutOfSections: leftOut },
    };
    for (const t of mine) {
      const s = (metrics.byStage[t.stage] ??= { costUsd: 0, requests: 0, seconds: 0 });
      s.requests++;
      s.seconds += t.ms / 1000;
    }
    return { summary: checked.summary, metrics };
  }
}
