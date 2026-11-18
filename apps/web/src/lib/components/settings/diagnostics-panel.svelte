<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import { version } from '$app/environment';
  import SettingsSection from '$lib/components/settings/settings-section.svelte';
  import { fetchDiagnostics, type DiagnosticsResponse } from '$lib/diagnostics/diagnostics-api';
  import {
    buildDate,
    currentJobText,
    deviceName,
    lastSeenText,
    NOT_CONNECTED,
    NOT_OVER_HTTP,
    pcWorkerStateText,
    serverErrorText,
    storageUsedText
  } from '$lib/diagnostics/diagnostics-text';
  import { canEstimateStorage, canPersistStorage } from '$lib/functions/secure-context';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import type { RunnerStatus } from '$lib/sync/sync-runner';
  import { getSyncRunner } from '$lib/sync/sync-service';
  import { SYNC_STATE_TEXT } from '$lib/sync/sync-state-text';
  import { onDestroy, onMount } from 'svelte';
  import {
    CHANNEL_NAMES,
    firstLine,
    logKindText,
    logStatusText
  } from '$lib/notifications/notifications-text';

  /**
   * Settings > Diagnostics (Season 2 §7): read-only. This device's own figures come from
   * the browser and the sync runner; everything else from one GET /api/v1/diagnostics.
   * No timer: it refreshes on open, when the app comes back to the front, when the
   * connection returns, and on Refresh. Sync state is live (the runner's status).
   */

  const origin = typeof location === 'undefined' ? '' : location.origin;
  const appBuilt = buildDate(version);

  let now = Date.now();
  const runner = getSyncRunner();
  let sync: RunnerStatus | null = null;
  // status$ is a BehaviorSubject: it calls back at once, so `now` must exist before.
  const subscription = runner?.status$.subscribe((s) => {
    sync = s;
    now = Date.now();
  });

  let connection: LibraryConnection | null | undefined;
  let diag: DiagnosticsResponse | null = null;
  let diagAt = 0;
  let serverError = '';
  let loading = false;

  const estimateAvailable = canEstimateStorage();
  const persistAvailable = canPersistStorage();
  let storageUsed: string | null | undefined;
  let persisted: boolean | undefined;

  $: thisDevice = diag?.devices.find((d) => d.current) ?? null;
  $: thisName = thisDevice ? deviceName(thisDevice.name) : connection?.label || '';

  function formatTime(ms: number | null | undefined): string {
    return ms ? new Date(ms).toLocaleString() : 'Never';
  }

  function formatDate(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  async function readStorage() {
    if (estimateAvailable) {
      try {
        storageUsed = storageUsedText(await navigator.storage.estimate());
      } catch {
        storageUsed = null;
      }
    }
    if (persistAvailable && typeof navigator.storage.persisted === 'function') {
      try {
        persisted = await navigator.storage.persisted();
      } catch {
        persisted = undefined;
      }
    }
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      void readStorage();
      connection = (await getLibraryStore().getConnection()) ?? null;
      if (!connection) {
        diag = null;
        serverError = '';
        return;
      }
      const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
      diag = await fetchDiagnostics(connection, timeout);
      diagAt = Date.now();
      serverError = '';
    } catch (err) {
      // Keeps the last good figures (shown "as of" their time).
      serverError = serverErrorText(err);
    } finally {
      now = Date.now();
      loading = false;
    }
  }

  function onVisible() {
    if (document.visibilityState === 'visible') void refresh();
  }

  function onOnline() {
    void refresh();
  }

  onMount(() => {
    void refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
  });

  onDestroy(() => {
    subscription?.unsubscribe();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    }
  });
</script>

<div class="col-span-full" data-testid="diagnostics-panel">
  <div class="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
    <button
      type="button"
      class="c-btn c-btn-secondary"
      disabled={loading}
      on:click={refresh}
      data-testid="diag-refresh"
    >
      {loading ? 'Refreshing…' : 'Refresh'}
    </button>
    {#if diag}
      <span class="text-sm text-c-muted" data-testid="diag-as-of">
        Server figures as of {new Date(diagAt).toLocaleTimeString()}
      </span>
    {/if}
  </div>
  {#if serverError}
    <p class="c-notice mb-6" role="alert" data-testid="diag-error">{serverError}</p>
  {/if}
</div>

<SettingsSection jp="この端末" title="This device" testid="diag-section-device" />
<dl class="diag-list col-span-full">
  <dt>Opened at</dt>
  <dd class="break-all" data-testid="diag-origin">{origin}</dd>
  <dt>Library server</dt>
  <dd class="break-all" data-testid="diag-server-url">
    {connection ? connection.serverUrl : connection === null ? 'Not connected' : '…'}
  </dd>
  {#if thisName}
    <dt>Name</dt>
    <dd data-testid="diag-device-name">{thisName}</dd>
  {/if}
  <dt>Sync</dt>
  <dd data-testid="diag-sync">
    {#if sync}
      {SYNC_STATE_TEXT[sync.state]}
    {:else}
      {SYNC_STATE_TEXT.disconnected}
    {/if}
  </dd>
  <dt>Changes waiting</dt>
  <dd data-testid="diag-pending">{sync ? sync.pending : 0}</dd>
  <dt>Last successful sync</dt>
  <dd data-testid="diag-last-sync">
    {#if sync?.lastSyncAt}
      {formatTime(sync.lastSyncAt)}
      <span class="text-c-muted">({lastSeenText(sync.lastSyncAt, now)})</span>
    {:else}
      Never
    {/if}
  </dd>
  <dt>Storage used</dt>
  <dd data-testid="diag-storage">
    {#if !estimateAvailable}
      <span class="text-c-muted">{NOT_OVER_HTTP}</span>
    {:else if storageUsed === undefined}
      …
    {:else}
      {storageUsed ?? 'The browser gave no figure.'}
    {/if}
  </dd>
  <dt>Persistent storage</dt>
  <dd data-testid="diag-persist">
    {#if !persistAvailable}
      <span class="text-c-muted">{NOT_OVER_HTTP}</span>
    {:else if persisted === undefined}
      …
    {:else}
      {persisted ? 'Granted' : 'Not granted'}
    {/if}
  </dd>
  <dt>App version</dt>
  <dd data-testid="diag-app-version">
    {#if appBuilt}
      Built {appBuilt.toLocaleString()}
      <span class="break-all text-c-muted">({version})</span>
    {:else}
      {version}
    {/if}
  </dd>
</dl>

<SettingsSection
  jp="端末一覧"
  title="All devices"
  tooltip="Every device that has synced with the library server. Last seen is the last time it synced; a new pairing or a new address counts as a new device."
  testid="diag-section-devices"
/>
<div class="col-span-full">
  {#if connection === null}
    <p class="text-c-muted">{NOT_CONNECTED}</p>
  {:else if diag}
    {#if diag.devices.length}
      <dl class="diag-list" data-testid="diag-devices">
        {#each diag.devices as d (d.id)}
          <dt data-testid="diag-device">
            <span class="text-c-ink">{deviceName(d.name)}</span>{#if d.current}<span
                class="text-c-muted">{' (this device)'}</span
              >{/if}
            <span class="block text-xs" data-testid="diag-device-added">
              added {formatDate(d.createdAt)}
            </span>
          </dt>
          <dd>
            {#if d.lastSeenAt}
              {formatTime(d.lastSeenAt)}
              <span class="text-c-muted">({lastSeenText(d.lastSeenAt, now)})</span>
            {:else}
              Never
            {/if}
          </dd>
        {/each}
      </dl>
    {:else}
      <p class="text-c-muted">No devices yet.</p>
    {/if}
  {:else if !serverError}
    <p class="text-c-muted">Loading…</p>
  {/if}
</div>

<SettingsSection jp="パソコン" title="PC worker" testid="diag-section-worker" />
<div class="col-span-full">
  {#if connection === null}
    <p class="text-c-muted">{NOT_CONNECTED}</p>
  {:else if diag}
    <dl class="diag-list">
      <dt>State</dt>
      <dd data-testid="diag-worker-state">{pcWorkerStateText(diag.pcWorker)}</dd>
      {#if diag.pcWorker.available}
        <dt>Last seen</dt>
        <dd data-testid="diag-worker-last-seen">
          {#if diag.pcWorker.lastSeenAt}
            {formatTime(diag.pcWorker.lastSeenAt)}
            <span class="text-c-muted">({lastSeenText(diag.pcWorker.lastSeenAt, now)})</span>
          {:else}
            Never
          {/if}
        </dd>
        <dt>Current job</dt>
        <dd data-testid="diag-worker-job">{currentJobText(diag.pcWorker)}</dd>
        <dt>Waiting</dt>
        <dd data-testid="diag-worker-waiting">{diag.pcWorker.waiting}</dd>
        {#if diag.pcWorker.version}
          <dt>Worker version</dt>
          <dd>{diag.pcWorker.version}</dd>
        {/if}
      {/if}
    </dl>
  {:else if !serverError}
    <p class="text-c-muted">Loading…</p>
  {/if}
</div>

<SettingsSection jp="蔵書整理" title="Cleanup helper" testid="diag-section-helper" />
<div class="col-span-full">
  {#if connection === null}
    <p class="text-c-muted">{NOT_CONNECTED}</p>
  {:else if diag}
    <dl class="diag-list">
      <dt>Last seen</dt>
      <dd data-testid="diag-helper">
        {#if !diag.cleanupHelper.available}
          <span class="text-c-muted">The cleanup is off on the server.</span>
        {:else if diag.cleanupHelper.lastSeenAt}
          {formatTime(diag.cleanupHelper.lastSeenAt)}
          <span class="text-c-muted">({lastSeenText(diag.cleanupHelper.lastSeenAt, now)})</span>
        {:else}
          Never
        {/if}
      </dd>
    </dl>
  {:else if !serverError}
    <p class="text-c-muted">Loading…</p>
  {/if}
</div>

<SettingsSection
  jp="通知"
  title="Notifications"
  tooltip="Problems the server has told you about that are still there, and the last messages it sent (Settings > Notifications)."
  testid="diag-section-notifications"
/>
<div class="col-span-full">
  {#if connection === null}
    <p class="text-c-muted">{NOT_CONNECTED}</p>
  {:else if diag}
    {#if !diag.notifications?.available}
      <p class="pb-8 text-c-muted" data-testid="diag-notify-off">
        Notifications are off on the server{diag.notifications ? '' : ' (update the server)'}.
      </p>
    {:else}
      {#if diag.notifications.secretsUnreadable}
        <p class="c-notice mb-4" role="alert">
          A saved webhook address or app password can’t be read on the server any more: enter it
          again in Settings, Notifications.
        </p>
      {/if}
      <h3 class="mt-2 font-bold">Open problems</h3>
      {#if diag.notifications.openProblems.length}
        <ul class="flex max-w-3xl flex-col gap-3 py-3" data-testid="diag-open-problems">
          {#each diag.notifications.openProblems as p (p.event + p.since + (p.summary ?? ''))}
            <li data-testid="diag-open-problem">
              <span class="block">{p.summary ?? p.label}</span>
              <span class="block text-sm text-c-muted">since {formatTime(p.since)}</span>
              {#if p.detail}
                <span class="block break-words text-sm text-c-muted">{p.detail}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="py-3 text-c-muted" data-testid="diag-open-problems-none">None.</p>
      {/if}
      <h3 class="mt-4 font-bold">Sent</h3>
      {#if diag.notifications.log.length}
        <ul class="flex max-w-3xl flex-col gap-3 pb-8 pt-3" data-testid="diag-notify-log">
          {#each diag.notifications.log as row (row.id)}
            <li data-testid="diag-notify-log-row">
              <span class="block text-sm text-c-muted"
                >{formatTime(row.at)} · {CHANNEL_NAMES[row.channel]} · {logKindText(row.kind)}</span
              >
              <span class="block break-words">{firstLine(row.text)}</span>
              <span
                class="block break-words text-sm {row.status === 'failed'
                  ? 'text-c-seal'
                  : 'text-c-muted'}"
                data-testid="diag-notify-status">{logStatusText(row)}</span
              >
            </li>
          {/each}
        </ul>
      {:else}
        <p class="pb-8 pt-3 text-c-muted">Nothing sent yet.</p>
      {/if}
    {/if}
  {:else if !serverError}
    <p class="text-c-muted">Loading…</p>
  {/if}
</div>

<SettingsSection jp="サーバー" title="Server" testid="diag-section-server" />
<div class="col-span-full pb-8">
  {#if connection === null}
    <p class="text-c-muted">{NOT_CONNECTED}</p>
  {:else if diag}
    <dl class="diag-list">
      <dt>Version</dt>
      <dd data-testid="diag-server-version">
        {#if diag.server.builtAt}
          Built {formatTime(diag.server.builtAt)}
        {:else}
          {diag.server.version}
        {/if}
      </dd>
      <dt>Database version</dt>
      <dd data-testid="diag-schema">{diag.server.schemaVersion}</dd>
    </dl>
  {:else if !serverError}
    <p class="text-c-muted">Loading…</p>
  {/if}
</div>

<style>
  .diag-list {
    display: grid;
    grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr);
    column-gap: 1.5rem;
    row-gap: 0.5rem;
    max-width: 48rem;
    padding: 1rem 0 2rem;
  }

  .diag-list :global(dt) {
    color: var(--c-muted);
  }

  .diag-list :global(dd) {
    margin: 0;
    min-width: 0;
  }
</style>
