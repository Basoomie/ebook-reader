/**
 * The two providers (WP21d): Anthropic (Claude) and OpenAI (GPT), through their official SDKs.
 * Direct calls, the Batch APIs (half price), and the model lists.
 *
 * Decided before production (library-cleanup-plan.md section 6):
 * - Claude 5.5 models: no temperature (refused), adaptive thinking at its default effort (as the
 *   bake-off measured), and max_tokens includes the thinking, so it leaves room (setting).
 * - GPT: Chat Completions at its defaults (as the bake-off measured).
 * - A content block (Claude's refusal stop reason, GPT's content filter or refusal, a prompt the
 *   provider blocks) is final: recorded as `blocked`, never asked again.
 * - Only busy (429/529), server errors and network errors are tried again; everything else is
 *   final for this run.
 *
 * Test-only addresses: CLEANUP_AI_ANTHROPIC_URL and CLEANUP_AI_OPENAI_URL (the e2e's stand-in;
 * named when the layer was the cleanup's, kept so the existing e2e stacks keep their stand-ins).
 *
 * Once a batch's answers are collected, what the provider keeps of it is deleted
 * (`deleteBatchData`): OpenAI keeps a batch's input, output and error files for 30 days,
 * Anthropic a Message Batch's inputs and results for 29 days (both checked 2026-11-21).
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';
import type { Provider } from './types';

export interface CallInput {
  model: string;
  system: string;
  user: string;
  /** Structured outputs: the answer's JSON schema; null = plain JSON asked in the prompt. */
  schema: { name: string; schema: Record<string, unknown> } | null;
  /** Claude: max_tokens (thinking included). */
  maxTokens: number;
  /**
   * Request options of a stage that sets them (AiStageSpec.request); absent = the request as
   * before. `outputLimit`: GPT's max_completion_tokens; `stream`: direct calls stream.
   */
  effort?: import('./types').AiEffort;
  outputLimit?: number;
  stream?: boolean;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type CallResult =
  | { kind: 'answered'; text: string; json: unknown; usage: Usage }
  | { kind: 'blocked'; detail: string; text: string | null; usage: Usage }
  | { kind: 'invalid'; detail: string; text: string | null; usage: Usage };

interface ErrLike {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  address?: unknown;
  port?: unknown;
  errors?: unknown;
}

/** One low-level error: its code and the address it was connecting to, if any. */
function errDetail(x: ErrLike): string {
  const code = typeof x.code === 'string' && x.code ? x.code : null;
  const where = typeof x.address === 'string' ? ` ${x.address}:${String(x.port ?? '')}` : '';
  return code ? code + where : typeof x.message === 'string' ? x.message + where : 'unknown';
}

/**
 * Why a connection failed, from the error's cause chain (the SDKs' "Connection error." hides
 * it): the code with the address it was connecting to (e.g. "ETIMEDOUT 160.79.104.10:443"),
 * and for an attempt over several addresses each address's own error.
 */
export function causeOf(err: unknown): string | null {
  let e = (err as ErrLike | null)?.cause;
  for (let depth = 0; e && depth < 5; depth++) {
    const x = e as ErrLike;
    if (Array.isArray(x.errors) && x.errors.length)
      return `${errDetail(x)} [${(x.errors as ErrLike[]).map(errDetail).join('; ')}]`;
    if ((typeof x.code === 'string' && x.code) || !x.cause) return errDetail(x);
    e = x.cause;
  }
  return null;
}

/** A failure worth trying again later (busy, server error, network). */

/** A connection error's message with its cause, e.g. "Connection error. (ETIMEDOUT)". */
function connectionMessage(err: Error): string {
  const why = causeOf(err);
  return why ? `${err.message} (${why})` : err.message;
}

export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
    /**
     * The provider's own rate limit (429, Anthropic's 529 overloaded): not the question's fault,
     * so it uses up none of its tries (WP20e stop 2: 536 of Luna's questions were given up on
     * "Rate limit reached … tokens per min" with 60 calls at the same time).
     */
    readonly busy = false,
  ) {
    super(message);
  }
}

/** A failure that won't change by asking again (bad request, auth, model not found). */
export class FinalError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }

  /** The key is wrong or lacks access: nothing is marked failed, the stage waits. */
  get auth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface BatchItem {
  customId: string;
  call: CallInput;
}

export type BatchOutcome =
  | { customId: string; result: CallResult }
  | { customId: string; error: string; retryable: boolean };

export interface BatchStatus {
  ended: boolean;
  /** The provider's own word for it ("in_progress", "ended", "completed", "expired", ...). */
  status: string;
  /** The batch can't give results (failed as a whole): its requests go back. */
  failed: boolean;
  /** Requests the provider has finished so far (answered or errored). */
  done: number;
}

export interface ProviderClient {
  provider: Provider;
  listModels(): Promise<string[]>;
  call(input: CallInput, timeoutMs: number): Promise<CallResult>;
  submitBatch(items: BatchItem[]): Promise<{ id: string; inputFileId: string | null }>;
  batchStatus(id: string): Promise<BatchStatus>;
  batchResults(id: string): Promise<BatchOutcome[]>;
  /** Asks the provider to stop a batch; what it finished stays in its results. */
  cancelBatch(id: string): Promise<void>;
  /**
   * Deletes what the provider keeps of an ended batch (its prompts and answers): OpenAI's input,
   * output and error files, Anthropic's batch. Already gone counts as done.
   */
  deleteBatchData?(id: string): Promise<void>;
}

/** A 404 from a delete: already gone. */
function notFound(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 404;
}

export function providerOf(model: string): Provider {
  return /^claude/i.test(model) ? 'anthropic' : 'openai';
}

const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The first JSON object in a text (the bake-off's parse; text after it is ignored). */
export function firstJson(text: string): unknown {
  const k = text.indexOf('{');
  if (k < 0) return undefined;
  const s = text.slice(k);
  // Find the end of the first balanced object (strings and escapes respected).
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(0, i + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function statusError(
  status: number | undefined,
  message: string,
  retryAfter?: string | null,
) {
  const ms = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
  // A spent quota or billing limit also answers 429; waiting does not end it, so it keeps its
  // tries and is given up as before.
  const busy = (status === 429 && !/quota|billing/i.test(message)) || status === 529;
  if (status === undefined || status === 408 || status === 409 || status === 429 || status >= 500)
    return new RetryableError(message, ms, busy);
  return new FinalError(message, status);
}

// ---------------------------------------------------------------------------------------------
// Anthropic

type AnthropicMessage = Anthropic.Message;

function anthropicResult(m: AnthropicMessage): CallResult {
  const u = m.usage;
  const usage: Usage = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
  const text = m.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  if (m.stop_reason === 'refusal')
    return { kind: 'blocked', detail: 'refusal', text: text || null, usage };
  if (m.stop_reason === 'max_tokens')
    return { kind: 'invalid', detail: 'max_tokens reached', text: text || null, usage };
  const json = firstJson(text);
  if (json === undefined)
    return { kind: 'invalid', detail: 'no JSON object', text: text || null, usage };
  return { kind: 'answered', text, json, usage };
}

function anthropicParams(input: CallInput): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: input.model,
    max_tokens: input.maxTokens,
    system: input.system,
    messages: [{ role: 'user', content: input.user }],
    ...(input.schema || input.effort
      ? {
          output_config: {
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.schema
              ? { format: { type: 'json_schema' as const, schema: input.schema.schema } }
              : {}),
          },
        }
      : {}),
  } as Anthropic.MessageCreateParamsNonStreaming;
}

export class AnthropicProvider implements ProviderClient {
  readonly provider = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, baseURL = process.env.CLEANUP_AI_ANTHROPIC_URL || undefined) {
    this.client = new Anthropic({ apiKey, baseURL, maxRetries: 0 });
  }

  private wrap(err: unknown): Error {
    if (err instanceof Anthropic.APIConnectionError)
      return new RetryableError(connectionMessage(err));
    if (err instanceof Anthropic.APIError) {
      const h = err.headers as Headers | undefined;
      return statusError(
        err.status,
        `${err.status ?? ''} ${err.message}`.trim(),
        h?.get?.('retry-after'),
      );
    }
    return err instanceof Error ? new RetryableError(err.message) : new RetryableError(String(err));
  }

  async listModels(): Promise<string[]> {
    try {
      const out: string[] = [];
      for await (const m of this.client.models.list({ limit: 100 })) out.push(m.id);
      return out;
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async call(input: CallInput, timeoutMs: number): Promise<CallResult> {
    try {
      if (input.stream) {
        const stream = this.client.messages.stream(anthropicParams(input), {
          timeout: timeoutMs,
        });
        return anthropicResult(await stream.finalMessage());
      }
      const m = await this.client.messages.create(anthropicParams(input), { timeout: timeoutMs });
      return anthropicResult(m);
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async submitBatch(items: BatchItem[]): Promise<{ id: string; inputFileId: string | null }> {
    try {
      const b = await this.client.messages.batches.create({
        requests: items.map((i) => ({ custom_id: i.customId, params: anthropicParams(i.call) })),
      });
      return { id: b.id, inputFileId: null };
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async batchStatus(id: string): Promise<BatchStatus> {
    try {
      const b = await this.client.messages.batches.retrieve(id);
      const c = b.request_counts;
      return {
        ended: b.processing_status === 'ended',
        status: b.processing_status,
        failed: false,
        done: c.succeeded + c.errored,
      };
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async cancelBatch(id: string): Promise<void> {
    try {
      await this.client.messages.batches.cancel(id);
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async deleteBatchData(id: string): Promise<void> {
    try {
      await this.client.messages.batches.delete(id);
    } catch (err) {
      if (notFound(err)) return;
      throw this.wrap(err);
    }
  }

  async batchResults(id: string): Promise<BatchOutcome[]> {
    try {
      const out: BatchOutcome[] = [];
      for await (const r of await this.client.messages.batches.results(id)) {
        const res = r.result;
        if (res.type === 'succeeded')
          out.push({ customId: r.custom_id, result: anthropicResult(res.message) });
        else if (res.type === 'errored') {
          const e = res.error as unknown as { error?: { type?: string; message?: string } };
          const type = e.error?.type ?? 'error';
          out.push({
            customId: r.custom_id,
            error: `${type}: ${e.error?.message ?? ''}`.slice(0, 500),
            retryable: type !== 'invalid_request_error' && type !== 'authentication_error',
          });
        } else out.push({ customId: r.custom_id, error: res.type, retryable: true });
      }
      return out;
    } catch (err) {
      throw this.wrap(err);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// OpenAI

/** Error codes OpenAI uses when it blocks the prompt itself (a content block: final). */
const OPENAI_BLOCK_CODES = new Set([
  'content_filter',
  'content_policy_violation',
  'invalid_prompt',
  'prompt_blocked',
]);

interface ChatCompletionLike {
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

function openaiResult(c: ChatCompletionLike): CallResult {
  const u = c.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const usage: Usage = {
    input: Math.max(0, (u.prompt_tokens ?? 0) - cached),
    output: u.completion_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
  };
  const ch = c.choices?.[0];
  const text = (ch?.message?.content ?? '').trim();
  if (ch?.message?.refusal)
    return {
      kind: 'blocked',
      detail: `refusal: ${ch.message.refusal}`.slice(0, 300),
      text: null,
      usage,
    };
  if (ch?.finish_reason === 'content_filter')
    return { kind: 'blocked', detail: 'content_filter', text: text || null, usage };
  if (ch?.finish_reason === 'length')
    return { kind: 'invalid', detail: 'length limit reached', text: text || null, usage };
  const json = firstJson(text);
  if (json === undefined)
    return { kind: 'invalid', detail: 'no JSON object', text: text || null, usage };
  return { kind: 'answered', text, json, usage };
}

function openaiBody(input: CallInput) {
  return {
    model: input.model,
    messages: [
      { role: 'system' as const, content: input.system },
      { role: 'user' as const, content: input.user },
    ],
    response_format: input.schema
      ? {
          type: 'json_schema' as const,
          json_schema: { name: input.schema.name, schema: input.schema.schema, strict: true },
        }
      : { type: 'json_object' as const },
    ...(input.effort ? { reasoning_effort: input.effort } : {}),
    ...(input.outputLimit ? { max_completion_tokens: input.outputLimit } : {}),
  };
}

/** A streamed chat completion put back together (content, refusal, finish reason, usage). */
async function collectStream(
  chunks: AsyncIterable<{
    choices?: {
      finish_reason?: string | null;
      delta?: { content?: string | null; refusal?: string | null };
    }[];
    usage?: ChatCompletionLike['usage'];
  }>,
): Promise<ChatCompletionLike> {
  let content = '';
  let refusal = '';
  let finish: string | null = null;
  let usage: ChatCompletionLike['usage'] = null;
  for await (const c of chunks) {
    const ch = c.choices?.[0];
    if (ch?.delta?.content) content += ch.delta.content;
    if (ch?.delta?.refusal) refusal += ch.delta.refusal;
    if (ch?.finish_reason) finish = ch.finish_reason;
    if (c.usage) usage = c.usage;
  }
  return {
    choices: [{ finish_reason: finish, message: { content, refusal: refusal || null } }],
    usage,
  };
}

export class OpenAiProvider implements ProviderClient {
  readonly provider = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string, baseURL = process.env.CLEANUP_AI_OPENAI_URL || undefined) {
    this.client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
  }

  /** A blocked prompt (400 with a content code) is a result, not an error. */
  private blocked(err: unknown): CallResult | null {
    if (err instanceof OpenAI.APIError) {
      const e = err as InstanceType<typeof OpenAI.APIError>;
      if (e.status === 400) {
        const code = String((e as { code?: unknown }).code ?? '');
        if (OPENAI_BLOCK_CODES.has(code))
          return {
            kind: 'blocked',
            detail: `${code}: ${e.message}`.slice(0, 300),
            text: null,
            usage: ZERO,
          };
      }
    }
    return null;
  }

  private wrap(err: unknown): Error {
    if (err instanceof OpenAI.APIConnectionError)
      return new RetryableError(connectionMessage(err as Error));
    if (err instanceof OpenAI.APIError) {
      const e = err as InstanceType<typeof OpenAI.APIError>;
      const h = e.headers as Headers | undefined;
      return statusError(
        e.status,
        `${e.status ?? ''} ${e.message}`.trim(),
        h?.get?.('retry-after'),
      );
    }
    return err instanceof Error ? new RetryableError(err.message) : new RetryableError(String(err));
  }

  async listModels(): Promise<string[]> {
    try {
      const out: string[] = [];
      for await (const m of this.client.models.list()) out.push(m.id);
      return out;
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async call(input: CallInput, timeoutMs: number): Promise<CallResult> {
    try {
      if (input.stream) {
        const body = {
          ...openaiBody(input),
          stream: true as const,
          stream_options: { include_usage: true },
        };
        const chunks = await this.client.chat.completions.create(
          body as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
          { timeout: timeoutMs },
        );
        return openaiResult(await collectStream(chunks as never));
      }
      const c = await this.client.chat.completions.create(
        openaiBody(input) as OpenAI.ChatCompletionCreateParamsNonStreaming,
        { timeout: timeoutMs },
      );
      return openaiResult(c as unknown as ChatCompletionLike);
    } catch (err) {
      const b = this.blocked(err);
      if (b) return b;
      throw this.wrap(err);
    }
  }

  async submitBatch(items: BatchItem[]): Promise<{ id: string; inputFileId: string | null }> {
    try {
      const lines = items
        .map((i) =>
          JSON.stringify({
            custom_id: i.customId,
            method: 'POST',
            url: '/v1/chat/completions',
            body: openaiBody(i.call),
          }),
        )
        .join('\n');
      const file = await this.client.files.create({
        file: await toFile(Buffer.from(lines + '\n', 'utf8'), 'batch.jsonl'),
        purpose: 'batch',
      });
      const b = await this.client.batches.create({
        input_file_id: file.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
      });
      return { id: b.id, inputFileId: file.id };
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async batchStatus(id: string): Promise<BatchStatus> {
    try {
      const b = await this.client.batches.retrieve(id);
      const ended = ['completed', 'failed', 'expired', 'cancelled'].includes(b.status);
      // An expired or cancelled batch still has the answers it finished (its output file);
      // only a failed one (its input refused) has none.
      const c = b.request_counts;
      return {
        ended,
        status: b.status,
        failed: b.status === 'failed',
        done: c ? c.completed + c.failed : 0,
      };
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async cancelBatch(id: string): Promise<void> {
    try {
      await this.client.batches.cancel(id);
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async deleteBatchData(id: string): Promise<void> {
    let files: (string | null | undefined)[];
    try {
      const b = await this.client.batches.retrieve(id);
      files = [b.input_file_id, b.output_file_id, b.error_file_id];
    } catch (err) {
      if (notFound(err)) return;
      throw this.wrap(err);
    }
    for (const f of files) {
      if (!f) continue;
      try {
        await this.client.files.delete(f);
      } catch (err) {
        if (!notFound(err)) throw this.wrap(err);
      }
    }
  }

  async batchResults(id: string): Promise<BatchOutcome[]> {
    try {
      const b = await this.client.batches.retrieve(id);
      const out: BatchOutcome[] = [];
      const read = async (fileId: string | null | undefined) => {
        if (!fileId) return [] as Record<string, unknown>[];
        const res = await this.client.files.content(fileId);
        const text = await res.text();
        return text
          .split('\n')
          .filter((l: string) => l.trim())
          .map((l: string) => JSON.parse(l) as Record<string, unknown>);
      };
      const seen = new Set<string>();
      for (const line of [...(await read(b.output_file_id)), ...(await read(b.error_file_id))]) {
        const customId = String(line.custom_id ?? '');
        if (!customId || seen.has(customId)) continue;
        seen.add(customId);
        const response = line.response as { status_code?: number; body?: unknown } | null;
        const error = line.error as { code?: string; message?: string } | null;
        if (response && response.status_code === 200) {
          out.push({ customId, result: openaiResult(response.body as ChatCompletionLike) });
          continue;
        }
        const body = (response?.body ?? {}) as { error?: { code?: string; message?: string } };
        const code = body.error?.code ?? error?.code ?? '';
        const message =
          body.error?.message ?? error?.message ?? `HTTP ${response?.status_code ?? '?'}`;
        if (OPENAI_BLOCK_CODES.has(code)) {
          out.push({
            customId,
            result: {
              kind: 'blocked',
              detail: `${code}: ${message}`.slice(0, 300),
              text: null,
              usage: ZERO,
            },
          });
          continue;
        }
        const status = response?.status_code;
        out.push({
          customId,
          error: `${status ?? ''} ${code} ${message}`.trim().slice(0, 500),
          retryable:
            status === undefined || status === 429 || status >= 500 || code === 'batch_expired',
        });
      }
      return out;
    } catch (err) {
      throw this.wrap(err);
    }
  }
}

/** The client of a provider with its key (tests pass their own). */
export function makeProvider(provider: Provider, apiKey: string): ProviderClient {
  return provider === 'anthropic' ? new AnthropicProvider(apiKey) : new OpenAiProvider(apiKey);
}
