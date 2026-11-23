/**
 * Stage 3 (WP20c) reader process: forked by Stage3Worker (book-text-worker.ts) with the counter bundle as its
 * argument. It runs stage3-work's requests (the reader's own import through
 * bookTextForServer, and the text arithmetic) so jsdom, its CPU time, the index's memory and
 * any crash stay away from the server. One request at a time.
 */
import {
  describe,
  doWork,
  type BookTextModule,
  type CompareResult,
  type IndexResult,
  type LibIndexResult,
  type Stage3Request,
  type TextMeasureResult,
  type TextResult,
} from '../cleanup/stage3-work';

export type {
  CompareRequest,
  CompareResult,
  ComparedPair,
  ExtraSummary,
  IndexRequest,
  IndexResult,
  LibIndexRequest,
  LibIndexResult,
  Stage3Request,
  TextMeasureRequest,
  TextMeasureResult,
  TextRequest,
  TextResult,
} from '../cleanup/stage3-work';

export type Stage3ChildMessage =
  | { type: 'ready' }
  | { type: 'fatal'; message: string }
  | {
      type: 'result';
      id: number;
      ok: true;
      data: TextResult | CompareResult | IndexResult | LibIndexResult | TextMeasureResult;
    }
  | { type: 'result'; id: number; ok: false; code: string; message: string };

function send(message: Stage3ChildMessage): void {
  process.send?.(message);
}

// Only when forked (a test may import the types).
if (require.main === module) {
  process.on('disconnect', () => process.exit(0));
  let reader: BookTextModule | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    reader = require(process.argv[2]) as BookTextModule;
    if (typeof reader.bookTextForServer !== 'function') {
      throw new Error(
        'the counter bundle has no bookTextForServer (rebuild vendor/epub-count.cjs)',
      );
    }
  } catch (err) {
    send({ type: 'fatal', message: `the reader code could not be loaded: ${describe(err)}` });
    process.exit(1);
  }
  process.on('message', (req: Stage3Request) => {
    void doWork(reader!, req).then((r) => send({ type: 'result', id: req.id, ...r }));
  });
  send({ type: 'ready' });
}
