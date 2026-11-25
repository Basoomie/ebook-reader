/**
 * Book covers: the one-time import of the earlier covers this sidecar kept in its quarantine
 * into the reader's server (its cover archive, DB_DIR/covers), so nothing about covers needs the
 * quarantine afterwards. Run once, on the user's word, before the quarantine folder is removed:
 *
 *   docker exec ttsu-cleanup-apply node /app/dist/import-covers.js
 *
 * It only reads the quarantine (never changes or deletes a file there) and talks only to the
 * reader's server, never to Calibre. Safe to run again: the server lists only the pictures it
 * doesn't have yet.
 */
import { createHash } from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { ConfigError, loadConfig } from './config';

interface Listed {
  changeId: number;
  calibreId: number;
  path: string;
}

/** Whether `file` lies inside `dir` (the quarantine), after resolving "..". */
export function insideDir(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function importCovers(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  log: (line: string) => void = console.log
): Promise<{ kept: number; missing: number; failed: number; total: number }> {
  const config = loadConfig(env);
  const base = `${config.serverUrl}/api/v1/cleanup-apply/cover-archive/quarantine`;
  const auth = { Authorization: `Bearer ${config.token}` };
  const res = await fetchImpl(base, { headers: auth });
  if (!res.ok) throw new Error(`The server refused the list (HTTP ${res.status})`);
  const { covers } = (await res.json()) as { covers: Listed[] };
  log(`${covers.length} earlier cover(s) to keep`);
  let kept = 0;
  let missing = 0;
  let failed = 0;
  for (const [i, c] of covers.entries()) {
    if (!insideDir(config.quarantineDir, c.path)) {
      failed++;
      log(`Calibre book ${c.calibreId}: not inside the quarantine, left out (${c.path})`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(c.path);
    } catch {
      missing++;
      log(`Calibre book ${c.calibreId}: not in the quarantine any more (${c.path})`);
      continue;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const put = await fetchImpl(`${base}/${c.changeId}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/octet-stream', 'x-sha256': sha256 },
      body: new Uint8Array(bytes)
    });
    if (put.ok) kept++;
    else {
      failed++;
      let message = `HTTP ${put.status}`;
      try {
        message =
          ((await put.json()) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        // Not JSON.
      }
      log(`Calibre book ${c.calibreId}: not kept: ${message}`);
    }
    if ((i + 1) % 100 === 0) log(`${i + 1} of ${covers.length}`);
  }
  log(
    `Done: ${kept} kept, ${missing} no longer in the quarantine, ${failed} not kept (of ${covers.length})`
  );
  return { kept, missing, failed, total: covers.length };
}

if (require.main === module) {
  importCovers(process.env).then(
    (r) => process.exit(r.failed > 0 ? 1 : 0),
    (err) => {
      console.error(err instanceof ConfigError ? err.message : (err as Error).message);
      process.exit(1);
    }
  );
}
