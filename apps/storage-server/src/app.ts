import cors from 'cors';
import express, { Express } from 'express';
import type { CatalogOptions } from './api/catalog-routes';
import { createApiRouter } from './api/router';
import type { ServerConfig } from './config';
import type { DatabaseState } from './db/database';
import type { RecentLogs } from './logs/recent-logs';
import type { AudioOptions } from './audio/routes';

export interface AppOptions {
  config: ServerConfig;
  database: DatabaseState;
  version: string;
  catalog?: CatalogOptions;
  /** See ApiOptions.seedDefaults (tests turn it off). */
  seedDefaults?: boolean;
  /** The recent log lines for the bug report (default: the process-wide buffer). */
  logs?: RecentLogs;
  /** Audiobook index and streaming (WP15). */
  audio?: AudioOptions;
}

export function createApp({
  config,
  database,
  version,
  catalog,
  seedDefaults,
  logs,
  audio,
}: AppOptions): Express {
  const app = express();

  // With an explicit list, requests from other origins get no
  // Access-Control-Allow-Origin and browsers block them.
  app.use(
    cors({
      origin: config.corsOrigins,
      // Expose range-related headers so cross-origin <audio> can seek, and
      // ETag so the Library page can store which version of an EPUB it saved.
      exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Last-Modified', 'ETag'],
    }),
  );

  // The API, with its own JSON body parser and error handling. (WP15e removed the old
  // sync's file endpoints: /list, /file, /audio-file, /mkdir, /rmdir.)
  app.use(
    '/api/v1',
    createApiRouter({
      database,
      version,
      catalog,
      pairing: { maxFailuresPerMinute: config.pairing.maxFailuresPerMinute },
      sync: {
        maxClockSkewSeconds: config.sync.maxClockSkewSeconds,
        frozenKinds: config.sync.frozenKinds,
      },
      migration: { dataRoot: config.dataRoot, dbDir: config.dbDir },
      fonts: { dataRoot: config.dataRoot, maxMb: config.fonts.maxMb },
      attachments: { dataRoot: config.dataRoot, maxMb: config.attachments.maxMb },
      seedDefaults,
      logs,
      audio,
    }),
  );

  return app;
}
