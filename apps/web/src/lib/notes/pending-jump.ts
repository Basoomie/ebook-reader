/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP11c: "Open in book" from the Notes page or the Library leaves one pending jump; the
 * reader takes it once the book is on the page and jumps there without saving the place
 * (the return marker leads back). Kept in memory and in sessionStorage (so a full page
 * load on the way still finds it); the next reader open always takes it, and only uses it
 * when it is for that book.
 */
export interface PendingJump {
  /** Catalog book id. */
  bookId: string;
  highlightId: string | null;
  /** The stored position, used when the highlight can't be placed on this device. */
  position: number;
}

const KEY = 'ttu-pending-jump';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

let memory: PendingJump | null = null;

function session(): StorageLike | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

function isPendingJump(value: unknown): value is PendingJump {
  const v = value as PendingJump;
  return (
    !!v &&
    typeof v.bookId === 'string' &&
    (v.highlightId === null || typeof v.highlightId === 'string') &&
    typeof v.position === 'number' &&
    Number.isFinite(v.position)
  );
}

export function setPendingJump(jump: PendingJump, storage: StorageLike | undefined = session()) {
  memory = { ...jump };

  try {
    storage?.setItem(KEY, JSON.stringify(memory));
  } catch {
    // Memory is enough within the app.
  }
}

export function clearPendingJump(storage: StorageLike | undefined = session()) {
  memory = null;

  try {
    storage?.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}

/** Takes the pending jump (always clearing it) and returns it if it is for this book. */
export function takePendingJump(
  bookId: string | null,
  storage: StorageLike | undefined = session()
): PendingJump | undefined {
  let jump: unknown = memory;

  if (!jump) {
    try {
      const raw = storage?.getItem(KEY);
      jump = raw ? JSON.parse(raw) : null;
    } catch {
      jump = null;
    }
  }

  clearPendingJump(storage);
  return isPendingJump(jump) && bookId && jump.bookId === bookId ? jump : undefined;
}
