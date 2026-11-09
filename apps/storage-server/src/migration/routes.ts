import express, { Router } from 'express';
import { getAuth } from '../api/auth';
import { ApiError, asyncHandler } from '../api/errors';
import { MigrationError, MigrationService } from './service';

function toApi(err: unknown): never {
  if (err instanceof MigrationError) throw new ApiError(err.status, err.code, err.message);
  throw err;
}

/**
 * WP5 routes, mounted after requireUser under /api/v1:
 *   GET  /migration          overview: scan state, book folders, devices, switches
 *   POST /migration/scan     start a scan in the background (poll GET /migration)
 *   POST /migration/report   this device's Calibre links and local titles
 *   POST /migration/resolve  { folder, action: link | defer | unlink, bookId? }
 *   POST /migration/import   copy old positions and statistics of linked books
 *   GET  /migration/check    old files vs new records, per book
 */
export function createMigrationRouter(service: MigrationService): Router {
  const router = express.Router();

  router.get('/migration', (_req, res) => {
    res.json(service.overview(getAuth(res).user.id));
  });

  router.post('/migration/scan', (_req, res) => {
    try {
      service.startScan(getAuth(res).user.id);
    } catch (err) {
      toApi(err);
    }
    res.status(202).json({ scan: service.scanStatus() });
  });

  router.post('/migration/report', (req, res) => {
    const { user, token } = getAuth(res);
    if (!token.deviceId) {
      throw new ApiError(409, 'device_not_registered', 'Register this device first');
    }
    service.report(user.id, token.deviceId, req.body);
    res.json({ ok: true });
  });

  router.post('/migration/resolve', (req, res) => {
    const { user } = getAuth(res);
    const body = (req.body ?? {}) as { folder?: unknown; action?: unknown; bookId?: unknown };
    if (typeof body.folder !== 'string' || !body.folder) {
      throw new ApiError(400, 'invalid_body', 'folder is required');
    }
    try {
      if (body.action === 'link') {
        if (typeof body.bookId !== 'string') {
          throw new ApiError(400, 'invalid_body', 'bookId is required to link');
        }
        service.link(user.id, body.folder, body.bookId);
      } else if (body.action === 'defer') {
        service.defer(user.id, body.folder);
      } else if (body.action === 'unlink') {
        service.unlink(user.id, body.folder);
      } else {
        throw new ApiError(400, 'invalid_body', 'action must be link, defer or unlink');
      }
    } catch (err) {
      toApi(err);
    }
    res.json({ ok: true });
  });

  router.post(
    '/migration/import',
    asyncHandler(async (_req, res) => {
      try {
        res.json(await service.import(getAuth(res).user.id));
      } catch (err) {
        toApi(err);
      }
    }),
  );

  router.get(
    '/migration/check',
    asyncHandler(async (_req, res) => {
      res.json(await service.check(getAuth(res).user.id));
    }),
  );

  return router;
}
