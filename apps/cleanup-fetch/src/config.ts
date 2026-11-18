/**
 * The fetch container's settings come from its environment (compose). Everything about what to
 * fetch and how fast comes from the reader's server, which keeps the queue in cleanup.db.
 */
export interface FetchConfig {
  /** The storage server as reachable from inside gluetun's network, e.g. http://192.168.1.5:3081. */
  serverUrl: string;
  /** From `cli token fetch "<label>"`. */
  token: string;
  /** Requests to the server time out after this long (s). */
  serverTimeoutSeconds: number;
  /** The Python with SudachiPy for generated author readings; '' = no readings here. */
  sudachiPython: string;
  /** The readings script (sudachi/readings.py). */
  sudachiScript: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>): FetchConfig {
  const serverUrl = (env.TTSU_URL ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(serverUrl)) {
    throw new ConfigError(
      'TTSU_URL must be the storage server address, e.g. http://192.168.1.5:3081'
    );
  }
  const token = env.FETCH_TOKEN ?? '';
  if (!token.startsWith('ttsu_')) {
    throw new ConfigError(
      'FETCH_TOKEN is missing (make one with: cli token fetch "fetch container")'
    );
  }
  const t = Number(env.SERVER_TIMEOUT_SECONDS ?? '60');
  return {
    serverUrl,
    token,
    serverTimeoutSeconds: Number.isFinite(t) && t > 0 ? t : 60,
    sudachiPython: env.SUDACHI_PYTHON ?? '',
    sudachiScript: env.SUDACHI_SCRIPT ?? '/app/sudachi/readings.py'
  };
}
