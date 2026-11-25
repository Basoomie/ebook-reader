<script lang="ts">
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import CataloguePageHeader from '$lib/components/catalogue-page-header.svelte';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import SearchPicker, { type PickerOption } from '$lib/components/notes/search-picker.svelte';
  import { HeatmapType } from '$lib/components/statistics/statistics-heatmap/statistics-heatmap';
  import StatisticsHeatmap from '$lib/components/statistics/statistics-heatmap/statistics-heatmap.svelte';
  import StatsBooksTable from '$lib/components/stats/stats-books-table.svelte';
  import StatsGoals from '$lib/components/stats/stats-goals.svelte';
  import StatsPeriodChart from '$lib/components/stats/stats-period-chart.svelte';
  import StatsReadingLog from '$lib/components/stats/stats-reading-log.svelte';
  import {
    changeLine,
    chartMeasureFromParam,
    comparedWith,
    formatSummaryValue,
    periodChart,
    periodComparison,
    showsWhole,
    wholeLabel,
    type ChartMeasure,
    type PeriodComparison,
    type SummaryKey
  } from '$lib/stats/period-compare';
  import type { StatGoal } from '$lib/stats/goals';
  import { downloadBlob } from '$lib/functions/download-blob';
  import { buildStatsImageModel, statsImageFileName } from '$lib/stats/stats-image-model';
  import { renderStatsImage } from '$lib/stats/stats-image';
  import { pxScreen } from '$lib/css-classes';
  import type { BooksDbStatistic } from '$lib/data/database/books-db/versions/books-db';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import {
    lastReadingDataHeatmapAggregationMode$,
    speedGoalMinMinutes$,
    startDayHoursForTracker$,
    statsWeekStart$
  } from '$lib/data/store';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { getDateKey } from '$lib/functions/statistic-util';
  import type { CatalogLibrary } from '$lib/library/types';
  import { BEFORE_DEVICE_TRACKING, type StatEntry } from '$lib/stats/aggregate';
  import { formatClock, formatDay, formatDuration, formatNumber } from '$lib/stats/stats-format';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { deleteSessionCopy } from '$lib/confirm/confirm-copy';
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
    type StatsFilter,
    type StatsSummary,
    type StatsView
  } from '$lib/stats/stats-view';
  import type { ReadThrough } from '$lib/sync/book-state';
  import { statsApi } from '$lib/sync/sync-service';
  import { faFilter, faShareFromSquare, faXmark } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import { onDestroy, onMount } from 'svelte';

  /**
   * WP12b: the Stats page. Everything comes from synced records in this device's mirror
   * (reading sessions of every device, plus the frozen days from before device
   * tracking), so it works offline and updates after a sync. Period and filters live in
   * the address (?period=week:2026-11-09&device=&lib=&book=). Titles and libraries come
   * from the library server (books removed from Calibre included), else from this device.
   *
   * 2026-11-22 redesign (UI only): one bar for the period and Filters that stays at the top
   * while scrolling; filters in a panel (Book and Device are search pickers, as on the Notes
   * page) with removable chips; the totals as tiles; the chart beside Goals on wide screens;
   * Save image and the TMW copies in a Share menu; Books as a sortable, paged table; the
   * days as a folding reading log in pages of 7, a session's actions in its ⋯ menu.
   */

  const stats = statsApi();
  const menuItem = 'c-btn c-btn-ghost w-full justify-start px-3 text-left';
  const chip = 'c-chip gap-2 px-3';

  let entries: StatEntry[] = [];
  let readThroughs = new Map<string, ReadThrough[]>();
  let deviceNames = new Map<string, string>();
  let thisDeviceId: string | null = null;
  let goals: StatGoal[] = [];
  let books = new Map<string, StatsBookInfo>();
  let libraries: CatalogLibrary[] | null = null;
  let infoError = '';
  let loaded = false;
  let customFrom = '';
  let customTo = '';
  let showCustom = false;
  let filtersOpen = false;
  let actionError = '';
  let tmwText = '';
  let tmwNote = '';
  let imageBusy = false;
  let imageNote = '';
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
  // Phase 11: a week, month or year beside the one before it (same rules as the totals).
  $: measure = chartMeasureFromParam(params.get('measure'));
  $: comparison = periodComparison(period, todayKey, weekStart);
  $: changes = changeLines(comparison, entries, readThroughs, books, filter);
  $: chart =
    comparison && comparison.state !== 'future'
      ? periodChart(view, comparison, measure, todayKey)
      : null;
  $: deviceChoices = devicesIn(entries, namesWithThisDevice(deviceNames, thisDeviceId));
  $: bookChoices = bookChoiceList(entries, readThroughs, books);
  $: bookOptions = bookChoices.map((b) => ({ id: b.id, label: b.title }) as PickerOption);
  $: deviceOptions = deviceChoices.map((d) => ({ id: d.id, label: d.name }) as PickerOption);
  $: deviceName = filter.device
    ? (deviceChoices.find((d) => d.id === filter.device)?.name ?? 'One device')
    : '';
  $: libraryName = filter.library
    ? (libraries?.find((l) => l.id === filter.library)?.name ?? 'One library')
    : '';
  $: filterCount = [filter.device, filter.library, filter.book].filter(Boolean).length;
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
  // The reading log starts again (newest day open, page 1) for another period or filter.
  $: logKey = `${periodToParam(period)}|${filter.device}|${filter.library}|${filter.book}`;

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
      goals = await stats.goals();
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

  const SUMMARY_KEYS: SummaryKey[] = [
    'seconds',
    'chars',
    'speed',
    'booksCompleted',
    'lookups',
    'daysRead'
  ];

  /** The tiles, in order: their label, test id and shown value. */
  const TILES: { key: SummaryKey; label: string; id: string }[] = [
    { key: 'seconds', label: 'Reading time', id: 'time' },
    { key: 'chars', label: 'Characters', id: 'chars' },
    { key: 'speed', label: 'Speed', id: 'speed' },
    { key: 'booksCompleted', label: 'Books completed', id: 'completed' },
    { key: 'lookups', label: 'Dictionary lookups', id: 'lookups' },
    { key: 'daysRead', label: 'Days read', id: 'days' }
  ];

  function tileValue(key: SummaryKey, summary: StatsSummary): string {
    switch (key) {
      case 'seconds':
        return formatDuration(summary.seconds);
      case 'chars':
        return formatNumber(summary.chars);
      case 'speed':
        return summary.speed ? `${formatNumber(summary.speed)} / h` : '–';
      case 'lookups':
        return formatNumber(summary.lookups);
      default:
        return String(summary[key]);
    }
  }

  /** ▲ / ▼ / – for a change line ("+7,527 (+71%) vs …", "−3 min …", "No change …"). */
  function trend(line: string | null | undefined): 'up' | 'down' | 'flat' {
    if (!line) return 'flat';
    if (line.startsWith('+')) return 'up';
    if (line.startsWith('−') || line.startsWith('-')) return 'down';
    return 'flat';
  }

  /**
   * Each tile's change vs the previous period's same days (or whole period when over),
   * and the previous period's whole total while the period is running.
   */
  function changeLines(
    c: PeriodComparison | null,
    list: StatEntry[],
    rts: Map<string, ReadThrough[]>,
    info: Map<string, StatsBookInfo>,
    f: StatsFilter
  ): Partial<Record<SummaryKey, { change: string | null; whole: string | null }>> {
    if (!c || c.state === 'future') return {};
    const summaryOf = (p: StatsPeriod): StatsSummary =>
      buildStatsView({ entries: list, readThroughs: rts, books: info, filter: f, period: p })
        .summary;
    const current = summaryOf(c.current);
    const same = summaryOf(c.previousSame);
    const whole: StatsView['summary'] | null = showsWhole(c) ? summaryOf(c.previous) : null;
    const against = comparedWith(c);
    const out: Partial<Record<SummaryKey, { change: string | null; whole: string | null }>> = {};
    for (const key of SUMMARY_KEYS) {
      out[key] = {
        change: changeLine(key, current, same, against),
        whole: whole ? `${wholeLabel(c)}: ${formatSummaryValue(key, whole[key])}` : null
      };
    }
    return out;
  }

  function navigate(next: { period?: StatsPeriod; filter?: StatsFilter; measure?: ChartMeasure }) {
    const p = next.period ?? period;
    const f = next.filter ?? filter;
    const m = next.measure ?? measure;
    const query = new URLSearchParams();
    query.set('period', periodToParam(p));
    if (f.device) query.set('device', f.device);
    if (f.library) query.set('lib', f.library);
    if (f.book) query.set('book', f.book);
    if (m !== 'chars') query.set('measure', m);
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

  function setFilter(key: keyof StatsFilter, value: string | null) {
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

  async function correct(entry: StatEntry, value: { seconds: number; chars: number }) {
    actionError = '';
    if (!(await stats.correctSession(entry.id, value))) {
      actionError = 'The correction could not be saved.';
      return false;
    }
    return true;
  }

  async function exclude(entry: StatEntry) {
    actionError = '';
    if (!(await stats.excludeSession(entry.id))) actionError = 'The session could not be changed.';
  }

  async function clearFix(entry: StatEntry) {
    actionError = '';
    if (!(await stats.clearFix(entry.id))) actionError = 'The session could not be changed.';
  }

  async function removeSession(entry: StatEntry) {
    actionError = '';
    const clock = entryNote(entry);
    const confirmed = await confirmDestructive(
      deleteSessionCopy({
        title: bookTitle(entry.bookId),
        when: `${formatDay(entry.day, currentYear)}${clock ? `, ${clock}` : ''}`,
        numbers: `${formatDuration(entry.seconds)} · ${formatNumber(entry.chars)} characters`
      })
    );
    if (!confirmed) return;
    if (!(await stats.deleteSession(entry.id))) actionError = 'The session could not be deleted.';
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

  /** The filters as the image words them: "Device: Boox", "Library: …", "Book: …". */
  function filterLabels(): string[] {
    const out: string[] = [];
    if (filter.device) {
      const name = deviceChoices.find((d) => d.id === filter.device)?.name ?? 'one device';
      out.push(`Device: ${name.replace(' (this device)', '')}`);
    }
    if (filter.library) {
      out.push(
        `Library: ${libraries?.find((l) => l.id === filter.library)?.name ?? 'one library'}`
      );
    }
    if (filter.book) out.push(`Book: ${bookTitle(filter.book)}`);
    return out;
  }

  /** WP12d: the period on screen as a PNG (1080 × 1350), downloaded. */
  async function saveImage() {
    imageBusy = true;
    imageNote = '';
    try {
      const model = buildStatsImageModel({
        view,
        period,
        filters: filterLabels(),
        today: todayKey,
        weekStart,
        goals,
        goalInput: {
          entries,
          readThroughs,
          books,
          speedMinSeconds: Math.max(0, Number($speedGoalMinMinutes$) || 0) * 60
        },
        thumbnails: new Map([...books].map(([id, info]) => [id, info.thumbnail ?? null]))
      });
      const blob = await renderStatsImage(model);
      downloadBlob(blob, statsImageFileName(period));
      imageNote = 'Saved.';
    } catch (error) {
      logger.warn(`Stats image: ${(error as Error)?.message ?? error}`);
      imageNote = `The image could not be made: ${(error as Error)?.message ?? error}`;
    } finally {
      imageBusy = false;
    }
  }

  function selectAll(node: HTMLTextAreaElement) {
    node.focus();
    node.select();
  }
</script>

<svelte:head>
  <title>{formatPageTitle('Stats')}</title>
</svelte:head>

<AppHeader title="Stats" search />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="stats-page">
  <CataloguePageHeader jp="読書記録" title="Stats">
    {#if loaded}
      <DropdownMenu
        buttonClass="c-btn c-btn-secondary c-btn-sm gap-2 px-3 text-sm"
        align="right"
        panelWidth="w-64"
        label="Share"
        testid="stats-share"
        let:close
      >
        <span slot="button" class="flex items-center gap-2">
          <Fa icon={faShareFromSquare} />
          {imageBusy ? 'Making the image…' : 'Share'}
        </span>
        <div class="flex flex-col gap-1">
          <button
            type="button"
            class={menuItem}
            data-testid="stats-save-image"
            disabled={imageBusy}
            on:click={() => {
              close();
              void saveImage();
            }}
          >
            Save as image
          </button>
          <p class="px-3 pt-2 text-xs text-c-muted">For your TMW log</p>
          <button
            type="button"
            class={menuItem}
            data-testid="stats-tmw-chars"
            on:click={() => {
              close();
              void copyTmw('chars');
            }}
          >
            Copy characters
          </button>
          <button
            type="button"
            class={menuItem}
            data-testid="stats-tmw-minutes"
            on:click={() => {
              close();
              void copyTmw('minutes');
            }}
          >
            Copy minutes
          </button>
        </div>
      </DropdownMenu>
    {/if}
  </CataloguePageHeader>

  {#if tmwNote || imageNote}
    <div class="flex flex-wrap items-center gap-3 pb-2 text-sm">
      {#if tmwNote}
        <span role="status">{tmwNote}</span>
      {/if}
      {#if imageNote}
        <span role="status" data-testid="stats-image-note">{imageNote}</span>
      {/if}
    </div>
  {/if}
  {#if tmwText}
    <textarea
      class="c-input mb-3 w-full p-2 font-mono text-sm"
      rows="6"
      readonly
      data-testid="stats-tmw-text"
      use:selectAll>{tmwText}</textarea
    >
  {/if}

  <!-- The period and Filters: one bar that stays under the header while scrolling. -->
  <div class="c-period-bar" data-testid="stats-period-bar">
    <div class="c-stats-seg c-period-kinds" role="group" aria-label="Period">
      {#each PERIOD_KINDS as choice (choice.kind)}
        <button
          type="button"
          aria-pressed={period.kind === choice.kind}
          data-testid="stats-period-{choice.kind}"
          on:click={() => choosePeriod(choice.kind)}
        >
          {choice.label}
        </button>
      {/each}
      <button
        type="button"
        aria-pressed={period.kind === 'custom'}
        aria-expanded={showCustom}
        data-testid="stats-period-custom"
        on:click={openCustom}
      >
        Dates…
      </button>
    </div>
    <div class="c-stepper">
      <button
        type="button"
        class="c-btn c-btn-secondary c-btn-icon c-btn-sm"
        title="Previous"
        aria-label="Previous period"
        disabled={period.kind === 'all'}
        data-testid="stats-prev"
        on:click={() => navigate({ period: stepPeriod(period, -1, weekStart) })}
      >
        ‹
      </button>
      <h2 class="c-period-label" data-testid="stats-period-label">{label}</h2>
      <button
        type="button"
        class="c-btn c-btn-secondary c-btn-icon c-btn-sm"
        title="Next"
        aria-label="Next period"
        disabled={period.kind === 'all'}
        data-testid="stats-next"
        on:click={() => navigate({ period: stepPeriod(period, 1, weekStart) })}
      >
        ›
      </button>
    </div>
    <button
      type="button"
      class="c-btn c-btn-secondary c-btn-sm min-w-[var(--c-btn-h-sm)] gap-2 px-3 text-sm"
      title="Filters"
      aria-label="Filters"
      aria-expanded={filtersOpen}
      aria-controls="stats-filters"
      data-testid="stats-filters-toggle"
      on:click={() => (filtersOpen = !filtersOpen)}
    >
      <!-- Phones: the icon only, so the period and Filters fit on one row. -->
      <Fa icon={faFilter} />
      <span class="hidden sm:inline">Filters</span>{#if filterCount}<span
          class="c-count-badge"
          data-testid="stats-filter-count">{filterCount}</span
        >{/if}
    </button>
  </div>

  {#if showCustom}
    <form
      class="c-stats-card mt-3 flex flex-wrap items-end gap-3 px-4 py-3 sm:px-5"
      data-testid="stats-custom-range"
      on:submit|preventDefault={applyCustom}
    >
      <label class="flex flex-col gap-1 text-sm text-c-muted">
        From
        <input class="c-input" type="date" bind:value={customFrom} />
      </label>
      <label class="flex flex-col gap-1 text-sm text-c-muted">
        To
        <input class="c-input" type="date" bind:value={customTo} />
      </label>
      <button class="c-btn c-btn-primary px-4" type="submit">Show</button>
    </form>
  {/if}

  {#if filtersOpen}
    <div
      id="stats-filters"
      class="c-stats-card mt-3 grid gap-3 p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3"
      data-testid="stats-filters"
    >
      <SearchPicker
        label="Book"
        allLabel="All books"
        placeholder="Type a title"
        options={bookOptions}
        value={filter.book}
        valueLabel={filter.book ? bookTitle(filter.book) : ''}
        testid="stats-filter-book"
        on:change={(e) => setFilter('book', e.detail)}
      />
      <SearchPicker
        label="Device"
        allLabel="All devices"
        placeholder="Type a device name"
        options={deviceOptions}
        value={filter.device}
        valueLabel={deviceName}
        testid="stats-filter-device"
        on:change={(e) => setFilter('device', e.detail)}
      />
      {#if libraries && libraries.length > 1}
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium uppercase tracking-wider text-c-muted">Library</span>
          <div
            class="flex flex-wrap gap-2"
            role="group"
            aria-label="Library"
            data-testid="stats-filter-library"
          >
            <button
              type="button"
              class="c-chip"
              aria-pressed={!filter.library}
              on:click={() => setFilter('library', null)}
            >
              All libraries
            </button>
            {#each libraries as library (library.id)}
              <button
                type="button"
                class="c-chip"
                aria-pressed={filter.library === library.id}
                on:click={() => setFilter('library', library.id)}
              >
                {library.name}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if filterCount}
    <div
      class="flex flex-wrap items-center gap-2 pt-3"
      role="group"
      aria-label="Filters on"
      data-testid="stats-chips"
    >
      {#if filter.book}
        <button type="button" class={chip} on:click={() => setFilter('book', null)}>
          <span class="max-w-[16rem] truncate">Book: {bookTitle(filter.book)}</span>
          <Fa icon={faXmark} /><span class="sr-only">Remove</span>
        </button>
      {/if}
      {#if filter.device}
        <button type="button" class={chip} on:click={() => setFilter('device', null)}>
          <span class="max-w-[14rem] truncate">Device: {deviceName}</span>
          <Fa icon={faXmark} /><span class="sr-only">Remove</span>
        </button>
      {/if}
      {#if filter.library}
        <button type="button" class={chip} on:click={() => setFilter('library', null)}>
          <span class="max-w-[14rem] truncate">Library: {libraryName}</span>
          <Fa icon={faXmark} /><span class="sr-only">Remove</span>
        </button>
      {/if}
      <button
        type="button"
        class="c-btn c-btn-ghost c-btn-sm px-2 text-sm"
        data-testid="stats-filter-clear"
        on:click={() => navigate({ filter: { device: null, library: null, book: null } })}
      >
        Show all
      </button>
    </div>
  {/if}
  {#if infoError}
    <p class="c-notice" role="alert" data-testid="stats-info-error">{infoError}</p>
  {/if}

  {#if !loaded}
    <p class="py-6 text-c-muted">Loading…</p>
  {:else}
    <!-- Totals -->
    <dl class="c-tiles" data-testid="stats-summary" aria-label="Totals for {label}">
      {#each TILES as tile (tile.key)}
        <div class="c-tile-box">
          <dt class="text-xs font-semibold uppercase tracking-wider text-c-muted">{tile.label}</dt>
          <dd class="c-tile-value" data-testid="stats-total-{tile.id}">
            {tileValue(tile.key, view.summary)}
          </dd>
          {#if changes[tile.key]?.change}
            <dd
              class="c-change c-change-{trend(changes[tile.key]?.change)}"
              data-testid="stats-change-{tile.id}"
            >
              <span aria-hidden="true"
                >{trend(changes[tile.key]?.change) === 'up'
                  ? '▲'
                  : trend(changes[tile.key]?.change) === 'down'
                    ? '▼'
                    : '–'}</span
              >
              <span>{changes[tile.key]?.change}</span>
            </dd>
          {/if}
          {#if changes[tile.key]?.whole}
            <dd class="pt-0.5 text-xs text-c-muted" data-testid="stats-whole-{tile.id}">
              {changes[tile.key]?.whole}
            </dd>
          {/if}
        </div>
      {/each}
    </dl>
    {#if view.summary.manualChars}
      <p class="pt-2 text-sm text-c-muted" data-testid="stats-manual-note">
        Characters include {formatNumber(view.summary.manualChars)} from books marked completed by hand
        (no time, so not in the speed).
      </p>
    {/if}
    {#if filter.device}
      <p class="pt-2 text-sm text-c-muted">
        Books completed counts every device: a completion isn't tied to one device.
      </p>
    {/if}

    <!-- Phase 11: this week, month or year beside the one before it; WP12c goals. -->
    <div class="c-duo">
      {#if comparison && chart}
        <StatsPeriodChart
          {chart}
          {comparison}
          {measure}
          today={todayKey}
          on:measure={(ev) => navigate({ measure: ev.detail })}
        />
      {:else if comparison?.state === 'future'}
        <p
          class="c-stats-card px-4 py-5 text-sm text-c-muted sm:px-5"
          data-testid="stats-chart-future"
        >
          This {comparison.kind} hasn't started yet.
        </p>
      {/if}
      <StatsGoals
        {stats}
        {goals}
        {entries}
        {readThroughs}
        {books}
        {todayKey}
        {weekStart}
        speedMinMinutes={$speedGoalMinMinutes$}
      />
    </div>

    {#if !entries.length && !readThroughs.size}
      <p class="c-stats-card mt-8 px-4 py-6 text-center sm:px-5" data-testid="stats-empty">
        No reading recorded yet. Turn on the tracker in a book; sessions from every device show
        here.
      </p>
    {:else}
      <!-- Calendar (all time, filters applied) -->
      {#if heatmapData.length}
        <section class="pt-8" data-testid="stats-heatmap" aria-labelledby="stats-heatmap-title">
          <div class="c-sec-head">
            <h2 id="stats-heatmap-title" class="font-mincho text-xl font-bold sm:text-2xl">
              Calendar
            </h2>
            <span class="text-sm text-c-muted">Every day you read, with the filters applied</span>
          </div>
          <div class="c-stats-card px-3 py-4 sm:px-5">
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
          </div>
        </section>
      {/if}

      <!-- Books -->
      <section class="pt-8" data-testid="stats-books" aria-labelledby="stats-books-title">
        <div class="c-sec-head">
          <h2 id="stats-books-title" class="font-mincho text-xl font-bold sm:text-2xl">Books</h2>
          {#if view.books.length}
            <span class="text-sm text-c-muted">
              {view.books.length.toLocaleString('en-US')} read in this period · tap a title to see only
              that book
            </span>
          {/if}
        </div>
        {#if view.books.length}
          <StatsBooksTable rows={view.books} {books} on:pick={(e) => setFilter('book', e.detail)} />
        {:else}
          <p class="c-stats-card px-4 py-5 text-sm text-c-muted sm:px-5">
            No reading in this period.
          </p>
        {/if}
      </section>

      <!-- Reading log (days and sessions) -->
      <section class="pt-8" data-testid="stats-days" aria-labelledby="stats-days-title">
        <div class="c-sec-head">
          <h2 id="stats-days-title" class="font-mincho text-xl font-bold sm:text-2xl">
            Reading log
          </h2>
          <span class="text-sm text-c-muted">
            Each day's sessions; open a day to correct, leave out or delete one
          </span>
        </div>
        {#if actionError}
          <p class="pb-2 text-sm font-semibold" role="alert">{actionError}</p>
        {/if}
        {#key logKey}
          <StatsReadingLog
            days={view.days}
            {currentYear}
            {bookTitle}
            {deviceLabel}
            {entryNote}
            {correct}
            {exclude}
            {clearFix}
            remove={removeSession}
          />
        {/key}
      </section>
    {/if}
  {/if}
</div>

<AppBottomBar />

<style>
  /* Under the fixed header (48 px; 40 px from 1280 px) while the page scrolls. */
  .c-period-bar {
    position: sticky;
    top: 3rem;
    z-index: 20;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.625rem;
    margin: 0 -1rem;
    padding: 0.5rem 1rem;
    background-color: var(--c-bg);
    border-bottom: 1px solid var(--c-gold);
  }

  @media (min-width: 768px) {
    .c-period-bar {
      margin: 0 -2rem;
      padding: 0.5rem 2rem;
    }
  }

  @media (min-width: 1280px) {
    .c-period-bar {
      top: 2.5rem;
    }
  }

  /* Phones: the period choices fill the first row; the stepper and Filters share the next. */
  .c-period-kinds {
    flex: 1 1 100%;
  }

  @media (min-width: 768px) {
    .c-period-kinds {
      flex: 0 1 auto;
    }
  }

  .c-stepper {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    align-items: center;
    gap: 0.25rem;
  }

  @media (min-width: 768px) {
    .c-stepper {
      flex: 0 1 auto;
      margin-left: auto;
    }
  }

  .c-period-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
    font-family: 'Shippori Mincho', 'Noto Serif JP', serif;
    font-size: 1.125rem;
    font-weight: 700;
  }

  @media (min-width: 768px) {
    .c-period-label {
      min-width: 11rem;
    }
  }

  .c-count-badge {
    display: inline-flex;
    min-width: 1.25rem;
    height: 1.25rem;
    align-items: center;
    justify-content: center;
    padding: 0 0.3rem;
    border-radius: 999px;
    background-color: var(--c-sel-bg);
    color: var(--c-sel-ink);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .c-tiles {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.625rem;
    padding-top: 1rem;
  }

  @media (min-width: 768px) {
    .c-tiles {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  .c-tile-box {
    min-width: 0;
    padding: 0.75rem 0.875rem;
    border-radius: 0.625rem;
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }

  .c-tile-value {
    padding-top: 0.25rem;
    font-family: 'Shippori Mincho', 'Noto Serif JP', serif;
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  @media (min-width: 640px) {
    .c-tile-value {
      font-size: 1.75rem;
    }
  }

  .c-change {
    display: flex;
    gap: 0.25rem;
    padding-top: 0.25rem;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  /* Green and red that stay at 4.5:1 on the tiles; E-ink keeps the ▲/▼ only. */
  .c-change-up {
    color: #1f6b3a;
  }

  .c-change-down {
    color: #a3301b;
  }

  .c-change-flat {
    color: var(--c-muted);
  }

  :global(html.catalogue-dark) .c-change-up {
    color: #8fd3a6;
  }

  :global(html.catalogue-dark) .c-change-down {
    color: #ee9a84;
  }

  :global(html.eink) .c-change-up,
  :global(html.eink) .c-change-down {
    color: #000;
  }

  /* The chart beside Goals from 1280 px; stacked below. */
  .c-duo {
    display: grid;
    gap: 1rem;
    padding-top: 2rem;
    align-items: start;
  }

  @media (min-width: 1280px) {
    .c-duo {
      grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr);
    }
  }

  .c-sec-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.75rem;
    padding-bottom: 0.75rem;
  }
</style>
