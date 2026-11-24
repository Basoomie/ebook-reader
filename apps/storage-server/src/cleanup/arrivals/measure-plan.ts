/**
 * The new arrivals' measuring (WP20g, 2026-11-24): which pairs still need measuring, and how the
 * books of a batch of owners are grouped so each file is read once per group. Pure.
 *
 * A pair can be left out only when its verdict cannot change an outcome: a new book is a
 * duplicate as soon as one of its verdicts says the other copy is as good or better (the outcome
 * step takes the first such verdict; later ones are only appended after it), so a pair of two
 * such books, or of such a book and a library book (which has no outcome), changes nothing.
 * Every other pair is measured as before.
 */

/** A new book's key is -(its catalog id); a library book's is its Calibre id. */
export interface OwnerPairs {
  /** The owner's catalog id. */
  owner: number;
  /** The keys of the copies it is still to be measured against. */
  others: number[];
}

/** The pairs of an owner that can still change an outcome. */
export function neededOthers(
  owner: number,
  others: number[],
  settled: (key: number) => boolean,
): number[] {
  if (!settled(-owner)) return others;
  return others.filter((o) => o < 0 && !settled(o));
}

export interface MeasureUnit {
  owners: number[];
  /** Every book read for the unit (keys), and the pairs (a = the owner's key). */
  books: number[];
  pairs: { a: number; b: number }[];
}

/**
 * Groups owners (in their order) into units of at most `maxBooks` books: owners whose pairs share
 * books go together, so a book is read once for all of them. An owner with more books than fit
 * is a unit of its own (the measuring splits its requests as before).
 */
export function groupUnits(owners: OwnerPairs[], maxBooks: number): MeasureUnit[] {
  // Owners connected through shared books (union-find over keys).
  const parent = new Map<number, number>();
  const find = (k: number): number => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let x = k;
    while (parent.get(x) !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const add = (k: number) => {
    if (!parent.has(k)) parent.set(k, k);
  };
  for (const o of owners) {
    add(-o.owner);
    for (const k of o.others) {
      add(k);
      const a = find(-o.owner);
      const b = find(k);
      if (a !== b) parent.set(b, a);
    }
  }
  const groups = new Map<number, OwnerPairs[]>();
  for (const o of owners) {
    const g = find(-o.owner);
    const list = groups.get(g);
    if (list) list.push(o);
    else groups.set(g, [o]);
  }
  const units: MeasureUnit[] = [];
  for (const group of groups.values()) {
    let cur: { owners: number[]; books: Set<number>; pairs: { a: number; b: number }[] } | null =
      null;
    for (const o of group) {
      const own = new Set([-o.owner, ...o.others]);
      if (own.size > maxBooks) {
        units.push({
          owners: [o.owner],
          books: [...own],
          pairs: o.others.map((b) => ({ a: -o.owner, b })),
        });
        continue;
      }
      let joined = cur ? cur.books.size : 0;
      if (cur) for (const k of own) if (!cur.books.has(k)) joined++;
      if (cur && joined > maxBooks) {
        units.push({ owners: cur.owners, books: [...cur.books], pairs: cur.pairs });
        cur = null;
      }
      cur ??= { owners: [], books: new Set(), pairs: [] };
      cur.owners.push(o.owner);
      for (const k of own) cur.books.add(k);
      for (const b of o.others) cur.pairs.push({ a: -o.owner, b });
    }
    if (cur) units.push({ owners: cur.owners, books: [...cur.books], pairs: cur.pairs });
  }
  return units;
}
