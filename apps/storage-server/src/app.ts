import cors from 'cors';
import express, { Express } from 'express';
import type { CatalogOptions } from './api/catalog-routes';
import { createApiRouter } from './api/router';
import type { ServerConfig } from './config';
import type { DatabaseState } from './db/database';
import { createLegacyAudioUploadRouter, createLegacyFileRouter } from './legacy';
import type { RecentLogs } from './logs/recent-logs';

export interface AppOptions {
  config: ServerConfig;
  database: DatabaseState;
  version: string;
  catalog?: CatalogOptions;
  /** See ApiOptions.seedDefaults (tests turn it off). */
  seedDefaults?: boolean;
  /** The recent log lines for the bug report (default: the process-wide buffer). */
  logs?: RecentLogs;
}

export function createApp({
  config,
  database,
  version,
  catalog,
  seedDefaults,
  logs,
}: AppOptions): Express {
  const app = express();

  // Applies to the legacy and the new routes. With an explicit list, requests
  // from other origins get no Access-Control-Allow-Origin and browsers block them.
  app.use(
    cors({
      origin: config.corsOrigins,
      // Expose range-related headers so cross-origin <audio> can seek, and
      // ETag so the Library page can store which version of an EPUB it saved.
      exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Last-Modified', 'ETag'],
    }),
  );

  const legacy = { dataRoot: config.dataRoot, authToken: config.authToken };

  // Streaming upload: must come before any body parser.
  app.use(createLegacyAudioUploadRouter(legacy));

  // New API, with its own JSON body parser and error handling.
  app.use(
    '/api/v1',
    createApiRouter({
      database,
      version,
      catalog,
      pairing: { maxFailuresPerMinute: config.pairing.maxFailuresPerMinute },
      sync: { maxClockSkewSeconds: config.sync.maxClockSkewSeconds },
      migration: { dataRoot: config.dataRoot, dbDir: config.dbDir },
      fonts: { dataRoot: config.dataRoot, maxMb: config.fonts.maxMb },
      seedDefaults,
      logs,
    }),
  );

  // Legacy file API (raw body parser for everything it handles).
  app.use(createLegacyFileRouter(legacy));

  return app;
}
