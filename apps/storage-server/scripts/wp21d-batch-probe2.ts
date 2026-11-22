/**
 * WP21d: narrowing down OpenAI's batches that never start. (1) Every batch this organization has
 * (status, model, endpoint, counts, times): has any ever completed, and how long did it take?
 * (2) Two one-question batches on one labeled book: gpt-6-luna through /v1/responses, and
 * gpt-6.1-sol through /v1/chat/completions (our endpoint). Polls every 20 s for --minutes.
 *
 *   npx ts-node --transpile-only scripts/wp21d-batch-probe2.ts --db <work/cleanup.db> --main <ttsu.db>
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
const when = (s: number | null | undefined) => (s ? new Date(s * 1000).toLocaleString() : '-');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // 1. The organization's batches.
  let n = 0;
  for await (const b of client.batches.list({ limit: 100 })) {
    n++;
    const x = b as unknown as { model?: string };
    const took =
      b.completed_at && b.in_progress_at
        ? `${Math.round((b.completed_at - b.in_progress_at) / 60)} min`
        : '-';
    console.log(
      `batch ${b.id} ${b.status} model ${x.model ?? '?'} ${b.endpoint} counts ${JSON.stringify(b.request_counts)} created ${when(b.created_at)} started ${when(b.in_progress_at)} completed ${when(b.completed_at)} (${took})`,
    );
    if (n >= 100) break;
  }
  console.log(`${n} batches in the organization's list`);

  // 2. Two more one-question batches.
  const runner = new AiRunner({ db, secrets: { read: () => null } });
  const key = (
    db
      .prepare(`SELECT item_key FROM ai_items WHERE stage = 'audio5' AND labeled = 1 LIMIT 1`)
      .get() as { item_key: string }
  ).item_key;
  const ev = runner.evidenceOf(META_SPEC, key)!.evidence;
  const system = META_SPEC.system;
  const user = META_SPEC.userText(ev);
  const probes: { name: string; url: string; body: Record<string, unknown> }[] = [
    {
      name: 'luna-responses',
      url: '/v1/responses',
      body: {
        model: 'gpt-6-luna',
        instructions: system,
        input: user,
        text: { format: { type: 'json_object' } },
      },
    },
    {
      name: 'sol-chat',
      url: '/v1/chat/completions',
      body: {
        model: 'gpt-6.1-sol',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
      },
    },
  ];
  const ids: Record<string, string> = {};
  for (const p of probes) {
    const line = JSON.stringify({
      custom_id: `probe-${p.name}`,
      method: 'POST',
      url: p.url,
      body: p.body,
    });
    const file = await client.files.create({
      file: await toFile(Buffer.from(line + '\n'), `probe-${p.name}.jsonl`),
      purpose: 'batch',
    });
    const b = await client.batches.create({
      input_file_id: file.id,
      endpoint: p.url as '/v1/responses',
      completion_window: '24h',
    });
    ids[p.name] = b.id;
    console.log(`${t()} sent probe "${p.name}": batch ${b.id} (${b.status})`);
  }
  const last: Record<string, string> = {};
  const end = Date.now() + Number(arg('minutes') ?? 15) * 60_000;
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
    }
    if (!open) break;
    await sleep(20_000);
  }
  console.log(`${t()} probes2: ${JSON.stringify(ids)}`);
}
run().then(
  () => process.exit(0),
  (e) => {
    console.error(String(e).slice(0, 800));
    process.exit(1);
  },
);
