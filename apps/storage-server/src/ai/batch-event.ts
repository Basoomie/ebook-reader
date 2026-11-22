/**
 * The alert of a model whose batches the provider keeps refusing (batch-health.ts): sent once
 * while its batches are paused, "Resolved" in the digest once a batch is accepted again.
 * Registered with the notifications before their defaults are made.
 */
import { registerEvent } from '../notifications/events';

export const AI_BATCHES_EVENT = 'ai_batches_failing';

registerEvent({
  id: AI_BATCHES_EVENT,
  section: 'jobs',
  label: "An AI model's batches keep failing",
  kind: 'now',
});
