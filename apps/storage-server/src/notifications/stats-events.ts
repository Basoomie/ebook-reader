/**
 * N2's events: the daily, weekly and monthly stats messages in the Stats section. Imported
 * by settings.ts so the defaults and the Settings tab always include them.
 */
import { registerEvent } from './events';

export type ReportKind = 'day' | 'week' | 'month';
export const REPORT_KINDS: ReportKind[] = ['day', 'week', 'month'];

export const STATS_EVENT: Record<ReportKind, string> = {
  day: 'stats_daily',
  week: 'stats_weekly',
  month: 'stats_monthly',
};

registerEvent({ id: STATS_EVENT.day, section: 'stats', label: 'Daily stats', kind: 'report' });
registerEvent({ id: STATS_EVENT.week, section: 'stats', label: 'Weekly stats', kind: 'report' });
registerEvent({ id: STATS_EVENT.month, section: 'stats', label: 'Monthly stats', kind: 'report' });
