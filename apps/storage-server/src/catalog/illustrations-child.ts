/**
 * Season 2 §6: reads one book's illustrations list (illustrations.ts) in its own
 * short-lived process, like WP17's book script (jsdom's globals and memory stay away from
 * the server). Argument: the counter bundle. Message in: { file, options }. Message out:
 * { ok: true, list } or { ok: false, message }. Exits after. The EPUB is opened read-only
 * (calibre/source-fs).
 */
import { openSourceBlob } from '../calibre/source-fs';

interface IllustrationsModule {
  illustrationsForServer(epub: unknown, options: unknown): Promise<unknown>;
}

interface Request {
  file: string;
  options: unknown;
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
      const bundle = require(process.argv[2]) as IllustrationsModule;
      const source = await openSourceBlob(req.file);
      close = source.close;
      const list = await bundle.illustrationsForServer(source.blob, req.options);
      await reply({ ok: true, list });
    } catch (err) {
      await reply({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      await close?.().catch(() => undefined);
      process.exit(0);
    }
  })();
});
