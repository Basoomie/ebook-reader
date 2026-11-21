<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Settings > Audiobooks (WP15b): the server's audiobooks folder (what the last scan
   * found, Scan again), the books with a linked audiobook (problems first) and the books
   * marked "No audiobook". (WP15e removed the empty "From the old sync" section: WP15d was
   * dropped.) Linking itself happens on each book's details page. Read-only towards
   * the audiobooks folder. Polling stops when the tab is left (the panel is destroyed).
   * WP16: "Subtitles made on the PC" (gpu-worker-section.svelte) after the folder.
   */
  import GpuWorkerSection from '$lib/components/audio/gpu-worker-section.svelte';
  import TtsModelsSection from '$lib/components/audio/tts-models-section.svelte';
  import SpeakerModelsSection from '$lib/components/audio/speaker-models-section.svelte';
  import PronunciationFixesSection from '$lib/components/audio/pronunciation-fixes-section.svelte';
  import VoicesSection from '$lib/components/audio/voices-section.svelte';
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import SettingRow from '$lib/components/settings/setting-row.svelte';
  import PagedList from '$lib/components/settings/paged-list.svelte';
  import { compareText, type ListFilter, type ListSort } from '$lib/settings/paged-list';
  import {
    folderDetails,
    linkMarks,
    linkedFolderName,
    linkedSubtitleName,
    scanBusy,
    scanStatusText,
    subtitleView
  } from '$lib/audio/audio-link';
  import type { AudioLinkListEntry, AudioStatus } from '$lib/audio/audio-types';
  import { pagePath } from '$lib/data/env';
  import { LibraryApi, LibraryApiError } from '$lib/library/api';
  import { plural } from '$lib/library/format';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import { formatWhen } from '$lib/notes/notes-format';
  import { onDestroy, onMount } from 'svelte';

  /** How often the panel asks again while a scan is asked for or running. */
  const POLL_MS = 3000;

  const store = getLibraryStore();

  let connection: LibraryConnection | null | undefined;
  let api: LibraryApi | undefined;
  let status: AudioStatus | null = null;
  let links: AudioLinkListEntry[] = [];
  let loading = true;
  let error = '';
  let scanError = '';
  let scanning = false;
  let destroyed = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  // One list of the books (linked, and marked "No audiobook"), searched, filtered and
  // sorted in pages: the server sends them problems first, then by title.
  let bookFilter = 'linked';
  $: linked = links.filter((l) => l.state === 'linked');
  $: none = links.filter((l) => l.state === 'none');
  $: listed = [...linked, ...none];
  $: if (!linked.length && none.length && bookFilter === 'linked') bookFilter = 'none';
  $: serverOrder = new Map(listed.map((l, i) => [l.bookId, i]));
  $: busy = scanning || scanBusy(status);

  const titleOf = (l: AudioLinkListEntry) => l.book?.title ?? l.bookId;

  const bookFilters: ListFilter<AudioLinkListEntry>[] = [
    { id: 'linked', label: 'Linked', test: (l) => l.state === 'linked' },
    {
      id: 'problems',
      label: 'Problems',
      test: (l) => l.state === 'linked' && linkMarks(l).length > 0
    },
    {
      id: 'none',
      label: 'No audiobook',
      test: (l) => l.state === 'none',
      testid: 'audiobooks-none-toggle'
    }
  ];

  $: bookSorts = [
    {
      id: 'server',
      label: 'Problems first',
      compare: (a, b) => (serverOrder.get(a.bookId) ?? 0) - (serverOrder.get(b.bookId) ?? 0)
    },
    { id: 'title', label: 'Title', compare: (a, b) => compareText(titleOf(a), titleOf(b)) },
    {
      id: 'folder',
      label: 'Folder',
      compare: (a, b) => compareText(linkedFolderName(a), linkedFolderName(b))
    }
  ] as ListSort<AudioLinkListEntry>[];

  function bookText(l: AudioLinkListEntry): string {
    return l.state === 'linked'
      ? `${titleOf(l)} ${linkedFolderName(l)} ${subtitleLine(l)}`
      : titleOf(l);
  }

  onMount(async () => {
    connection = (await store.getConnection()) ?? null;
    if (!connection) {
      loading = false;
      return;
    }
    const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
    api = new LibraryApi(connection.serverUrl, connection.token, timeout);
    await load();
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(pollTimer);
  });

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  async function load() {
    if (!api) return;
    try {
      const [s, l] = await Promise.all([api.audioStatus(), api.audioLinks()]);
      if (destroyed) return;
      status = s;
      links = l;
      error = '';
    } catch (err) {
      if (!destroyed) error = describe(err);
    } finally {
      loading = false;
    }
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (destroyed || !scanBusy(status)) return;
    pollTimer = setTimeout(() => void load(), POLL_MS);
  }

  async function scanAgain() {
    if (!api || busy) return;
    scanning = true;
    scanError = '';
    try {
      await api.requestAudioScan();
      // Show "Scan requested…" at once; the next status read takes over.
      if (status) {
        status = {
          ...status,
          libraries: status.libraries.map((l) => ({ ...l, scanRequested: true }))
        };
      }
    } catch (err) {
      scanError = describe(err);
    } finally {
      scanning = false;
    }
    schedulePoll();
  }

  function bookHref(id: string) {
    return `${pagePath}/library/book?id=${encodeURIComponent(id)}`;
  }

  function subtitleLine(l: AudioLinkListEntry): string {
    const v = subtitleView(l);
    if (v === 'linked' || v === 'missing') return linkedSubtitleName(l);
    if (v === 'none') return 'No subtitles';
    return '';
  }
</script>

<div class="flex flex-col gap-10" data-testid="audiobooks-page">
  {#if connection === null}
    <p class="c-notice" data-testid="not-connected">
      This device isn't connected to the library server yet.
      <a class="c-link" href="{pagePath}/library">Connect on the Library page</a>.
    </p>
  {:else if loading}
    <p class="py-8 text-c-muted">Loading…</p>
  {:else if error}
    <p class="c-notice" role="alert" data-testid="audiobooks-error">
      {error}
      <button class="c-link ml-2 min-h-[2.75rem]" on:click={load}>Try again</button>
    </p>
  {:else}
    <p class="s-intro">
      Audiobooks stay in the server's audiobooks folder and play from there; nothing is copied or
      changed in it. Link a book's audiobook on the book's page.
    </p>

    <!-- The audiobooks folder -->
    <SettingsGroup id="audio-folder" testid="audiobooks-folder">
      {#if !status?.enabled}
        <p class="px-5 py-4" data-testid="audiobooks-off">
          The server has no audiobooks folder set up{status?.error ? ` (${status.error})` : ''}.
        </p>
      {:else}
        {#if status.libraries.length === 0}
          <p class="px-5 py-4" data-testid="audiobooks-no-library">
            No library has an audiobooks folder yet.
          </p>
        {/if}
        {#each status.libraries as lib (lib.id)}
          <div data-testid="audiobooks-library">
            {#if status.libraries.length > 1}
              <p class="px-4 pt-3 font-mincho font-bold sm:px-5">{lib.name}</p>
            {/if}
            <dl class="s-tiles">
              <div>
                <dt>Audiobooks</dt>
                <dd data-testid="audiobooks-folders">
                  {lib.audioDir ? plural(lib.folders, 'audiobook', 'audiobooks') : 'No folder'}
                </dd>
              </div>
              <div>
                <dt>Subtitle files</dt>
                <dd data-testid="audiobooks-subtitles">
                  {lib.subtitleDir ? plural(lib.subtitles, 'file', 'files') : 'No folder'}
                </dd>
              </div>
              {#if lib.archivesSkipped}
                <div>
                  <dt>Archives skipped</dt>
                  <dd>{lib.archivesSkipped.toLocaleString()}</dd>
                </div>
              {/if}
              {#if lib.durationsPending}
                <div>
                  <dt>Lengths still being read</dt>
                  <dd data-testid="audiobooks-pending">{lib.durationsPending.toLocaleString()}</dd>
                </div>
              {/if}
            </dl>
            {#if lib.lastError && lib.status === 'error'}
              <p class="break-words px-4 pb-3 text-sm font-semibold sm:px-5" role="alert">
                {lib.lastError}
              </p>
            {/if}
          </div>
        {/each}
        <SettingRow id="audio-scan" layout="inline">
          <svelte:fragment slot="description">
            {#each status.libraries as lib (lib.id)}
              <p class="mt-1 text-sm">
                {#if status.libraries.length > 1}{lib.name}:{/if}
                Last scan
                <span data-testid="audiobooks-scanned"
                  >{lib.scannedAt ? formatWhen(lib.scannedAt) : 'never'}</span
                >
                ·
                <span data-testid="audiobooks-status">{scanStatusText(lib)}</span>
              </p>
            {/each}
            {#if scanError}
              <p class="mt-1 text-sm font-semibold text-c-ink" role="alert">⚠ {scanError}</p>
            {/if}
          </svelte:fragment>
          <button
            class="c-btn c-btn-secondary"
            data-testid="audiobooks-scan"
            disabled={busy}
            on:click={scanAgain}
          >
            {busy ? 'Scanning…' : 'Scan again'}
          </button>
        </SettingRow>
      {/if}
    </SettingsGroup>

    <!-- Linked books and books marked "No audiobook": one list in pages. -->
    <SettingsGroup id="audio-books" testid="audiobooks-linked">
      {#if listed.length === 0}
        <p class="px-5 py-4" data-testid="audiobooks-linked-empty">
          No book has an audiobook linked yet. Open a book's page and choose one under “Audiobook”.
        </p>
      {:else}
        <PagedList
          items={listed}
          pageSize={20}
          text={bookText}
          searchLabel="Search titles or folders"
          sorts={bookSorts}
          filters={bookFilters}
          bind:filter={bookFilter}
          label="Books"
          testid="audiobooks-books"
          let:rows
        >
          {#if bookFilter === 'none'}
            <ul data-testid="audiobooks-none-list">
              {#each rows as l (l.bookId)}
                <li class="s-item">
                  <div class="s-item-main">
                    <a class="c-link font-mincho text-[15px]" href={bookHref(l.bookId)}
                      >{titleOf(l)}</a
                    >
                  </div>
                </li>
              {/each}
            </ul>
          {:else}
            <ul>
              {#each rows as l (l.bookId)}
                <li class="s-item" data-testid="audiobooks-linked-row">
                  <div class="s-item-main flex flex-col gap-0.5">
                    <a
                      class="c-link self-start font-mincho text-[15px] font-bold"
                      href={bookHref(l.bookId)}
                      data-testid="audiobooks-linked-title">{titleOf(l)}</a
                    >
                    <div class="text-sm">
                      <span class="text-c-muted">Audiobook:</span>
                      {linkedFolderName(l)}
                      {#if l.folder && l.status !== 'missing'}
                        <span class="text-c-muted">· {folderDetails(l.folder)}</span>
                      {/if}
                    </div>
                    {#if subtitleLine(l)}
                      <div class="text-sm">
                        <span class="text-c-muted">Subtitles:</span>
                        {subtitleLine(l)}
                      </div>
                    {/if}
                    {#if linkMarks(l).length}
                      <div class="mt-1 flex flex-wrap gap-2" data-testid="audiobooks-marks">
                        {#each linkMarks(l) as mark (mark)}
                          <span class="c-abmark">{mark}</span>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </PagedList>
      {/if}
    </SettingsGroup>

    <!-- WP16/WP17: the PC, its voices and models; Season 2 Phase 12: speakers and fixes. -->
    {#if api && status?.enabled}
      <GpuWorkerSection {api} />
      <VoicesSection {api} />
      <TtsModelsSection {api} />
      <SpeakerModelsSection {api} />
      <PronunciationFixesSection {api} />
    {/if}
  {/if}
</div>

<style>
  .s-intro {
    padding: 0.75rem 1rem;
    border: var(--c-border-width) solid var(--c-line);
    border-left: 3px solid var(--c-gold);
    border-radius: 0.375rem;
    background-color: var(--c-raised);
    font-size: 0.875rem;
  }

  .s-tiles {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  @media (min-width: 640px) {
    .s-tiles {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }

  .s-tiles > div {
    padding: 0.75rem 1rem;
  }

  .s-tiles dt {
    font-size: 0.8125rem;
    color: var(--c-muted);
  }

  .s-tiles dd {
    font-family: 'Shippori Mincho', 'Noto Serif JP', serif;
    font-size: 1.125rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .c-abmark {
    display: inline-flex;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    border: var(--c-border-width) solid var(--c-seal);
    color: var(--c-ink);
    font-size: 0.75rem;
    font-weight: 500;
  }
</style>
