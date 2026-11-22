/**
 * Book summaries session 2: the shared AI layer's per-stage request options. Without them the
 * requests are exactly what they were (the cleanup's); with them Claude gets its effort and a
 * streamed call, GPT its reasoning effort, max_completion_tokens and a streamed call (with
 * usage), through the official SDKs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider, OpenAiProvider, type CallInput } from '../src/ai/providers';
import { startAiStandin } from './helpers/ai-standin';

let standin: Awaited<ReturnType<typeof startAiStandin>> | null = null;
afterEach(async () => {
  await standin?.close();
  standin = null;
});

const SCHEMA = {
  name: 't',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: { title: { type: 'string' } },
  },
};
const BASE: CallInput = {
  model: '',
  system: 'S',
  user: 'ITEM x',
  schema: SCHEMA,
  maxTokens: 16000,
};

describe('request options', () => {
  it('without options: the same request bodies as before', async () => {
    standin = await startAiStandin({ answer: () => ({ kind: 'json', json: { title: 'x' } }) });
    const a = new AnthropicProvider('k', standin.anthropicUrl);
    const o = new OpenAiProvider('k', standin.openaiUrl);
    expect((await a.call({ ...BASE, model: 'claude-haiku-5-5' }, 5000)).kind).toBe('answered');
    expect((await o.call({ ...BASE, model: 'gpt-6-luna' }, 5000)).kind).toBe('answered');
    const [ab, ob] = standin.calls
      .filter((c: { body?: unknown }) => c.body)
      .map((c: { body: unknown }) => c.body);
    expect(ab).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 16000,
      system: 'S',
      messages: [{ role: 'user', content: 'ITEM x' }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA.schema } },
    });
    expect(ob).toEqual({
      model: 'gpt-6-luna',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'ITEM x' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 't', schema: SCHEMA.schema, strict: true },
      },
    });
  });

  it('with options: effort, output limit and streamed answers (usage kept)', async () => {
    standin = await startAiStandin({
      answer: () => ({ kind: 'json', json: { title: 'ナギ' } }),
      usage: { input: 1234, output: 567 },
    });
    const a = new AnthropicProvider('k', standin.anthropicUrl);
    const o = new OpenAiProvider('k', standin.openaiUrl);
    const opts = { effort: 'high' as const, stream: true, outputLimit: 64000, maxTokens: 64000 };
    const ra = await a.call({ ...BASE, ...opts, model: 'claude-sonnet-5-5' }, 5000);
    const ro = await o.call({ ...BASE, ...opts, model: 'gpt-6.1-sol' }, 5000);
    expect(ra).toMatchObject({
      kind: 'answered',
      json: { title: 'ナギ' },
      usage: { input: 1234, output: 567 },
    });
    expect(ro).toMatchObject({
      kind: 'answered',
      json: { title: 'ナギ' },
      usage: { input: 1234, output: 567 },
    });
    const [ab, ob] = standin.calls
      .filter((c: { body?: unknown }) => c.body)
      .map((c: { body: Record<string, unknown> }) => c.body);
    expect(ab).toMatchObject({
      stream: true,
      max_tokens: 64000,
      output_config: { effort: 'high', format: { type: 'json_schema' } },
    });
    expect(ob).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
      max_completion_tokens: 64000,
    });
  });

  it('a streamed refusal is still a refusal (final)', async () => {
    standin = await startAiStandin({ answer: () => ({ kind: 'refusal' }) });
    const a = new AnthropicProvider('k', standin.anthropicUrl);
    const o = new OpenAiProvider('k', standin.openaiUrl);
    expect((await a.call({ ...BASE, stream: true, model: 'claude-sonnet-5-5' }, 5000)).kind).toBe(
      'blocked',
    );
    expect((await o.call({ ...BASE, stream: true, model: 'gpt-6.1-sol' }, 5000)).kind).toBe(
      'blocked',
    );
  });
});
