/**
 * Book summaries: one setup on one book, step by step, through the shared AI layer's queue
 * (session 2's engine; session 3 runs it as a job).
 *
 * Every step asks through `ask`: the evidence is stored and the question queued; one pump steps
 * every stage of the feature in turn (never two steps of a stage at once), and the answer comes
 * from what is stored. Asking again with the same evidence is answered from the store without a
 * request, so a stopped run that starts again asks nothing twice and gets the same results.
 */
import type Database from 'better-sqlite3';
import type { AiRunner } from '../ai/runner';
import type { AiStageSpec, StoredAnswer } from '../ai/types';
import type { AiWait } from '../ai/waits';
import type { BookScript } from '../audio/book-script';
import { bookTextFromScript, QuoteIndex, type BookText } from './book-text';
import {
  applyTranslation,
  chapterEvidence,
  checkExtraction,
  checkWritten,
  cleanPairs,
  crossChecked,
  extractEvidence,
  matchEvidence,
  summaryItems,
  supportEvidence,
  translationItems,
  writeEvidence,
  type CrossCheck,
  type ExtractCheck,
} from './pipeline';
import {
  ALL_SPECS,
  EXTRACT_CHAPTER_SPEC,
  EXTRACT_SPEC,
  MATCH_SPEC,
  MODELS,
  SUPPORT_SPEC,
  TRANSLATE_SPEC,
  WRITE_SPEC,
  type ExtractAnswer,
  type ModelRole,
  type RawItem,
  type Verdict,
  type WriteAnswer,
} from './specs';
import type { CheckedItem, Summary } from './types';

export const EVIDENCE_VERSION = 1;

/** The setups compared in the accuracy test (book-summaries.md "Step A"). */
export type CloudSetup = 'two' | 'opus';
export const SETUPS: Record<
  CloudSetup,
  { label: string; extract: ModelRole[]; writer: ModelRole; matcher: ModelRole | null }
> = {
  two: {
    label: 'Sonnet 5.5 + GPT-6.1 Sol',
    extract: ['sonnet', 'sol'],
    writer: 'sonnet',
    matcher: 'sonnet',
  },
  opus: { label: 'Opus 5.5 alone', extract: ['opus'], writer: 'opus', matcher: null },
};

export class Refused extends Error {
  constructor(
    readonly stage: string,
    readonly model: string,
  ) {
    super(`${model} refused (${stage})`);
  }
}

export class Unusable extends Error {
  constructor(
    readonly stage: string,
    readonly model: string,
    readonly state: string,
  ) {
    super(`${model} gave no usable answer (${stage}: ${state})`);
  }
}

/** One question the run asked, for its costs and times. */
export interface Asked {
  stage: string;
  key: string;
  model: string;
}

export interface RunReport {
  extracted: Record<string, ExtractCheck>;
  cross: CrossCheck;
  writtenDropped: number;
  droppedItems: { section: string; text: string; why: string }[];
  refusals: { stage: string; model: string }[];
  asked: Asked[];
}

/** Steps every stage of the feature in turn while anything is open. One per runner. */
export class Pump {
  private running = false;
  private stopped = false;
  lastWait: AiWait | null = null;
  private wakers: (() => void)[] = [];

  constructor(
    private readonly runner: AiRunner,
    private readonly runId: string,
    private readonly specs: AiStageSpec<unknown, ModelRole>[] = ALL_SPECS,
    private readonly intervalMs = 2000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  /** Resolves at the next pass of the pump. */
  tick(): Promise<void> {
    return new Promise((r) => this.wakers.push(r));
  }

  private async loop(): Promise<void> {
    try {
      while (!this.stopped) {
        let wait: AiWait | null = null;
        for (const spec of this.specs) {
          if (this.stopped) break;
          if (this.runner.pending(spec.stage, this.runId) === 0) continue;
          const r = await this.runner.step(spec, this.runId, () => this.stopped);
          wait ??= r.wait;
        }
        this.lastWait = wait;
        const w = this.wakers;
        this.wakers = [];
        for (const f of w) f();
        await new Promise((r) => setTimeout(r, this.intervalMs));
      }
    } finally {
      this.running = false;
      const w = this.wakers;
      this.wakers = [];
      for (const f of w) f();
    }
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}

export interface EngineDeps {
  runner: AiRunner;
  pump: Pump;
  runId: string;
  /** Called with each question asked (the run's report). */
  onAsk?: (a: Asked) => void;
}

/** Asks one question (or reads its stored answer) and waits for the answer. */
export async function ask<E>(
  d: EngineDeps,
  spec: AiStageSpec<E, ModelRole>,
  role: ModelRole,
  key: string,
  evidence: E,
): Promise<StoredAnswer> {
  d.runner.putItems(spec as AiStageSpec<E>, [{ key, evidence, labeled: false }], EVIDENCE_VERSION);
  d.onAsk?.({ stage: spec.stage, key, model: MODELS[role] });
  let a = d.runner.answerOf(spec, role, key);
  if (a && a.state !== 'failed') return a;
  d.runner.enqueue(spec, role, [key], d.runId);
  for (;;) {
    a = d.runner.answerOf(spec, role, key);
    if (a) return a;
    if (d.pump.isStopped) throw new Error('stopped');
    await d.pump.tick();
  }
}

function usable(a: StoredAnswer, stage: string): Record<string, unknown> {
  if (a.state === 'blocked') throw new Refused(stage, a.model);
  if (a.state !== 'answered' || !a.answer) throw new Unusable(stage, a.model, a.state);
  return a.answer;
}

export interface BookInput {
  key: string;
  title: string;
  script: BookScript;
  lang: string;
  /** Earlier volumes' summaries as background text (null = none). */
  background: string | null;
}

export function prepared(b: BookInput): { book: BookText; index: QuoteIndex } {
  return { book: bookTextFromScript(b.script), index: new QuoteIndex(b.script) };
}

/** One model's extraction: the whole book, then the chapters it left empty, then the quote check. */
async function extractOne(
  d: EngineDeps,
  b: BookInput,
  book: BookText,
  index: QuoteIndex,
  role: ModelRole,
  bg: string,
): Promise<ExtractCheck> {
  const whole = usable(
    await ask(
      d,
      EXTRACT_SPEC,
      role,
      `${b.key}|${bg}`,
      extractEvidence(b.title, book, b.background),
    ),
    EXTRACT_SPEC.stage,
  ) as unknown as ExtractAnswer;
  const first = checkExtraction(role, MODELS[role], book, index, whole, new Map());
  const follow = new Map<number, { not_story: boolean; items: RawItem[] }>();
  await Promise.all(
    first.emptyChapters.map(async (ch) => {
      const a = await ask(
        d,
        EXTRACT_CHAPTER_SPEC,
        role,
        `${b.key}|${bg}#${ch}`,
        chapterEvidence(b.title, book, ch, b.background),
      );
      if (a.state === 'answered' && a.answer)
        follow.set(ch, a.answer as unknown as { not_story: boolean; items: RawItem[] });
    }),
  );
  return checkExtraction(role, MODELS[role], book, index, whole, follow);
}

/** The support check of `items` by `checker`. */
async function support(
  d: EngineDeps,
  b: BookInput,
  book: BookText,
  items: CheckedItem[],
  checker: ModelRole,
  label: string,
  refusals: RunReport['refusals'],
): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>();
  const parts = supportEvidence(b.title, book, items);
  await Promise.all(
    parts.map(async (p) => {
      const a = await ask(d, SUPPORT_SPEC, checker, `${b.key}|${label}|${p.key}`, p.evidence);
      if (a.state === 'blocked') {
        refusals.push({ stage: SUPPORT_SPEC.stage, model: a.model });
        return;
      }
      if (a.state !== 'answered' || !a.answer) return;
      for (const v of (a.answer as { verdicts: { id: string; verdict: Verdict }[] }).verdicts)
        out.set(v.id, v.verdict);
    }),
  );
  return out;
}

/** One cloud setup on one book: extract, quote check, cross-check, write, check. */
export async function runCloudSetup(
  d: EngineDeps,
  b: BookInput,
  setup: CloudSetup,
  now: () => number = Date.now,
): Promise<{ summary: Summary; report: RunReport }> {
  const conf = SETUPS[setup];
  const { book, index } = prepared(b);
  const bg = b.background ? 'bg1' : 'bg0';
  const refusals: RunReport['refusals'] = [];
  const extracted: Record<string, ExtractCheck> = {};
  const roles: ModelRole[] = [];
  await Promise.all(
    conf.extract.map(async (role) => {
      try {
        extracted[role] = await extractOne(d, b, book, index, role, bg);
        roles.push(role);
      } catch (e) {
        if (e instanceof Refused) refusals.push({ stage: e.stage, model: e.model });
        else throw e;
      }
    }),
  );
  if (!roles.length)
    throw new Refused(EXTRACT_SPEC.stage, conf.extract.map((r) => MODELS[r]).join(', '));
  roles.sort((x, y) => conf.extract.indexOf(x) - conf.extract.indexOf(y));

  let cross: CrossCheck;
  if (roles.length === 2) {
    const [ra, rb] = roles;
    const A = extracted[ra].items;
    const B = extracted[rb].items;
    const m = await ask(
      d,
      MATCH_SPEC,
      conf.matcher!,
      `${b.key}|${bg}|${setup}`,
      matchEvidence(b.title, A, B),
    );
    const pairs = cleanPairs(
      (usable(m, MATCH_SPEC.stage) as { pairs: { a: string; b: string }[] }).pairs,
      A,
      B,
    );
    const pa = new Set(pairs.map((p) => p.a));
    const pb = new Set(pairs.map((p) => p.b));
    const [va, vb] = await Promise.all([
      support(
        d,
        b,
        book,
        A.filter((x) => !pa.has(x.id)),
        rb,
        `${bg}|${rb}-checks-${ra}`,
        refusals,
      ),
      support(
        d,
        b,
        book,
        B.filter((x) => !pb.has(x.id)),
        ra,
        `${bg}|${ra}-checks-${rb}`,
        refusals,
      ),
    ]);
    cross = crossChecked(A, B, pairs, new Map([...va, ...vb]));
  } else {
    // One model (Opus alone, or a setup whose other model refused): it checks its own items.
    const [r] = roles;
    const A = extracted[r].items;
    const v = await support(d, b, book, A, r, `${bg}|${r}-checks-${r}`, refusals);
    cross = crossChecked(A, [], [], v);
  }

  const writer = roles.includes(conf.writer) ? conf.writer : roles[0];
  const w = await ask(
    d,
    WRITE_SPEC,
    writer,
    `${b.key}|${bg}|${setup}|${roles.join('+')}`,
    writeEvidence(b.title, book, cross.items, b.background),
  );
  const answer = usable(w, WRITE_SPEC.stage) as unknown as WriteAnswer;
  const models = [...new Set([...roles.map((r) => MODELS[r]), MODELS[writer]])];
  const checked = checkWritten(answer, cross.items, book, index, {
    lang: b.lang,
    title: b.title,
    models,
    madeAt: now(),
  });
  return {
    summary: checked.summary,
    report: {
      extracted,
      cross,
      writtenDropped: checked.dropped,
      droppedItems: checked.droppedItems,
      refusals,
      asked: [],
    },
  };
}

/** A finished summary translated item by item (quotes kept in the original). */
export async function translate(
  d: EngineDeps,
  runKey: string,
  s: Summary,
  to: string,
  role: ModelRole = 'sonnet',
): Promise<{ summary: Summary; missing: string[] }> {
  const a = await ask(d, TRANSLATE_SPEC, role, `${runKey}|${to}`, {
    from: s.lang,
    to,
    title: s.bookTitle,
    items: translationItems(s),
  });
  const ans = usable(a, TRANSLATE_SPEC.stage) as {
    items: { ref: string; heading: string; text: string }[];
  };
  return applyTranslation(s, to, ans.items);
}

/** Background text for a later volume: the earlier summaries' overview, people and terms. */
export function backgroundText(volumes: { title: string; summary: Summary }[]): string | null {
  if (!volumes.length) return null;
  return volumes
    .map(({ title, summary }) => {
      const lines: string[] = [`## ${title}`];
      for (const { section, item } of summaryItems(summary)) {
        if (section === 'chapters') continue;
        const head =
          item.heading ?? (item.between ? `${item.between[0]} / ${item.between[1]}` : null);
        lines.push(`- (${section}) ${head ? `${head}: ` : ''}${item.text}`);
      }
      if (summary.alsoMentioned.length)
        lines.push(`- (also mentioned) ${summary.alsoMentioned.join('、')}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Costs and times of the questions a run asked, from the stored requests. */
export function askedMetrics(
  db: Database.Database,
  asked: Asked[],
): {
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  modelSeconds: number;
  /** From the first request sent to the last answer (stored times: the same after a restart). */
  spanSeconds: number;
  /**
   * The run's own time: each step's longest request, added up (a step's requests run side by
   * side, the steps one after another). Unlike the span, a pause or an earlier failed try
   * between steps doesn't count.
   */
  pathSeconds: number;
  /**
   * The time any request of the run was at a model (overlapping request times merged): the
   * run's time without gaps between its requests (a stop, a restart, an earlier failed try).
   */
  busySeconds: number;
  byStage: Record<string, { costUsd: number; requests: number; seconds: number }>;
  refusals: number;
} {
  const seen = new Set<string>();
  const get = db.prepare(
    `SELECT state, cost_usd, input_tokens, output_tokens, cache_read_tokens, sent_at, answered_at, mode
     FROM ai_requests WHERE stage = ? AND item_key = ? AND model = ? AND state IN ('answered','blocked','invalid')
     ORDER BY id DESC LIMIT 1`,
  );
  const out = {
    costUsd: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelSeconds: 0,
    spanSeconds: 0,
    pathSeconds: 0,
    busySeconds: 0,
    byStage: {} as Record<string, { costUsd: number; requests: number; seconds: number }>,
    refusals: 0,
  };
  let first = Infinity;
  let last = 0;
  const longest: Record<string, number> = {};
  const spans: [number, number][] = [];
  for (const a of asked) {
    const k = `${a.stage}|${a.key}|${a.model}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const r = get.get(a.stage, a.key, a.model) as
      | {
          state: string;
          cost_usd: number | null;
          input_tokens: number | null;
          output_tokens: number | null;
          cache_read_tokens: number | null;
          sent_at: number | null;
          answered_at: number | null;
          mode: string | null;
        }
      | undefined;
    if (!r) continue;
    const secs =
      r.mode === 'direct' && r.sent_at && r.answered_at ? (r.answered_at - r.sent_at) / 1000 : 0;
    out.costUsd += r.cost_usd ?? 0;
    out.requests++;
    out.inputTokens += (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0);
    out.outputTokens += r.output_tokens ?? 0;
    out.modelSeconds += secs;
    longest[a.stage] = Math.max(longest[a.stage] ?? 0, secs);
    if (r.sent_at && r.answered_at) {
      if (r.mode === 'direct') spans.push([r.sent_at, r.answered_at]);
      first = Math.min(first, r.sent_at);
      last = Math.max(last, r.answered_at);
    }
    if (r.state === 'blocked') out.refusals++;
    const s = (out.byStage[a.stage] ??= { costUsd: 0, requests: 0, seconds: 0 });
    s.costUsd += r.cost_usd ?? 0;
    s.requests++;
    s.seconds += secs;
  }
  out.spanSeconds = last > 0 && first < Infinity ? (last - first) / 1000 : 0;
  out.pathSeconds = Object.values(longest).reduce((a, x) => a + x, 0);
  spans.sort((x, y) => x[0] - y[0]);
  let busy = 0;
  let cur: [number, number] | null = null;
  for (const s of spans) {
    if (!cur || s[0] > cur[1]) {
      if (cur) busy += cur[1] - cur[0];
      cur = [s[0], s[1]];
    } else cur[1] = Math.max(cur[1], s[1]);
  }
  if (cur) busy += cur[1] - cur[0];
  out.busySeconds = busy / 1000;
  return out;
}
