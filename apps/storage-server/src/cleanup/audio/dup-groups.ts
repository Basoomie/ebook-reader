/**
 * Stage 3's groups (WP21b): copies joined by "same recording" edges, cheapest test first.
 * Pure. Typed arrays, no per-pair maps (WP20 lessons (3): a Map holds 2^24 entries).
 *
 * - Edges say same / different / unsure, with the test that measured them.
 * - Groups are the connected components of "same" edges.
 * - A group that also holds a "different" edge between two of its copies is never resolved
 *   silently: review.
 * - "unsure" edges between two copies not joined otherwise become review pairs: both copies
 *   stay (decided by the user).
 */
import { createHash } from 'crypto';

export type DupTest = 'identical' | 'asin' | 'abs_asin' | 'title' | 'in_folder';
export const TEST_ORDER: DupTest[] = ['identical', 'asin', 'abs_asin', 'title', 'in_folder'];

export type EdgeVerdict = 'same' | 'different' | 'unsure';

export interface Edge {
  a: number;
  b: number;
  test: DupTest;
  verdict: EdgeVerdict;
}

export class UnionFind {
  private readonly parent: Int32Array;
  private readonly rank: Uint8Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.rank = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++;
  }
}

export interface Component {
  members: number[];
  /** The cheapest test that joined any two of its copies. */
  firstTest: DupTest;
  tests: DupTest[];
  /** Two of its copies were measured as different recordings. */
  conflict: boolean;
}

export interface Grouping {
  components: Component[];
  /** Unsure pairs whose copies are not in one group: each a review item, both copies stay. */
  unsure: Edge[];
}

/** Groups copies 0..n-1 by the edges. */
export function groupCopies(n: number, edges: Edge[]): Grouping {
  const uf = new UnionFind(n);
  for (const e of edges) if (e.verdict === 'same') uf.union(e.a, e.b);
  const byRoot = new Map<number, Component>();
  const testRank = (t: DupTest) => TEST_ORDER.indexOf(t);
  for (const e of edges) {
    if (e.verdict !== 'same') continue;
    const r = uf.find(e.a);
    let c = byRoot.get(r);
    if (!c) {
      c = { members: [], firstTest: e.test, tests: [], conflict: false };
      byRoot.set(r, c);
    }
    if (testRank(e.test) < testRank(c.firstTest)) c.firstTest = e.test;
    if (!c.tests.includes(e.test)) c.tests.push(e.test);
  }
  for (let i = 0; i < n; i++) {
    const c = byRoot.get(uf.find(i));
    if (c) c.members.push(i);
  }
  const unsure: Edge[] = [];
  for (const e of edges) {
    if (e.verdict === 'same') continue;
    const ra = uf.find(e.a);
    if (ra === uf.find(e.b)) {
      const c = byRoot.get(ra);
      // An unsure edge inside a group is outweighed by the edges that joined it.
      if (c && e.verdict === 'different') c.conflict = true;
      continue;
    }
    if (e.verdict === 'unsure') unsure.push(e);
  }
  for (const c of byRoot.values()) c.tests.sort((x, y) => testRank(x) - testRank(y));
  return { components: [...byRoot.values()], unsure };
}

/** A stable name for a set of copies (decisions are kept by it across analyses). */
export function groupKey(copyKeys: string[]): string {
  return createHash('sha1')
    .update([...copyKeys].sort().join('\n'))
    .digest('hex')
    .slice(0, 20);
}
