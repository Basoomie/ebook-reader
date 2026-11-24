/**
 * The alert of a book whose summary could not be made by any setup of the route (book
 * summaries session 3; book-summaries.md "Summaries on the server": the note on the book page
 * and one alert). Registered with the notifications before their defaults are made.
 */
import { registerEvent } from '../notifications/events';

export const SUMMARY_FAILED_EVENT = 'summary_failed';

registerEvent({
  id: SUMMARY_FAILED_EVENT,
  section: 'jobs',
  label: 'A book summary failed on every model',
  kind: 'now',
});
