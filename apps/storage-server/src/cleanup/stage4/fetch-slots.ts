/**
 * TEMPORARY (2026-11-19, to be removed 2026-11-20): parallel fetchers, each behind its own VPN
 * address (gluetun + ttsu-cleanup-fetch, gluetun2 + ttsu-cleanup-fetch2, ...). Remove by
 * reverting the one commit that added this file; nothing in cleanup.db depends on it.
 *
 * - Slot 0 is the fetcher named in fetcher_status (as before: it survives a server restart, and
 *   its pace and back-off keys are the bare ones, so its clocks and history are unchanged).
 * - Up to MAX_FETCHERS - 1 more fetchers get slots 1, 2, ... on their heartbeat (kept in memory
 *   only; after a server restart they rejoin on their next heartbeat, within 30 s).
 * - A slot paces and backs off every site on its own keys (`<key>-<slot>`), takes the next due
 *   request from the whole queue (no split), and counts its own requests in flight. A request is
 *   never handed out twice: the lease is taken in one UPDATE ... WHERE state = 'queued'.
 * - Lease tokens of slots 1+ start with `s<slot>:` (slot 0's stay plain UUIDs), so an answer's
 *   back-off goes to the slot that asked, and a restarted fetcher releases only its own leases.
 * - What this leaves behind after removal: fetch_sites rows named `<key>-<slot>` (read by
 *   nothing) and, for at most a lease's time, leases with prefixed tokens (still answered or
 *   expired as usual).
 */
import type Database from 'better-sqlite3';

/** Fetchers active at once: the usual one plus two on their own VPN addresses. */
export const MAX_FETCHERS = 3;

/** Slot 0 keeps the bare key; slot k its own `key-k`. */
export const slotKey = (key: string, slot: number): string => (slot > 0 ? `${key}-${slot}` : key);

/** A lease token carrying its slot (slot 0's is the plain UUID; UUIDs never start with 's'). */
export const slotToken = (uuid: string, slot: number): string =>
  slot > 0 ? `s${slot}:${uuid}` : uuid;

export function tokenSlot(token: string | null | undefined): number {
  const m = /^s(\d+):/.exec(token ?? '');
  return m ? Number(m[1]) : 0;
}

/** SQL: the slot of a fetch_requests row's lease token. */
export const LEASE_SLOT_SQL =
  "(CASE WHEN lease_token LIKE 's%:%' THEN CAST(substr(lease_token, 2, instr(lease_token, ':') - 2) AS INTEGER) ELSE 0 END)";

interface StateRow {
  paused_reason: string | null;
  backoff_until: number | null;
  backoff_reason: string | null;
  slow_factor: number;
}

/**
 * A site's back-off row as the page shows it: slot 0's, unless another fetcher's slot is paused
 * (or waiting while slot 0 isn't): then that one, named "fetcher N".
 */
export function slotStateRow<T extends StateRow>(
  db: Database.Database,
  key: string,
  now: number,
): T | undefined {
  const get = db.prepare('SELECT * FROM fetch_sites WHERE site = ?');
  const rows = Array.from({ length: MAX_FETCHERS }, (_, k) => ({
    k,
    r: get.get(slotKey(key, k)) as T | undefined,
  }));
  const base = rows[0].r;
  const tag = (k: number, s: string | null) => (s === null ? null : `fetcher ${k + 1}: ${s}`);
  const paused = rows.find((x) => x.r?.paused_reason);
  if (paused && paused.k > 0)
    return {
      ...(base ?? paused.r!),
      paused_reason: tag(paused.k, paused.r!.paused_reason),
      slow_factor: base?.slow_factor ?? 1,
    };
  if (paused) return base;
  const waiting = rows.find((x) => x.r?.backoff_until && x.r.backoff_until > now);
  if (waiting && waiting.k > 0)
    return {
      ...(base ?? waiting.r!),
      backoff_until: waiting.r!.backoff_until,
      backoff_reason: tag(waiting.k, waiting.r!.backoff_reason),
      slow_factor: base?.slow_factor ?? 1,
    };
  return base;
}

export interface FetcherSlot {
  slot: number;
  /** The fetcher's version (undefined for slot 0: the queue reads fetcher_status as before). */
  version?: string | null;
}

interface Extra {
  slot: number;
  runId: string | null;
  lastSeen: number;
  version: string | null;
}

/** Slots 1+ (slot 0 stays in fetcher_status, handled by the service as before). */
export class FetcherSlots {
  private readonly extra = new Map<string, Extra>();

  constructor(
    private readonly release: (slot: number) => number,
    private readonly log: (m: string) => void,
  ) {}

  /** Another fetcher's heartbeat while slot 0 is taken: its slot, or null when all are taken. */
  heartbeat(
    hb: { fetcherId: string; runId?: string | null; version: string | null },
    now: number,
    offlineMs: number,
  ): number | null {
    const fresh = (e: Extra) => now - e.lastSeen < offlineMs;
    let e = this.extra.get(hb.fetcherId);
    if (!e) {
      let slot = 0;
      let takenOver = false;
      for (let k = 1; k < MAX_FETCHERS && !slot; k++) {
        const holder = [...this.extra.entries()].find(([, x]) => x.slot === k);
        if (!holder) slot = k;
        else if (!fresh(holder[1])) {
          this.extra.delete(holder[0]);
          slot = k;
          takenOver = true;
        }
      }
      if (!slot) return null;
      // A slot taken over from a gone fetcher: what it had in flight is asked again now. A free
      // slot after a server restart releases nothing (a fetcher that kept running may still
      // post its answers; unanswered leases expire as usual).
      const n = takenOver ? this.release(slot) : 0;
      e = { slot, runId: hb.runId ?? null, lastSeen: now, version: hb.version };
      this.extra.set(hb.fetcherId, e);
      this.log(
        `Cleanup: fetcher ${hb.fetcherId} joined as fetcher ${slot + 1}` +
          (n > 0 ? `; ${n} requests in flight asked again` : ''),
      );
      return slot;
    }
    if (hb.runId && e.runId && hb.runId !== e.runId) {
      const n = this.release(e.slot);
      if (n > 0)
        this.log(`Cleanup: fetcher ${e.slot + 1} restarted; ${n} requests in flight asked again`);
    }
    e.runId = hb.runId ?? e.runId;
    e.lastSeen = now;
    e.version = hb.version;
    return e.slot;
  }

  /** The slot of a fetcher that heartbeated recently (slots 1+ only). */
  slotOf(fetcherId: string, now: number, offlineMs: number): FetcherSlot | null {
    const e = this.extra.get(fetcherId);
    return e && now - e.lastSeen < offlineMs ? { slot: e.slot, version: e.version } : null;
  }

  /** The fetcher took slot 0 (the one before it went offline): it leaves its extra slot. */
  drop(fetcherId: string): void {
    this.extra.delete(fetcherId);
  }
}
