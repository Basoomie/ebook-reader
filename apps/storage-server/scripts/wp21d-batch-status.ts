/**
 * WP21d stop 1: what each provider says about the batches stored in a working copy (state,
 * timestamps, request counts). Read-only at the providers (no request is sent to a model).
 *
 *   npx ts-node --transpile-only scripts/wp21d-batch-status.ts --db <work/cleanup.db> --main <ttsu.db>
 */
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import OpenAI from 'openai';
import { SecretStore } from '../src/cleanup/secrets';

const arg = (n: string) => process.argv[process.argv.indexOf(`--${n}`) + 1];
const db = new Database(arg('db'), { readonly: true, fileMustExist: true });
const main = new Database(arg('main'), { readonly: true, fileMustExist: true });
const secrets = new SecretStore(db, main);
const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toLocaleTimeString() : null);

async function run() {
  // --cancel id,id: cancels OpenAI batches (the probes), then lists as usual.
  const cancel = process.argv.includes('--cancel') ? arg('cancel').split(',') : [];
  for (const id of cancel) {
    const c = new OpenAI({ apiKey: secrets.read('openaiApiKey')! });
    const b = await c.batches.cancel(id);
    console.log(`cancel ${id}: ${b.status} ${JSON.stringify(b.request_counts)}`);
  }
  const rows = db.prepare('SELECT id, provider, submitted_at FROM ai_batches').all() as {
    id: string;
    provider: string;
    submitted_at: number;
  }[];
  for (const b of rows) {
    if (b.provider === 'openai') {
      const c = new OpenAI({ apiKey: secrets.read('openaiApiKey')! });
      const x = await c.batches.retrieve(b.id);
      console.log(
        JSON.stringify({
          provider: 'openai',
          status: x.status,
          request_counts: x.request_counts,
          created: iso(x.created_at),
          in_progress_at: iso(x.in_progress_at),
          finalizing_at: iso(x.finalizing_at),
          completed_at: iso(x.completed_at),
          expires_at: iso(x.expires_at),
          errors: x.errors,
          model: (x as unknown as { model?: string }).model,
        }),
      );
    } else {
      const c = new Anthropic({ apiKey: secrets.read('anthropicApiKey')! });
      const x = await c.messages.batches.retrieve(b.id);
      console.log(
        JSON.stringify({
          provider: 'anthropic',
          status: x.processing_status,
          request_counts: x.request_counts,
          created: x.created_at,
          ended: x.ended_at,
        }),
      );
    }
  }
}
run().then(
  () => process.exit(0),
  (e) => {
    console.error(String(e).slice(0, 500));
    process.exit(1);
  },
);
