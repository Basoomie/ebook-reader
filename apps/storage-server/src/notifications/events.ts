/**
 * What can be notified (notifications-design.md, "Events"). Settings > Notifications lists
 * these from the server, so a later session adds an event here (registerEvent) and the tab
 * shows it without a web change: the Calibre and audiobook daily summaries, and N2's Stats.
 */

export type SectionId = 'jobs' | 'cleanup' | 'data' | 'stats';
/**
 * now: an alert; digest: a line in the daily digest; finished: the user's Now/Digest/Off;
 * report: a stats message (N2) when a day, week or month ends.
 */
export type EventKind = 'now' | 'digest' | 'finished' | 'report';

export interface EventDef {
  id: string;
  section: SectionId;
  label: string;
  kind: EventKind;
}

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'jobs', label: 'Jobs (PC and NAS)' },
  { id: 'cleanup', label: 'Library cleanup' },
  { id: 'data', label: 'Library and data' },
  // N2: its events are added by stats-report.ts (registerEvent). Off by default.
  { id: 'stats', label: 'Stats' },
];

const EVENTS: EventDef[] = [
  { id: 'job_failed', section: 'jobs', label: 'A PC job failed', kind: 'now' },
  { id: 'pc_problem', section: 'jobs', label: 'The PC reports a Docker problem', kind: 'now' },
  {
    id: 'pc_waiting',
    section: 'jobs',
    label: 'Jobs waiting while the PC is off or paused',
    kind: 'now',
  },
  { id: 'merge_failed', section: 'jobs', label: 'An audiobook merge failed', kind: 'now' },
  { id: 'jobs_finished', section: 'jobs', label: 'Finished jobs', kind: 'finished' },
  { id: 'stage_paused', section: 'cleanup', label: 'A Calibre cleanup stage paused', kind: 'now' },
  {
    id: 'audio_stage_paused',
    section: 'cleanup',
    label: 'An audiobook cleanup stage paused',
    kind: 'now',
  },
  { id: 'apply_offline', section: 'cleanup', label: 'The apply helper is offline', kind: 'now' },
  {
    id: 'fetch_offline',
    section: 'cleanup',
    label: 'The fetch helper is offline or has a problem while stage 4 has work',
    kind: 'now',
  },
  {
    id: 'field_pauses',
    section: 'cleanup',
    label: 'A field paused or resumed by the accuracy checks',
    kind: 'digest',
  },
  // WP21f-1: the audiobook cleanup's daily new arrivals (stage 7).
  {
    id: 'audio_arrivals_review',
    section: 'cleanup',
    label: 'New audiobooks need a look (once per daily run with new review items)',
    kind: 'now',
  },
  {
    id: 'audio_arrivals_summary',
    section: 'cleanup',
    label: 'Audiobook daily summary (books added, duplicates, waiting, review)',
    kind: 'digest',
  },
  {
    id: 'index_refused',
    section: 'data',
    label: 'The Calibre index refused an update (many books gone)',
    kind: 'now',
  },
  {
    id: 'snapshot_failed',
    section: 'data',
    label: 'The nightly database copy failed',
    kind: 'now',
  },
  {
    id: 'sync_refused',
    section: 'data',
    label: "A device's change refused by the server",
    kind: 'now',
  },
];

export function listEvents(): EventDef[] {
  return EVENTS.slice();
}

export function getEvent(id: string): EventDef | undefined {
  return EVENTS.find((e) => e.id === id);
}

/** Adds an event (later sessions: the daily summaries, Stats). A known id is left as it is. */
export function registerEvent(def: EventDef): void {
  if (!getEvent(def.id)) EVENTS.push({ ...def });
}
