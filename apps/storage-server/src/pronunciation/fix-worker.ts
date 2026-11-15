/**
 * The pronunciation fix worker thread (Season 2 Phase 12): applies the fixes to a book's
 * sentences, so a regex pattern that never finishes can be stopped by terminating the
 * thread (fix-runner.ts) while the server keeps answering. Before each entry runs it reports
 * the entry's id, so the runner can name the one that was running when time ran out.
 */
import { parentPort } from 'worker_threads';
import { applyFixes, type FixEntry, type FixSentence } from './fix-rules';

interface Job {
  id: number;
  entries: FixEntry[];
  sentences: FixSentence[];
}

parentPort!.on('message', (job: Job) => {
  try {
    const results = applyFixes(job.sentences, job.entries, (entryId) =>
      parentPort!.postMessage({ id: job.id, entryId }),
    );
    parentPort!.postMessage({ id: job.id, results });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: (err as Error).message });
  }
});

parentPort!.postMessage({ ready: true });
