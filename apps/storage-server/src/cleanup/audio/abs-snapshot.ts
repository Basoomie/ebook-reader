/**
 * Stage 0 of the audiobook cleanup (WP21a): a read-only snapshot of Audiobookshelf, so the user
 * can redo listening progress by hand after the switch (decided: ABS progress is not carried
 * over). Libraries with their folders and settings, the number of items per library, and every
 * user's media progress with the book's title and path. ABS has no GET for its server settings
 * (v2.37.1: /settings is PATCH, /authorize is POST), so they are not in the snapshot.
 */
import type Database from 'better-sqlite3';
import { AbsClient } from './abs-client';

interface AbsLibrary {
  id: string;
  name?: string;
  mediaType?: string;
  provider?: string;
  folders?: { fullPath?: string }[];
  settings?: Record<string, unknown>;
}

interface AbsProgress {
  id?: string;
  libraryItemId?: string;
  episodeId?: string | null;
  mediaItemType?: string;
  duration?: number;
  progress?: number;
  currentTime?: number;
  isFinished?: boolean;
  hideFromContinueListening?: boolean;
  lastUpdate?: number;
  startedAt?: number;
  finishedAt?: number | null;
  displayTitle?: string;
}

interface AbsItem {
  id: string;
  libraryId?: string;
  path?: string;
  relPath?: string;
  media?: { metadata?: { title?: string; authorName?: string } };
}

export interface ProgressRow {
  user: string;
  userType: string | null;
  libraryItemId: string | null;
  title: string | null;
  author: string | null;
  library: string | null;
  path: string | null;
  relPath: string | null;
  /** false: the item is no longer in ABS (its progress is still stored). */
  inAbs: boolean;
  isFinished: boolean;
  /** 0-100. */
  progressPercent: number;
  currentTime: number | null;
  duration: number | null;
  lastUpdate: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  hidden: boolean;
}

export interface AbsSnapshotData {
  takenAt: number;
  absUrl: string;
  serverVersion: string | null;
  libraries: {
    id: string;
    name: string | null;
    mediaType: string | null;
    provider: string | null;
    folders: string[];
    settings: Record<string, unknown> | null;
    itemCount: number | null;
  }[];
  serverSettings: string;
  users: { id: string; username: string; type: string | null; progressCount: number }[];
  progress: ProgressRow[];
  problems: string[];
}

export interface AbsSnapshotSummary {
  takenAt: number;
  serverVersion: string | null;
  libraries: number;
  items: number;
  users: number;
  progress: number;
  finished: number;
  inProgress: number;
  notInAbs: number;
  problems: number;
}

export async function takeAbsSnapshot(
  client: AbsClient,
  absUrl: string,
  now = Date.now(),
): Promise<AbsSnapshotData> {
  const problems: string[] = [];
  const status = await client.status().catch(() => null);
  const libs = (await client.get<{ libraries?: AbsLibrary[] }>('/libraries'))?.libraries ?? [];
  const libraries: AbsSnapshotData['libraries'] = [];
  for (const lib of libs) {
    const full = (await client.get<AbsLibrary>(`/libraries/${encodeURIComponent(lib.id)}`)) ?? lib;
    let itemCount: number | null = null;
    try {
      const items = await client.get<{ total?: number }>(
        `/libraries/${encodeURIComponent(lib.id)}/items?limit=1&minified=1`,
      );
      itemCount = typeof items?.total === 'number' ? items.total : null;
    } catch (err) {
      problems.push(`Items of ${lib.name ?? lib.id}: ${(err as Error).message}`);
    }
    libraries.push({
      id: lib.id,
      name: full.name ?? lib.name ?? null,
      mediaType: full.mediaType ?? null,
      provider: full.provider ?? null,
      folders: (full.folders ?? []).map((f) => f.fullPath ?? '').filter(Boolean),
      settings: full.settings ?? null,
      itemCount,
    });
  }
  const libName = new Map(libraries.map((l) => [l.id, l.name]));
  const userList =
    (await client.get<{ users?: { id: string; username?: string; type?: string }[] }>('/users'))
      ?.users ?? [];
  const items = new Map<string, AbsItem | null>();
  const item = async (id: string): Promise<AbsItem | null> => {
    if (!items.has(id)) {
      try {
        items.set(id, await client.get<AbsItem>(`/items/${encodeURIComponent(id)}`));
      } catch (err) {
        problems.push(`Item ${id}: ${(err as Error).message}`);
        items.set(id, null);
      }
    }
    return items.get(id) ?? null;
  };
  const users: AbsSnapshotData['users'] = [];
  const progress: ProgressRow[] = [];
  for (const u of userList) {
    const full = await client.get<{
      username?: string;
      type?: string;
      mediaProgress?: AbsProgress[];
    }>(`/users/${encodeURIComponent(u.id)}`);
    const list = full?.mediaProgress ?? [];
    const username = full?.username ?? u.username ?? u.id;
    users.push({
      id: u.id,
      username,
      type: full?.type ?? u.type ?? null,
      progressCount: list.length,
    });
    for (const p of list) {
      const it = p.libraryItemId ? await item(p.libraryItemId) : null;
      progress.push({
        user: username,
        userType: full?.type ?? u.type ?? null,
        libraryItemId: p.libraryItemId ?? null,
        title: it?.media?.metadata?.title ?? p.displayTitle ?? null,
        author: it?.media?.metadata?.authorName ?? null,
        library: it?.libraryId ? (libName.get(it.libraryId) ?? it.libraryId) : null,
        path: it?.path ?? null,
        relPath: it?.relPath ?? null,
        inAbs: it !== null,
        isFinished: p.isFinished === true,
        progressPercent: Math.round((typeof p.progress === 'number' ? p.progress : 0) * 1000) / 10,
        currentTime: typeof p.currentTime === 'number' ? p.currentTime : null,
        duration: typeof p.duration === 'number' ? p.duration : null,
        lastUpdate: p.lastUpdate ?? null,
        startedAt: p.startedAt ?? null,
        finishedAt: p.finishedAt ?? null,
        hidden: p.hideFromContinueListening === true,
      });
    }
  }
  // Finished first, then in progress, newest first.
  progress.sort(
    (a, b) =>
      Number(b.isFinished) - Number(a.isFinished) ||
      Number(b.progressPercent > 0) - Number(a.progressPercent > 0) ||
      (b.lastUpdate ?? 0) - (a.lastUpdate ?? 0),
  );
  return {
    takenAt: now,
    absUrl,
    serverVersion: status?.serverVersion ?? null,
    libraries,
    serverSettings: 'Not in the snapshot: Audiobookshelf has no read-only way to get them (GET)',
    users,
    progress,
    problems,
  };
}

export function summarize(d: AbsSnapshotData): AbsSnapshotSummary {
  return {
    takenAt: d.takenAt,
    serverVersion: d.serverVersion,
    libraries: d.libraries.length,
    items: d.libraries.reduce((a, l) => a + (l.itemCount ?? 0), 0),
    users: d.users.length,
    progress: d.progress.length,
    finished: d.progress.filter((p) => p.isFinished).length,
    inProgress: d.progress.filter((p) => !p.isFinished && p.progressPercent > 0).length,
    notInAbs: d.progress.filter((p) => !p.inAbs).length,
    problems: d.problems.length,
  };
}

export function saveSnapshot(db: Database.Database, d: AbsSnapshotData): number {
  const r = db
    .prepare(
      'INSERT INTO abs_snapshots (taken_at, abs_version, data_json, summary_json) VALUES (?, ?, ?, ?)',
    )
    .run(d.takenAt, d.serverVersion, JSON.stringify(d), JSON.stringify(summarize(d)));
  return Number(r.lastInsertRowid);
}

export function listSnapshots(
  db: Database.Database,
): { id: number; summary: AbsSnapshotSummary }[] {
  return (
    db.prepare('SELECT id, summary_json FROM abs_snapshots ORDER BY id DESC LIMIT 50').all() as {
      id: number;
      summary_json: string;
    }[]
  ).map((r) => ({ id: r.id, summary: JSON.parse(r.summary_json) as AbsSnapshotSummary }));
}

export function getSnapshot(db: Database.Database, id: number): AbsSnapshotData | null {
  const r = db.prepare('SELECT data_json FROM abs_snapshots WHERE id = ?').get(id) as
    | { data_json: string }
    | undefined;
  return r ? (JSON.parse(r.data_json) as AbsSnapshotData) : null;
}

function hms(s: number | null): string {
  if (s === null) return '';
  const t = Math.round(s);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function cell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The progress list as CSV (UTF-8 with BOM so Excel shows Japanese). */
export function progressCsv(d: AbsSnapshotData): string {
  const head = [
    'user',
    'title',
    'author',
    'library',
    'path',
    'in Audiobookshelf',
    'finished',
    'progress %',
    'position',
    'length',
    'last listened',
    'finished at',
  ];
  const iso = (t: number | null) => (t ? new Date(t).toISOString() : '');
  const rows = d.progress.map((p) =>
    [
      p.user,
      p.title,
      p.author,
      p.library,
      p.path,
      p.inAbs ? 'yes' : 'no',
      p.isFinished ? 'yes' : 'no',
      p.progressPercent,
      hms(p.currentTime),
      hms(p.duration),
      iso(p.lastUpdate),
      iso(p.finishedAt),
    ]
      .map(cell)
      .join(','),
  );
  return String.fromCharCode(0xfeff) + [head.join(','), ...rows].join('\r\n') + '\r\n';
}
