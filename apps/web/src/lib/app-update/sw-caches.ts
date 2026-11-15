/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Rules the service worker uses for its caches (plain functions, so they can be
 * tested without a service worker).
 *
 * Each version of the app keeps its files in `build:<version>` (plus `other:<version>`
 * for Google Fonts). A new version keeps its own caches and the previous version's,
 * so a window still open on the previous version keeps working online and offline,
 * and deletes the rest of the worker's own kinds. Caches with any other name are
 * left alone.
 */

export const BUILD_PREFIX = 'build:';
export const OTHER_PREFIX = 'other:';
/** The cache of ttsu's removed per-browser fonts (WP18). */
export const OLD_USERFONTS_CACHE = 'ttu-userfonts';

/** Written into a version's build cache once all its files are in. */
export const INSTALLED_MARK = '/__ttsu-installed';
/** Written into a version's build cache when it takes over. */
export const ACTIVATED_MARK = '/__ttsu-activated';

export function buildCacheName(version: string) {
  return `${BUILD_PREFIX}${version}`;
}

export function otherCacheName(version: string) {
  return `${OTHER_PREFIX}${version}`;
}

/** The version of a `build:` or `other:` cache, or undefined for any other name. */
export function cacheVersion(name: string): string | undefined {
  if (name.startsWith(BUILD_PREFIX)) return name.slice(BUILD_PREFIX.length);
  if (name.startsWith(OTHER_PREFIX)) return name.slice(OTHER_PREFIX.length);
  return undefined;
}

/** True for the caches the service worker owns (its own kinds and ttsu's old ones). */
export function isOwnCache(name: string) {
  return cacheVersion(name) !== undefined || name === OLD_USERFONTS_CACHE;
}

/**
 * True when `version` is older than `current`. SvelteKit's version is the build time
 * in milliseconds; anything that isn't a number is never "older".
 */
export function isOlderVersion(version: string, current: string) {
  if (!/^\d+$/.test(version) || !/^\d+$/.test(current)) return false;
  return Number(version) < Number(current);
}

export interface BuildCacheState {
  version: string;
  /** Holds INSTALLED_MARK: made by this worker and complete. */
  installed: boolean;
  /** Holds ACTIVATED_MARK: this version took over at some point. */
  activated: boolean;
  /** Holds no entries at all. */
  empty: boolean;
}

/**
 * The version whose caches stay as "previous" when `current` takes over:
 * - the newest older version that took over (it carries ACTIVATED_MARK);
 * - if none did (the first switch from a worker without marks: today's build or
 *   ttsu's), the newest older cache without any mark that isn't empty. Those
 *   workers filled their cache with one atomic addAll, so it is complete or empty.
 * A cache with INSTALLED_MARK but no ACTIVATED_MARK was a version that waited and
 * never took over; one with neither mark from this worker was an install that
 * didn't finish. Neither is kept.
 */
export function previousVersion(
  current: string,
  builds: readonly BuildCacheState[]
): string | undefined {
  const older = builds
    .filter((b) => isOlderVersion(b.version, current))
    .sort((a, b) => Number(b.version) - Number(a.version));
  const activated = older.find((b) => b.activated);
  if (activated) return activated.version;
  const fromOldWorker = older.find((b) => !b.installed && !b.activated && !b.empty);
  return fromOldWorker?.version;
}

/** The worker's own caches to delete when `current` takes over (keeping `previous`). */
export function cachesToDelete(
  names: readonly string[],
  current: string,
  previous: string | undefined
): string[] {
  const keep = new Set([buildCacheName(current), otherCacheName(current)]);
  if (previous !== undefined) {
    keep.add(buildCacheName(previous));
    keep.add(otherCacheName(previous));
  }
  return names.filter((name) => isOwnCache(name) && !keep.has(name));
}

/**
 * True for files whose name holds a hash of their content (SvelteKit's
 * `_app/immutable/`): a file with the same path is the same file in every version,
 * so it can be served from, or copied out of, any version's cache.
 */
export function isImmutablePath(pathname: string, base = '') {
  return pathname.startsWith(`${base}/_app/immutable/`);
}
