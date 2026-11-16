import { describe, expect, it } from 'vitest';
import { TextPipe } from '../src/cleanup/stage3';

/** A run whose books finish when the test says so. */
function controlled() {
  const open = new Map<number, (v: string | null) => void>();
  const fail = new Map<number, (e: unknown) => void>();
  const started: number[] = [];
  const run = (id: number) =>
    new Promise<string | null>((resolve, reject) => {
      started.push(id);
      open.set(id, resolve);
      fail.set(id, reject);
    });
  const finish = async (id: number, v: string | null = `book ${id}`) => {
    open.get(id)!(v);
    await new Promise((r) => setImmediate(r));
  };
  const throwIn = async (id: number) => {
    fail.get(id)!(new Error(`book ${id} broke`));
    await new Promise((r) => setImmediate(r));
  };
  return { run, finish, throwIn, started };
}

describe('stage 3 text pipeline', () => {
  it('keeps the limit in flight and starts the next book as soon as one finishes', async () => {
    const c = controlled();
    const pipe = new TextPipe<string>('a', 6, [1, 2, 3, 4, 5, 6]);
    pipe.run = c.run;
    pipe.limit = 2;
    pipe.fill();
    expect(c.started).toEqual([1, 2]);
    await c.finish(2);
    pipe.fill();
    // Book 2 finished first: book 3 starts at once, without waiting for book 1.
    expect(c.started).toEqual([1, 2, 3]);
    expect(pipe.inFlight).toBe(2);
  });

  it('gives results in cursor order, holding later books until the earlier ones are done', async () => {
    const c = controlled();
    const pipe = new TextPipe<string>('a', 4, [10, 11, 12, 13]);
    pipe.run = c.run;
    pipe.limit = 4;
    pipe.fill();
    await c.finish(12);
    await c.finish(11);
    expect(pipe.ready()).toBe(0);
    expect(pipe.take()).toEqual([]);
    await c.finish(10);
    expect(pipe.ready()).toBe(3);
    expect(pipe.take()).toEqual(['book 10', 'book 11', 'book 12']);
    expect(pipe.finished()).toBe(false);
    await c.finish(13);
    expect(pipe.take()).toEqual(['book 13']);
    expect(pipe.finished()).toBe(true);
  });

  it('a stopped book stops the pipeline there: nothing after it is given or started', async () => {
    const c = controlled();
    const pipe = new TextPipe<string>('a', 5, [1, 2, 3, 4, 5]);
    pipe.run = c.run;
    pipe.limit = 3;
    pipe.fill();
    await c.finish(1);
    await c.finish(2, null);
    await c.finish(3);
    expect(pipe.ready()).toBe(1);
    expect(pipe.take()).toEqual(['book 1']);
    expect(pipe.stopped).toBe(true);
    pipe.fill();
    expect(c.started).toEqual([1, 2, 3]);
    expect(pipe.finished()).toBe(false);
  });

  it('a book whose read throws fails the step when it is reached in cursor order', async () => {
    const c = controlled();
    const pipe = new TextPipe<string>('a', 2, [1, 2]);
    pipe.run = c.run;
    pipe.limit = 2;
    pipe.fill();
    await c.throwIn(2);
    expect(pipe.take()).toEqual([]);
    await c.finish(1);
    expect(() => pipe.take()).toThrow('book 2 broke');
  });

  it('wait() returns when a book finishes, or after the time given', async () => {
    const c = controlled();
    const pipe = new TextPipe<string>('a', 1, [1]);
    pipe.run = c.run;
    pipe.limit = 1;
    pipe.fill();
    const t0 = Date.now();
    await pipe.wait(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    const waiting = pipe.wait(10_000);
    await c.finish(1);
    await waiting;
    expect(pipe.take()).toEqual(['book 1']);
  });
});
