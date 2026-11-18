/** WP20d: times readFileMetadata({ text: false }) (the cover facts) on local EPUB copies. */
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { readFileMetadata } from '../src/cleanup/file-metadata';
async function main() {
  const dir = process.argv[2];
  const out: { f: string; ms: number; cpu: number; w: number | null }[] = [];
  for (const f of fs.readdirSync(dir)) {
    const t0 = performance.now();
    const u0 = process.cpuUsage();
    const m = await readFileMetadata(path.join(dir, f), { text: false });
    const u = process.cpuUsage(u0);
    out.push({
      f,
      ms: Math.round(performance.now() - t0),
      cpu: Math.round((u.user + u.system) / 1000),
      w: m.cover?.width ?? null,
    });
  }
  out.sort((a, b) => b.ms - a.ms);
  console.log(
    out
      .slice(0, 8)
      .map((o) => JSON.stringify(o))
      .join('\n'),
  );
  console.log(
    'books',
    out.length,
    'wall total',
    out.reduce((s, o) => s + o.ms, 0),
    'cpu total',
    out.reduce((s, o) => s + o.cpu, 0),
  );
}
void main();
