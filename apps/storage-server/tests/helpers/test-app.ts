import path from 'path';
import { createApp } from '../../src/app';
import {
  CalibreConfig,
  DEFAULT_CALIBRE,
  DEFAULT_COUNTS_CONFIG,
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_PAIRING_CONFIG,
  DEFAULT_SYNC_CONFIG,
  DEFAULT_UPLOAD_CONFIG,
  ServerConfig,
} from '../../src/config';
import { DatabaseState, initDatabase } from '../../src/db/database';
import { createToken } from '../../src/db/tokens';
import { listUsers } from '../../src/db/users';
import { makeTempDir } from './spawn-server';

export const LEGACY_TOKEN = 'legacy-token';

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    dataRoot: makeTempDir('data'),
    authToken: LEGACY_TOKEN,
    port: 0,
    corsOrigins: '*',
    dbDir: makeTempDir('db'),
    snapshotTime: { hour: 3, minute: 0 },
    snapshotKeep: 7,
    calibre: testCalibreConfig(),
    pairing: { ...DEFAULT_PAIRING_CONFIG },
    sync: { ...DEFAULT_SYNC_CONFIG },
    counts: { ...DEFAULT_COUNTS_CONFIG, background: false },
    search: { ...DEFAULT_SEARCH_CONFIG },
    uploads: { ...DEFAULT_UPLOAD_CONFIG },
    ...overrides,
  };
}

/** Calibre settings for tests: no settle wait, no rate limit, writable fixtures allowed. */
export function testCalibreConfig(overrides: Partial<CalibreConfig> = {}): CalibreConfig {
  return {
    ...DEFAULT_CALIBRE,
    dir: null,
    cacheDir: makeTempDir('cache'),
    settleSeconds: 0,
    requireReadonly: false,
    thumbPerSecond: 0,
    ...overrides,
  };
}

/**
 * `seedDefaults`: the server's once-per-user records ("Planned"); off by default so
 * tests see only the records they write.
 */
export function makeTestApp(
  overrides: Partial<ServerConfig> = {},
  database?: DatabaseState,
  { seedDefaults = false }: { seedDefaults?: boolean } = {},
): {
  app: ReturnType<typeof createApp>;
  config: ServerConfig;
  database: DatabaseState;
  newUserToken: (label?: string) => string;
} {
  const config = testConfig(overrides);
  const state = database ?? initDatabase(config.dbDir, config.dataRoot);
  const app = createApp({ config, database: state, version: '9.9.9-test', seedDefaults });
  return {
    app,
    config,
    database: state,
    newUserToken: (label = 'test device') => {
      if (!state.ok) throw new Error('database not available');
      const [owner] = listUsers(state.db);
      return createToken(state.db, owner.id, label).token;
    },
  };
}

export function unavailableDatabase(reason = 'test: no database'): DatabaseState {
  return { ok: false, error: reason };
}

export { path };
