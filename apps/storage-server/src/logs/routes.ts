/**
 * GET /api/v1/logs/recent (WP18), behind requireUser: the server's recent log lines for
 * the bug report, secrets removed. Nothing is sent anywhere by the server; the web app
 * puts the lines into the file the user downloads.
 */
import express, { Router } from 'express';
import { SERVER_VERSION } from '../version';
import type { RecentLogs } from './recent-logs';

export function createLogsRouter(logs: RecentLogs): Router {
  const router = express.Router();
  router.get('/logs/recent', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ serverVersion: SERVER_VERSION, ...logs.snapshot() });
  });
  return router;
}
