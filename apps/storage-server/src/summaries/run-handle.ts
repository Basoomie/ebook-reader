/**
 * One running set of questions of the summaries feature (a summary job's setup, a translation,
 * a series recap's setup): the service's pump steps every open handle's questions, wakes those
 * waiting for an answer, and abandons one that can't send for too long.
 */
import type { AiWait } from '../ai/waits';

export class RunHandle {
  stopped = false;
  abandoned = false;
  waitSince: number | null = null;
  /** Since when it has been waiting for anything (the book page's "waiting 4 min"). */
  waitFrom: number | null = null;
  wait: AiWait | null = null;
  private wakers: (() => void)[] = [];
  constructor(readonly runId: string) {}
  get isStopped(): boolean {
    return this.stopped;
  }
  tick(): Promise<void> {
    return new Promise((r) => this.wakers.push(r));
  }
  wake(): void {
    const w = this.wakers;
    this.wakers = [];
    for (const f of w) f();
  }
}
