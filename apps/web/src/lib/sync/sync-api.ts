/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { errorFrom, send } from '$lib/library/api';
import type { Change, LocalRecord } from '$lib/sync/sync-db';

/** Client for the storage server's WP4 routes (/api/v1/devices, /api/v1/sync). */

export type ServerRecord = LocalRecord & { rev: number };

export type ChangeResult =
  | { kind: string; id: string; status: 'applied' | 'duplicate'; rev: number }
  | { kind: string; id: string; status: 'stale'; record: ServerRecord }
  | {
      kind: string;
      id: string;
      status: 'rejected';
      error: { code: string; message: string };
      /** The server's copy, when the change was refused because of it. */
      record?: ServerRecord;
    };

export interface PushResponse {
  results: ChangeResult[];
  serverTime: number;
}

export interface PullResponse {
  records: ServerRecord[];
  cursor: string;
  more: boolean;
  serverTime: number;
}

export interface RegisterResponse {
  device: { id: string; name: string };
  serverTime: number;
}

/** The transport the engine uses; tests swap in their own. */
export interface SyncTransport {
  register(deviceId: string | null): Promise<RegisterResponse>;
  push(changes: Change[]): Promise<PushResponse>;
  pull(cursor: string | undefined, limit?: number): Promise<PullResponse>;
}

export class SyncApi implements SyncTransport {
  constructor(
    readonly serverUrl: string,
    private readonly token: string,
    readonly timeoutSeconds = 0,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)
  ) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      { timeoutSeconds: this.timeoutSeconds }
    );
    if (!response.ok) throw await errorFrom(response);
    return response.json() as Promise<T>;
  }

  register(deviceId: string | null): Promise<RegisterResponse> {
    return this.request('POST', '/devices/register', deviceId ? { deviceId } : {});
  }

  push(changes: Change[]): Promise<PushResponse> {
    return this.request('POST', '/sync', { changes });
  }

  pull(cursor: string | undefined, limit?: number): Promise<PullResponse> {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return this.request('GET', `/sync${qs ? `?${qs}` : ''}`);
  }
}
