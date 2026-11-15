/// <reference lib="webworker" />

import { base, build, files, prerendered, version } from '$service-worker';

import {
  ACTIVATED_MARK,
  BUILD_PREFIX,
  INSTALLED_MARK,
  buildCacheName,
  cacheVersion,
  cachesToDelete,
  isImmutablePath,
  otherCacheName,
  previousVersion,
  type BuildCacheState
} from '$lib/app-update/sw-caches';
import { pagePath } from '$lib/data/env';
import { toSearchParams } from '$lib/functions/to-search-params';

// eslint-disable-next-line no-restricted-globals
const worker = self as unknown as ServiceWorkerGlobalScope;
const BUILD_CACHE_NAME = buildCacheName(version);

const prerenderedSet = new Set(prerendered);

const assetsToCache = build.concat(files).concat(prerendered);
const cachedAssets = new Set(assetsToCache);

// A new version waits until a page asks it to take over ("Reload" on the
// "New version available" notice, or quietly when the page already is this
// version) or until no window of the app is open. It never takes over under an
// open page by itself.
worker.addEventListener('install', (event) => {
  event.waitUntil(fillBuildCache());
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(cleanUpOnTakeOver());
});

worker.addEventListener('message', (event) => {
  const type = (event.data as { type?: unknown } | null)?.type;
  if (type === 'ttsu-skip-waiting') {
    event.waitUntil(worker.skipWaiting());
  } else if (type === 'ttsu-version') {
    event.ports[0]?.postMessage({ version });
  }
});

/**
 * Puts every file of this version into its build cache. Files under
 * `_app/immutable/` that an older version's cache already holds are copied from
 * there (same path, same content); everything else is downloaded. Any failure
 * fails the install, and the version that is active stays as it is.
 */
async function fillBuildCache() {
  const cache = await caches.open(BUILD_CACHE_NAME);
  try {
    const olderBuildCaches = (await caches.keys()).filter(
      (name) => name.startsWith(BUILD_PREFIX) && name !== BUILD_CACHE_NAME
    );
    const toDownload: string[] = [];
    const reused: [string, Response][] = [];
    for (const path of assetsToCache) {
      const old = isImmutablePath(path, base)
        ? await matchInCaches(path, olderBuildCaches)
        : undefined;
      if (old?.ok) {
        reused.push([path, old]);
      } else {
        toDownload.push(path);
      }
    }
    await cache.addAll(toDownload);
    await Promise.all(reused.map(([path, response]) => cache.put(path, response)));
    await cache.put(INSTALLED_MARK, new Response(String(Date.now())));
  } catch (error) {
    // Leave nothing half-filled behind; the next update check tries again.
    await caches.delete(BUILD_CACHE_NAME);
    throw error;
  }
}

async function matchInCaches(path: string, cacheNames: string[]) {
  for (const name of cacheNames) {
    // eslint-disable-next-line no-await-in-loop
    const response = await caches.match(path, { cacheName: name });
    if (response) return response;
  }
  return undefined;
}

/**
 * Keeps this version's caches and the previous version's (a window still open on
 * it keeps working, online and offline) and deletes the worker's other old caches.
 * Caches with other names are left alone.
 */
async function cleanUpOnTakeOver() {
  const cache = await caches.open(BUILD_CACHE_NAME);
  await cache.put(ACTIVATED_MARK, new Response(String(Date.now())));

  const names = await caches.keys();
  const builds: BuildCacheState[] = [];
  for (const name of names) {
    if (!name.startsWith(BUILD_PREFIX) || name === BUILD_CACHE_NAME) continue;
    // eslint-disable-next-line no-await-in-loop
    const other = await caches.open(name);
    // eslint-disable-next-line no-await-in-loop
    const [installed, activated, keys] = await Promise.all([
      other.match(INSTALLED_MARK),
      other.match(ACTIVATED_MARK),
      other.keys()
    ]);
    builds.push({
      version: cacheVersion(name) ?? '',
      installed: !!installed,
      activated: !!activated,
      empty: keys.length === 0
    });
  }
  const previous = previousVersion(version, builds);
  await Promise.all(cachesToDelete(names, version, previous).map((name) => caches.delete(name)));
}

worker.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.headers.has('range')) return;

  const url = new URL(event.request.url);

  // don't try to handle e.g. data: URIs
  const isHttp = url.protocol.startsWith('http');
  const isDevServerRequest =
    url.hostname === worker.location.hostname && url.port !== worker.location.port;
  const isSelfHost = url.host === worker.location.host;
  const isBuildAsset = isSelfHost && cachedAssets.has(url.pathname);
  const isImmutableAsset = isSelfHost && isImmutablePath(url.pathname, base);
  const skipBecauseUncached =
    event.request.cache === 'only-if-cached' && !isBuildAsset && !isImmutableAsset;

  if (!isHttp || isDevServerRequest || skipBecauseUncached) return;

  if (isSelfHost && prerenderedSet.has(url.pathname)) {
    const requestWithoutParams = new Request(url.pathname);
    event.respondWith(
      networkFirstRaceCache(event.request, false, BUILD_CACHE_NAME, requestWithoutParams, true)
    );
    return;
  }

  if (isSelfHost) {
    // This version's files come from its own cache (other versions' caches hold
    // files with the same unhashed names, e.g. _app/version.json). A page of the
    // previous version still open asks for its own files, which the server may no
    // longer have: any version's cache can answer for immutable files.
    let response: Promise<Response> | Response | undefined;
    if (isBuildAsset) {
      response = caches
        .match(url.pathname, { cacheName: BUILD_CACHE_NAME })
        .then((r) => r ?? fetch(event.request));
    } else if (isImmutableAsset) {
      response = caches.match(url.pathname).then((r) => r ?? fetch(event.request));
    } else {
      response = selfHostParameterizedUrlResponse(event.request);
    }
    if (response) {
      event.respondWith(response);
      return;
    }
  }

  if (url.host === 'fonts.googleapis.com') {
    event.respondWith(networkFirstRaceCache(event.request));
  }
});

async function networkFirstRaceCache(
  request: Request,
  storeResponse = true,
  fallbackCacheName?: string,
  fallbackCacheRequest?: Request,
  revalidate = false
) {
  const cache = await caches.open(otherCacheName(version));
  const controller = new AbortController();

  let cachedResponse: Response | undefined;

  let done = false;
  let attempted = false;

  const retrieveFromFallbackCache = () =>
    fallbackCacheName
      ? caches.match(fallbackCacheRequest ?? request, { cacheName: fallbackCacheName })
      : undefined;

  const retrieveFromCache = async () => {
    if (!storeResponse) return retrieveFromFallbackCache();
    const response = await cache.match(request);
    if (response) return response;
    if (!fallbackCacheName) return undefined;
    return retrieveFromFallbackCache();
  };

  try {
    const handle = setTimeout(async () => {
      cachedResponse = await retrieveFromCache();
      attempted = true;
      if (!cachedResponse || done) return;
      controller.abort();
    }, 1000);
    // Pages are checked with the server every time (revalidate): the server sends no
    // Cache-Control, so the browser's HTTP cache could otherwise hand back an older
    // version's page for hours after a deploy, even after "Reload".
    const response = await fetch(request, {
      signal: controller.signal,
      ...(revalidate ? { cache: 'no-cache' as RequestCache } : {})
    });
    done = true; // avoid Cache.put() was aborted exception
    clearTimeout(handle);
    if (storeResponse) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    if (!attempted) {
      cachedResponse = await retrieveFromCache();
    }
    if (cachedResponse) return cachedResponse;

    throw err;
  }
}

function selfHostParameterizedUrlResponse(request: Request) {
  const url = new URL(request.url);

  const readerRegex = /\/b\/(?<id>\d+)\/?(\?|$)/;
  const readerRegexResult = readerRegex.exec(url.pathname);
  if (readerRegexResult?.groups) {
    return createRedirectResponse(`${[[pagePath]]}/b?${toSearchParams(readerRegexResult.groups)}`);
  }
  return undefined;
}

function createRedirectResponse(location: string) {
  return new Response(null, {
    status: 302,
    headers: {
      location
    }
  });
}
