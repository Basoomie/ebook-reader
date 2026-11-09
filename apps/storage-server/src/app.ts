import cors from 'cors';
import express, { Express } from 'express';
import type { ServerConfig } from './config';
import { createLegacyAudioUploadRouter, createLegacyFileRouter } from './legacy';

export function createApp(config: ServerConfig): Express {
  const app = express();

  app.use(
    cors({
      origin: config.corsOrigins,
      // Expose range-related headers so cross-origin <audio> can seek.
      exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Last-Modified'],
    }),
  );

  const legacy = { dataRoot: config.dataRoot, authToken: config.authToken };

  // Streaming upload: must come before any body parser.
  app.use(createLegacyAudioUploadRouter(legacy));

  // Legacy file API (raw body parser for everything it handles).
  app.use(createLegacyFileRouter(legacy));

  return app;
}
