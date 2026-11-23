/**
 * Book summaries session 2: why GPT-6.1 Sol's whole-book calls lost their connection (~85 s).
 * One small request that makes the model think a while, streamed through Chat Completions with
 * the time of each event, then the same through the Responses API with reasoning summaries.
 *
 *   npx ts-node --transpile-only scripts/summaries-sol-probe.ts <test DB_DIR> chat|responses
 */
import Database from 'better-sqlite3';
import OpenAI from 'openai';
import path from 'path';
import { AiSecretStore } from '../src/ai/secrets';

const PROMPT =
  'Find all integer solutions (x, y) with 0 <= x, y <= 2000 of x^3 + y^3 = 1729 * k for some k from 1 to 50, ' +
  'and list how many there are for each k. Think it through carefully; answer as JSON {"counts": [...]}.';

async function main() {
  const [dbDir, mode] = process.argv.slice(2);
  const db = new Database(path.join(dbDir, 'ttsu.db'), { readonly: true });
  const key = new AiSecretStore(db, dbDir).read('openaiApiKey');
  if (!key) throw new Error('no OpenAI key');
  const client = new OpenAI({ apiKey: key, maxRetries: 0 });
  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  try {
    if (mode === 'chat') {
      const s = await client.chat.completions.create(
        {
          model: 'gpt-6.1-sol',
          messages: [{ role: 'user', content: PROMPT }],
          stream: true,
          stream_options: { include_usage: true },
          reasoning_effort: 'high',
          max_completion_tokens: 20000,
        } as OpenAI.ChatCompletionCreateParamsStreaming,
        { timeout: 600_000 },
      );
      let n = 0;
      for await (const c of s) {
        if (n++ < 3 || c.usage) console.log(at(), JSON.stringify(c).slice(0, 200));
      }
      console.log(at(), `chunks ${n}`);
    } else {
      const s = await client.responses.create(
        {
          model: 'gpt-6.1-sol',
          input: PROMPT,
          stream: true,
          store: false,
          reasoning: { effort: 'high', summary: 'auto' },
          max_output_tokens: 20000,
        } as never,
        { timeout: 600_000 },
      );
      const kinds = new Map<string, number>();
      let last = 0;
      for await (const e of s as unknown as AsyncIterable<{
        type: string;
        response?: { usage?: unknown };
      }>) {
        kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1);
        const now = Date.now();
        if (now - last > 10_000 || (e.type.startsWith('response.') && !e.type.includes('delta'))) {
          console.log(at(), e.type, e.response?.usage ? JSON.stringify(e.response.usage) : '');
          last = now;
        }
      }
      console.log(at(), JSON.stringify([...kinds]));
    }
  } catch (e) {
    console.log(
      at(),
      'ERROR',
      (e as Error).message,
      JSON.stringify((e as { cause?: unknown }).cause ?? null)?.slice(0, 300),
    );
  }
}
void main();
