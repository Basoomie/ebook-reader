/**
 * Counter process (WP3b). Forked by CountWorker with the bundle path as its argument.
 * Loads the counter bundle (the reader's import and counting code plus jsdom) and
 * counts one EPUB per request. It is a separate, lower-priority process so jsdom's
 * globals, its CPU time and any crash or memory blow-up stay away from the server.
 *
 * Calibre files are opened only through calibre/source-fs (read-only).
 */
import { openSourceBlob, SourceBlob } from '../calibre/source-fs';
import type { ChildMessage, ChildRequest } from './count-worker';

interface CounterModule {
  EPUB_COUNT_VERSION: number;
  countEpubForServer(
    epub: unknown,
    options: ChildRequest['options'],
  ): Promise<{ characters: number }>;
}

const MAX_MESSAGE = 500;

function send(message: ChildMessage): void {
  process.send?.(message);
}

function describe(err: unknown): string {
  const text = err instanceof Error ? err.message || String(err) : String(err);
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}...` : text;
}

// The server is gone (or closed the channel): nothing left to do.
process.on('disconnect', () => process.exit(0));

let counter: CounterModule;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  counter = require(process.argv[2]) as CounterModule;
} catch (err) {
  send({ type: 'fatal', message: `the counter could not be loaded: ${describe(err)}` });
  process.exit(1);
}

async function handle(req: ChildRequest): Promise<void> {
  const started = Date.now();
  let source: SourceBlob;
  try {
    source = await openSourceBlob(req.file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    send({
      type: 'result',
      id: req.id,
      ok: false,
      code: code === 'ENOENT' || code === 'ENOTDIR' ? 'file_missing' : 'read_error',
      message: describe(err),
    });
    return;
  }
  try {
    const { characters } = await counter.countEpubForServer(source.blob, req.options);
    send({
      type: 'result',
      id: req.id,
      ok: true,
      characters,
      bytesRead: source.bytesRead(),
      durationMs: Date.now() - started,
    });
  } catch (err) {
    send({ type: 'result', id: req.id, ok: false, code: 'bad_epub', message: describe(err) });
  } finally {
    await source.close().catch(() => {});
  }
}

process.on('message', (req: ChildRequest) => {
  void handle(req);
});

send({ type: 'ready', version: counter.EPUB_COUNT_VERSION });
