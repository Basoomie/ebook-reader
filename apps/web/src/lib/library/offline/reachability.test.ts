/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstServerAnswer, Reachability, serverWorthAskingNow } from './reachability';

afterEach(() => {
  vi.useRealTimers();
});

/** A fetch that never answers until its signal aborts (a request away from home). */
const hangingFetch = vi.fn(
  (_url: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError'))
      );
    })
);

describe('Reachability', () => {
  it('starts unknown and remembers marks', () => {
    const r = new Reachability(vi.fn());
    expect(r.knownUnreachable()).toBe(false);
    r.markUnreachable();
    expect(r.knownUnreachable()).toBe(true);
    r.markReachable();
    expect(r.knownUnreachable()).toBe(false);
  });

  it('asks the health endpoint without a token and counts any answer as reachable', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }));
    const r = new Reachability(fetchImpl);
    r.markUnreachable();
    await expect(r.check('http://nas:3081', 5)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://nas:3081/api/v1/health');
    expect(init.headers).toBeUndefined();
    expect(r.knownUnreachable()).toBe(false);
  });

  it('gives up after the quick check time and marks the server unreachable', async () => {
    vi.useFakeTimers();
    const r = new Reachability(hangingFetch);
    const result = r.check('http://nas:3081', 5);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(r.knownUnreachable()).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe(false);
    expect(r.knownUnreachable()).toBe(true);
  });

  it('counts a network error as unreachable', async () => {
    const r = new Reachability(vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(r.check('http://nas:3081', 5)).resolves.toBe(false);
    expect(r.knownUnreachable()).toBe(true);
  });

  it('shares one check in flight and asks again afterwards', async () => {
    let answer: (r: Response) => void = () => {};
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    const r = new Reachability(fetchImpl);
    const a = r.check('http://nas:3081', 5);
    const b = r.check('http://nas:3081', 5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    answer(new Response('{}'));
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
    void r.check('http://nas:3081', 5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not ask when the quick check is off', async () => {
    const fetchImpl = vi.fn();
    const r = new Reachability(fetchImpl);
    await expect(r.check('http://nas:3081', 0)).resolves.toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('firstServerAnswer', () => {
  const unreachable = (e: unknown) => e === 'no answer';

  it('gives the request up when the quick check gets no answer', async () => {
    vi.useFakeTimers();
    const r = new Reachability(hangingFetch);
    let aborted = false;
    const result = firstServerAnswer(
      r,
      'http://nas:3081',
      5,
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      unreachable
    );
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(result).resolves.toEqual({ status: 'unreachable' });
    expect(aborted).toBe(true);
    expect(r.knownUnreachable()).toBe(true);
  });

  it('waits for a slow answer once the server answered the check', async () => {
    vi.useFakeTimers();
    const r = new Reachability(vi.fn(async () => new Response('{}')));
    r.markUnreachable();
    const result = firstServerAnswer(
      r,
      'http://nas:3081',
      5,
      () => new Promise<string>((resolve) => setTimeout(() => resolve('books'), 30_000)),
      unreachable
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(result).resolves.toEqual({ status: 'ok', value: 'books' });
    expect(r.knownUnreachable()).toBe(false);
  });

  it('tells "no answer" from other failures', async () => {
    const r = new Reachability(vi.fn(async () => new Response('{}')));
    await expect(
      firstServerAnswer(r, 'u', 5, () => Promise.reject('no answer'), unreachable)
    ).resolves.toEqual({ status: 'unreachable' });
    expect(r.knownUnreachable()).toBe(true);
    const failed = await firstServerAnswer(r, 'u', 5, () => Promise.reject('500'), unreachable);
    expect(failed).toEqual({ status: 'error', error: '500' });
  });
});

describe('serverWorthAskingNow (Enrich)', () => {
  it('does not ask with no network', async () => {
    const fetchImpl = vi.fn();
    const r = new Reachability(fetchImpl);
    await expect(serverWorthAskingNow(r, 'http://nas:3081', 5, false)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers at once when the server is known not to answer, and asks again behind it', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const r = new Reachability(fetchImpl);
    r.markUnreachable();
    await expect(serverWorthAskingNow(r, 'http://nas:3081', 5, true)).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(r.knownUnreachable()).toBe(false));
    // The next tap asks.
    await expect(serverWorthAskingNow(r, 'http://nas:3081', 5, true)).resolves.toBe(true);
  });

  it('waits at most the quick check away from home', async () => {
    vi.useFakeTimers();
    const r = new Reachability(hangingFetch);
    const asked = serverWorthAskingNow(r, 'http://nas:3081', 5, true);
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(asked).resolves.toBe(false);
    expect(r.knownUnreachable()).toBe(true);
  });

  it('asks when the server answers, and without a check when it is off', async () => {
    const r = new Reachability(vi.fn(async () => new Response('{}')));
    await expect(serverWorthAskingNow(r, 'http://nas:3081', 5, true)).resolves.toBe(true);
    const off = vi.fn();
    await expect(serverWorthAskingNow(new Reachability(off), 'u', 0, true)).resolves.toBe(true);
    expect(off).not.toHaveBeenCalled();
  });
});
