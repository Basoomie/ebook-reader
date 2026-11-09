<script lang="ts">
  import MigrationBookCard from '$lib/components/migration/migration-book-card.svelte';
  import { mergeEntries } from '$lib/components/merged-header-icon/merged-entries';
  import MergedHeaderIcon from '$lib/components/merged-header-icon/merged-header-icon.svelte';
  import { baseHeaderClasses, pxScreen } from '$lib/css-classes';
  import { pagePath } from '$lib/data/env';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { LibraryApi } from '$lib/library/api';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import type {
    CheckResult,
    ImportResult,
    MigrationApi,
    MigrationOverview
  } from '$lib/migration/api';
  import { formatWhen, methodText } from '$lib/migration/describe';
  import {
    becomeSettingsSourceHere,
    getMigrationApi,
    reportDevice,
    setLegacySyncEnabled,
    settingsSourceState
  } from '$lib/sync/sync-service';
  import { legacyReadingSyncOff$ } from '$lib/sync/legacy-switch';
  import { onDestroy, onMount } from 'svelte';

  /**
   * Migration off the old file sync (WP5). One page per step, top to bottom:
   * devices report what they hold, the server checks every old-sync book
   * against the library, you decide the ones it can't verify, import, pick
   * the desktop as the source of shared settings, check, and finally switch
   * the old sync off yourself. Nothing here runs on its own.
   */

  const bigButton =
    'min-h-[48px] rounded border-2 border-current px-4 py-2 font-medium disabled:opacity-50';

  let connection: LibraryConnection | null | undefined;
  let api: MigrationApi | null = null;
  let libraryApi: LibraryApi | null = null;
  let overview: MigrationOverview | null = null;
  let loadError = '';
  let actionError = '';
  let busy = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  let thisDeviceId = '';
  let sourceId: string | null = null;
  let reportState = '';
  let importResult: ImportResult | null = null;
  let confirmSource = false;
  let confirmSwitch: { check: CheckResult | null; error: string } | null = null;

  $: books = overview?.books ?? [];
  $: needsYou = books.filter((b) => b.state === 'needs_user');
  $: later = books.filter((b) => b.state === 'deferred');
  $: linked = books.filter((b) => b.state === 'linked');
  $: notImported = linked.filter((b) => !b.importedAt);
  $: sourceName = overview?.devices.find((d) => d.id === sourceId)?.name ?? 'another device';

  onMount(async () => {
    connection = (await getLibraryStore().getConnection()) ?? null;
    if (!connection) return;
    api = await getMigrationApi();
    libraryApi = new LibraryApi(
      connection.serverUrl,
      connection.token,
      Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0)
    );
    await refresh();
    void report(true);
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(pollTimer);
  });

  async function refresh() {
    if (!api) return;
    try {
      overview = await api.overview();
      ({ deviceId: thisDeviceId, sourceId } = await settingsSourceState());
      loadError = '';
    } catch (error) {
      loadError = (error as Error)?.message ?? String(error);
    }
    clearTimeout(pollTimer);
    if (overview?.scan.running && !destroyed) pollTimer = setTimeout(refresh, 2000);
  }

  async function act(fn: () => unknown) {
    busy = true;
    actionError = '';
    try {
      await fn();
    } catch (error) {
      actionError = (error as Error)?.message ?? String(error);
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function report(quiet = false) {
    reportState = 'Reporting…';
    try {
      await reportDevice();
      reportState = `Reported ${formatWhen(Date.now())}.`;
      if (!quiet) await refresh();
    } catch (error) {
      reportState = `Could not report: ${(error as Error)?.message ?? error}`;
    }
  }

  const thumb = (relative: string | null) =>
    relative && libraryApi ? libraryApi.absolute(relative) : '';

  const search = async (q: string) => (await libraryApi!.books({ q, limit: 20 })).books;

  async function openSwitchConfirm() {
    confirmSwitch = { check: null, error: '' };
    try {
      confirmSwitch = { check: await api!.check(), error: '' };
    } catch (error) {
      confirmSwitch = { check: null, error: (error as Error)?.message ?? String(error) };
    }
  }
</script>

<svelte:head>
  <title>{formatPageTitle('Migration')}</title>
</svelte:head>

<div class="elevation-4 fixed inset-x-0 top-0 z-10">
  <div class={baseHeaderClasses}>
    <div class="{pxScreen} flex h-full items-center justify-between">
      <h1 class="text-lg font-medium">Migration</h1>
      <MergedHeaderIcon items={[mergeEntries.MANAGE, mergeEntries.LIBRARY]} />
    </div>
  </div>
</div>

<div class="{pxScreen} max-w-3xl pb-16 pt-16 xl:pt-14">
  {#if connection === undefined}
    <p class="py-8">Loading…</p>
  {:else if connection === null}
    <p class="py-8">
      Connect this device to the server first, on the
      <a class="underline" href="{pagePath}/library">Library page</a>.
    </p>
  {:else}
    <p class="py-3 text-sm">
      Moves your books, places and statistics from the old file sync to the new sync. The old sync
      keeps running next to it until you switch it off at the end of this page. The migration itself
      only reads the old sync's files on the NAS; it never changes them.
    </p>
    {#if loadError}
      <p class="py-2 font-medium" role="alert">{loadError}</p>
    {/if}
    {#if actionError}
      <p class="py-2 font-medium" role="alert">{actionError}</p>
    {/if}

    {#if overview}
      <!-- 1. Devices -->
      <section class="mt-4">
        <h2 class="text-lg font-medium">1. Devices</h2>
        <p class="text-sm">
          Each device reports the books it opened from the library, so those are matched exactly.
          Open this page once on every device (or just use it; it reports in the background).
        </p>
        <ul class="mt-2 text-sm">
          {#each overview.devices as d (d.id)}
            <li class="border-b border-gray-400/40 py-2">
              <span class="font-medium">{d.name}</span>{d.id === thisDeviceId
                ? ' (this device)'
                : ''}
              — {d.reportedAt ? `reported ${formatWhen(d.reportedAt)}` : 'not reported yet'}
              {#if d.localOnlyTitles.length}
                <div class="mt-1">
                  Only on this device, not in the old sync (open each there once so the old sync
                  uploads it, then check again): {d.localOnlyTitles.join('、')}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
        <div class="mt-2 flex items-center gap-3">
          <button class={bigButton} disabled={busy} on:click={() => report()}>
            Report this device now
          </button>
          <span class="text-sm">{reportState}</span>
        </div>
      </section>

      <!-- 2. Check books against the library -->
      <section class="mt-8">
        <h2 class="text-lg font-medium">2. Match books to the library</h2>
        {#if !overview.calibreAvailable}
          <p class="text-sm">The Calibre library is not available on the server right now.</p>
        {/if}
        <p class="text-sm">
          Last checked: {formatWhen(overview.lastScanAt)}.
          {#if books.length}
            {books.length} books in the old sync: {linked.length} linked, {needsYou.length} need you,
            {later.length} decided later.
          {/if}
        </p>
        {#if overview.scan.running}
          <p class="text-sm font-medium">
            Checking… {overview.scan.done} of {overview.scan.total || '?'}
          </p>
        {:else if overview.scan.error}
          <p class="text-sm font-medium" role="alert">The check failed: {overview.scan.error}</p>
        {/if}
        <button
          class="{bigButton} mt-2"
          disabled={busy || overview.scan.running || !overview.calibreAvailable}
          on:click={() => act(() => api?.scan())}
        >
          {overview.lastScanAt ? 'Check again' : 'Check books'}
        </button>
      </section>

      {#if needsYou.length}
        <section class="mt-8">
          <h2 class="text-lg font-medium">Needs you ({needsYou.length})</h2>
          <ul class="mt-2 flex flex-col gap-3">
            {#each needsYou as book (book.folder)}
              <MigrationBookCard
                {book}
                {busy}
                {thumb}
                {search}
                on:link={(e) => act(() => api?.link(e.detail.folder, e.detail.bookId))}
                on:defer={(e) => act(() => api?.defer(e.detail.folder))}
              />
            {/each}
          </ul>
        </section>
      {/if}

      {#if later.length}
        <details class="mt-6">
          <summary class="cursor-pointer font-medium">Decided later ({later.length})</summary>
          <p class="text-sm">
            These stay on the old sync only. Add the EPUB to Calibre, then press "Check again".
          </p>
          <ul class="mt-2 flex flex-col gap-3">
            {#each later as book (book.folder)}
              <MigrationBookCard
                {book}
                {busy}
                {thumb}
                {search}
                on:link={(e) => act(() => api?.link(e.detail.folder, e.detail.bookId))}
              />
            {/each}
          </ul>
        </details>
      {/if}

      {#if linked.length}
        <details class="mt-6">
          <summary class="cursor-pointer font-medium">Linked ({linked.length})</summary>
          <ul class="mt-2 text-sm">
            {#each linked as book (book.folder)}
              <li class="flex items-center gap-3 border-b border-gray-400/40 py-2">
                <div class="min-w-0 grow">
                  <div class="font-medium">{book.title}</div>
                  <div class="opacity-75">
                    → {book.book?.title ?? book.bookId} · {methodText(book.method)}{book.importedAt
                      ? ' · imported'
                      : ''}
                  </div>
                  {#if book.details.conflictBookIds?.length}
                    <div>A device reports a different library book for this title.</div>
                  {/if}
                </div>
                {#if !book.importedAt}
                  <button
                    class={bigButton}
                    disabled={busy}
                    on:click={() => act(() => api?.unlink(book.folder))}
                  >
                    Unlink
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        </details>
      {/if}

      <!-- 3. Import -->
      <section class="mt-8">
        <h2 class="text-lg font-medium">3. Import</h2>
        <p class="text-sm">
          Copies the old place and statistics of every linked book into the new sync. A backup of
          the server database is made first. You can run it again (for example after linking more
          books); newer data is never overwritten. Last import: {formatWhen(overview.lastImportAt)}.
        </p>
        <button
          class="{bigButton} mt-2"
          disabled={busy || !linked.length || overview.scan.running}
          on:click={() => act(async () => (importResult = (await api?.import()) ?? null))}
        >
          Import {notImported.length ? `${notImported.length} new` : ''} linked books
        </button>
        {#if importResult}
          <p class="mt-2 text-sm">
            Imported {importResult.books} books: {importResult.positions} places and
            {importResult.statDays} reading days were new. Backup: {importResult.snapshot}.
          </p>
        {/if}
      </section>

      <!-- 4. Shared settings -->
      <section class="mt-8">
        <h2 class="text-lg font-medium">4. Shared settings</h2>
        <p class="text-sm">
          A few settings are shared by all devices (custom themes, day start hour, statistics on
          completion and deletion) together with your reading goals. Do this on the desktop: its
          values become the shared ones, and the other devices take them over.
        </p>
        {#if sourceId === thisDeviceId}
          <p class="mt-2 text-sm font-medium">This device is the source of the shared settings.</p>
        {:else if sourceId}
          <p class="mt-2 text-sm font-medium">{sourceName} is the source of the shared settings.</p>
        {:else if confirmSource}
          <div class="mt-2 border-2 border-current p-3 text-sm">
            <p>
              Use this device's values for all devices? Other devices replace theirs on their next
              sync.
            </p>
            <div class="mt-2 flex gap-2">
              <button
                class={bigButton}
                disabled={busy}
                on:click={() =>
                  act(async () => {
                    await becomeSettingsSourceHere();
                    confirmSource = false;
                  })}
              >
                Use this device's settings
              </button>
              <button class={bigButton} on:click={() => (confirmSource = false)}>Cancel</button>
            </div>
          </div>
        {:else}
          <button class="{bigButton} mt-2" on:click={() => (confirmSource = true)}>
            Use this device's shared settings…
          </button>
        {/if}
      </section>

      <!-- 5. Check -->
      <section class="mt-8">
        <h2 class="text-lg font-medium">5. Check</h2>
        <p class="text-sm">
          Read normally for about a week with both syncs running, then compare the old and the new
          data per book.
        </p>
        <a class="{bigButton} mt-2 inline-flex items-center" href="{pagePath}/migration/check">
          Open the check page
        </a>
      </section>

      <!-- 6. The old sync -->
      <section class="mt-8">
        <h2 class="text-lg font-medium">6. The old sync</h2>
        <p class="text-sm">
          The old sync is <span class="font-medium">{$legacyReadingSyncOff$ ? 'off' : 'on'}</span>.
          Switching it off stops it for places, statistics and reading goals on every device (each
          after its next sync). Whispersync keeps using it as today (audiobook position, subtitles
          and the matched book files it uploads when you save a match). Its files on the NAS
          otherwise stay as they are, so you can switch it back on at any time.
        </p>
        {#if !$legacyReadingSyncOff$}
          {#if confirmSwitch}
            <div class="mt-2 border-2 border-current p-3 text-sm">
              {#if confirmSwitch.error}
                <p role="alert">The check could not run: {confirmSwitch.error}</p>
              {:else if !confirmSwitch.check}
                <p>Checking old and new data…</p>
              {:else if confirmSwitch.check.allMatch}
                <p class="font-medium">
                  All match ({confirmSwitch.check.books.length} books).
                </p>
              {:else}
                <p class="font-medium">
                  {confirmSwitch.check.differences} books differ. See the
                  <a class="underline" href="{pagePath}/migration/check">check page</a>. Switch off
                  anyway?
                </p>
              {/if}
              <div class="mt-2 flex gap-2">
                <button
                  class={bigButton}
                  disabled={busy || (!confirmSwitch.check && !confirmSwitch.error)}
                  on:click={() =>
                    act(async () => {
                      await setLegacySyncEnabled(false);
                      confirmSwitch = null;
                    })}
                >
                  Switch the old sync off
                </button>
                <button class={bigButton} on:click={() => (confirmSwitch = null)}>Cancel</button>
              </div>
            </div>
          {:else}
            <button class="{bigButton} mt-2" disabled={busy} on:click={openSwitchConfirm}>
              Switch the old sync off…
            </button>
          {/if}
        {:else}
          <button
            class="{bigButton} mt-2"
            disabled={busy}
            on:click={() => act(() => setLegacySyncEnabled(true))}
          >
            Switch the old sync back on
          </button>
        {/if}
      </section>
    {/if}
  {/if}
</div>
