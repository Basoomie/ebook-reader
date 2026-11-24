/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The Relationships diagram (session 4, book-summaries.md "UI"): the people as name pills, a
 * line per relationship with its label on it (the item's own one or two words, else its
 * number), laid out in a fixed box the page scales to its width, so the whole diagram is on
 * screen without scrolling. The most connected person sits in the middle when they are tied
 * to many; everyone else goes round an ellipse in the order that keeps partners close.
 */

export interface DiagramRelationship {
  ref: string;
  between: [string, string];
  label?: string;
}

export interface DiagramNode {
  name: string;
  /** Percent of the box's width and height. */
  x: number;
  y: number;
}

export interface DiagramEdge {
  ref: string;
  /** The text on the line: the label, else the relationship's number. */
  label: string;
  numbered: boolean;
  from: number;
  to: number;
  /** The label's place, percent of the box. */
  lx: number;
  ly: number;
}

export interface Diagram {
  /** The box's shape (width / height); the page keeps it and scales it to its width. */
  aspect: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

const W = 600;

export function layoutDiagram(rels: DiagramRelationship[], narrow = false): Diagram {
  const names: string[] = [];
  const index = (n: string) => {
    let i = names.indexOf(n);
    if (i < 0) i = names.push(n) - 1;
    return i;
  };
  const pairs = rels.map((r) => [index(r.between[0]), index(r.between[1])] as const);
  const n = names.length;
  // Taller on a phone so names around the ring have room side by side.
  const H = narrow ? 560 : 420;
  const degree = names.map((_, i) => pairs.filter(([a, b]) => a === i || b === i).length);
  const pos: { x: number; y: number }[] = new Array(n);
  const hub = degree.indexOf(Math.max(...degree, 0));
  const useHub = n >= 4 && degree[hub] >= Math.max(3, Math.ceil(n / 3));
  const ring = names.map((_, i) => i).filter((i) => !(useHub && i === hub));
  // Order the ring so partners sit next to each other: walk from the best-connected, each time
  // to the not yet placed person who shares most relationships with the last one placed.
  const order: number[] = [];
  const left = new Set(ring);
  const shared = (a: number, b: number) =>
    pairs.filter(([x, y]) => (x === a && y === b) || (x === b && y === a)).length;
  while (left.size) {
    const last = order[order.length - 1];
    let best = -1;
    let score = -1;
    for (const i of left) {
      const s = last === undefined ? degree[i] : shared(last, i) * 100 + degree[i];
      if (s > score) {
        score = s;
        best = i;
      }
    }
    order.push(best);
    left.delete(best);
  }
  const cx = W / 2;
  const cy = H / 2;
  const rx = W * 0.38;
  const ry = H * 0.38;
  if (n === 2 && !useHub) {
    pos[0] = { x: W * 0.22, y: cy };
    pos[1] = { x: W * 0.78, y: cy };
  } else {
    order.forEach((i, k) => {
      // Start at the top, go round clockwise.
      const a = -Math.PI / 2 + (2 * Math.PI * k) / order.length;
      pos[i] = { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
    });
    if (useHub) pos[hub] = { x: cx, y: cy };
  }
  // Labels at the middle of their line, moved apart from each other and off the names.
  const placed: { x: number; y: number }[] = [];
  const edges: DiagramEdge[] = rels.map((r, k) => {
    const [a, b] = pairs[k];
    const p = pos[a];
    const q = pos[b];
    let t = 0.5;
    const at = (tt: number) => ({ x: p.x + (q.x - p.x) * tt, y: p.y + (q.y - p.y) * tt });
    let l = at(t);
    const near = (
      u: { x: number; y: number },
      v: { x: number; y: number },
      dx: number,
      dy: number
    ) => Math.abs(u.x - v.x) < dx && Math.abs(u.y - v.y) < dy;
    for (const tt of [0.5, 0.38, 0.62, 0.3, 0.7]) {
      const c = at(tt);
      const clash = placed.some((o) => near(o, c, 70, 26)) || pos.some((o) => near(o, c, 60, 24));
      t = tt;
      l = c;
      if (!clash) break;
    }
    placed.push(l);
    void t;
    const own = r.label?.trim();
    return {
      ref: r.ref,
      label: own || String(k + 1),
      numbered: !own,
      from: a,
      to: b,
      lx: (l.x / W) * 100,
      ly: (l.y / H) * 100
    };
  });
  return {
    aspect: W / H,
    nodes: names.map((name, i) => ({ name, x: (pos[i].x / W) * 100, y: (pos[i].y / H) * 100 })),
    edges
  };
}
