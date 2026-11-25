<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Calibre library cleanup (Phase 6, WP20a). Not linked from reading or catalogue views;
   * reached from Settings > Data. Three tabs: the Calibre cleanup, the audiobook cleanup (WP21a)
   * and the settings of both.
   *
   * Manga part B (2026-11-25): the cleanup works on each of its Calibre libraries (japanese-library
   * and manga-library), each with its own stages, Preview/On and Undo. The Cleanup tab shows them
   * by the device's choice (Settings > Data, cleanupLibrariesAs): a picker (a button per library,
   * the cleanup of the one picked, kept in the address as ?library=) or side by side (a column
   * per library; one after the other on phones). Each library's cleanup is cleanup-library.svelte.
   */
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import CataloguePageHeader from '$lib/components/catalogue-page-header.svelte';
  import CleanupAudiobooks from '$lib/components/cleanup/cleanup-audiobooks.svelte';
  import CleanupLibrary from '$lib/components/cleanup/cleanup-library.svelte';
  import CleanupSettings from '$lib/components/cleanup/cleanup-settings.svelte';
  import SettingsSection from '$lib/components/settings/settings-section.svelte';
  import {
    CleanupApi,
    type CleanupLibrarySummary,
    type CleanupStatus
  } from '$lib/cleanup/cleanup-api';
  import { n } from '$lib/cleanup/cleanup-text';
  import { pxScreen } from '$lib/css-classes';
  import { pagePath } from '$lib/data/env';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { LibraryApiError } from '$lib/library/api';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { cleanupLibrariesAs$, libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import { settingsTabHref } from '$lib/settings/settings-tab';

  /** How often the libraries' lines are asked for (the cards ask for their own status). */
  const LIBRARIES_POLL_MS = 10_000;

  type Tab = 'cleanup' | 'audiobooks' | 'settings';
  const TABS: { id: Tab; label: string }[] = [
    { id: 'cleanup', label: 'Cleanup' },
    { id: 'audiobooks', label: 'Audiobooks' },
    { id: 'settings', label: 'Settings' }
  ];
  let tab: Tab = 'cleanup';

  function tabFrom(value: string | null): Tab {
    return value === 'settings' || value === 'audiobooks' ? value : 'cleanup';
  }

  let connection: LibraryConnection | null | undefined;
  let api: CleanupApi | null = null;
  let libraries: CleanupLibrarySummary[] | null = null;
  /** The library picked (picker layout); null = the primary one. */
  let chosen: string | null = null;
  let loadError = '';
  let unavailable = '';
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The primary library's status, for the Settings tab (its library lists). */
  let settingsStatus: CleanupStatus | null = null;

  /** Each library's client, made once (a column or the picked library keeps its own). */
  const clients = new Map<string, CleanupApi>();
  function apiOf(libraryId: string): CleanupApi {
    let c = clients.get(libraryId);
    if (!c && api) {
      c = api.withLibrary(libraryId);
      clients.set(libraryId, c);
    }
    return c!;
  }

  $: shown =
    libraries === null
      ? null
      : (libraries.find((l) => l.id === chosen) ??
        libraries.find((l) => l.primary) ??
        libraries[0] ??
        null);
  $: columns = $cleanupLibrariesAs$ === 'columns' && (libraries?.length ?? 0) > 1;

  function href(next: Tab, library: string | null): string {
    const q = new URLSearchParams();
    if (next !== 'cleanup') q.set('tab', next);
    if (library) q.set('library', library);
    const s = q.toString();
    return `${pagePath}/cleanup${s ? `?${s}` : ''}`;
  }

  function go(next: Tab, library: string | null) {
    tab = next;
    chosen = library;
    const to = href(next, library);
    if (`${location.pathname}${location.search}` !== to) {
      void goto(to, { replaceState: true, keepFocus: true, noScroll: true });
    }
    if (next === 'settings') void loadSettingsStatus();
  }

  function pick(library: CleanupLibrarySummary) {
    go(tab, library.primary ? null : library.id);
  }

  onMount(async () => {
    tab = tabFrom($page.url.searchParams.get('tab'));
    chosen = $page.url.searchParams.get('library');
    connection = (await getLibraryStore().getConnection()) ?? null;
    if (!connection) return;
    const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
    api = new CleanupApi(connection.serverUrl, connection.token, timeout);
    await loadLibraries();
    if (tab === 'settings') await loadSettingsStatus();
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  async function loadLibraries() {
    if (!api || destroyed) return;
    clearTimeout(timer);
    try {
      libraries = (await api.libraries()).libraries;
      loadError = '';
    } catch (err) {
      // A server before manga part B, or the cleanup off: the status says which.
      try {
        const s = await api.status();
        if (!s.available)
          unavailable = `The library cleanup is off on the server: ${s.error ?? ''}`;
        else libraries = [];
      } catch {
        loadError = describe(err);
      }
    }
    if (!destroyed)
      timer = setTimeout(
        () => void loadLibraries(),
        document.visibilityState !== 'hidden' ? LIBRARIES_POLL_MS : LIBRARIES_POLL_MS * 6
      );
  }

  async function loadSettingsStatus() {
    if (!api) return;
    try {
      settingsStatus = await api.status();
    } catch (err) {
      loadError = describe(err);
    }
  }

  /** "58,812 books · 5 of 5 stages On · paused" */
  function summary(l: CleanupLibrarySummary): string {
    const modes =
      l.on === 0 && l.preview === 0
        ? 'every stage Off'
        : `${l.on} of 5 stages On${l.preview ? `, ${l.preview} in Preview` : ''}`;
    return `${n(l.present)} books · ${modes}${l.paused ? ' · paused' : ''}`;
  }
</script>

<svelte:head>
  <title>{formatPageTitle('Library cleanup')}</title>
</svelte:head>

<AppHeader title="Library cleanup" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="cleanup-page">
  <CataloguePageHeader jp="蔵書整理" title="Library cleanup">
    <a
      slot="back"
      class="c-link inline-flex min-h-[3rem] items-center gap-2 text-sm"
      href={settingsTabHref(pagePath, 'Data')}
    >
      ← Settings
    </a>
  </CataloguePageHeader>

  {#if connection === null}
    <p class="c-notice">Connect this device to the library server first (Settings &gt; Data).</p>
  {:else if unavailable}
    <p class="c-notice" role="alert">{unavailable}</p>
  {:else if loadError && libraries === null}
    <p class="c-notice" role="alert">{loadError}</p>
  {:else if libraries === null || !api}
    <p class="c-rule-text text-sm text-c-muted">Loading…</p>
  {:else}
    {#if loadError}<p class="c-notice" role="alert">{loadError}</p>{/if}

    <div class="mt-2 flex flex-wrap gap-2" role="tablist" aria-label="Library cleanup">
      {#each TABS as t (t.id)}
        <button
          class="c-btn {tab === t.id ? 'c-btn-primary' : 'c-btn-secondary'}"
          role="tab"
          aria-selected={tab === t.id}
          on:click={() => go(t.id, chosen)}
          data-testid="cleanup-tab-{t.id}"
        >
          {t.label}
        </button>
      {/each}
    </div>

    {#if tab === 'cleanup'}
      {#if libraries.length === 0}
        <p class="mt-6 max-w-prose text-sm">No library chosen yet (the Settings tab).</p>
      {:else if columns}
        <div class="grid grid-cols-1 gap-x-8 xl:grid-cols-2" data-testid="cleanup-columns">
          {#each libraries as l (l.id)}
            <div class="min-w-0" data-testid="cleanup-column-{l.folder}">
              <h2 class="mt-6 font-mincho text-xl font-bold">{l.name}</h2>
              <p class="text-sm text-c-muted">{summary(l)}</p>
              <CleanupLibrary api={apiOf(l.id)} primary={l.primary} />
            </div>
          {/each}
        </div>
      {:else}
        {#if libraries.length > 1}
          <div
            class="mt-4 flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Library"
            data-testid="cleanup-library-picker"
          >
            <span class="text-sm text-c-muted">Library</span>
            {#each libraries as l (l.id)}
              <button
                class="c-btn c-btn-secondary flex-col items-start !py-1 text-left"
                aria-pressed={shown?.id === l.id}
                on:click={() => pick(l)}
                data-testid="cleanup-pick-{l.folder}"
              >
                <span class="font-bold">{l.name}</span>
                <span class="text-xs text-c-muted">{summary(l)}</span>
              </button>
            {/each}
          </div>
        {:else if shown}
          <p class="mt-6 max-w-prose text-sm">
            Library: <b>{shown.name}</b> ({n(shown.present)} books in the reader’s index).
          </p>
        {/if}
        {#if shown}
          {#key shown.id}
            <CleanupLibrary api={apiOf(shown.id)} primary={shown.primary} />
          {/key}
        {/if}
      {/if}
    {:else if tab === 'audiobooks'}
      <CleanupAudiobooks {api} />
    {:else}
      <section class="mt-6 flex flex-col gap-3" data-testid="cleanup-settings-tab">
        <SettingsSection jp="設定" title="Settings" />
        {#if settingsStatus}
          <CleanupSettings
            {api}
            libraries={settingsStatus.libraries}
            calibre={settingsStatus.calibre}
            on:saved={() => {
              void loadSettingsStatus();
              void loadLibraries();
            }}
          />
        {:else}
          <p class="c-rule-text text-sm text-c-muted">Loading…</p>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<AppBottomBar />
