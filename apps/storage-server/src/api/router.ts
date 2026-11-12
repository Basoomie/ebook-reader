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
import { createExportRouter } from '../export/routes';
import { createLogsRouter } from '../logs/routes';
import { serverLogs, type RecentLogs } from '../logs/recent-logs';
import { createUploadRouter } from '../uploads/routes';
import { FontStore } from '../fonts/font-store';
import { createFontRouter } from '../fonts/routes';
import { FontService } from '../fonts/service';
import { DEFAULT_MAX_CLOCK_SKEW_SECONDS, SyncStore } from '../sync/store';
import { audioStreamRoute, type AudioOptions, createAudioRouter } from '../audio/routes';

export interface PairingOptions {
  /** Failed pairing attempts allowed per minute (all clients together). */
  maxFailuresPerMinute: number;
}

export const DEFAULT_PAIRING: PairingOptions = { maxFailuresPerMinute: 10 };

export interface SyncOptions {
  /** updatedAt further ahead of the server clock than this is set to the server time. */
  maxClockSkewSeconds: number;
  /** Kinds devices may no longer change (WP12: `stat-day`); the server's own writes still can. */
  frozenKinds?: string[];
}

export const DEFAULT_SYNC: SyncOptions = {
  maxClockSkewSeconds: DEFAULT_MAX_CLOCK_SKEW_SECONDS,
  frozenKinds: ['stat-day'],
};

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
  /** Custom fonts (WP13): stored in DATA_DIR/.uploads/fonts. Without it they are off. */
  fonts?: FontOptions;
  /** Recent log lines for the bug report (WP18). Default: the process-wide buffer. */
  logs?: RecentLogs;
  /** Audiobook index and streaming (WP15). Without it the audio routes answer 503. */
  audio?: AudioOptions;
}

export interface FontOptions {
  dataRoot: string;
  maxMb: number;
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
  fonts,
  logs = serverLogs,
  audio = { service: null },
}: ApiOptions): Router {
  const router = express.Router();
  // Pushes can carry many records; everything else keeps the small default limit.
  const smallJson = express.json();
  const syncJson = express.json({ limit: SYNC_BODY_LIMIT });
  router.use((req, res, next) => {
    // An upload's body is the EPUB itself, streamed by the upload route (WP7b); a
    // font upload's body is the font file (WP13).
    if (req.path === '/uploads' || req.path === '/fonts') return next();
    (req.path === '/sync' ? syncJson : smallJson)(req, res, next);
  });

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
      // Never the code or the token (WP18: the bug report includes these lines).
      console.log(`Pairing: a device paired as "${result.record.label}"`);
      res.json({ token: result.token, label: result.record.label });
    });

    // Signed URL or token (a plain <img> can't send the token).
    router.get('/books/:id/thumbnail', thumbnailAuth(db), thumbnailHandler(db, catalog));
    // Audio streams: signed URL or token (an <audio> element can't send the token, WP15).
    router.use(audioStreamRoute(db, audio));

    router.use(requireUser(db));

    router.get('/me', (_req, res) => {
      const { user, token } = getAuth(res);
      res.json({ user, token });
    });

    // The server's recent log lines for the bug report (WP18), secrets removed.
    router.use(createLogsRouter(logs));

    router.use(createCatalogRouter(db, catalog));
    router.use(createAudioRouter(db, audio));
    // Uploads (WP7b): a separate source adapter, mounted only when it is on.
    if (catalog.uploads) {
      router.use(
        createUploadRouter(db, catalog.uploads, { countSpec: () => catalog.counts?.spec ?? null }),
      );
    }

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
    router.use(
      createSyncRouter(db, syncStore, {
        frozenKinds: sync.frozenKinds ?? DEFAULT_SYNC.frozenKinds ?? [],
      }),
    );
    // Export my data (WP18): read-only.
    router.use(createExportRouter(db, syncStore));

    // Custom fonts (WP13). Independent of Calibre; off only when the folder is unusable.
    if (fonts) {
      try {
        const store = new FontStore(fonts.dataRoot);
        store.init();
        const service = new FontService({
          db,
          store,
          sync: syncStore,
          maxBytes: Math.round(fonts.maxMb * 1024 * 1024),
        });
        router.use(createFontRouter(service));
      } catch (err) {
        console.error('Error: custom fonts are off, the font folder is unusable:', err);
      }
    }

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
