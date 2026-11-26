/**
 * The series-arrival alert (2026-11-25, docs/design/series-arrivals.md): a new volume of a
 * series you're reading arrived in the library. Off until switched on in Settings ›
 * Notifications (its only settings: the switches and the wait time).
 */
import { registerEvent } from '../notifications/events';

export const SERIES_ARRIVAL_EVENT = 'series_arrival';

registerEvent({
  id: SERIES_ARRIVAL_EVENT,
  section: 'data',
  label: 'A new volume of a series you’re reading arrived in the library',
  kind: 'now',
  defaultOff: true,
});
