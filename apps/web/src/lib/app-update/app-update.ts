/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writable, type Readable } from 'svelte/store';
import { canUseServiceWorker } from '$lib/functions/secure-context';

/**
 * Offline app loading and the "New version available" notice (Season 2 §2).
 *
 * Registers the service worker (HTTPS only; on plain http nothing happens) and
 * watches for a new version that is waiting:
 * - the open page is older than it: the notice is shown; "Reload" lets it take
 *   over and loads the page again. The app never reloads by itself.
 * - the open page already is that version (it came from the server while the
 *   worker was still waiting): it takes over quietly, nothing to reload.
 * - another window let a new version take over: this page is now older than the
 *   worker serving it, so the notice is shown.
 * Looks for a new version when the app comes back to the front and when the
 * connection returns; the browser itself looks at every full page load.
 * Any failure only means no notice; it never affects the page.
 */

export const SKIP_WAITING_MESSAGE = { type: 'ttsu-skip-waiting' } as const;
export const VERSION_MESSAGE = { type: 'ttsu-version' } as const;

export interface AppUpdateEnv {
  serviceWorker: ServiceWorkerContainer;
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  reload: () => void;
  createChannel: () => MessageChannel;
  /** This page's version (`version` from `$app/environment`). */
  pageVersion: string;
  scriptUrl: string;
  warn?: (message: string, error?: unknown) => void;
}

export interface AppUpdate {
  /** True while the notice should show. */
  available: Readable<boolean>;
  /** "Reload": lets the waiting version take over, then loads the page again. */
  reload: () => Promise<void>;
  /** "✕": hides the notice for this page load (a newer version shows it again). */
  dismiss: () => void;
  stop: () => void;
  /** Resolves once registration and the first look for a waiting version are done. */
  ready: Promise<void>;
}

export function createAppUpdate(env: AppUpdateEnv): AppUpdate {
  const available = writable(false);
  const warn = env.warn ?? ((message, error) => console.warn(message, error));
  let registration: ServiceWorkerRegistration | undefined;
  let stopped = false;
  /** Set once this page asked a version to take over (Reload or the quiet switch). */
  let switchRequested = false;
  /** The version the notice is about: the waiting worker, or the new controller after another window switched. */
  let shownFor: ServiceWorker | 'controller' | undefined;
  let dismissedFor: ServiceWorker | 'controller' | undefined;
  const inspected = new WeakSet<ServiceWorker>();
  const cleanups: (() => void)[] = [];

  function show(subject: ServiceWorker | 'controller') {
    shownFor = subject;
    available.set(dismissedFor !== subject);
  }

  function askVersion(target: ServiceWorker): Promise<string | undefined> {
    return new Promise((resolve) => {
      const channel = env.createChannel();
      channel.port1.onmessage = (event: MessageEvent) => {
        const value = (event.data as { version?: unknown } | null)?.version;
        resolve(typeof value === 'string' ? value : undefined);
        channel.port1.close();
      };
      target.postMessage(VERSION_MESSAGE, [channel.port2]);
    });
  }

  async function inspectWaiting() {
    const waiting = registration?.waiting;
    // No active version: a first install, which takes over by itself.
    if (!waiting || !registration?.active || inspected.has(waiting)) return;
    inspected.add(waiting);
    const waitingVersion = await askVersion(waiting);
    if (stopped || registration?.waiting !== waiting) return;
    if (waitingVersion === env.pageVersion) {
      switchRequested = true;
      waiting.postMessage(SKIP_WAITING_MESSAGE);
      return;
    }
    show(waiting);
  }

  function safely(what: string, run: () => Promise<unknown> | unknown) {
    try {
      const result = run();
      if (result instanceof Promise) result.catch((error) => warn(`App update: ${what}`, error));
    } catch (error) {
      warn(`App update: ${what}`, error);
    }
  }

  function watchInstalling(worker: ServiceWorker | null | undefined) {
    if (!worker) return;
    const onState = () => {
      if (worker.state === 'installed') safely('inspect waiting', inspectWaiting);
      if (worker.state !== 'installing') worker.removeEventListener('statechange', onState);
    };
    worker.addEventListener('statechange', onState);
  }

  function checkForUpdate() {
    // Offline or the server unreachable: the check fails; nothing to do.
    registration?.update().catch(() => undefined);
  }

  function listen<T extends { addEventListener: EventTarget['addEventListener'] }>(
    target: T & { removeEventListener: EventTarget['removeEventListener'] },
    type: string,
    handler: () => void
  ) {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  }

  async function start() {
    const reg = await env.serviceWorker.register(env.scriptUrl);
    if (stopped) return;
    registration = reg;
    listen(reg, 'updatefound', () => watchInstalling(reg.installing));
    listen(env.serviceWorker, 'controllerchange', () => {
      if (switchRequested) {
        switchRequested = false;
        return;
      }
      // The new controller is the same object as the worker that waited, so a
      // version the user already closed the notice for stays closed.
      show(env.serviceWorker.controller ?? 'controller');
    });
    listen(env.document, 'visibilitychange', () => {
      if (env.document.visibilityState === 'visible') checkForUpdate();
    });
    listen(env.window, 'online', checkForUpdate);
    watchInstalling(reg.installing);
    await inspectWaiting();
  }

  const ready = start().catch((error) => warn('App update: not started', error));

  async function reload() {
    const waiting = registration?.waiting;
    if (!waiting) {
      env.reload();
      return;
    }
    switchRequested = true;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (waiting.state === 'activated' || waiting.state === 'redundant') {
          waiting.removeEventListener('statechange', check);
          resolve();
        }
      };
      waiting.addEventListener('statechange', check);
      waiting.postMessage(SKIP_WAITING_MESSAGE);
      check();
    });
    env.reload();
  }

  function dismiss() {
    dismissedFor = shownFor;
    available.set(false);
  }

  function stop() {
    stopped = true;
    cleanups.splice(0).forEach((cleanup) => cleanup());
  }

  return { available: { subscribe: available.subscribe }, reload, dismiss, stop, ready };
}

/** Starts it for this page, or returns undefined where there is no service worker (plain http). */
export function startAppUpdate(pageVersion: string, base = ''): AppUpdate | undefined {
  if (!canUseServiceWorker()) return undefined;
  return createAppUpdate({
    serviceWorker: navigator.serviceWorker,
    document,
    window,
    reload: () => window.location.reload(),
    createChannel: () => new MessageChannel(),
    pageVersion,
    scriptUrl: `${base}/service-worker.js`
  });
}
