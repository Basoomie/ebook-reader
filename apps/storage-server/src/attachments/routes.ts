/**
 * /api/v1 book attachments (WP15c): whispersync's saved subtitles and saved match, too
 * large for a sync record. The file lives in DATA_DIR/.uploads/attachments; the
 * `book_attachments` row (migration 12) says what is stored; the sync record
 * `book-attachment` (<bookId>:<name>, { size, sha256, modifiedAt }) tells the other
 * devices, which download it in the background.
 *
 * Newest wins by the device's own modification time (`modifiedAt`, the time the user
 * saved the match or the subtitles): an upload older than what the server holds is
 * refused (409 stale), so a device coming back online can't overwrite newer data with
 * an old copy. A reset (deletion marker) is a plain sync write by the device.
 */
import type Database from 'better-sqlite3';
import express, { Router } from 'express';
import { pipeline } from 'stream/promises';
import { getAuth } from '../api/auth';
import { ApiError, asyncHandler } from '../api/errors';
import { getBookFor } from '../catalog/queries';
import { BOOK_ATTACHMENT_KIND, attachmentRecordId } from '../sync/kinds';
import type { SyncStore } from '../sync/store';
import {
  AttachmentStore,
  AttachmentTooLargeError,
  isAttachmentName,
  type AttachmentName,
} from './attachment-store';

export interface AttachmentOptions {
  dataRoot: string;
  maxMb: number;
}

export interface AttachmentRow {
  size: number;
  sha256: string;
  modifiedAt: number;
  filePath: string;
}

export function getAttachmentRow(
  db: Database.Database,
  userId: string,
  bookId: string,
  name: string,
): AttachmentRow | null {
  const row = db
    .prepare(
      `SELECT size, sha256, modified_at, file_path FROM book_attachments
       WHERE user_id = ? AND book_id = ? AND name = ?`,
    )
    .get(userId, bookId, name) as
    | { size: number; sha256: string; modified_at: number; file_path: string }
    | undefined;
  return row
    ? { size: row.size, sha256: row.sha256, modifiedAt: row.modified_at, filePath: row.file_path }
    : null;
}

const CONTENT_TYPE = 'application/json; charset=utf-8';

function drain(req: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    req.on('end', resolve);
    req.on('error', resolve);
    req.resume();
  });
}

export function createAttachmentRouter(
  db: Database.Database,
  sync: SyncStore,
  options: AttachmentOptions,
  { now = () => Date.now() }: { now?: () => number } = {},
): Router {
  const router = express.Router();
  const store = new AttachmentStore(options.dataRoot);
  store.init();
  const maxBytes = Math.round(options.maxMb * 1024 * 1024);
  // One upload at a time per attachment, so "is it newer" and "store it" belong together.
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  };

  const target = (req: express.Request, res: express.Response) => {
    const { user } = getAuth(res);
    const name = req.params.name;
    if (!isAttachmentName(name)) throw new ApiError(404, 'not_found', 'No such attachment');
    if (!getBookFor(db, user, req.params.id)) throw new ApiError(404, 'not_found', 'No such book');
    return { userId: user.id, bookId: req.params.id, name: name as AttachmentName };
  };

  router.put(
    '/books/:id/attachments/:name',
    asyncHandler(async (req, res) => {
      const auth = getAuth(res);
      let t: ReturnType<typeof target>;
      let modifiedAt: number;
      try {
        t = target(req, res);
        if (!auth.token.deviceId) {
          throw new ApiError(409, 'device_not_registered', 'Register this device first');
        }
        modifiedAt = Number(req.query.modifiedAt);
        if (!Number.isFinite(modifiedAt) || modifiedAt <= 0) {
          throw new ApiError(400, 'invalid_query', 'modifiedAt (milliseconds) is required');
        }
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new ApiError(413, 'too_large', `The file is larger than ${options.maxMb} MB`);
        }
      } catch (err) {
        await drain(req);
        throw err;
      }
      const deviceId = auth.token.deviceId as string;
      const recordId = attachmentRecordId(t.bookId, t.name);

      const result = await serial(recordId, async () => {
        const current = sync.getRecord(t.userId, BOOK_ATTACHMENT_KIND, recordId);
        const currentModified =
          current && current.deletedAt === null ? Number(current.data.modifiedAt) || 0 : 0;
        if (current && current.deletedAt === null && currentModified > modifiedAt) {
          await drain(req);
          return { stale: true as const, record: current };
        }
        let received;
        try {
          received = await store.receive(req, maxBytes);
        } catch (err) {
          if (err instanceof AttachmentTooLargeError) {
            throw new ApiError(413, 'too_large', `The file is larger than ${options.maxMb} MB`);
          }
          throw err;
        }
        const relative = AttachmentStore.attachmentPath(t.userId, t.bookId, t.name);
        await store.commit(received, relative);
        const at = now();
        const data = { size: received.size, sha256: received.sha256, modifiedAt };
        db.transaction(() => {
          db.prepare(
            `INSERT INTO book_attachments (user_id, book_id, name, size, sha256, modified_at, file_path, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, book_id, name) DO UPDATE SET size = excluded.size,
               sha256 = excluded.sha256, modified_at = excluded.modified_at,
               file_path = excluded.file_path, updated_at = excluded.updated_at`,
          ).run(t.userId, t.bookId, t.name, data.size, data.sha256, modifiedAt, relative, at);
          const written = sync.writeAs(
            t.userId,
            deviceId,
            { kind: BOOK_ATTACHMENT_KIND, id: recordId, updatedAt: at, data },
            at,
          );
          if (written.status !== 'applied') {
            throw new Error(`writing the attachment record: ${written.status}`);
          }
        })();
        return { stale: false as const, data };
      });

      if (result.stale) {
        throw new ApiError(409, 'stale', 'The server has newer data for this book', {
          record: result.record,
        });
      }
      res.status(200).json({ attachment: result.data });
    }),
  );

  router.get(
    '/books/:id/attachments/:name',
    asyncHandler(async (req, res) => {
      const t = target(req, res);
      const row = getAttachmentRow(db, t.userId, t.bookId, t.name);
      const record = sync.getRecord(
        t.userId,
        BOOK_ATTACHMENT_KIND,
        attachmentRecordId(t.bookId, t.name),
      );
      if (!row || !record || record.deletedAt !== null) {
        throw new ApiError(404, 'not_found', 'No such attachment');
      }
      const stat = await store.stat(row.filePath);
      if (!stat) throw new ApiError(404, 'file_missing', 'The file was not found on the server');
      const stream = await store.openStream(row.filePath);
      res.set('Content-Type', CONTENT_TYPE);
      res.set('Content-Length', String(stat.size));
      res.set('ETag', `"${row.sha256}"`);
      res.set('X-Modified-At', String(row.modifiedAt));
      res.set('Cache-Control', 'no-store');
      try {
        await pipeline(stream, res);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
        throw err;
      }
    }),
  );

  /** Marks the attachment removed on every device (the file stays until replaced). */
  router.delete('/books/:id/attachments/:name', (req, res) => {
    const auth = getAuth(res);
    const t = target(req, res);
    if (!auth.token.deviceId) {
      throw new ApiError(409, 'device_not_registered', 'Register this device first');
    }
    const at = now();
    const id = attachmentRecordId(t.bookId, t.name);
    const current = sync.getRecord(t.userId, BOOK_ATTACHMENT_KIND, id);
    if (current && current.deletedAt === null) {
      sync.writeAs(
        t.userId,
        auth.token.deviceId,
        { kind: BOOK_ATTACHMENT_KIND, id, updatedAt: at, deletedAt: at, data: {} },
        at,
      );
    }
    res.status(204).end();
  });

  return router;
}
