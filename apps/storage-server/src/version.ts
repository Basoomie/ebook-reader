import { readFileSync } from 'fs';
import path from 'path';

function readVersion(): string {
  try {
    // src/ (ts-node) and dist/ (built) both sit directly under the package root.
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const SERVER_VERSION = readVersion();

/** The file `npm run build` writes next to the compiled code: `{ "builtAt": <ms> }`. */
export const BUILD_INFO_FILE = 'build-info.json';

/**
 * When this server's code was built (ms), from `build-info.json` in `dir`; null when
 * there is none (ts-node, tests) or it can't be read. The Docker image's build step
 * runs only when the server's code changed, so this changes only with the code.
 */
export function readBuiltAt(dir: string = __dirname): number | null {
  try {
    const info = JSON.parse(readFileSync(path.join(dir, BUILD_INFO_FILE), 'utf8')) as {
      builtAt?: unknown;
    };
    const t = info?.builtAt;
    return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
  } catch {
    return null;
  }
}

export const SERVER_BUILT_AT = readBuiltAt();
