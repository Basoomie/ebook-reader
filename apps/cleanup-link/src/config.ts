/**
 * The linking sidecar's settings come from its environment (compose). What to build comes from
 * the reader's server, which keeps the plan in cleanup.db.
 */
export interface LinkConfig {
  /** The storage server, e.g. http://ttsu-storage:3001. */
  serverUrl: string;
  /** From `cli token link "<label>"`. */
  token: string;
  /** The mount of /mnt/disk1/data (one mount: a hard link can't cross two). */
  dataDir: string;
  dirMode: number;
  fileMode: number;
  /** Requests to the server time out after this long (s). */
  serverTimeoutSeconds: number;
  /** WP21f-1: libarchive's bsdtar (reads archives; never writes files itself). */
  bsdtar: string;
  /** WP21f-1: the iconv name of the encoding zips without UTF-8 names use (CP932). */
  archiveCharset: string;
}

export class ConfigError extends Error {}

function mode(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^0?[0-7]{3,4}$/.test(value.trim()))
    throw new ConfigError(`${name} must be an octal mode like 0777`);
  return parseInt(value.trim(), 8);
}

export function loadConfig(env: Record<string, string | undefined>): LinkConfig {
  const serverUrl = (env.TTSU_URL ?? 'http://ttsu-storage:3001').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(serverUrl)) {
    throw new ConfigError(
      'TTSU_URL must be the storage server address, e.g. http://ttsu-storage:3001'
    );
  }
  const token = env.LINK_TOKEN ?? '';
  if (!token.startsWith('ttsu_')) {
    throw new ConfigError('LINK_TOKEN is missing (make one with: cli token link "link sidecar")');
  }
  const t = Number(env.SERVER_TIMEOUT_SECONDS ?? '60');
  return {
    serverUrl,
    token,
    dataDir: (env.DATA_DIR ?? '/data').trim() || '/data',
    dirMode: mode(env.DIR_MODE, 0o777, 'DIR_MODE'),
    fileMode: mode(env.FILE_MODE, 0o666, 'FILE_MODE'),
    serverTimeoutSeconds: Number.isFinite(t) && t > 0 ? t : 60,
    bsdtar: (env.BSDTAR ?? 'bsdtar').trim() || 'bsdtar',
    archiveCharset: (env.ARCHIVE_CHARSET ?? 'CP932').trim() || 'CP932'
  };
}
