/**
 * Settings > Diagnostics (Season 2 §7): one read-only request with what the page shows
 * from the server. Mounted after requireUser.
 *
 *   GET /diagnostics  { serverTime, server, devices, pcWorker, cleanupHelper }
 *
 * `devices` leaves out the server's pseudo-devices (never seen; see below).
 *
 * Everything comes from the existing sources, unchanged: the devices list (GET /devices),
 * the PC worker's status (GET /gpu-worker) and the cleanup helper's heartbeat row (the
 * cheap part of GET /cleanup/status). It writes nothing of its own.
 */
import type Database from 'better-sqlite3';
import express, { Router } from 'express';
import { getAuth } from '../api/auth';
import type { AudioOptions } from '../audio/routes';
import { workerJobView } from '../audio/worker-routes';
import type { CleanupOptions } from '../cleanup/routes';
import { listDevices } from '../db/devices';
import { getSchemaVersion } from '../db/migrations';
import type { SyncStore } from '../sync/store';

export interface DiagnosticsOptions {
  version: string;
  /** When the server's code was built (version.ts), null when unknown. */
  builtAt: number | null;
  audio: AudioOptions;
  cleanup: CleanupOptions;
}

export function createDiagnosticsRouter(
  db: Database.Database,
  store: SyncStore,
  { version, builtAt, audio, cleanup }: DiagnosticsOptions,
): Router {
  const router = express.Router();

  router.get('/diagnostics', (_req, res) => {
    const auth = getAuth(res);
    const userId = auth.user.id;

    // Only devices that synced at least once (decided with the user, 2026-11-15): a real
    // device gets last_seen_at on its first register; the server's own pseudo-devices
    // ("Server" for its seeds, "Old sync (imported)" for the WP5 import) are inserted
    // directly and never do. createdAt tells devices with the same name apart.
    const devices = listDevices(db, store, userId)
      .filter((d) => d.lastSeenAt !== null)
      .map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        current: d.id === auth.token.deviceId,
      }));

    let pcWorker;
    if (!audio.jobs) {
      pcWorker = { available: false as const };
    } else {
      const s = audio.jobs.status(userId);
      const running = s.jobs.find((j) => j.state === 'running') ?? null;
      pcWorker = {
        available: true as const,
        online: s.online,
        paused: s.paused,
        lastSeenAt: s.lastSeenAt,
        problem: s.problem,
        version: s.version,
        currentJob: running ? workerJobView(running) : null,
        waiting: s.jobs.filter((j) => j.state === 'queued').length,
      };
    }

    let cleanupHelper;
    if (!cleanup.service) {
      cleanupHelper = { available: false as const };
    } else {
      const s = cleanup.service.sidecar();
      cleanupHelper = { available: true as const, online: s.online, lastSeenAt: s.lastSeenAt };
    }

    res.json({
      serverTime: Date.now(),
      server: { version, builtAt, schemaVersion: getSchemaVersion(db) },
      devices,
      pcWorker,
      cleanupHelper,
    });
  });

  return router;
}
