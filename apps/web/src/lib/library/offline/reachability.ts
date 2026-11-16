/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { send } from '$lib/library/api';

/**
 * Whether the library server can be reached, shared by the pages of the offline Library
 * (Library, details, Collections, Home), so each visit doesn't have to find out again.
 *
 * Away from home a request to the server's home address often gets no answer at all and
 * only ends at the request timeout, while `navigator.onLine` stays true. So:
 *
 * - once a page saw the server unreachable, the next pages start with this device's books
 *   at once (`knownUnreachable`) and ask the server again in the background;
 * - a page that doesn't know yet asks the server's health endpoint with the short "quick
 *   server check" time (`check`) beside its first request, and shows this device's books
 *   as soon as that check gets no answer.
 *
 * Kept in memory only: a reload starts over with the quick check.
 */
export class Reachability {
  private unreachableSince: number | null = null;
  private readonly checks = new Map<string, Promise<boolean>>();

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now
  ) {}

  /** The server didn't answer the last time anyone asked. */
  knownUnreachable(): boolean {
    return this.unreachableSince !== null;
  }

  markUnreachable(): void {
    this.unreachableSince ??= this.now();
  }

  markReachable(): void {
    this.unreachableSince = null;
  }

  /**
   * Asks `GET /api/v1/health` (no token) with `seconds` to answer. Resolves to true when
   * the server answered at all (any HTTP status: a server error is not "unreachable"),
   * false on no answer in time or a network error; never rejects. `seconds` <= 0 means
   * the quick check is off: resolves to true without asking. Callers asking the same
   * server at the same time share one request.
   */
  check(serverUrl: string, seconds: number): Promise<boolean> {
    if (!(seconds > 0)) return Promise.resolve(true);
    const running = this.checks.get(serverUrl);
    if (running) return running;
    const asked = send(
      this.fetchImpl,
      `${serverUrl}/api/v1/health`,
      { cache: 'no-store' },
      { timeoutSeconds: seconds }
    ).then(
      () => {
        this.markReachable();
        return true;
      },
      () => {
        this.markUnreachable();
        return false;
      }
    );
    const done = asked.finally(() => this.checks.delete(serverUrl));
    this.checks.set(serverUrl, done);
    return done;
  }
}

export type FirstAnswer<T> =
  | { status: 'ok'; value: T }
  /** No answer: the quick check got none in its time, or the request failed as unreachable. */
  | { status: 'unreachable' }
  | { status: 'error'; error: unknown };

/**
 * A page's first request with the quick check beside it. When the check gets no answer
 * the request is given up (`signal` aborts) instead of waiting for the request timeout.
 * The shared state follows the outcome. `unreachable(error)` tells a failed request that
 * means "no answer" (offline-source's isUnreachable). Never rejects.
 */
export async function firstServerAnswer<T>(
  reachability: Reachability,
  serverUrl: string,
  checkSeconds: number,
  request: (signal: AbortSignal) => Promise<T>,
  unreachable: (error: unknown) => boolean
): Promise<FirstAnswer<T>> {
  const controller = new AbortController();
  const answer: Promise<FirstAnswer<T>> = request(controller.signal).then(
    (value) => ({ status: 'ok', value }),
    (error: unknown) =>
      unreachable(error) ? { status: 'unreachable' } : { status: 'error', error }
  );
  const checked = reachability
    .check(serverUrl, checkSeconds)
    .then((ok): Promise<FirstAnswer<T>> | FirstAnswer<T> =>
      ok ? answer : { status: 'unreachable' }
    );
  const first = await Promise.race([answer, checked]);
  if (first.status === 'unreachable') {
    controller.abort();
    reachability.markUnreachable();
  } else if (first.status === 'ok') {
    reachability.markReachable();
  }
  return first;
}

/** The app's shared state (browser). */
export const serverReachability = new Reachability();
