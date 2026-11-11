/**
 * GET /api/v1/export (WP18), behind requireUser: everything synced for the token's user
 * as one pretty-printed JSON file. Any paired device may ask (registered or not).
 * Read-only.
 */
import type Database from 'better-sqlite3';
import express, { Router } from 'express';
import { getAuth } from '../api/auth';
import type { SyncStore } from '../sync/store';
import { buildExport, exportFileName } from './build-export';

export function createExportRouter(db: Database.Database, store: SyncStore): Router {
  const router = express.Router();

  router.get('/export', (_req, res) => {
    const { user } = getAuth(res);
    const now = Date.now();
    const body = JSON.stringify(buildExport(db, store, user, { now }), null, 2);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(now)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  });

  return router;
}
