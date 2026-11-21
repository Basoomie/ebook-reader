/**
 * WP21f-1: whether the library has been switched to the built one (WP21e-2). Once it has,
 * stage 6 is frozen (its plan, manifest and move list are history; a new analysis of stages
 * 1-5 never plans again or pauses it) and new books are added by stage 7. Its own module, so
 * stage 6, stage 7 and stage 3 can ask without importing the switch.
 */
import type Database from 'better-sqlite3';

export function librarySwitched(db: Database.Database): boolean {
  const row = db.prepare('SELECT state FROM audio_switch WHERE id = 1').get() as
    | { state: string }
    | undefined;
  return row?.state === 'switched' || row?.state === 'deleted';
}
