/**
 * Book summaries session 2: the input tokens of each test book's whole-book extraction, counted
 * by Anthropic's token counter (free; no answer is made), for the cost estimate before a round.
 *
 *   npx ts-node --transpile-only scripts/summaries-test-estimate.ts <test DB_DIR> <epub>...
 */
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import path from 'path';
import { AiSecretStore } from '../src/ai/secrets';
import { readBookScript } from '../src/audio/book-script';
import { bookTextFromScript } from '../src/summaries/book-text';
import { extractEvidence } from '../src/summaries/pipeline';
import { EXTRACT_SPEC, MODELS } from '../src/summaries/specs';

async function main() {
  const [dbDir, ...files] = process.argv.slice(2);
  const db = new Database(path.join(dbDir, 'ttsu.db'), { readonly: true });
  const key = new AiSecretStore(db, dbDir).read('anthropicApiKey');
  if (!key) throw new Error('no Anthropic key in the test copy');
  const client = new Anthropic({ apiKey: key });
  for (const f of files) {
    const script = await readBookScript(f, {
      importOptions: { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true },
      maxSentence: 120,
      timeoutMs: 180_000,
    });
    const book = bookTextFromScript(script);
    const user = EXTRACT_SPEC.userText(extractEvidence(path.basename(f), book, null));
    const out: Record<string, number> = {};
    for (const m of [MODELS.sonnet, MODELS.opus]) {
      const r = await client.messages.countTokens({
        model: m,
        system: EXTRACT_SPEC.system,
        messages: [{ role: 'user', content: user }],
      });
      out[m] = r.input_tokens;
    }
    console.log(
      JSON.stringify({
        file: path.basename(f),
        chars: user.length,
        counted: script.characters,
        chapters: book.chapters.length,
        tokens: out,
      }),
    );
  }
}
void main();
