import type Database from 'better-sqlite3';
import express, { Router } from 'express';
import { getAuth } from '../api/auth';
import { ApiError } from '../api/errors';
import { DeviceError, listDevices, registerDevice, touchDevice } from '../db/devices';
import { decodeCursor, encodeCursor, SyncChange, SyncStore } from './store';

export const MAX_PUSH_CHANGES = 500;
export const DEFAULT_PULL_LIMIT = 500;
export const MAX_PULL_LIMIT = 1000;
/** Body limit for POST /sync (500 records of up to 64 KB would be more; that's fine, rare). */
export const SYNC_BODY_LIMIT = '8mb';

function deviceErrorToApi(err: unknown): never {
  if (err instanceof DeviceError) throw new ApiError(err.status, err.code, err.message);
  throw err;
}

/**
 * WP4 routes, mounted after requireUser:
 *   POST /devices/register  bind this token to a device
 *   GET  /devices           all devices of the user
 *   POST /sync              push changes
 *   GET  /sync?cursor=      pull changes since the cursor
 */
/** A push had refused changes (notifications N1). Errors in it never reach the push. */
export type RefusedListener = (info: {
  userId: string;
  deviceId: string;
  deviceName: string | null;
  refused: { kind: string; code: string; message: string }[];
}) => void;

/**
 * Refused with this code, the device settles the change by itself on its next sync (the web
 * app's startOverRefusalHandler): not a problem to report.
 */
const SELF_SETTLING_CODES = new Set(['read_through_finished']);

/**
 * Changes a device's push applied (book summaries session 3: a book's first completion makes
 * its summary). Called after the answer; an error here never affects the push.
 */
export type AppliedListener = (i: {
  userId: string;
  deviceId: string;
  applied: { kind: string; id: string }[];
}) => void;

export function createSyncRouter(
  db: Database.Database,
  store: SyncStore,
  {
    frozenKinds = [],
    onRefused,
    onApplied,
  }: { frozenKinds?: string[]; onRefused?: RefusedListener; onApplied?: AppliedListener } = {},
): Router {
  const router = express.Router();
  // WP12: kinds devices may no longer change. Only device pushes are refused here;
  // the server's own writes (the WP5 migration import) call the store directly.
  const frozen = new Set(frozenKinds);

  router.post('/devices/register', (req, res) => {
    const auth = getAuth(res);
    const body = (req.body ?? {}) as { deviceId?: unknown; name?: unknown };
    let device;
    try {
      device = registerDevice(db, store, auth, body);
    } catch (err) {
      deviceErrorToApi(err);
    }
    auth.token.deviceId = device.id;
    touchDevice(db, device.id);
    res.json({ device, serverTime: Date.now() });
  });

  router.get('/devices', (_req, res) => {
    const auth = getAuth(res);
    res.json({
      devices: listDevices(db, store, auth.user.id).map((d) => ({
        ...d,
        current: d.id === auth.token.deviceId,
      })),
      serverTime: Date.now(),
    });
  });

  /** The calling device; sync needs a registered one. */
  const requireDevice = (res: express.Response): string => {
    const deviceId = getAuth(res).token.deviceId;
    if (!deviceId) {
      throw new ApiError(
        409,
        'device_not_registered',
        'Register this device first (POST /api/v1/devices/register)',
      );
    }
    return deviceId;
  };

  router.post('/sync', (req, res) => {
    const deviceId = requireDevice(res);
    const { user } = getAuth(res);
    const changes = (req.body as { changes?: unknown } | undefined)?.changes;
    if (!Array.isArray(changes)) throw new ApiError(400, 'invalid_body', 'changes must be a list');
    if (changes.length > MAX_PUSH_CHANGES) {
      throw new ApiError(400, 'too_many_changes', `Push at most ${MAX_PUSH_CHANGES} changes`);
    }
    const now = Date.now();
    const results = store.push(user.id, deviceId, changes as SyncChange[], now, { frozen });
    touchDevice(db, deviceId, now);
    res.json({ results, serverTime: Date.now() });
    if (onApplied) {
      try {
        const applied = results.flatMap((r) =>
          r.status === 'applied' ? [{ kind: r.kind, id: r.id }] : [],
        );
        if (applied.length) onApplied({ userId: user.id, deviceId, applied });
      } catch (err) {
        console.error('Sync: after the push:', err);
      }
    }
    if (onRefused) {
      try {
        const refused = results.flatMap((r) =>
          r.status === 'rejected' && !SELF_SETTLING_CODES.has(r.error.code)
            ? [{ kind: r.kind, code: r.error.code, message: r.error.message }]
            : [],
        );
        if (refused.length) {
          const name = listDevices(db, store, user.id).find((d) => d.id === deviceId)?.name ?? null;
          onRefused({ userId: user.id, deviceId, deviceName: name, refused });
        }
      } catch (err) {
        console.error('Sync: reporting refused changes failed:', err);
      }
    }
  });

  router.get('/sync', (req, res) => {
    const deviceId = requireDevice(res);
    const { user } = getAuth(res);
    const state = store.getState(user.id);

    let since = 0;
    const rawCursor = req.query.cursor;
    if (typeof rawCursor === 'string' && rawCursor !== '') {
      const cursor = decodeCursor(rawCursor);
      if (!cursor) throw new ApiError(400, 'invalid_cursor', 'Unreadable cursor');
      if (cursor.epoch !== state.epoch || cursor.rev > state.lastRev) {
        // The database was restored or replaced: the device must start over.
        throw new ApiError(409, 'cursor_reset', 'The server data changed; sync from the start');
      }
      since = cursor.rev;
    } else if (rawCursor !== undefined && typeof rawCursor !== 'string') {
      throw new ApiError(400, 'invalid_cursor', 'Unreadable cursor');
    }

    let limit = DEFAULT_PULL_LIMIT;
    if (req.query.limit !== undefined) {
      const n = Number(req.query.limit);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PULL_LIMIT) {
        throw new ApiError(400, 'invalid_limit', `limit must be 1 to ${MAX_PULL_LIMIT}`);
      }
      limit = n;
    }

    const result = store.pull(user.id, since, limit);
    touchDevice(db, deviceId);
    res.json({
      records: result.records,
      cursor: encodeCursor(state.epoch, result.rev),
      more: result.more,
      serverTime: Date.now(),
    });
  });

  return router;
}
