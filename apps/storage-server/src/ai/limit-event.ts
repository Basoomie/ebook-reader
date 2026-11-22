/**
 * The alert of a feature waiting for room under the monthly AI spending limit (a feature whose
 * spec says `onLimit: 'queue'`; the cleanup's stages pause and send their own stage alerts
 * instead). Registered with the notifications before their defaults are made.
 */
import { registerEvent } from '../notifications/events';

export const AI_LIMIT_EVENT = 'ai_limit_waiting';

registerEvent({
  id: AI_LIMIT_EVENT,
  section: 'jobs',
  label: 'AI work waits for the monthly spending limit',
  kind: 'now',
});
