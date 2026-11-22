/**
 * WP21d: why OpenAI's batch doesn't progress. Shows the first line of the stored batch's input
 * file (what we sent), then sends two one-question batches for one labeled book, built exactly
 * as the runner builds them: one with the structured-output schema, one with plain JSON mode.
 * Polls both every 20 s for up to --minutes (default 15) and prints each change.
 *
 *   npx ts-node --transpile-only scripts/wp21d-batch-probe.ts --db <work/cleanup.db> --main <ttsu.db>
 */
import Database from 'better-sqlite3';
import OpenAI, { toFile } from 'openai';
import { SecretStore } from '../src/cleanup/secrets';
import { META_SPEC } from '../src/cleanup/audio/meta-prompt';
import { AiRunner } from '../src/ai/runner';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const db = new Database(arg('db')!, { readonly: true, fileMustExist: true });
const main = new Database(arg('main')!, { readonly: true, fileMustExist: true });
const secrets = new SecretStore(db, main);
const client = new OpenAI({ apiKey: secrets.read('openaiApiKey')!, maxRetries: 0 });
const t = () => new Date().toLocaleTimeString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // 1. What we sent: the stored batch's input file.
  const stored = db
    .prepare(`SELECT id, input_file_id FROM ai_batches WHERE provider = 'openai'`)
    .get() as { id: string; input_file_id: string } | undefined;
  if (stored?.input_file_id) {
    const f = await client.files.retrieve(stored.input_file_id);
    console.log(
      `input file ${f.id}: ${f.bytes} bytes, purpose ${f.purpose}, status ${(f as unknown as { status?: string }).status}`,
    );
    const text = await (await client.files.content(stored.input_file_id)).text();
    const lines = text.split('\n').filter((l) => l.trim());
    const first = JSON.parse(lines[0]) as {
      custom_id: string;
      method: string;
      url: string;
      body: Record<string, unknown>;
    };
    console.log(
      `lines ${lines.length}; first: custom_id ${first.custom_id}, ${first.method} ${first.url}, body keys ${Object.keys(first.body).join(',')}, model ${first.body.model}, response_format ${JSON.stringify(first.body.response_format).slice(0, 120)}`,
    );
    const b = await client.batches.retrieve(stored.id);
    console.log(
      `stored batch ${b.id}: ${b.status} ${JSON.stringify(b.request_counts)} endpoint ${b.endpoint} window ${b.completion_window}`,
    );
  }

  // 2. Two one-question batches for one labeled book.
  const runner = new AiRunner({ db, secrets: { read: () => null } });
  const key = (
    db
      .prepare(`SELECT item_key FROM ai_items WHERE stage = 'audio5' AND labeled = 1 LIMIT 1`)
      .get() as { item_key: string }
  ).item_key;
  const ev = runner.evidenceOf(META_SPEC, key)!.evidence;
  const messages = [
    { role: 'system', content: META_SPEC.system },
    { role: 'user', content: META_SPEC.userText(ev) },
  ];
  const variants: Record<string, unknown> = {
    schema: {
      type: 'json_schema',
      json_schema: { name: META_SPEC.schemaName, schema: META_SPEC.schema, strict: true },
    },
    json: { type: 'json_object' },
  };
  const ids: Record<string, string> = {};
  for (const [name, response_format] of Object.entries(variants)) {
    const line = JSON.stringify({
      custom_id: `probe-${name}`,
      method: 'POST',
      url: '/v1/chat/completions',
      body: { model: 'gpt-6-luna', messages, response_format },
    });
    const file = await client.files.create({
      file: await toFile(Buffer.from(line + '\n'), `probe-${name}.jsonl`),
      purpose: 'batch',
    });
    const b = await client.batches.create({
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    });
    ids[name] = b.id;
    console.log(`${t()} sent probe "${name}": batch ${b.id} (${b.status})`);
  }
  const minutes = Number(arg('minutes') ?? 15);
  const last: Record<string, string> = {};
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    let open = 0;
    for (const [name, id] of Object.entries(ids)) {
      const b = await client.batches.retrieve(id);
      const s = `${b.status} ${JSON.stringify(b.request_counts)}`;
      if (s !== last[name])
        console.log(
          `${t()} probe "${name}": ${s}${b.errors ? ' errors ' + JSON.stringify(b.errors).slice(0, 300) : ''}`,
        );
      last[name] = s;
      if (!['completed', 'failed', 'expired', 'cancelled'].includes(b.status)) open++;
      else if (b.status === 'completed' && b.output_file_id && !last[name + ':out']) {
        const out = await (await client.files.content(b.output_file_id)).text();
        const r = JSON.parse(out.split('\n')[0]) as {
          response?: { status_code?: number; body?: { usage?: unknown } };
        };
        last[name + ':out'] = '1';
        console.log(
          `${t()} probe "${name}" output: HTTP ${r.response?.status_code}, usage ${JSON.stringify(r.response?.body?.usage)}`,
        );
      }
    }
    if (!open) break;
    await sleep(20_000);
  }
  console.log(`${t()} probes: ${JSON.stringify(ids)} (not cancelled; each is one question)`);
}
run().then(
  () => process.exit(0),
  (e) => {
    console.error(String(e).slice(0, 800));
    process.exit(1);
  },
);
