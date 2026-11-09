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
