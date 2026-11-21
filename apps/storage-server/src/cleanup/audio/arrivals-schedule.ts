/**
 * When stage 7's daily run starts (WP21f-1). Pure. Times are the server's own time zone (the
 * container's TZ, as the nightly snapshot and the notifications' default): the run starts once a
 * day at the set time or later that day, never inside the backup window (CA Appdata Backup stops
 * ttsu-storage at 00:00 NAS time), and a day it already started on is never repeated. Run now
 * starts at once (also inside the window: the user asked).
 */

export interface ClockNow {
  /** The local day, YYYY-MM-DD. */
  day: string;
  /** Minutes since local midnight. */
  minutes: number;
}

export function clockNow(now: number, timeZone?: string): ClockNow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

export function hhmm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

/** Inside [start, end) of the day; a window across midnight (23:30-00:30) wraps. */
export function inWindow(minutes: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export interface ScheduleSettings {
  arrivalsTime: string;
  arrivalsQuietStart: string;
  arrivalsQuietEnd: string;
}

/** Whether the scheduled run starts now. `lastDay`: the local day the last scheduled run began. */
export function scheduledRunDue(
  now: number,
  s: ScheduleSettings,
  lastDay: string | null,
  timeZone?: string,
): boolean {
  const c = clockNow(now, timeZone);
  if (lastDay === c.day) return false;
  if (inWindow(c.minutes, hhmm(s.arrivalsQuietStart), hhmm(s.arrivalsQuietEnd))) return false;
  return c.minutes >= hhmm(s.arrivalsTime);
}

/** The next time the scheduled run would start (ms), for the page. Searched minute by minute. */
export function nextScheduledRun(
  now: number,
  s: ScheduleSettings,
  lastDay: string | null,
  timeZone?: string,
): number {
  const start = Math.ceil(now / 60_000) * 60_000;
  let day = lastDay;
  for (let t = start; t < now + 3 * 86_400_000; t += 60_000) {
    if (scheduledRunDue(t, s, day, timeZone)) return t;
    const c = clockNow(t, timeZone);
    if (day !== null && day !== c.day) day = null;
  }
  return start;
}
