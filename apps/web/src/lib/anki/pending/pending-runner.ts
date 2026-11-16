/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { AnkiConnectError, type AnkiConnect } from '../anki-connect';
import { arrayBufferToBase64 } from '../base64';
import { decideClip, workOrder, type PendingClip } from './pending-clip';
import type { PendingStore } from './pending-db';

/**
 * One pass over this device's waiting clips, oldest first (Season 2 §3):
 * - 'waiting': the clip is made (`resolve`). It stays waiting when its source can't be
 *   asked now, and fails with the reason when it can't be made at all.
 * - 'ready': the field's mode is applied to the card as it is now, the clip is stored and
 *   written, and the record goes. Anki not answering keeps it ready (the clip isn't made
 *   again).
 * Nothing here ever drops a clip without a reason the user sees in Settings > Anki.
 */

/** The clip's source can't be asked now; it is tried again later. */
export class RetryLater extends Error {
  constructor(
    message: string,
    /** The source is down: the other clips waiting for it aren't tried in this pass. */
    readonly sourceDown = false,
    /** What it waits for (the status line in Settings > Anki), e.g. "Waiting for the PC". */
    readonly waitingFor?: string
  ) {
    super(message);
  }
}

export type MadeClip = { fileName: string; data: ArrayBuffer } | { skip: string };

export interface PendingRunnerDeps {
  store: Pick<PendingStore, 'all' | 'get' | 'update' | 'delete' | 'claim' | 'release'>;
  /** Makes the clip, or says why it can't be made; RetryLater (or any error) waits. */
  resolve: (clip: PendingClip) => Promise<MadeClip>;
  anki: () => AnkiConnect;
  /** This tab (claims). */
  tabId: string;
  now?: () => number;
  /** How long a claim holds (a tab that stopped mid-way frees it after this). */
  claimMs?: number;
  /**
   * The clip's bytes are kept on this device now (its source may let go of it; Season 2
   * Phase 12: the server deletes a PC clip). Errors are ignored.
   */
  onReady?: (clip: PendingClip) => Promise<void>;
}

export interface RunReport {
  added: number;
  failed: number;
  waiting: number;
}

export const CARD_DELETED = 'the card was deleted';

function messageOf(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

/** Anki didn't answer at all (closed, AnkiConnect off, refused): the next clips wait too. */
function ankiDown(error: unknown): boolean {
  return error instanceof AnkiConnectError && error.kind !== 'anki';
}

export async function runPendingOnce(deps: PendingRunnerDeps): Promise<RunReport> {
  const now = deps.now ?? Date.now;
  const claimMs = deps.claimMs ?? 120_000;
  const { store } = deps;
  const report: RunReport = { added: 0, failed: 0, waiting: 0 };
  let sourceDown = false;
  let ankiOff = false;
  let anki: AnkiConnect | null = null;

  const fail = async (id: string, reason: string) => {
    await store.update(id, (r) => ({
      ...r,
      state: 'failed',
      failedReason: reason,
      problem: undefined,
      lastTriedAt: now()
    }));
    report.failed += 1;
  };

  const stillWaiting = async (id: string, problem: string, waitingFor?: string) => {
    await store.update(id, (r) => ({ ...r, problem, waitingFor, lastTriedAt: now() }));
    report.waiting += 1;
  };

  for (const listed of workOrder(await store.all())) {
    if ((listed.state === 'waiting' && sourceDown) || (listed.state === 'ready' && ankiOff)) {
      report.waiting += 1;
      continue;
    }

    if (!(await store.claim(listed.id, deps.tabId, now(), now() + claimMs))) {
      continue;
    }

    try {
      let clip = await store.get(listed.id);

      if (!clip || clip.state === 'failed') continue;

      if (clip.state === 'waiting') {
        let made: MadeClip;

        try {
          made = await deps.resolve(clip);
        } catch (error) {
          if (error instanceof RetryLater && error.sourceDown) sourceDown = true;
          await stillWaiting(
            clip.id,
            messageOf(error),
            error instanceof RetryLater ? error.waitingFor : undefined
          );
          continue;
        }

        if ('skip' in made) {
          await fail(clip.id, made.skip);
          continue;
        }

        clip = await store.update(clip.id, (r) => ({
          ...r,
          state: 'ready',
          clip: { fileName: made.fileName, data: (made as { data: ArrayBuffer }).data },
          problem: undefined,
          waitingFor: undefined,
          lastTriedAt: now()
        }));

        if (!clip) continue; // cancelled meanwhile
        await deps.onReady?.(clip).catch(() => undefined);
      }

      if (ankiOff) {
        report.waiting += 1;
        continue;
      }

      const ready = clip as PendingClip & { clip: NonNullable<PendingClip['clip']> };

      try {
        anki ??= deps.anki();
        const note = await anki.noteInfo(ready.noteId);

        if (!note) {
          await fail(ready.id, CARD_DELETED);
          continue;
        }

        const fieldNow = note.fields[ready.field]?.value;

        if (fieldNow === undefined) {
          await fail(ready.id, `the note type has no field "${ready.field}"`);
          continue;
        }

        const decision = decideClip(ready, fieldNow, ready.clip.fileName);

        if (decision.kind === 'fail') {
          await fail(ready.id, decision.reason);
          continue;
        }

        if (decision.kind === 'write') {
          // Cancelled while Anki was asked: leave the card alone.
          if (!(await store.get(ready.id))) continue;

          const stored = await anki.storeMedia(
            ready.clip.fileName,
            arrayBufferToBase64(ready.clip.data)
          );
          // Anki's editor keeps the note it shows and saves it back (as Enrich does).
          const selection = await anki.releaseNote(ready.noteId);

          try {
            await anki.updateFields(ready.noteId, { [ready.field]: decision.value(stored) });
          } finally {
            await anki.restoreSelection(selection);
          }
        }

        await store.delete(ready.id);
        report.added += 1;
      } catch (error) {
        if (ankiDown(error)) ankiOff = true;
        await stillWaiting(ready.id, messageOf(error));
      }
    } finally {
      await store.release(listed.id, deps.tabId).catch(() => undefined);
    }
  }

  return report;
}
