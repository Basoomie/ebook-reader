/**
 * WP21c follow-up (3), stop 1: the recordings sharing a store record that stage 3 never compared,
 * compared with stage 3's own windows before the deploy (the live run does the same under the
 * shared disk lock). Two steps, because the PC has ffmpeg but no fpcalc:
 *
 *   extract (on the PC): for each pair in `pairs-to-compare.json` (from wp21c-redecide.ts), the
 *     stage's window plan (`planWindows`, `spansOf`) and the stage's exact ffmpeg arguments
 *     (`toolArgs('window-pcm', …)`) read only those seconds of each file from the NAS share
 *     (read only) into one raw PCM file per window and side: what fpcalc gets in the stage.
 *       npx vite-node scripts/wp21c3-compare.ts -- extract --pairs <json> --out <dir>
 *         --torrents <dir> --library <dir> [--ffmpeg <path>]
 *   score (in the Linux image with fpcalc): each PCM through fpcalc with the stage's arguments,
 *     `scoreWindow` and `fingerprintVerdict` with the live settings' `dupSameScore`; writes the
 *     verdicts as `pair-checks.json` for `wp21c-redecide.ts --pair-checks`.
 *       npx vite-node scripts/wp21c3-compare.ts -- score --pairs <json> --out <dir>
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  fingerprintVerdict,
  parseFpcalc,
  planWindows,
  scoreWindow,
  type WindowScore,
} from '../src/cleanup/audio/dup-fingerprint';
import { toolArgs } from '../src/cleanup/audio/probe';
import { spansOf } from '../src/cleanup/audio/stage3-dups';
import type { OpeningFile } from '../src/cleanup/audio/stage4-online';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

interface Pair {
  key: string;
  a: { name: string; seconds: number | null; files: OpeningFile[] };
  b: { name: string; seconds: number | null; files: OpeningFile[] };
}

const mode = process.argv[2] === '--' ? process.argv[3] : process.argv[2];
// The live copy's stage-3 window settings and same-recording score, as redecide wrote them.
const job = JSON.parse(fs.readFileSync(arg('pairs'), 'utf8')) as {
  windows: { windowSeconds: number; shiftSeconds: number; middleSearchMinutes: number };
  same: number;
  pairs: Pair[];
};
const WINDOWS = job.windows;
const pairs = job.pairs;
const out = arg('out');
fs.mkdirSync(out, { recursive: true });
const seconds = (x: Pair['a']) => x.seconds ?? x.files.reduce((t, f) => t + (f.duration ?? 0), 0);

if (mode === 'extract') {
  const roots: Record<string, string> = { torrents: arg('torrents'), library: arg('library') };
  const ffmpeg = arg('ffmpeg', 'ffmpeg');
  pairs.forEach((p, i) => {
    const { plans, skipped } = planWindows(seconds(p.a), seconds(p.b), WINDOWS);
    console.log(
      `[${i}] ${p.a.name}  <>  ${p.b.name}: windows ${plans.map((w) => w.name).join(', ')}${skipped.length ? `; skipped ${JSON.stringify(skipped)}` : ''}`,
    );
    for (const w of plans)
      for (const [side, x, span] of [
        ['a', p.a, w.a],
        ['b', p.b, w.b],
      ] as const) {
        const file = path.join(out, `${i}-${w.name}-${side}.pcm`);
        if (fs.existsSync(file)) continue;
        const chunks: Buffer[] = [];
        for (const sp of spansOf(x.files, span)) {
          const f = x.files.find((y) => y.id === sp.fileId)!;
          const input = path.join(roots[f.root], ...f.rel.split('/'));
          const r = spawnSync(ffmpeg, toolArgs('window-pcm', input, 0, sp), {
            maxBuffer: 1 << 28,
            windowsHide: true,
          });
          if (r.status !== 0)
            throw new Error(`ffmpeg failed on ${input}: ${r.stderr.toString().slice(0, 300)}`);
          chunks.push(r.stdout);
        }
        fs.writeFileSync(file, Buffer.concat(chunks));
      }
  });
  console.log(`extracted into ${out}`);
} else if (mode === 'score') {
  const same = job.same;
  const results: { key: string; a: string; b: string; verdict: string; scores: unknown }[] = [];
  pairs.forEach((p, i) => {
    const { plans, skipped } = planWindows(seconds(p.a), seconds(p.b), WINDOWS);
    const fp = (file: string) => {
      const pcm = fs.readFileSync(file);
      const total = pcm.length / 2 / 11025;
      const stdout = execFileSync(
        'fpcalc',
        toolArgs('fpcalc', '-', 0, { start: 0, length: total }),
        {
          input: pcm,
          maxBuffer: 1 << 26,
        },
      );
      return parseFpcalc(stdout.toString('utf8'));
    };
    const scores: WindowScore[] = plans.map((w) => {
      const fa = fp(path.join(out, `${i}-${w.name}-a.pcm`));
      const fb = fp(path.join(out, `${i}-${w.name}-b.pcm`));
      return fa && fb
        ? scoreWindow(w, fa, fb)
        : { name: w.name, score: null, shiftSeconds: null, reason: 'not read' };
    });
    const verdict = fingerprintVerdict(scores, same);
    console.log(`[${i}] ${verdict}  ${p.a.name}  <>  ${p.b.name}  ${JSON.stringify(scores)}`);
    results.push({
      key: p.key,
      a: p.a.name,
      b: p.b.name,
      verdict,
      scores: { windows: scores, skipped },
    });
  });
  fs.writeFileSync(path.join(out, 'pair-checks.json'), JSON.stringify(results, null, 1));
  console.log(`verdicts: ${path.join(out, 'pair-checks.json')}`);
} else throw new Error('extract or score');
