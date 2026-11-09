/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BooksDbReadingGoal } from '$lib/data/database/books-db/versions/books-db';
import type { LocalRecord } from '$lib/sync/sync-db';
import type { SyncEngine } from '$lib/sync/sync-engine';

/**
 * Reading goals over the record sync (WP5). One `reading-goal` record per
 * goal (id = its start date). The old sync never carried goals here (no goal
 * file exists on the NAS), so the desktop, the source device for global
 * settings, publishes its goals first. Until the old sync is switched off only
 * the source device publishes goal edits; afterwards every device does, since
 * all of them then hold the same goals.
 */

export const READING_GOAL_KIND = 'reading-goal';

export function goalData(goal: BooksDbReadingGoal): Record<string, unknown> {
  return {
    timeGoal: Number(goal.timeGoal) || 0,
    characterGoal: Number(goal.characterGoal) || 0,
    goalFrequency: goal.goalFrequency,
    goalStartDate: goal.goalStartDate,
    goalEndDate: goal.goalEndDate || '',
    goalOriginalEndDate: goal.goalOriginalEndDate || '',
    lastGoalModified: Number(goal.lastGoalModified) || 0
  };
}

export function goalFromRecord(record: LocalRecord): BooksDbReadingGoal {
  const d = record.data;
  return {
    timeGoal: Number(d.timeGoal) || 0,
    characterGoal: Number(d.characterGoal) || 0,
    goalFrequency: d.goalFrequency as BooksDbReadingGoal['goalFrequency'],
    goalStartDate: String(d.goalStartDate),
    goalEndDate: typeof d.goalEndDate === 'string' ? d.goalEndDate : '',
    goalOriginalEndDate: typeof d.goalOriginalEndDate === 'string' ? d.goalOriginalEndDate : '',
    lastGoalModified: Number(d.lastGoalModified) || 0
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Makes the `reading-goal` records equal this device's goals: changed goals
 * are written, goals that no longer exist here are deleted. Returns how many
 * records were queued; never throws.
 */
export async function publishReadingGoals(
  engine: SyncEngine,
  goals: BooksDbReadingGoal[],
  warn: (message: string) => void
): Promise<number> {
  try {
    let queued = 0;
    const local = new Set<string>();
    for (const goal of goals) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(goal.goalStartDate)) continue;
      local.add(goal.goalStartDate);
      const data = goalData(goal);
      const existing = await engine.get(READING_GOAL_KIND, goal.goalStartDate);
      if (existing && existing.deletedAt === null && sameJson(existing.data, data)) continue;
      if (await engine.put(READING_GOAL_KIND, goal.goalStartDate, data)) queued += 1;
    }
    for (const r of await engine.getAll(READING_GOAL_KIND)) {
      if (
        r.deletedAt === null &&
        !local.has(r.id) &&
        (await engine.remove(READING_GOAL_KIND, r.id))
      ) {
        queued += 1;
      }
    }
    return queued;
  } catch (error) {
    warn(`Sync: could not record reading goals: ${(error as Error)?.message ?? error}`);
    return 0;
  }
}

/** The live goals in the mirror, oldest start first. */
export async function mirroredReadingGoals(engine: SyncEngine): Promise<BooksDbReadingGoal[]> {
  return (await engine.getAll(READING_GOAL_KIND))
    .filter((r) => r.deletedAt === null)
    .map(goalFromRecord)
    .sort((a, b) => (a.goalStartDate < b.goalStartDate ? -1 : 1));
}
