<script lang="ts">
  import {
    bucketReadout,
    CHART_MEASURES,
    formatMeasure,
    runningReadout,
    type ChartMeasure,
    type PeriodChart,
    type PeriodComparison
  } from '$lib/stats/period-compare';
  import { periodLabel } from '$lib/stats/periods';
  import { createEventDispatcher } from 'svelte';

  /**
   * Season 2 Phase 11: a week, month or year beside the one before it, as paired bars
   * (this period filled, the previous one outlined) or as running totals (this period
   * solid, the previous one dashed), one at a time in one card (2026-11-22 redesign). Tap or click anywhere on a chart to read a day or
   * month; arrow keys move it when the chart has focus. Plain SVG drawn with the
   * catalogue colours (black and white in E-ink), no transitions.
   */

  export let chart: PeriodChart;
  export let comparison: PeriodComparison;
  export let measure: ChartMeasure;
  export let today: string;

  const dispatch = createEventDispatcher<{ measure: ChartMeasure }>();
  const UNIT = { week: 'week', month: 'month', year: 'year' } as const;

  /** 2026-11-22 redesign: one chart at a time (by day / month, or running total). */
  let view: 'bars' | 'running' = 'bars';
  let bucket = 0;
  let day = 0;
  let shownKey = '';

  // A new period starts on today (running) or its last day/month; a new measure keeps the place.
  $: {
    const key = `${comparison.kind}:${comparison.period.from}`;
    if (key !== shownKey) {
      shownKey = key;
      bucket = chart.selectedBucket;
      day = chart.selectedDay;
    }
  }

  $: buckets = chart.buckets;
  // The top line's value (0 when nothing was read); the scale never divides by 0.
  $: barTop = Math.max(0, ...buckets.flatMap((b) => [b.current ?? 0, b.previous ?? 0]));
  $: barMax = Math.max(1, barTop);
  $: runLength = chart.running.current.length;
  $: runTop = Math.max(
    0,
    ...chart.running.current.map((v) => v ?? 0),
    ...chart.running.previous.map((v) => v ?? 0)
  );
  $: runMax = Math.max(1, runTop);
  $: runSpan = Math.max(1, runLength - 1);
  $: currentPoints = points(chart.running.current);
  $: previousPoints = points(chart.running.previous);
  $: empty =
    buckets.every((b) => !b.current && !b.previous) &&
    chart.running.current.every((v) => !v) &&
    chart.running.previous.every((v) => !v);
  $: thisLabel = periodLabel(comparison.period);
  $: previousLabel = periodLabel(comparison.previous);
  $: barsTitle = comparison.kind === 'year' ? 'By month' : 'By day';
  $: runTitle = measure === 'speed' ? 'Speed so far' : 'Running total';
  $: barText = bucketReadout(chart, Math.min(bucket, buckets.length - 1));
  $: runText = runningReadout(chart, Math.min(day, runLength - 1), today);

  function y(value: number, max: number): number {
    return 100 - (value / max) * 94;
  }

  function points(values: (number | null)[]): string {
    const out: string[] = [];
    values.forEach((v, i) => {
      if (v !== null) out.push(`${runLength === 1 ? 0.5 : i},${y(v, runMax)}`);
    });
    return out.join(' ');
  }

  function pick(ev: MouseEvent, count: number, set: (i: number) => void, round: boolean) {
    const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    if (!box.width) return;
    const frac = Math.min(0.9999, Math.max(0, (ev.clientX - box.left) / box.width));
    set(round ? Math.round(frac * (count - 1)) : Math.floor(frac * count));
  }

  function keys(ev: KeyboardEvent, count: number, current: number, set: (i: number) => void) {
    const next =
      ev.key === 'ArrowLeft' || ev.key === 'ArrowDown'
        ? current - 1
        : ev.key === 'ArrowRight' || ev.key === 'ArrowUp'
          ? current + 1
          : ev.key === 'Home'
            ? 0
            : ev.key === 'End'
              ? count - 1
              : null;
    if (next === null) return;
    ev.preventDefault();
    set(Math.min(count - 1, Math.max(0, next)));
  }

  /** Centred under its day, except the first and last label (kept inside the edges). */
  function tickShift(i: number, span: number, length: number): string {
    if (length === 1 || (i > 0 && i < span)) return '-translate-x-1/2';
    return i === span ? '-translate-x-full' : '';
  }

  const setBucket = (i: number) => (bucket = i);
  const setDay = (i: number) => (day = i);
</script>

<section class="c-stats-card" data-testid="stats-charts" data-kind={comparison.kind}>
  <div class="c-stats-card-head">
    <h2 class="font-mincho text-lg font-bold sm:text-xl">
      Compared with last {UNIT[comparison.kind]}
    </h2>
    <div class="c-stats-seg" role="group" aria-label="Chart">
      <button
        type="button"
        aria-pressed={view === 'bars'}
        data-testid="stats-chart-view-bars"
        on:click={() => (view = 'bars')}
      >
        {barsTitle}
      </button>
      <button
        type="button"
        aria-pressed={view === 'running'}
        data-testid="stats-chart-view-running"
        on:click={() => (view = 'running')}
      >
        {runTitle}
      </button>
    </div>
  </div>
  <div class="px-4 pt-3 sm:px-5">
    <div class="c-stats-seg" role="group" aria-label="Chart measure">
      {#each CHART_MEASURES as choice (choice.measure)}
        <button
          type="button"
          aria-pressed={measure === choice.measure}
          data-testid="stats-chart-measure-{choice.measure}"
          on:click={() => dispatch('measure', choice.measure)}
        >
          {choice.label}
        </button>
      {/each}
    </div>
    {#if empty}
      <p class="pt-2 text-sm text-c-muted" data-testid="stats-chart-empty">
        No {measure === 'speed' ? 'tracked reading' : 'reading'} in either {UNIT[comparison.kind]}.
      </p>
    {/if}
  </div>

  {#if view === 'bars'}
    <!-- Paired bars -->
    <div class="px-4 pb-4 pt-3 sm:px-5" data-testid="stats-chart-bars">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span class="flex items-center gap-1.5">
            <span class="swatch-current inline-block h-3 w-3 rounded-sm" />{thisLabel}
          </span>
          <span class="flex items-center gap-1.5">
            <span class="swatch-previous inline-block h-3 w-3 rounded-sm" />{previousLabel}
          </span>
        </div>
        <div class="text-xs text-c-muted" data-testid="stats-chart-bars-max">
          {formatMeasure(measure, barTop)}
        </div>
      </div>
      <div
        class="chart relative mt-1 h-44 w-full cursor-pointer"
        role="slider"
        tabindex="0"
        aria-label="{barsTitle}: choose a {comparison.kind === 'year' ? 'month' : 'day'}"
        aria-valuemin={1}
        aria-valuemax={buckets.length}
        aria-valuenow={bucket + 1}
        aria-valuetext={barText}
        data-testid="stats-chart-bars-area"
        on:click={(ev) => pick(ev, buckets.length, setBucket, false)}
        on:keydown={(ev) => keys(ev, buckets.length, bucket, setBucket)}
      >
        <svg
          class="block h-full w-full"
          viewBox="0 0 {buckets.length} 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line class="axis" x1="0" y1="100" x2={buckets.length} y2="100" />
          <line class="grid" x1="0" y1="6" x2={buckets.length} y2="6" />
          <line class="grid" x1="0" y1="53" x2={buckets.length} y2="53" />
          <line class="marker" x1={bucket + 0.5} y1="0" x2={bucket + 0.5} y2="100" />
          {#each buckets as b, i (i)}
            {#if b.current}
              <rect
                class="bar-current"
                x={i + 0.1}
                y={y(b.current, barMax)}
                width="0.38"
                height={100 - y(b.current, barMax)}
                data-testid="stats-chart-bar-current"
              />
            {/if}
            {#if b.previous}
              <rect
                class="bar-previous"
                x={i + 0.54}
                y={y(b.previous, barMax)}
                width="0.36"
                height={100 - y(b.previous, barMax)}
                data-testid="stats-chart-bar-previous"
              />
            {/if}
          {/each}
        </svg>
      </div>
      <div
        class="grid pt-1 text-center text-xs text-c-muted"
        style:grid-template-columns="repeat({buckets.length}, minmax(0, 1fr))"
        aria-hidden="true"
      >
        {#each buckets as b, i (i)}
          <span class="overflow-visible whitespace-nowrap">{b.tick}</span>
        {/each}
      </div>
      <p class="pt-2 text-sm" aria-live="polite" data-testid="stats-chart-bars-readout">
        {barText}
      </p>
    </div>
  {:else}
    <!-- Running totals -->
    <div class="px-4 pb-4 pt-3 sm:px-5" data-testid="stats-chart-running">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span class="flex items-center gap-1.5">
            <svg class="h-3 w-6" viewBox="0 0 24 12" aria-hidden="true">
              <line class="line-current" x1="0" y1="6" x2="24" y2="6" />
            </svg>{thisLabel}
          </span>
          <span class="flex items-center gap-1.5">
            <svg class="h-3 w-6" viewBox="0 0 24 12" aria-hidden="true">
              <line class="line-previous" x1="0" y1="6" x2="24" y2="6" />
            </svg>{previousLabel}
          </span>
        </div>
        <div class="text-xs text-c-muted" data-testid="stats-chart-running-max">
          {formatMeasure(measure, runTop)}
        </div>
      </div>
      <div
        class="chart relative mt-1 h-44 w-full cursor-pointer"
        role="slider"
        tabindex="0"
        aria-label="{runTitle}: choose a day"
        aria-valuemin={1}
        aria-valuemax={runLength}
        aria-valuenow={day + 1}
        aria-valuetext={runText}
        data-testid="stats-chart-running-area"
        on:click={(ev) => pick(ev, runLength, setDay, true)}
        on:keydown={(ev) => keys(ev, runLength, day, setDay)}
      >
        <svg
          class="block h-full w-full overflow-visible"
          viewBox="0 0 {runSpan} 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line class="axis" x1="0" y1="100" x2={runSpan} y2="100" />
          <line class="grid" x1="0" y1="6" x2={runSpan} y2="6" />
          <line class="grid" x1="0" y1="53" x2={runSpan} y2="53" />
          <line class="marker" x1={day} y1="0" x2={day} y2="100" />
          {#if previousPoints}
            <polyline class="line-previous" points={previousPoints} />
          {/if}
          {#if currentPoints}
            <polyline class="line-current" points={currentPoints} />
          {/if}
        </svg>
      </div>
      <div class="relative h-5 pt-1 text-xs text-c-muted" aria-hidden="true">
        {#each chart.running.ticks as tick, i (i)}
          {#if tick}
            <!-- The first and last labels stay inside the chart's edges. -->
            <span
              class="absolute whitespace-nowrap {tickShift(i, runSpan, runLength)}"
              style:left="{runLength === 1 ? 50 : (i / runSpan) * 100}%">{tick}</span
            >
          {/if}
        {/each}
      </div>
      <p class="pt-2 text-sm" aria-live="polite" data-testid="stats-chart-running-readout">
        {runText}
      </p>
    </div>
  {/if}
</section>

<style>
  .chart:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: 2px;
  }

  .bar-current {
    fill: var(--c-fill);
  }

  .bar-previous {
    fill: none;
    stroke: var(--c-muted);
    stroke-width: 1.5px;
    vector-effect: non-scaling-stroke;
  }

  .swatch-current {
    background-color: var(--c-fill);
  }

  .swatch-previous {
    border: 1.5px solid var(--c-muted);
  }

  .axis {
    stroke: var(--c-ink);
    stroke-width: 1px;
    vector-effect: non-scaling-stroke;
  }

  .grid {
    stroke: var(--c-line-strong);
    stroke-width: 1px;
    stroke-dasharray: 2 4;
    vector-effect: non-scaling-stroke;
  }

  .marker {
    stroke: var(--c-ink);
    stroke-width: 1px;
    stroke-dasharray: 3 3;
    vector-effect: non-scaling-stroke;
  }

  .line-current {
    fill: none;
    stroke: var(--c-fill);
    stroke-width: 2.5px;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }

  .line-previous {
    fill: none;
    stroke: var(--c-muted);
    stroke-width: 1.5px;
    stroke-dasharray: 5 4;
    vector-effect: non-scaling-stroke;
  }

  :global(html.eink) .bar-previous,
  :global(html.eink) .swatch-previous {
    stroke-width: 2px;
    border-width: 2px;
  }
</style>
