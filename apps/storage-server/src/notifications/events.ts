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
  // Series-order follow-up: every value written as a best guess is counted in the digest.
  {
    id: 'cleanup_best_guesses',
    section: 'cleanup',
    label: 'Values written to Calibre as best guesses (listed under Best guesses)',
    kind: 'digest',
  },
  // A fetch site paused after refusals in a row (WP20 lessons 4: every pause tells someone).
  {
    id: 'fetch_site_paused',
    section: 'cleanup',
    label: 'A site the cleanup fetches from paused after refusals',
    kind: 'now',
  },
  // More Bookmeter coverage (step 2): its spot check before On, and a line per finished step.
  {
    id: 'bookmeter_spot_ready',
    section: 'cleanup',
    label: 'More Bookmeter matches: the spot check is ready for you',
    kind: 'now',
  },
  {
    id: 'bookmeter_summary',
    section: 'cleanup',
    label: 'More Bookmeter matches: each finished step',
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
  // WP21g: audiobook stage 8, the pairs with the Calibre ebooks (in stage 7's daily run).
  {
    id: 'audio_ebooks_review',
    section: 'cleanup',
    label: 'Audiobooks whose Calibre ebook needs a look (once per daily run with new review items)',
    kind: 'now',
  },
  {
    id: 'audio_ebooks_summary',
    section: 'cleanup',
    label: 'Audiobooks and their Calibre ebooks in the daily summary (paired, to review, changes)',
    kind: 'digest',
  },
  // WP20g: the Calibre library's new arrivals (books added by hand and the import).
  {
    id: 'calibre_arrivals_review',
    section: 'cleanup',
    label: 'New books need a look (once per run with new review items)',
    kind: 'now',
  },
  {
    id: 'calibre_arrivals_summary',
    section: 'cleanup',
    label: 'New books daily summary (added, copies found, not imported, AI cost)',
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
