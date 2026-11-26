/**
 * Bookmeter sync's notification (2026-11-25, docs/design/bookmeter-sync.md): a book on your
 * 読みたい本 that arrived in the library, told once per book. Registered with the
 * notifications before their defaults are made.
 */
import { registerEvent } from '../notifications/events';

export const BOOKMETER_ARRIVED_EVENT = 'bookmeter_wanted_arrived';

registerEvent({
  id: BOOKMETER_ARRIVED_EVENT,
  section: 'data',
  label: 'A book on your 読みたい本 arrived in the library',
  kind: 'now',
});
