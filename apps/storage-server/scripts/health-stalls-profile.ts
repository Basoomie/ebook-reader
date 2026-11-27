/**
 * Sums a .cpuprofile from scripts/health-stalls-drive.ts: the main thread's time inside each
 * named function (inclusive), how often it ran (separate runs = sample gaps of over 5 ms), and
 * its longest single run, plus the top functions by their own time.
 *   npx ts-node --transpile-only scripts/health-stalls-profile.ts <file.cpuprofile> [function names...]
 */
import fs from 'node:fs';

const [file, ...names] = process.argv.slice(2);
const want = names.length
  ? names
  : [
      'dueIds',
      'walkDue',
      'listDue',
      'sliced',
      'libraryIndex',
      'buildSlices',
      'readAnswer',
      'readAnswerAsync',
      'searchFill',
      'fillOnce',
      'firstFill',
      'unfilledIds',
      'readSnapshotBooks',
      'presentBookCount',
      'medianPooledAverage',
      'updateScoreParams',
      'answeredSince',
    ];
type Frame = { functionName: string; url: string; lineNumber: number };
type Node = { id: number; callFrame: Frame; children?: number[] };
const p = JSON.parse(fs.readFileSync(file, 'utf8')) as {
  nodes: Node[];
  samples: number[];
  timeDeltas: number[];
};
const byId = new Map(p.nodes.map((n) => [n.id, n] as const));
const parent = new Map<number, number>();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const label = (n: Node) => {
  const f = n.callFrame;
  const url = (f.url || '').replace(/^.*[\\/](dist|src)[\\/]/, '');
  return `${f.functionName || '(anonymous)'} ${url}:${f.lineNumber + 1}`;
};
// Each sample: its node, and how long it lasted (the next time delta).
const samples = p.samples.map((id, i) => ({ id, dt: (p.timeDeltas[i + 1] ?? 0) / 1000 }));
const total = samples.reduce((a, s) => a + s.dt, 0);
const self = new Map<string, number>();
const incl = new Map(want.map((w) => [w, { ms: 0, runs: 0, longest: 0, cur: 0, last: -1e9 }]));
let t = 0;
for (const s of samples) {
  const n = byId.get(s.id)!;
  const k = label(n);
  self.set(k, (self.get(k) ?? 0) + s.dt);
  const seen = new Set<string>();
  for (let id: number | undefined = s.id; id !== undefined; id = parent.get(id)) {
    const fn = byId.get(id)!.callFrame.functionName;
    if (incl.has(fn) && !seen.has(fn)) {
      seen.add(fn);
      const r = incl.get(fn)!;
      r.ms += s.dt;
      if (t - r.last > 5) {
        r.runs += 1;
        r.cur = 0;
      }
      r.cur += s.dt;
      r.longest = Math.max(r.longest, r.cur);
      r.last = t + s.dt;
    }
  }
  t += s.dt;
}
const idle = [...self.entries()]
  .filter(([k]) => k.startsWith('(idle)') || k.startsWith('(program)'))
  .reduce((a, [, v]) => a + v, 0);
console.log(
  `profile ${(total / 1000).toFixed(0)} s, main thread busy ${((total - idle) / 1000).toFixed(1)} s`,
);
console.log('\nnamed functions (inclusive): ms total | runs | longest run ms');
for (const [k, r] of incl)
  if (r.ms > 0)
    console.log(
      `  ${k.padEnd(22)} ${r.ms.toFixed(0).padStart(7)} | ${String(r.runs).padStart(4)} | ${r.longest.toFixed(0)}`,
    );
console.log('\ntop own time:');
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25))
  console.log(`  ${v.toFixed(0).padStart(7)} ms  ${k}`);
