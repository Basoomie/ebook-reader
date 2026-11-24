/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { SummaryRouteSetup } from './summary-api';

/**
 * Settings › Library › Summaries: the fallback order of setups (session 4). Each setup has one
 * or two models that read the book and one that writes; the first that works makes the summary.
 * Pure edits; the server checks the same rules (summaries/settings.ts) when it is saved.
 */

export const MAX_SETUPS = 6;

function moveIndex<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

export function moveSetup(
  route: SummaryRouteSetup[],
  i: number,
  delta: number
): SummaryRouteSetup[] {
  return moveIndex(route, i, i + delta);
}

export function removeSetup(route: SummaryRouteSetup[], i: number): SummaryRouteSetup[] {
  if (route.length <= 1) return route;
  return route.filter((_, k) => k !== i);
}

/** A new setup at the end: a copy of the last one (the user changes its models). */
export function addSetup(route: SummaryRouteSetup[], fallback: string): SummaryRouteSetup[] {
  if (route.length >= MAX_SETUPS) return route;
  const last = route[route.length - 1];
  return [
    ...route,
    last
      ? { finders: [...last.finders], writer: last.writer }
      : { finders: [fallback], writer: fallback }
  ];
}

/** Sets a reader: slot 0 always has a model; slot 1 may be none (one model reads). */
export function setFinder(
  route: SummaryRouteSetup[],
  i: number,
  slot: 0 | 1,
  model: string | null
): SummaryRouteSetup[] {
  return route.map((r, k) => {
    if (k !== i) return r;
    const finders = [...r.finders];
    if (slot === 0) {
      if (!model) return r;
      finders[0] = model;
    } else if (model) finders[1] = model;
    else finders.splice(1);
    return { ...r, finders: [...new Set(finders)] };
  });
}

export function setWriter(
  route: SummaryRouteSetup[],
  i: number,
  model: string
): SummaryRouteSetup[] {
  return route.map((r, k) => (k === i ? { ...r, writer: model } : r));
}

/** What is wrong with a route, in the settings' words, or null. */
export function routeProblem(route: SummaryRouteSetup[], models: string[]): string | null {
  if (!route.length) return 'Add at least one setup.';
  if (route.length > MAX_SETUPS) return `At most ${MAX_SETUPS} setups.`;
  for (const [k, r] of route.entries()) {
    const n = `Setup ${k + 1}`;
    if (!r.finders.length || r.finders.length > 2) return `${n}: one or two models read the book.`;
    if (new Set(r.finders).size !== r.finders.length)
      return `${n}: two different models read the book.`;
    for (const m of [...r.finders, r.writer])
      if (!models.includes(m)) return `${n}: ${m} is not in Settings › AI's list.`;
  }
  return null;
}
