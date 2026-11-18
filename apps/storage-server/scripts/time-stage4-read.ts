/**
 * WP20d: times readRefEpub per book (wall and CPU) on local copies of labeled EPUBs.
 *   node -r ts-node/register/transpile-only scripts/time-stage4-read.ts <gold800.json> <metadata.db copy> <library dir> <work dir> <n>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { monitorEventLoopDelay } from 'perf_hooks';
import { readRefEpub } from '../src/cleanup/stage4/ref-epub';

const [goldFile, mdb, libDir, work, nArg] = process.argv.slice(2);
const gold = Object.keys(JSON.parse(fs.readFileSync(goldFile, 'utf8')));
const db = new Database(mdb, { readonly: true, fileMustExist: true });
const row = db.prepare(
  `SELECT b.path, d.name, d.uncompressed_size AS size FROM books b JOIN data d ON d.book = b.id AND d.format = 'EPUB' WHERE b.id = ?`,
);
async function main() {
  const n = Number(nArg);
  const out: {
    id: string;
    mb: number;
    copyMs: number;
    wallMs: number;
    cpuMs: number;
    chars: number;
    spine: number;
  }[] = [];
  const h = monitorEventLoopDelay({ resolution: 10 });
  for (const id of gold.slice(0, n)) {
    const r = row.get(Number(id)) as { path: string; name: string; size: number } | undefined;
    if (!r) continue;
    const src = path.join(libDir, r.path, `${r.name}.epub`);
    const dst = path.join(work, `${id}.epub`);
    const c0 = performance.now();
    fs.copyFileSync(src, dst);
    const copyMs = performance.now() - c0;
    h.enable();
    const t0 = performance.now();
    const u0 = process.cpuUsage();
    const f = await readRefEpub(dst);
    const u = process.cpuUsage(u0);
    h.disable();
    out.push({
      id,
      mb: +(r.size / 1e6).toFixed(1),
      copyMs: Math.round(copyMs),
      wallMs: Math.round(performance.now() - t0),
      cpuMs: Math.round((u.user + u.system) / 1000),
      chars: f.chars,
      spine: 0,
    });
  }
  out.sort((a, b) => b.cpuMs - a.cpuMs);
  for (const o of out.slice(0, 12)) console.log(JSON.stringify(o));
  const sum = (k: 'cpuMs' | 'wallMs' | 'copyMs') => out.reduce((s, o) => s + o[k], 0);
  console.log(
    `books ${out.length}: cpu total ${sum('cpuMs')} ms (mean ${Math.round(sum('cpuMs') / out.length)}), wall ${sum('wallMs')} ms, smb copy ${sum('copyMs')} ms; event loop max block ${Math.round(h.max / 1e6)} ms, p99 ${Math.round(h.percentile(99) / 1e6)} ms`,
  );
}
void main();
