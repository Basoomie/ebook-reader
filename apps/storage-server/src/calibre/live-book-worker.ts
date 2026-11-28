/**
 * The live lookup's thread (live-book.ts): opens the library's metadata.db read only for each
 * lookup, finds the book, closes it again (never holds Calibre's database open between
 * lookups). Reads only.
 */
import { parentPort } from 'worker_threads';
import { readLiveBook } from './live-book-read';
import type { LookupReply, LookupRequest } from './live-book';
import { openSourceDatabase } from './source-fs';

if (parentPort) {
  const port = parentPort;
  port.on('message', (req: LookupRequest) => {
    let reply: LookupReply;
    try {
      const db = openSourceDatabase(req.file);
      try {
        db.pragma(`busy_timeout = ${Math.max(0, Math.round(req.busyTimeoutMs))}`);
        reply = { id: req.id, ok: true, book: readLiveBook(db, req.key) };
      } finally {
        db.close();
      }
    } catch (err) {
      reply = { id: req.id, ok: false, message: (err as Error)?.message ?? String(err) };
    }
    port.postMessage(reply);
  });
}
