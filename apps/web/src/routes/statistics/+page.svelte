<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import { HeatmapType } from '$lib/components/statistics/statistics-heatmap/statistics-heatmap';
  import StatisticsHeatmap from '$lib/components/statistics/statistics-heatmap/statistics-heatmap.svelte';
  import { pxScreen } from '$lib/css-classes';
  import type { BooksDbStatistic } from '$lib/data/database/books-db/versions/books-db';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import {
    lastReadingDataHeatmapAggregationMode$,
    startDayHoursForTracker$,
    statsWeekStart$
  } from '$lib/data/store';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { getDateKey } from '$lib/functions/statistic-util';
  import type { CatalogLibrary } from '$lib/library/types';
  import { BEFORE_DEVICE_TRACKING, type StatEntry } from '$lib/stats/aggregate';
  import {
    formatClock,
    formatDay,
    formatDuration,
    formatNumber,
    parseCount
  } from '$lib/stats/stats-format';
  import {
    customPeriod,
    isDayKey,
    normalizeWeekStart,
    PERIOD_KINDS,
    periodContaining,
    periodFromParam,
    periodLabel,
    periodToParam,
    stepPeriod,
    type PeriodKind,
    type StatsPeriod
  } from '$lib/stats/periods';
  import {
    buildStatsView,
    devicesIn,
    tmwLog,
    unknownBookTitle,
    type StatsBookInfo,
    type StatsFilter
  } from '$lib/stats/stats-view';
  import type { ReadThrough } from '$lib/sync/book-state';
  import { statsApi } from '$lib/sync/sync-service';
  import { onDestroy, onMount } from 'svelte';

  /**
   * WP12b: the Stats page. Everything comes from synced records in this device's mirror
   * (reading sessions of every device, plus the frozen days from before device
   * tracking), so it works offline and updates after a sync. Period and filters live in
   * the address (?period=week:2026-11-09&device=&lib=&book=). Titles and libraries come
   * from the library server (books removed from Calibre included), else from this device.
   * Plain for e-ink: 48 px bordered controls, no transitions, Load more.
   */

  const DAYS_PER_PAGE = 14;
  const solid = 'border-gray-800 bg-gray-800 text-white';
  const control = 'min-h-[3rem] rounded border-2 border-current bg-white px-3';
  const stats = statsApi();

  let entries: StatEntry[] = [];
  let readThroughs = new Map<string, ReadThrough[]>();
  let deviceNames = new Map<string, string>();
  let thisDeviceId: string | null = null;
  let books = new Map<string, StatsBookInfo>();
  let libraries: CatalogLibrary[] | null = null;
  let infoError = '';
  let loaded = false;
  let shownDays = DAYS_PER_PAGE;
  let customFrom = '';
  let customTo = '';
  let showCustom = false;
  let editing: { id: string; minutes: string; chars: string; error: string } | null = null;
  let actionError = '';
  let tmwText = '';
  let tmwNote = '';
  let stop: (() => void) | undefined;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  $: weekStart = normalizeWeekStart($statsWeekStart$);
  $: todayKey = getDateKey($startDayHoursForTracker$);
  $: today = new Date(`${todayKey}T12:00:00`);
  // Prerendered without an address: the period and filters exist only in the browser.
  $: params = browser ? $page.url.searchParams : new URLSearchParams();
  $: period = periodFromParam(params.get('period'), todayKey, weekStart);
  $: filter = {
    device: params.get('device') || null,
    library: params.get('lib') || null,
    book: params.get('book') || null
  } as StatsFilter;
  $: view = buildStatsView({ entries, readThroughs, books, filter, period });
  $: shownDayRows = view.days.slice(0, shownDays);
  $: deviceChoices = devicesIn(entries, namesWithThisDevice(deviceNames, thisDeviceId));
  $: bookChoices = bookChoiceList(entries, readThroughs, books);
  $: heatmapData = view.heatmapRows.map(
    (row): BooksDbStatistic => ({
      ...row,
      minReadingSpeed: 0,
      altMinReadingSpeed: 0,
      lastReadingSpeed: 0,
      maxReadingSpeed: 0,
      lastStatisticModified: 0
    })
  );
  $: heatmapTitles = new Map(view.heatmapRows.map((row) => [row.title, true]));
  $: currentYear = todayKey.slice(0, 4);
  $: label = periodLabel(period);

  onMount(async () => {
    void stats.syncSoon();
    await load();
    const off = await stats.onChanged(() => schedule());
    if (destroyed) off();
    else stop = off;
    libraries = await stats.libraries();
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
    stop?.();
  });

  /** Changes come in bursts (a sync): settle first. */
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!destroyed) void load();
    }, 300);
  }

  async function load() {
    try {
      const data = await stats.pageData();
      entries = data.entries;
      readThroughs = data.readThroughs;
      deviceNames = data.deviceNames;
      thisDeviceId = data.thisDeviceId;
      loaded = true;
      const ids = [...new Set([...entries.map((e) => e.bookId), ...readThroughs.keys()])];
      const missing = ids.filter((id) => !books.has(id));
      if (missing.length) {
        const info = await stats.bookInfo(missing);
        if (destroyed) return;
        books = new Map([...books, ...info.books]);
        infoError = info.error;
      }
    } catch (error) {
      logger.warn(`Stats page: ${(error as Error)?.message ?? error}`);
      loaded = true;
    }
  }

  function namesWithThisDevice(names: Map<string, string>, own: string | null) {
    if (!own) return names;
    const out = new Map(names);
    out.set(own, `${names.get(own) ?? 'This device'} (this device)`);
    return out;
  }

  function bookChoiceList(
    list: StatEntry[],
    rts: Map<string, ReadThrough[]>,
    info: Map<string, StatsBookInfo>
  ) {
    const ids = new Set([...list.map((e) => e.bookId), ...rts.keys()]);
    return [...ids]
      .map((id) => ({ id, title: info.get(id)?.title ?? unknownBookTitle(id) }))
      .sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  }

  function navigate(next: { period?: StatsPeriod; filter?: StatsFilter }) {
    const p = next.period ?? period;
    const f = next.filter ?? filter;
    const query = new URLSearchParams();
    query.set('period', periodToParam(p));
    if (f.device) query.set('device', f.device);
    if (f.library) query.set('lib', f.library);
    if (f.book) query.set('book', f.book);
    shownDays = DAYS_PER_PAGE;
    editing = null;
    tmwText = '';
    tmwNote = '';
    void goto(`${pagePath}/statistics?${query.toString()}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true
    });
  }

  function choosePeriod(kind: Exclude<PeriodKind, 'custom'>) {
    showCustom = false;
    const anchor = period.from && period.kind !== 'all' ? period.from : todayKey;
    // Picking a kind keeps the day in view when it is in the shown period, else today.
    const day =
      period.from && period.to && todayKey >= period.from && todayKey <= period.to
        ? todayKey
        : anchor;
    navigate({ period: periodContaining(kind, day, weekStart) });
  }

  function openCustom() {
    showCustom = !showCustom;
    customFrom = period.from ?? todayKey;
    customTo = period.to ?? todayKey;
  }

  function applyCustom() {
    if (!isDayKey(customFrom) || !isDayKey(customTo)) return;
    showCustom = false;
    navigate({ period: customPeriod(customFrom, customTo) });
  }

  function setFilter(key: keyof StatsFilter, value: string) {
    navigate({ filter: { ...filter, [key]: value || null } });
  }

  function deviceLabel(entry: StatEntry): string {
    if (entry.deviceId === BEFORE_DEVICE_TRACKING) return 'Before device tracking';
    const name = deviceNames.get(entry.deviceId) ?? `Device ${entry.deviceId.slice(0, 4)}`;
    return entry.deviceId === thisDeviceId ? `${name} (this device)` : name;
  }

  function bookTitle(bookId: string): string {
    return books.get(bookId)?.title ?? unknownBookTitle(bookId);
  }

  function entryNote(entry: StatEntry): string {
    if (entry.source === 'frozen') return '';
    if (entry.source === 'completion') return 'Characters added by Complete Book';
    return entry.startedAt ? `${formatClock(entry.startedAt)}–${formatClock(entry.endedAt)}` : '';
  }

  function startEdit(entry: StatEntry) {
    actionError = '';
    editing = {
      id: entry.id,
      minutes: String(Math.round((entry.seconds / 60) * 10) / 10),
      chars: String(entry.chars),
      error: ''
    };
  }

  async function saveEdit(entry: StatEntry) {
    if (!editing) return;
    const minutes = Number(editing.minutes.trim().replace(',', '.'));
    const chars = parseCount(editing.chars);
    if (!Number.isFinite(minutes) || minutes < 0 || chars === null) {
      editing = { ...editing, error: 'Enter minutes and characters as numbers of 0 or more.' };
      return;
    }
    const seconds = entry.source === 'completion' ? 0 : Math.round(minutes * 60);
    if (!(await stats.correctSession(entry.id, { seconds, chars }))) {
      actionError = 'The correction could not be saved.';
      return;
    }
    editing = null;
  }

  function cancelOnEscape(ev: KeyboardEvent) {
    if (ev.key === 'Escape') editing = null;
  }

  async function exclude(entry: StatEntry) {
    actionError = '';
    if (!(await stats.excludeSession(entry.id))) actionError = 'The session could not be changed.';
  }

  async function clearFix(entry: StatEntry) {
    actionError = '';
    if (!(await stats.clearFix(entry.id))) actionError = 'The session could not be changed.';
  }

  async function copyTmw(what: 'chars' | 'minutes') {
    const text = tmwLog(view, label, what);
    tmwText = '';
    if (!text) {
      tmwNote = 'Nothing to copy for this period.';
      return;
    }
    // The Clipboard API exists only in a secure context (https or localhost).
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        tmwNote = 'Copied.';
        return;
      } catch (error) {
        logger.warn(`Stats: clipboard: ${(error as Error)?.message ?? error}`);
      }
    }
    tmwText = text;
    tmwNote = 'Select the text below and copy it.';
  }

  function selectAll(node: HTMLTextAreaElement) {
    node.focus();
    node.select();
  }
</script>

<svelte:head>
  <title>{formatPageTitle('Stats')}</title>
</svelte:head>

<AppHeader title="Stats" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="stats-page">
  <!-- Period -->
  <div class="flex flex-wrap items-center gap-2 pt-3" role="group" aria-label="Period">
    {#each PERIOD_KINDS as choice (choice.kind)}
      <button
        class="min-h-[3rem] min-w-[3rem] rounded border-2 px-3 {period.kind === choice.kind
          ? solid
          : 'border-current'}"
        aria-pressed={period.kind === choice.kind}
        data-testid="stats-period-{choice.kind}"
        on:click={() => choosePeriod(choice.kind)}
      >
        {choice.label}
      </button>
    {/each}
    <button
      class="min-h-[3rem] rounded border-2 px-3 {period.kind === 'custom'
        ? solid
        : 'border-current'}"
      aria-pressed={period.kind === 'custom'}
      aria-expanded={showCustom}
      data-testid="stats-period-custom"
      on:click={openCustom}
    >
      Dates…
    </button>
  </div>
  {#if showCustom}
    <form
      class="flex flex-wrap items-end gap-2 pt-2"
      data-testid="stats-custom-range"
      on:submit|preventDefault={applyCustom}
    >
      <label class="flex flex-col text-sm">
        From
        <input class={control} type="date" bind:value={customFrom} />
      </label>
      <label class="flex flex-col text-sm">
        To
        <input class={control} type="date" bind:value={customTo} />
      </label>
      <button class="{control} {solid}" type="submit">Show</button>
    </form>
  {/if}
  <div class="flex items-center gap-2 pt-2">
    <button
      class="{control} min-w-[3rem]"
      title="Previous"
      aria-label="Previous period"
      disabled={period.kind === 'all'}
      class:opacity-40={period.kind === 'all'}
      data-testid="stats-prev"
      on:click={() => navigate({ period: stepPeriod(period, -1, weekStart) })}
    >
      ‹
    </button>
    <h2 class="flex-1 text-center text-lg font-medium" data-testid="stats-period-label">
      {label}
    </h2>
    <button
      class="{control} min-w-[3rem]"
      title="Next"
      aria-label="Next period"
      disabled={period.kind === 'all'}
      class:opacity-40={period.kind === 'all'}
      data-testid="stats-next"
      on:click={() => navigate({ period: stepPeriod(period, 1, weekStart) })}
    >
      ›
    </button>
  </div>

  <!-- Filters -->
  <div class="flex flex-wrap items-end gap-2 pt-3">
    <label class="flex w-full flex-col text-sm sm:w-auto">
      Device
      <select
        class="{control} max-w-full sm:max-w-[16rem]"
        data-testid="stats-filter-device"
        on:change={(ev) => setFilter('device', ev.currentTarget.value)}
      >
        <!-- Selected per option: the options arrive after the address is read. -->
        <option value="" selected={!filter.device}>All devices</option>
        {#each deviceChoices as device (device.id)}
          <option value={device.id} selected={device.id === filter.device}>{device.name}</option>
        {/each}
      </select>
    </label>
    {#if libraries && libraries.length > 1}
      <label class="flex w-full flex-col text-sm sm:w-auto">
        Library
        <select
          class="{control} max-w-full sm:max-w-[16rem]"
          data-testid="stats-filter-library"
          on:change={(ev) => setFilter('library', ev.currentTarget.value)}
        >
          <option value="" selected={!filter.library}>All libraries</option>
          {#each libraries as library (library.id)}
            <option value={library.id} selected={library.id === filter.library}>
              {library.name}
            </option>
          {/each}
        </select>
      </label>
    {/if}
    <label class="flex w-full flex-col text-sm sm:w-auto">
      Book
      <select
        class="{control} max-w-full sm:max-w-[18rem]"
        data-testid="stats-filter-book"
        on:change={(ev) => setFilter('book', ev.currentTarget.value)}
      >
        <option value="" selected={!filter.book}>All books</option>
        {#each bookChoices as book (book.id)}
          <option value={book.id} selected={book.id === filter.book}>{book.title}</option>
        {/each}
      </select>
    </label>
    {#if filter.device || filter.library || filter.book}
      <button
        class="{control} underline"
        data-testid="stats-filter-clear"
        on:click={() => navigate({ filter: { device: null, library: null, book: null } })}
      >
        Show all
      </button>
    {/if}
  </div>
  {#if infoError}
    <p class="pt-2 text-sm" role="alert" data-testid="stats-info-error">{infoError}</p>
  {/if}

  {#if !loaded}
    <p class="py-6">Loading…</p>
  {:else}
    <!-- Totals -->
    <dl
      class="grid grid-cols-2 gap-2 pt-4 sm:grid-cols-3"
      data-testid="stats-summary"
      aria-label="Totals for {label}"
    >
      <div class="rounded border-2 border-current p-3">
        <dt class="text-sm">Reading time</dt>
        <dd class="text-xl font-medium" data-testid="stats-total-time">
          {formatDuration(view.summary.seconds)}
        </dd>
      </div>
      <div class="rounded border-2 border-current p-3">
        <dt class="text-sm">Characters</dt>
        <dd class="text-xl font-medium" data-testid="stats-total-chars">
          {formatNumber(view.summary.chars)}
        </dd>
      </div>
      <div class="rounded border-2 border-current p-3">
        <dt class="text-sm">Speed</dt>
        <dd class="text-xl font-medium" data-testid="stats-total-speed">
          {view.summary.speed ? `${formatNumber(view.summary.speed)} / h` : '–'}
        </dd>
      </div>
      <div class="rounded border-2 border-current p-3">
        <dt class="text-sm">Books completed</dt>
        <dd class="text-xl font-medium" data-testid="stats-total-completed">
          {view.summary.booksCompleted}
        </dd>
      </div>
      <div class="rounded border-2 border-current p-3">
        <dt class="text-sm">Dictionary lookups</dt>
        <dd class="text-xl font-medium" data-testid="stats-total-lookups">
          {formatNumber(view.summary.lookups)}
        </dd>
      </div>
      <div class="rounded border-2 border-current p-3">
        <dt class="text-sm">Days read</dt>
        <dd class="text-xl font-medium" data-testid="stats-total-days">
          {view.summary.daysRead}
        </dd>
      </div>
    </dl>
    {#if view.summary.manualChars}
      <p class="pt-2 text-sm" data-testid="stats-manual-note">
        Characters include {formatNumber(view.summary.manualChars)} from books marked completed by hand
        (no time, so not in the speed).
      </p>
    {/if}
    {#if filter.device}
      <p class="pt-2 text-sm">
        Books completed counts every device: a completion isn't tied to one device.
      </p>
    {/if}

    <!-- Copy for TMW -->
    <div class="flex flex-wrap items-center gap-2 pt-3">
      <button class={control} data-testid="stats-tmw-chars" on:click={() => copyTmw('chars')}>
        Copy characters (TMW)
      </button>
      <button class={control} data-testid="stats-tmw-minutes" on:click={() => copyTmw('minutes')}>
        Copy minutes (TMW)
      </button>
      {#if tmwNote}
        <span class="text-sm" role="status">{tmwNote}</span>
      {/if}
    </div>
    {#if tmwText}
      <textarea
        class="mt-2 w-full rounded border-2 border-current p-2 font-mono text-sm"
        rows="6"
        readonly
        data-testid="stats-tmw-text"
        use:selectAll>{tmwText}</textarea
      >
    {/if}

    {#if !entries.length && !readThroughs.size}
      <p class="py-6" data-testid="stats-empty">
        No reading recorded yet. Turn on the tracker in a book; sessions from every device show
        here.
      </p>
    {:else}
      <!-- Heatmap (all time, filters applied) -->
      {#if heatmapData.length}
        <section class="pt-6" data-testid="stats-heatmap">
          <StatisticsHeatmap
            statisticsData={heatmapData}
            readingGoals={[]}
            statisticsTitleFilters={heatmapTitles}
            {today}
            {todayKey}
            selectedFrom={period.from ?? ''}
            selectedTo={period.to ?? ''}
            heatmapType={HeatmapType.STATISTICS}
            bind:heatmapAggregration={$lastReadingDataHeatmapAggregationMode$}
          />
        </section>
      {/if}

      <!-- Books -->
      <section class="pt-6" data-testid="stats-books">
        <h2 class="pb-2 text-lg font-medium">Books</h2>
        {#if view.books.length}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead>
                <tr class="border-b-2 border-current">
                  <th class="py-2 pr-2">Book</th>
                  <th class="py-2 pr-2 text-right">Time</th>
                  <th class="py-2 pr-2 text-right">Characters</th>
                  <th class="py-2 pr-2 text-right">Speed</th>
                  <th class="py-2 text-right">Lookups</th>
                </tr>
              </thead>
              <tbody>
                {#each view.books as row (row.bookId)}
                  <tr class="border-b border-current" data-testid="stats-book-row">
                    <td class="py-2 pr-2">
                      <button
                        class="min-h-[3rem] text-left underline"
                        title="Show only this book"
                        on:click={() => setFilter('book', row.bookId)}
                      >
                        {row.title}
                      </button>
                      {#if row.missing}
                        <span class="block text-xs">No longer in the library</span>
                      {/if}
                      {#if row.completed}
                        <span class="block text-xs" data-testid="stats-book-completed">
                          {row.manual ? 'Marked completed' : 'Completed'}
                        </span>
                      {/if}
                    </td>
                    <td class="py-2 pr-2 text-right">{formatDuration(row.seconds)}</td>
                    <td class="py-2 pr-2 text-right">{formatNumber(row.chars)}</td>
                    <td class="py-2 pr-2 text-right">
                      {row.speed ? formatNumber(row.speed) : '–'}
                    </td>
                    <td class="py-2 text-right">{formatNumber(row.lookups)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="text-sm">No reading in this period.</p>
        {/if}
      </section>

      <!-- Days and sessions -->
      <section class="pt-6" data-testid="stats-days">
        <h2 class="pb-2 text-lg font-medium">Days</h2>
        {#if actionError}
          <p class="pb-2 text-sm" role="alert">{actionError}</p>
        {/if}
        {#each shownDayRows as day (day.day)}
          <div class="border-t-2 border-current py-3" data-testid="stats-day" data-day={day.day}>
            <div class="flex flex-wrap items-baseline justify-between gap-x-4">
              <h3 class="font-medium">{formatDay(day.day, currentYear)}</h3>
              <span class="text-sm">
                {formatDuration(day.totals.seconds)} · {formatNumber(day.totals.chars)} characters
                {#if day.totals.lookups}· {formatNumber(day.totals.lookups)} lookups{/if}
              </span>
            </div>
            <ul class="pt-1">
              {#each day.entries as entry (entry.id)}
                <li
                  class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
                  data-testid="stats-entry"
                  data-entry-id={entry.id}
                  data-excluded={entry.excluded ? '1' : '0'}
                >
                  <div class="min-w-0 flex-1">
                    <div class="truncate">{bookTitle(entry.bookId)}</div>
                    <div class="text-xs">
                      {deviceLabel(entry)}{entryNote(entry) ? ` · ${entryNote(entry)}` : ''}
                    </div>
                  </div>
                  <div
                    class="text-sm"
                    class:line-through={entry.excluded}
                    data-testid="stats-entry-numbers"
                  >
                    {formatDuration(entry.seconds)} · {formatNumber(entry.chars)} characters
                    {#if entry.lookups}· {entry.lookups} lookups{/if}
                    {#if entry.recorded}
                      <span class="block text-xs" data-testid="stats-entry-corrected">
                        Corrected (recorded {formatDuration(entry.recorded.seconds)} · {formatNumber(
                          entry.recorded.chars
                        )})
                      </span>
                    {/if}
                    {#if entry.excluded}
                      <span class="block text-xs">Left out of the totals</span>
                    {/if}
                  </div>
                  {#if entry.source !== 'frozen'}
                    <div class="flex flex-wrap gap-2">
                      {#if entry.excluded || entry.recorded}
                        <button
                          class={control}
                          data-testid="stats-entry-restore"
                          on:click={() => clearFix(entry)}
                        >
                          {entry.excluded ? 'Count again' : 'Undo correction'}
                        </button>
                      {/if}
                      {#if !entry.excluded}
                        <button
                          class={control}
                          data-testid="stats-entry-exclude"
                          on:click={() => exclude(entry)}
                        >
                          Leave out
                        </button>
                        <button
                          class={control}
                          data-testid="stats-entry-correct"
                          on:click={() => startEdit(entry)}
                        >
                          Correct…
                        </button>
                      {/if}
                    </div>
                  {/if}
                </li>
                {#if editing && editing.id === entry.id}
                  <li>
                    <form
                      class="flex flex-wrap items-end gap-2 pb-3"
                      data-testid="stats-correct-form"
                      on:submit|preventDefault={() => saveEdit(entry)}
                    >
                      {#if entry.source !== 'completion'}
                        <label class="flex flex-col text-sm">
                          Minutes
                          <input
                            class="{control} w-28"
                            inputmode="decimal"
                            bind:value={editing.minutes}
                            on:keydown={cancelOnEscape}
                            data-testid="stats-correct-minutes"
                          />
                        </label>
                      {/if}
                      <label class="flex flex-col text-sm">
                        Characters
                        <input
                          class="{control} w-36"
                          inputmode="numeric"
                          bind:value={editing.chars}
                          on:keydown={cancelOnEscape}
                          data-testid="stats-correct-chars"
                        />
                      </label>
                      <button class="{control} {solid}" type="submit">Save</button>
                      <button class={control} type="button" on:click={() => (editing = null)}>
                        Cancel
                      </button>
                      {#if editing.error}
                        <p class="w-full text-sm" role="alert">{editing.error}</p>
                      {/if}
                    </form>
                  </li>
                {/if}
              {/each}
            </ul>
          </div>
        {:else}
          <p class="text-sm">No reading in this period.</p>
        {/each}
        {#if view.days.length > shownDays}
          <button
            class="{control} mt-2 w-full"
            data-testid="stats-days-more"
            on:click={() => (shownDays += DAYS_PER_PAGE)}
          >
            Load more days
          </button>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<AppBottomBar />
