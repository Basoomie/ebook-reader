/**
 * WP20d: the stage-4 rules on the 800 labeled books' stored records.
 *
 *   node -r ts-node/register/transpile-only scripts/measure-stage4.ts <cleanup-reference dir> [python.json] [--windows]
 *
 * 1. The plain port (rules-v3.ts) per field, for the 600 (samples A-C) and check D, beside the
 *    measured numbers. With python.json (every book's P and AU from rules_v3.py), every book and
 *    field is compared with the original and each difference is listed.
 * 2. --windows: the same with the file text cut to stage 2's evidence windows (first 600, last
 *    1,500 characters) instead of ref4's (1,500 / 3,000), to see whether stage 4 can use stage
 *    2's evidence.
 * Reads only.
 */
import fs from 'fs';
import path from 'path';
import { decide, type RefRecord } from '../src/cleanup/stage4/rules-v3';
import { decideStage4 } from '../src/cleanup/stage4/stage4-rules';
import { fieldRight } from '../src/cleanup/stage4/score';
import {
  MEASURED_V3,
  SCORED_FIELDS,
  addScore,
  emptyScores,
  percent,
  type ScoredField,
  type Stage4Gold,
} from '../src/cleanup/stage4/score';

const args = process.argv.slice(2);
const refDir = args[0];
const pyFile = args.find((a, i) => i > 0 && a.endsWith('.json'));
const windows = args.includes('--windows');
if (!refDir) {
  console.error('usage: measure-stage4.ts <cleanup-reference dir> [python.json] [--windows]');
  process.exit(2);
}
const gold = JSON.parse(fs.readFileSync(path.join(refDir, 'gold800.json'), 'utf8')) as Record<
  string,
  Stage4Gold
>;
const py = pyFile
  ? (JSON.parse(fs.readFileSync(pyFile, 'utf8')) as Record<
      string,
      { P: Record<string, unknown>; AU: Record<string, unknown> }
    >)
  : null;

function run(cut: boolean): Record<string, ReturnType<typeof emptyScores>> {
  const groups = { ABC: emptyScores(), D: emptyScores() } as Record<
    string,
    ReturnType<typeof emptyScores>
  >;
  const diffs: string[] = [];
  for (const [id, g] of Object.entries(gold)) {
    const r = JSON.parse(
      fs.readFileSync(path.join(refDir, 'records', `${id}.json`), 'utf8'),
    ) as RefRecord;
    if (cut) {
      const front = (r.file.front_text || '').slice(0, 600);
      const col = r.file.colophon_text || '';
      r.file = {
        ...r.file,
        front_text: front,
        colophon_text: col.slice(Math.max(0, col.length - 1500)),
      };
    }
    const { P, AU } = decide(r);
    addScore(
      groups[g.sample === 'D' ? 'D' : 'ABC'],
      id,
      P as unknown as Record<ScoredField, unknown>,
      AU,
      g,
    );
    if (py && !cut) {
      const o = py[id];
      for (const f of SCORED_FIELDS) {
        const a = JSON.stringify(normalise(P[f]));
        const b = JSON.stringify(normalise(o.P[f]));
        if (a !== b) diffs.push(`${id} P.${f}: ts ${a} | py ${b}`);
        if (Boolean(AU[f]) !== Boolean(o.AU[f]))
          diffs.push(`${id} AU.${f}: ts ${AU[f]} | py ${o.AU[f]}`);
      }
    }
  }
  if (py && !cut) {
    console.log(
      `Port vs rules_v3.py: ${diffs.length} differences in ${Object.keys(gold).length} books x 6 fields x (value, auto)`,
    );
    for (const d of diffs.slice(0, 40)) console.log('  ' + d);
  }
  return groups;
}
const normalise = (v: unknown): unknown => (typeof v === 'number' ? Number(v) : v);

function print(label: string, groups: Record<string, ReturnType<typeof emptyScores>>): void {
  console.log(`\n${label}`);
  for (const grp of ['ABC', 'D'] as const) {
    const s = groups[grp];
    console.log(
      `  ${grp === 'ABC' ? 'the 600' : 'check D'}: ` +
        SCORED_FIELDS.map((f) => {
          const p = percent(s[f].right, s[f].auto);
          return `${f} ${p === null ? '-' : p.toFixed(1)}% (${s[f].auto}/${s[f].scored} auto; measured ${MEASURED_V3[grp][f]})`;
        }).join(', '),
    );
  }
}

const full = run(false);
print("Rules v3 port, ref4's text windows (1,500 / 3,000)", full);
if (windows) {
  const cut = run(true);
  print("Rules v3 port, stage 2's text windows (600 / 1,500)", cut);
  for (const grp of ['ABC', 'D'] as const) {
    for (const f of SCORED_FIELDS) {
      const a = full[grp][f];
      const b = cut[grp][f];
      if (a.auto !== b.auto || a.right !== b.right) {
        console.log(
          `  differs: ${grp} ${f}: auto ${a.auto} -> ${b.auto}, right ${a.right} -> ${b.right}`,
        );
      }
    }
  }
}

// 3. Stage 4's rules (the decided additions and the check-D fixes) against the plain port.
{
  const groups = { ABC: emptyScores(), D: emptyScores() } as Record<
    string,
    ReturnType<typeof emptyScores>
  >;
  const kind = { right: 0, all: 0, wrong: [] as string[] };
  const guess = { right: 0, all: 0, wrong: [] as string[] };
  const changed: string[] = [];
  for (const [id, g] of Object.entries(gold)) {
    const r = JSON.parse(
      fs.readFileSync(path.join(refDir, 'records', `${id}.json`), 'utf8'),
    ) as RefRecord;
    const d = decideStage4(r);
    const v3 = decide(r);
    addScore(
      groups[g.sample === 'D' ? 'D' : 'ABC'],
      id,
      d.values as unknown as Record<ScoredField, unknown>,
      d.auto,
      g,
    );
    for (const f of SCORED_FIELDS) {
      if (JSON.stringify(d.values[f]) !== JSON.stringify(v3.P[f]) || d.auto[f] !== v3.AU[f]) {
        const was = fieldRight(f, v3.P[f], g);
        const now = fieldRight(f, d.values[f], g);
        changed.push(
          `${id} ${f}: ${JSON.stringify(v3.P[f])}${v3.AU[f] ? ' auto' : ''} (${was}) -> ${JSON.stringify(d.values[f])}${d.auto[f] ? ' auto' : ''} (${now})${d.amazonRejected ? ' [' + d.amazonRejected + ']' : ''}`,
        );
      }
    }
    kind.all += 1;
    if (d.values.kind === g.kind) kind.right += 1;
    else
      kind.wrong.push(
        `${id} ${d.values.kind} vs ${g.kind} (${String(r.file.opf_title).slice(0, 40)})`,
      );
    if (d.numberGuess && g.ix !== '?') {
      guess.all += 1;
      const ok = d.numberGuess.value === g.ix || fieldRight('ix', d.numberGuess.value, g) === true;
      if (ok) guess.right += 1;
      else
        guess.wrong.push(`${id} ${d.numberGuess.rule}: ${d.numberGuess.value} vs ${String(g.ix)}`);
    }
  }
  print("Stage 4's rules (v3 + decided additions + check-D fixes)", groups);
  console.log(`
  values or classes changed from the plain port (${changed.length}; (right?) per the labels):`);
  for (const c of changed) console.log('    ' + c);
  console.log(`
  edition kind: ${kind.right}/${kind.all} right`);
  for (const w of kind.wrong) console.log('    ' + w);
  console.log(
    `  number guesses (side volume, bonus, omnibus) with a scored label: ${guess.right}/${guess.all} right`,
  );
  for (const w of guess.wrong) console.log('    ' + w);
}
