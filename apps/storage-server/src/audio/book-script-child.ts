/**
 * WP17: reads one book's text for a generated audiobook (book-script.ts) in its own
 * short-lived process, like the character counter (jsdom's globals and memory stay away
 * from the server). Argument: the counter bundle. Message in: { file, options,
 * maxSentence }. Message out: { ok: true, script } or { ok: false, message }. Exits after.
 * The EPUB is opened read-only (calibre/source-fs).
 */
import { openSourceBlob } from '../calibre/source-fs';

interface ScriptModule {
  bookScriptForServer(
    epub: unknown,
    options: unknown,
    scriptOptions: { maxSentence?: number },
  ): Promise<unknown>;
}

interface Request {
  file: string;
  options: unknown;
  maxSentence: number;
}

function reply(message: unknown): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) resolve();
    else process.send(message, () => resolve());
  });
}

process.on('disconnect', () => process.exit(0));

process.once('message', (req: Request) => {
  void (async () => {
    let close: (() => Promise<void>) | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bundle = require(process.argv[2]) as ScriptModule;
      const source = await openSourceBlob(req.file);
      close = source.close;
      const script = await bundle.bookScriptForServer(source.blob, req.options, {
        maxSentence: req.maxSentence,
      });
      await reply({ ok: true, script });
    } catch (err) {
      await reply({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      await close?.().catch(() => undefined);
      process.exit(0);
    }
  })();
});
