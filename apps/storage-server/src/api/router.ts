import express, { Router } from 'express';
import type { DatabaseState } from '../db/database';
import { getSchemaVersion } from '../db/migrations';
import { PairingRateLimiter, redeemPairingCode } from '../db/pairing';
import { getAuth, requireUser } from './auth';
import {
  CatalogOptions,
  createCatalogRouter,
  thumbnailAuth,
  thumbnailHandler,
} from './catalog-routes';
import { ApiError, errorHandler, notFound, sendError } from './errors';

export interface PairingOptions {
  /** Failed pairing attempts allowed per minute (all clients together). */
  maxFailuresPerMinute: number;
}

export const DEFAULT_PAIRING: PairingOptions = { maxFailuresPerMinute: 10 };

export interface ApiOptions {
  database: DatabaseState;
  version: string;
  /** Catalog routes (WP2). Without it they report the indexer as off. */
  catalog?: CatalogOptions;
  pairing?: PairingOptions;
}

const NO_CATALOG: CatalogOptions = {
  thumbnails: null,
  indexer: { enabled: false, error: 'the Calibre indexer is not configured' },
};

/**
 * /api/v1: the new API. Later work packages add their routes here, behind
 * requireUser. Failures in here never affect the legacy endpoints.
 */
export function createApiRouter({
  database,
  version,
  catalog = NO_CATALOG,
  pairing = DEFAULT_PAIRING,
}: ApiOptions): Router {
  const router = express.Router();
  router.use(express.json());

  // Unauthenticated, for the Docker healthcheck. Reports only status.
  router.get('/health', (_req, res) => {
    if (!database.ok) {
      res.status(503).json({ ok: false, version, database: 'unavailable' });
      return;
    }
    res.json({ ok: true, version, schemaVersion: getSchemaVersion(database.db) });
  });

  if (database.ok) {
    const db = database.db;

    // Unauthenticated: a device trades a one-time pairing code (made with the
    // CLI) for its own token. Failed attempts are rate-limited.
    const limiter = new PairingRateLimiter(pairing.maxFailuresPerMinute);
    router.post('/pair', (req, res) => {
      if (!limiter.allow()) {
        throw new ApiError(429, 'too_many_attempts', 'Too many wrong codes; wait a minute');
      }
      const code = (req.body as { code?: unknown } | undefined)?.code;
      const result = typeof code === 'string' ? redeemPairingCode(db, code) : null;
      if (!result) {
        limiter.recordFailure();
        throw new ApiError(401, 'invalid_code', 'Unknown, used or expired pairing code');
      }
      res.json({ token: result.token, label: result.record.label });
    });

    // Signed URL or token (a plain <img> can't send the token).
    router.get('/books/:id/thumbnail', thumbnailAuth(db), thumbnailHandler(db, catalog));

    router.use(requireUser(db));

    router.get('/me', (_req, res) => {
      const { user, token } = getAuth(res);
      res.json({ user, token });
    });

    router.use(createCatalogRouter(db, catalog));

    router.use(notFound);
  } else {
    const reason = database.error;
    router.use((_req, res) => {
      sendError(res, 503, 'database_unavailable', `Database unavailable: ${reason}`);
    });
  }

  router.use(errorHandler);
  return router;
}
