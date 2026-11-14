/**
 * The sidecar's settings come from its environment (compose). Everything about Calibre
 * (content server address, library id, user, password) comes from the reader's server,
 * which keeps it in cleanup.db; nothing about Calibre is configured in the container.
 */
export interface SidecarConfig {
  /** The storage server, e.g. http://ttsu-storage:3001 (compose network). */
  serverUrl: string;
  /** From `cli token cleanup "<label>"`. */
  token: string;
  /** Mounted /mnt/user/data/backups/calibre-quarantine. Nothing here is ever deleted. */
  quarantineDir: string;
  /** The calibredb program (the linuxserver/calibre image: /opt/calibre/calibredb). */
  calibredb: string;
  /** The quarantine folder needs at least this much free space (MB). */
  minFreeMb: number;
  /** One calibredb call is stopped after this long (s). */
  calibredbTimeoutSeconds: number;
  /** How often the safety checks run (s). */
  checkSeconds: number;
  /** Requests to the server time out after this long (s). */
  requestTimeoutSeconds: number;
  /**
   * Undo: how long to wait for Calibre to bring books back from its trash (s). Calibre reads
   * its whole trash first (minutes with thousands of entries) and keeps going after the
   * request itself times out.
   */
  trashRestoreWaitSeconds: number;
  /**
   * How long to wait for Calibre to remove a copy after the remove request failed (s). The
   * request can time out while Calibre still removes it.
   */
  removeWaitSeconds: number;
  /** While waiting for Calibre (Undo, a timed-out remove): how often to look (s). */
  waitPollSeconds: number;
}

export class ConfigError extends Error {}

function num(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${name} must be a positive number`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): SidecarConfig {
  const serverUrl = (env.TTSU_URL ?? 'http://ttsu-storage:3001').replace(/\/+$/, '');
  const token = env.CLEANUP_TOKEN ?? '';
  if (!token.startsWith('ttsu_')) {
    throw new ConfigError(
      'CLEANUP_TOKEN is not set. Make one with: docker exec ttsu-storage node dist/cli.js token cleanup "cleanup sidecar"'
    );
  }
  return {
    serverUrl,
    token,
    quarantineDir: env.QUARANTINE_DIR ?? '/quarantine',
    calibredb: env.CALIBREDB ?? '/opt/calibre/calibredb',
    minFreeMb: num(env, 'QUARANTINE_MIN_FREE_MB', 2048),
    calibredbTimeoutSeconds: num(env, 'CALIBREDB_TIMEOUT_SECONDS', 600),
    checkSeconds: num(env, 'CHECK_SECONDS', 120),
    requestTimeoutSeconds: num(env, 'REQUEST_TIMEOUT_SECONDS', 60),
    trashRestoreWaitSeconds: num(env, 'TRASH_RESTORE_WAIT_SECONDS', 3600),
    removeWaitSeconds: num(env, 'REMOVE_WAIT_SECONDS', 600),
    waitPollSeconds: num(env, 'WAIT_POLL_SECONDS', 15)
  };
}
