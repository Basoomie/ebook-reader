<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import { version } from '$app/environment';
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import SettingRow from '$lib/components/settings/setting-row.svelte';
  import PagedList from '$lib/components/settings/paged-list.svelte';
  import { compareText, type ListFilter, type ListSort } from '$lib/settings/paged-list';
  import {
    fetchDiagnostics,
    type DiagnosticsNotificationLog,
    type DiagnosticsResponse
  } from '$lib/diagnostics/diagnostics-api';
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

  type Device = DiagnosticsResponse['devices'][number];
  type LogRow = DiagnosticsNotificationLog;

  const deviceSorts: ListSort<Device>[] = [
    {
      id: 'seen',
      label: 'Last seen',
      compare: (a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
    },
    {
      id: 'name',
      label: 'Name',
      compare: (a, b) => compareText(deviceName(a.name), deviceName(b.name))
    },
    { id: 'added', label: 'Added', compare: (a, b) => b.createdAt - a.createdAt }
  ];
  const WEEK_MS = 7 * 86_400_000;
  const MONTH_MS = 30 * 86_400_000;
  $: deviceFilters = [
    { id: 'all', label: 'All', test: () => true },
    {
      id: 'week',
      label: 'Seen this week',
      test: (d: Device) => !!d.lastSeenAt && now - d.lastSeenAt < WEEK_MS
    },
    {
      id: 'old',
      label: 'Not seen for a month',
      test: (d: Device) => !d.lastSeenAt || now - d.lastSeenAt > MONTH_MS
    }
  ] as ListFilter<Device>[];

  const logFilters: ListFilter<LogRow>[] = [
    { id: 'all', label: 'All', test: () => true },
    { id: 'failed', label: 'Failed', test: (r) => r.status === 'failed' }
  ];
</script>

<div class="flex flex-col gap-10" data-testid="diagnostics-panel">
  <div>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <button
        type="button"
        class="c-btn c-btn-secondary"
        disabled={loading}
        on:click={refresh}
        data-testid="diag-refresh"
        id="setting-diag-refresh"
      >
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
      {#if diag}
        <span class="text-sm text-c-muted" data-testid="diag-as-of">
          Server figures as of {new Date(diagAt).toLocaleTimeString()}
        </span>
      {/if}
      <span class="text-sm text-c-muted">Read-only: nothing here changes a setting.</span>
    </div>
    {#if serverError}
      <p class="c-notice mt-3" role="alert" data-testid="diag-error">{serverError}</p>
    {/if}
  </div>

  <SettingsGroup id="diag-device" testid="diag-section-device">
    <SettingRow title="Opened at" layout="info">
      <span class="break-all" data-testid="diag-origin">{origin}</span>
    </SettingRow>
    <SettingRow title="Library server" layout="info">
      <span class="break-all" data-testid="diag-server-url">
        {connection ? connection.serverUrl : connection === null ? 'Not connected' : '…'}
      </span>
    </SettingRow>
    {#if thisName}
      <SettingRow title="Name" layout="info">
        <span data-testid="diag-device-name">{thisName}</span>
      </SettingRow>
    {/if}
    <SettingRow title="Sync" layout="info">
      <span data-testid="diag-sync">
        {#if sync}
          {SYNC_STATE_TEXT[sync.state]}
        {:else}
          {SYNC_STATE_TEXT.disconnected}
        {/if}
      </span>
    </SettingRow>
    <SettingRow title="Changes waiting" layout="info">
      <span data-testid="diag-pending">{sync ? sync.pending : 0}</span>
    </SettingRow>
    <SettingRow title="Last successful sync" layout="info">
      <span data-testid="diag-last-sync">
        {#if sync?.lastSyncAt}
          {formatTime(sync.lastSyncAt)}
          <span class="text-c-muted">({lastSeenText(sync.lastSyncAt, now)})</span>
        {:else}
          Never
        {/if}
      </span>
    </SettingRow>
    <SettingRow title="Storage used" layout="info">
      <span data-testid="diag-storage">
        {#if !estimateAvailable}
          <span class="text-c-muted">{NOT_OVER_HTTP}</span>
        {:else if storageUsed === undefined}
          …
        {:else}
          {storageUsed ?? 'The browser gave no figure.'}
        {/if}
      </span>
    </SettingRow>
    <SettingRow title="Persistent storage" layout="info">
      <span data-testid="diag-persist">
        {#if !persistAvailable}
          <span class="text-c-muted">{NOT_OVER_HTTP}</span>
        {:else if persisted === undefined}
          …
        {:else}
          {persisted ? 'Granted' : 'Not granted'}
        {/if}
      </span>
    </SettingRow>
    <SettingRow title="App version" layout="info">
      <span data-testid="diag-app-version">
        {#if appBuilt}
          Built {appBuilt.toLocaleString()}
          <span class="break-all text-c-muted">({version})</span>
        {:else}
          {version}
        {/if}
      </span>
    </SettingRow>
  </SettingsGroup>

  <SettingsGroup id="diag-devices" testid="diag-section-devices">
    {#if connection === null}
      <p class="s-note">{NOT_CONNECTED}</p>
    {:else if diag}
      {#if diag.devices.length}
        <PagedList
          items={diag.devices}
          pageSize={10}
          text={(d) => deviceName(d.name)}
          searchLabel="Search devices"
          sorts={deviceSorts}
          filters={deviceFilters}
          label="Devices"
          testid="diag-devices-pages"
          let:rows
        >
          <ul data-testid="diag-devices">
            {#each rows as d (d.id)}
              <li class="s-item" data-testid="diag-device">
                <div class="s-item-main">
                  <span class="s-item-title">{deviceName(d.name)}</span>
                  {#if d.current}<span class="c-count ml-2">This device</span>{/if}
                  <span class="s-item-meta block" data-testid="diag-device-added">
                    added {formatDate(d.createdAt)}
                  </span>
                </div>
                <div class="text-sm">
                  {#if d.lastSeenAt}
                    <span class="block sm:text-right">{lastSeenText(d.lastSeenAt, now)}</span>
                    <span class="block text-xs text-c-muted sm:text-right"
                      >{formatTime(d.lastSeenAt)}</span
                    >
                  {:else}
                    Never seen
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        </PagedList>
      {:else}
        <p class="s-note">No devices yet.</p>
      {/if}
    {:else if !serverError}
      <p class="s-note">Loading…</p>
    {/if}
  </SettingsGroup>

  <SettingsGroup id="diag-worker" testid="diag-section-worker">
    {#if connection === null}
      <p class="s-note">{NOT_CONNECTED}</p>
    {:else if diag}
      <SettingRow title="State" layout="info">
        <span data-testid="diag-worker-state">{pcWorkerStateText(diag.pcWorker)}</span>
      </SettingRow>
      {#if diag.pcWorker.available}
        <SettingRow title="Last seen" layout="info">
          <span data-testid="diag-worker-last-seen">
            {#if diag.pcWorker.lastSeenAt}
              {formatTime(diag.pcWorker.lastSeenAt)}
              <span class="text-c-muted">({lastSeenText(diag.pcWorker.lastSeenAt, now)})</span>
            {:else}
              Never
            {/if}
          </span>
        </SettingRow>
        <SettingRow title="Current job" layout="info">
          <span data-testid="diag-worker-job">{currentJobText(diag.pcWorker)}</span>
        </SettingRow>
        <SettingRow title="Waiting" layout="info">
          <span data-testid="diag-worker-waiting">{diag.pcWorker.waiting}</span>
        </SettingRow>
        {#if diag.pcWorker.version}
          <SettingRow title="Worker version" layout="info">
            <span>{diag.pcWorker.version}</span>
          </SettingRow>
        {/if}
      {/if}
    {:else if !serverError}
      <p class="s-note">Loading…</p>
    {/if}
  </SettingsGroup>

  <SettingsGroup id="diag-helper" testid="diag-section-helper">
    {#if connection === null}
      <p class="s-note">{NOT_CONNECTED}</p>
    {:else if diag}
      <SettingRow title="Last seen" layout="info">
        <span data-testid="diag-helper">
          {#if !diag.cleanupHelper.available}
            <span class="text-c-muted">The cleanup is off on the server.</span>
          {:else if diag.cleanupHelper.lastSeenAt}
            {formatTime(diag.cleanupHelper.lastSeenAt)}
            <span class="text-c-muted">({lastSeenText(diag.cleanupHelper.lastSeenAt, now)})</span>
          {:else}
            Never
          {/if}
        </span>
      </SettingRow>
    {:else if !serverError}
      <p class="s-note">Loading…</p>
    {/if}
  </SettingsGroup>

  <SettingsGroup id="diag-notify" testid="diag-section-notifications">
    {#if connection === null}
      <p class="s-note">{NOT_CONNECTED}</p>
    {:else if diag}
      {#if !diag.notifications?.available}
        <p class="s-note" data-testid="diag-notify-off">
          Notifications are off on the server{diag.notifications ? '' : ' (update the server)'}.
        </p>
      {:else}
        {#if diag.notifications.secretsUnreadable}
          <p class="c-notice mx-4 sm:mx-5" role="alert">
            A saved webhook address or app password can’t be read on the server any more: enter it
            again in Settings, Notifications.
          </p>
        {/if}
        <div id="setting-diag-open-problems">
          <p class="s-subhead">
            Open problems
            {#if diag.notifications.openProblems.length}
              <span class="c-count">{diag.notifications.openProblems.length}</span>
            {/if}
          </p>
          {#if diag.notifications.openProblems.length}
            <PagedList
              items={diag.notifications.openProblems}
              pageSize={5}
              label="Open problems"
              let:rows
            >
              <ul data-testid="diag-open-problems">
                {#each rows as p (p.event + p.since + (p.summary ?? ''))}
                  <li class="s-item" data-testid="diag-open-problem">
                    <div class="s-item-main">
                      <span class="block">{p.summary ?? p.label}</span>
                      <span class="s-item-meta block">since {formatTime(p.since)}</span>
                      {#if p.detail}
                        <details class="s-detail">
                          <summary>Details</summary>
                          <p class="whitespace-pre-wrap break-words text-sm text-c-muted">
                            {p.detail}
                          </p>
                        </details>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            </PagedList>
          {:else}
            <p class="s-note pt-0" data-testid="diag-open-problems-none">None.</p>
          {/if}
        </div>
        <div id="setting-diag-sent">
          <p class="s-subhead">Sent messages</p>
          {#if diag.notifications.log.length}
            <PagedList
              items={diag.notifications.log}
              pageSize={10}
              text={(row) => `${firstLine(row.text)} ${logKindText(row.kind)}`}
              searchLabel="Search sent messages"
              filters={logFilters}
              label="Sent messages"
              testid="diag-notify-log-pages"
              let:rows
            >
              <ul data-testid="diag-notify-log">
                {#each rows as row (row.id)}
                  <li class="s-item" data-testid="diag-notify-log-row">
                    <div class="s-item-main">
                      <span class="s-item-meta block"
                        >{formatTime(row.at)} · {CHANNEL_NAMES[row.channel]} · {logKindText(
                          row.kind
                        )}</span
                      >
                      <span class="block">{firstLine(row.text)}</span>
                      <!-- Failed: bold ink with a mark (the red was under 4.5:1 on the dark card). -->
                      <span
                        class="block text-sm {row.status === 'failed'
                          ? 'font-semibold text-c-ink'
                          : 'text-c-muted'}"
                        data-testid="diag-notify-status"
                        >{row.status === 'failed' ? '⚠ ' : ''}{logStatusText(row)}</span
                      >
                    </div>
                  </li>
                {/each}
              </ul>
            </PagedList>
          {:else}
            <p class="s-note pt-0">Nothing sent yet.</p>
          {/if}
        </div>
      {/if}
    {:else if !serverError}
      <p class="s-note">Loading…</p>
    {/if}
  </SettingsGroup>

  <SettingsGroup id="diag-server" testid="diag-section-server">
    {#if connection === null}
      <p class="s-note">{NOT_CONNECTED}</p>
    {:else if diag}
      <SettingRow title="Version" layout="info">
        <span data-testid="diag-server-version">
          {#if diag.server.builtAt}
            Built {formatTime(diag.server.builtAt)}
          {:else}
            {diag.server.version}
          {/if}
        </span>
      </SettingRow>
      <SettingRow title="Database version" layout="info">
        <span data-testid="diag-schema">{diag.server.schemaVersion}</span>
      </SettingRow>
    {:else if !serverError}
      <p class="s-note">Loading…</p>
    {/if}
  </SettingsGroup>
</div>

<style>
  .s-note {
    padding: 0.875rem 1rem;
    font-size: 0.875rem;
    color: var(--c-muted);
  }

  .s-subhead {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.875rem 1rem 0.5rem;
    font-weight: 600;
  }

  @media (min-width: 640px) {
    .s-note,
    .s-subhead {
      padding-left: 1.25rem;
      padding-right: 1.25rem;
    }
  }

  .s-detail > summary {
    display: inline-flex;
    align-items: center;
    min-height: 2.75rem;
    color: var(--c-link);
    font-size: 0.8125rem;
    cursor: pointer;
  }
</style>
