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
import { seedPlannedCollections } from '../collections/seed';
import { createMigrationRouter } from '../migration/routes';
import { MigrationService } from '../migration/service';
import { createSyncRouter, SYNC_BODY_LIMIT } from '../sync/routes';
import { DEFAULT_MAX_CLOCK_SKEW_SECONDS, SyncStore } from '../sync/store';

export interface PairingOptions {
  /** Failed pairing attempts allowed per minute (all clients together). */
  maxFailuresPerMinute: number;
}

export const DEFAULT_PAIRING: PairingOptions = { maxFailuresPerMinute: 10 };

export interface SyncOptions {
  /** updatedAt further ahead of the server clock than this is set to the server time. */
  maxClockSkewSeconds: number;
}

export const DEFAULT_SYNC: SyncOptions = { maxClockSkewSeconds: DEFAULT_MAX_CLOCK_SKEW_SECONDS };

/** Where the WP5 migration reads the old sync and writes its pre-import snapshot. */
export interface MigrationPaths {
  /** The old sync's folder (DATA_DIR), read-only. */
  dataRoot: string;
  dbDir: string;
}

export interface ApiOptions {
  database: DatabaseState;
  version: string;
  /** Catalog routes (WP2). Without it they report the indexer as off. */
  catalog?: CatalogOptions;
  pairing?: PairingOptions;
  sync?: SyncOptions;
  /** WP5 migration routes. Without it they are not mounted. */
  migration?: MigrationPaths;
  /** Write the records the server creates once per user ("Planned", WP8b). Default on. */
  seedDefaults?: boolean;
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
  sync = DEFAULT_SYNC,
  migration,
  seedDefaults = true,
}: ApiOptions): Router {
  const router = express.Router();
  // Pushes can carry many records; everything else keeps the small default limit.
  const smallJson = express.json();
  const syncJson = express.json({ limit: SYNC_BODY_LIMIT });
  router.use((req, res, next) => (req.path === '/sync' ? syncJson : smallJson)(req, res, next));

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

    const syncStore = new SyncStore(db, { maxClockSkewMs: sync.maxClockSkewSeconds * 1000 });
    if (seedDefaults) {
      try {
        for (const userId of seedPlannedCollections(db, syncStore)) {
          console.log(`Collections: created "Planned" for user ${userId}`);
        }
      } catch (err) {
        // Never stops the API; tried again on the next start.
        console.error('Collections: could not create "Planned"', err);
      }
    }
    router.use(createSyncRouter(db, syncStore));

    if (migration) {
      const service = new MigrationService({
        db,
        store: syncStore,
        dataRoot: migration.dataRoot,
        dbDir: migration.dbDir,
        calibreDir: catalog.calibreDir ?? null,
        indexerEnabled: () => catalog.indexer.enabled,
        log: (m) => console.log(m),
      });
      router.use(createMigrationRouter(service));
    }

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
