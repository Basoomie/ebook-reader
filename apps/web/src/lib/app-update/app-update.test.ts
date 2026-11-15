/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAppUpdate,
  SKIP_WAITING_MESSAGE,
  startAppUpdate,
  VERSION_MESSAGE,
  type AppUpdate,
  type AppUpdateEnv
} from './app-update';

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

class FakeWorker extends EventTarget {
  messages: unknown[] = [];

  constructor(
    public version: string,
    public state: ServiceWorkerState,
    private host: FakeHost
  ) {
    super();
  }

  postMessage(message: unknown, ports?: MessagePort[]) {
    this.messages.push(message);
    if ((message as { type?: string }).type === VERSION_MESSAGE.type) {
      ports?.[0]?.postMessage({ version: this.version });
      ports?.[0]?.close();
    }
    if ((message as { type?: string }).type === SKIP_WAITING_MESSAGE.type) {
      setTimeout(() => this.host.activate(this), 1);
    }
  }

  setState(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }

  get skipRequested() {
    return this.messages.some((m) => (m as { type?: string }).type === SKIP_WAITING_MESSAGE.type);
  }
}

class FakeRegistration extends EventTarget {
  active: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  update = vi.fn(() => Promise.resolve());
}

class FakeHost {
  registration = new FakeRegistration();
  container = new EventTarget() as EventTarget & {
    register: ReturnType<typeof vi.fn>;
    controller: FakeWorker | null;
  };
  document = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState
  });
  window = new EventTarget();
  reload = vi.fn();
  channels: MessageChannel[] = [];

  constructor(active?: string) {
    if (active) {
      this.registration.active = new FakeWorker(active, 'activated', this);
    }
    this.container.controller = this.registration.active;
    this.container.register = vi.fn(() => Promise.resolve(this.registration));
  }

  worker(version: string, state: ServiceWorkerState) {
    return new FakeWorker(version, state, this);
  }

  /** A new version finished installing while one is active: it waits. */
  waitingVersion(version: string) {
    const w = this.worker(version, 'installed');
    this.registration.waiting = w;
    return w;
  }

  /** What the browser does when a worker takes over. */
  activate(w: FakeWorker) {
    if (this.registration.waiting === w) this.registration.waiting = null;
    this.registration.active = w;
    w.setState('activating');
    w.setState('activated');
    if (this.container.controller) {
      this.container.controller = w;
      this.container.dispatchEvent(new Event('controllerchange'));
    }
  }

  env(pageVersion: string): AppUpdateEnv {
    return {
      serviceWorker: this.container as unknown as ServiceWorkerContainer,
      document: this.document as unknown as AppUpdateEnv['document'],
      window: this.window as unknown as AppUpdateEnv['window'],
      reload: this.reload,
      createChannel: () => {
        const channel = new MessageChannel();
        this.channels.push(channel);
        return channel;
      },
      pageVersion,
      scriptUrl: '/service-worker.js',
      warn: vi.fn()
    };
  }
}

let current: AppUpdate | undefined;
afterEach(() => {
  current?.stop();
  current = undefined;
});

async function started(host: FakeHost, pageVersion: string) {
  current = createAppUpdate(host.env(pageVersion));
  await current.ready;
  await flush();
  return current;
}

describe('app update', () => {
  it('registers the service worker script', async () => {
    const host = new FakeHost('100');
    await started(host, '100');
    expect(host.container.register).toHaveBeenCalledWith('/service-worker.js');
  });

  it('shows nothing when no version is waiting', async () => {
    const host = new FakeHost('100');
    const update = await started(host, '100');
    expect(get(update.available)).toBe(false);
  });

  it('shows nothing on a first install (no active version)', async () => {
    const host = new FakeHost();
    host.registration.waiting = host.worker('100', 'installed');
    const update = await started(host, '100');
    expect(get(update.available)).toBe(false);
    expect(host.registration.waiting?.skipRequested).toBe(false);
  });

  it('shows the notice when a newer version is waiting at start', async () => {
    const host = new FakeHost('100');
    const waiting = host.waitingVersion('200');
    const update = await started(host, '100');
    expect(get(update.available)).toBe(true);
    expect(waiting.skipRequested).toBe(false);
    expect(host.reload).not.toHaveBeenCalled();
  });

  it('switches quietly when the page already is the waiting version', async () => {
    const host = new FakeHost('100');
    const waiting = host.waitingVersion('200');
    const update = await started(host, '200');
    expect(waiting.skipRequested).toBe(true);
    await flush();
    expect(host.registration.active).toBe(waiting);
    expect(get(update.available)).toBe(false);
    expect(host.reload).not.toHaveBeenCalled();
  });

  it('shows the notice when a new version finishes installing while the page is open', async () => {
    const host = new FakeHost('100');
    const update = await started(host, '100');
    const installing = host.worker('200', 'installing');
    host.registration.installing = installing;
    host.registration.dispatchEvent(new Event('updatefound'));
    expect(get(update.available)).toBe(false);
    host.registration.installing = null;
    host.registration.waiting = installing;
    installing.setState('installed');
    await flush();
    expect(get(update.available)).toBe(true);
  });

  it('shows nothing when an install fails', async () => {
    const host = new FakeHost('100');
    const update = await started(host, '100');
    const installing = host.worker('200', 'installing');
    host.registration.installing = installing;
    host.registration.dispatchEvent(new Event('updatefound'));
    host.registration.installing = null;
    installing.setState('redundant');
    await flush();
    expect(get(update.available)).toBe(false);
  });

  it('shows the notice when another window lets a new version take over', async () => {
    const host = new FakeHost('100');
    const update = await started(host, '100');
    host.activate(host.worker('200', 'installed'));
    expect(get(update.available)).toBe(true);
    expect(host.reload).not.toHaveBeenCalled();
  });

  it('Reload lets the waiting version take over, then reloads', async () => {
    const host = new FakeHost('100');
    const waiting = host.waitingVersion('200');
    const update = await started(host, '100');
    const done = update.reload();
    expect(waiting.skipRequested).toBe(true);
    expect(host.reload).not.toHaveBeenCalled();
    await done;
    expect(waiting.state).toBe('activated');
    expect(host.reload).toHaveBeenCalledTimes(1);
    // Its own switch is not "another window".
    expect(get(update.available)).toBe(true);
  });

  it('a closed notice stays closed when another window lets that version take over', async () => {
    const host = new FakeHost('100');
    const waiting = host.waitingVersion('200');
    const update = await started(host, '100');
    update.dismiss();
    host.activate(waiting);
    expect(host.container.controller).toBe(waiting);
    expect(get(update.available)).toBe(false);
    // A later, newer version taking over shows it again.
    host.activate(host.worker('300', 'installed'));
    expect(get(update.available)).toBe(true);
  });

  it('Reload with nothing waiting reloads at once', async () => {
    const host = new FakeHost('100');
    const update = await started(host, '100');
    host.activate(host.worker('200', 'installed'));
    await update.reload();
    expect(host.reload).toHaveBeenCalledTimes(1);
  });

  it('✕ hides the notice until a newer version arrives', async () => {
    const host = new FakeHost('100');
    host.waitingVersion('200');
    const update = await started(host, '100');
    update.dismiss();
    expect(get(update.available)).toBe(false);
    // The same waiting version found again: stays hidden.
    host.document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(get(update.available)).toBe(false);
    // A newer one replaces it.
    const installing = host.worker('300', 'installing');
    host.registration.installing = installing;
    host.registration.dispatchEvent(new Event('updatefound'));
    host.registration.installing = null;
    host.registration.waiting = installing;
    installing.setState('installed');
    await flush();
    expect(get(update.available)).toBe(true);
  });

  it('looks for a new version when the app comes to the front or goes online', async () => {
    const host = new FakeHost('100');
    await started(host, '100');
    host.registration.update.mockClear();
    host.document.visibilityState = 'hidden';
    host.document.dispatchEvent(new Event('visibilitychange'));
    expect(host.registration.update).not.toHaveBeenCalled();
    host.document.visibilityState = 'visible';
    host.document.dispatchEvent(new Event('visibilitychange'));
    expect(host.registration.update).toHaveBeenCalledTimes(1);
    host.window.dispatchEvent(new Event('online'));
    expect(host.registration.update).toHaveBeenCalledTimes(2);
  });

  it('ignores a failed check (offline)', async () => {
    const host = new FakeHost('100');
    const update = await started(host, '100');
    host.registration.update.mockImplementation(() => Promise.reject(new TypeError('offline')));
    host.window.dispatchEvent(new Event('online'));
    await flush();
    expect(get(update.available)).toBe(false);
  });

  it('a failed registration only means no notice', async () => {
    const host = new FakeHost('100');
    host.container.register.mockImplementation(() => Promise.reject(new Error('blocked')));
    const env = host.env('100');
    current = createAppUpdate(env);
    await current.ready;
    expect(env.warn).toHaveBeenCalled();
    expect(get(current.available)).toBe(false);
  });

  it('stop removes its listeners', async () => {
    const host = new FakeHost('100');
    const update = await started(host, '100');
    update.stop();
    host.registration.update.mockClear();
    host.window.dispatchEvent(new Event('online'));
    host.activate(host.worker('200', 'installed'));
    expect(host.registration.update).not.toHaveBeenCalled();
    expect(get(update.available)).toBe(false);
  });
});

describe('startAppUpdate', () => {
  it('does nothing on plain http (no secure context)', () => {
    // Under Vitest (Node) there is no secure context, as on plain http.
    expect(startAppUpdate('100')).toBeUndefined();
  });
});
