import express, { Router } from 'express';
import type { DatabaseState } from '../db/database';
import { getSchemaVersion } from '../db/migrations';
import { getAuth, requireUser } from './auth';
import { CatalogOptions, createCatalogRouter } from './catalog-routes';
import { errorHandler, notFound, sendError } from './errors';

export interface ApiOptions {
  database: DatabaseState;
  version: string;
  /** Catalog routes (WP2). Without it they report the indexer as off. */
  catalog?: CatalogOptions;
}

const NO_CATALOG: CatalogOptions = {
  thumbnails: null,
  indexer: { enabled: false, error: 'the Calibre indexer is not configured' },
};

/**
 * /api/v1: the new API. Later work packages add their routes here, behind
 * requireUser. Failures in here never affect the legacy endpoints.
 */
export function createApiRouter({ database, version, catalog = NO_CATALOG }: ApiOptions): Router {
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
    router.use(requireUser(database.db));

    router.get('/me', (_req, res) => {
      const { user, token } = getAuth(res);
      res.json({ user, token });
    });

    router.use(createCatalogRouter(database.db, catalog));

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
