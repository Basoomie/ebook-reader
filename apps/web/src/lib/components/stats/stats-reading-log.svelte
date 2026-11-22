<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Stats page's reading log (2026-11-22 redesign; was "Days"): one row per day with its
   * totals and number of sessions, opened to show the sessions. The newest day is open.
   * Each session's actions (Correct…, Leave out, Count again, Undo correction) are in its
   * ⋯ menu; correcting opens the form under the session. Seven days a page, so the page
   * never grows with the period. The page keeps the rules: it saves and leaves out.
   */
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import ListPager from '$lib/components/list-pager.svelte';
  import type { StatEntry } from '$lib/stats/aggregate';
  import { formatDay, formatDuration, formatNumber, parseCount } from '$lib/stats/stats-format';
  import type { StatsDayRow } from '$lib/stats/stats-view';

  export let days: StatsDayRow[];
  export let currentYear: string;
  export let bookTitle: (bookId: string) => string;
  export let deviceLabel: (entry: StatEntry) => string;
  export let entryNote: (entry: StatEntry) => string;
  /** Saves a correction; false when it couldn't be saved. */
  export let correct: (
    entry: StatEntry,
    value: { seconds: number; chars: number }
  ) => Promise<boolean>;
  export let exclude: (entry: StatEntry) => void;
  export let clearFix: (entry: StatEntry) => void;

  const PER_PAGE = 7;
  const menuItem = 'c-btn c-btn-ghost w-full justify-start px-3 text-left';

  let page = 1;
  let open = new Set<string>(days[0] ? [days[0].day] : []);
  let editing: { id: string; minutes: string; chars: string; error: string } | null = null;
  let root: HTMLElement;

  $: pages = Math.max(1, Math.ceil(days.length / PER_PAGE));
  $: if (page > pages) page = pages;
  $: shown = days.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  $: allOpen = shown.length > 0 && shown.every((d) => open.has(d.day));

  function toggle(day: string) {
    const next = new Set(open);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    open = next;
  }

  function toggleAll() {
    open = allOpen ? new Set() : new Set([...open, ...shown.map((d) => d.day)]);
  }

  function goTo(next: number) {
    page = next;
    editing = null;
    root?.scrollIntoView({ block: 'start' });
  }

  function sessionCount(day: StatsDayRow): string {
    const n = day.entries.length;
    return `${n} session${n === 1 ? '' : 's'}`;
  }

  function lookups(n: number): string {
    return `${formatNumber(n)} lookup${n === 1 ? '' : 's'}`;
  }

  function startEdit(entry: StatEntry) {
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
    if (await correct(entry, { seconds, chars })) editing = null;
  }

  function cancelOnEscape(ev: KeyboardEvent) {
    if (ev.key === 'Escape') editing = null;
  }
</script>

<div class="c-stats-card c-log" bind:this={root} data-testid="stats-log">
  {#if days.length > 1}
    <div class="flex items-center justify-end border-b border-c-line px-4 py-1 sm:px-5">
      <button
        type="button"
        class="c-btn c-btn-ghost c-btn-sm px-2 text-sm"
        data-testid="stats-days-toggle-all"
        on:click={toggleAll}
      >
        {allOpen ? 'Close all' : 'Open all'}
      </button>
    </div>
  {/if}
  {#each shown as day (day.day)}
    <div class="c-day" data-testid="stats-day" data-day={day.day}>
      <button
        type="button"
        class="c-day-head"
        aria-expanded={open.has(day.day)}
        on:click={() => toggle(day.day)}
      >
        <h3 class="c-day-date">{formatDay(day.day, currentYear)}</h3>
        <span class="c-day-sum">
          <b>{formatDuration(day.totals.seconds)}</b> ·
          <b>{formatNumber(day.totals.chars)}</b> characters{#if day.totals.lookups}
            · {lookups(day.totals.lookups)}{/if} · {sessionCount(day)}
        </span>
        <span class="c-chev" aria-hidden="true">›</span>
      </button>
      {#if open.has(day.day)}
        <ul class="c-sessions">
          {#each day.entries as entry (entry.id)}
            <li
              class="c-session"
              class:c-out={entry.excluded}
              data-testid="stats-entry"
              data-entry-id={entry.id}
              data-excluded={entry.excluded ? '1' : '0'}
            >
              <span class="c-when">{entryNote(entry) || ' '}</span>
              <div class="min-w-0">
                <div class="truncate">{bookTitle(entry.bookId)}</div>
                <div class="text-xs text-c-muted">
                  {deviceLabel(entry)}{#if entry.excluded}
                    · Left out of the totals{/if}
                </div>
              </div>
              <div class="c-figures" data-testid="stats-entry-numbers">
                <span class:line-through={entry.excluded}>
                  {formatDuration(entry.seconds)} · {formatNumber(entry.chars)}
                </span>
                {#if entry.lookups}
                  <span class="block text-xs text-c-muted">{lookups(entry.lookups)}</span>
                {/if}
                {#if entry.recorded}
                  <span class="block text-xs text-c-muted" data-testid="stats-entry-corrected">
                    Corrected (recorded {formatDuration(entry.recorded.seconds)} · {formatNumber(
                      entry.recorded.chars
                    )})
                  </span>
                {/if}
              </div>
              {#if entry.source !== 'frozen'}
                <DropdownMenu
                  buttonClass="c-btn c-btn-ghost c-btn-icon c-btn-sm"
                  align="right"
                  panelWidth="w-56"
                  label="Session: {bookTitle(entry.bookId)}"
                  testid="stats-entry-menu"
                  let:close
                >
                  <span slot="button" aria-label="Session options">⋯</span>
                  <div class="flex flex-col gap-1">
                    {#if entry.excluded || entry.recorded}
                      <button
                        type="button"
                        class={menuItem}
                        data-testid="stats-entry-restore"
                        on:click={() => {
                          close();
                          clearFix(entry);
                        }}
                      >
                        {entry.excluded ? 'Count again' : 'Undo correction'}
                      </button>
                    {/if}
                    {#if !entry.excluded}
                      <button
                        type="button"
                        class={menuItem}
                        data-testid="stats-entry-correct"
                        on:click={() => {
                          close();
                          startEdit(entry);
                        }}
                      >
                        Correct…
                      </button>
                      <button
                        type="button"
                        class={menuItem}
                        data-testid="stats-entry-exclude"
                        on:click={() => {
                          close();
                          exclude(entry);
                        }}
                      >
                        Leave out of the totals
                      </button>
                    {/if}
                  </div>
                </DropdownMenu>
              {:else}
                <span />
              {/if}
            </li>
            {#if editing && editing.id === entry.id}
              <li>
                <form
                  class="flex flex-wrap items-end gap-2 pb-3 pt-1"
                  data-testid="stats-correct-form"
                  on:submit|preventDefault={() => saveEdit(entry)}
                >
                  {#if entry.source !== 'completion'}
                    <label class="flex flex-col gap-1 text-sm text-c-muted">
                      Minutes
                      <input
                        class="c-input w-28"
                        inputmode="decimal"
                        bind:value={editing.minutes}
                        on:keydown={cancelOnEscape}
                        data-testid="stats-correct-minutes"
                      />
                    </label>
                  {/if}
                  <label class="flex flex-col gap-1 text-sm text-c-muted">
                    Characters
                    <input
                      class="c-input w-36"
                      inputmode="numeric"
                      bind:value={editing.chars}
                      on:keydown={cancelOnEscape}
                      data-testid="stats-correct-chars"
                    />
                  </label>
                  <button class="c-btn c-btn-primary px-4" type="submit">Save</button>
                  <button
                    class="c-btn c-btn-secondary px-4"
                    type="button"
                    on:click={() => (editing = null)}
                  >
                    Cancel
                  </button>
                  {#if editing.error}
                    <p class="w-full text-sm font-semibold" role="alert">{editing.error}</p>
                  {/if}
                </form>
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
    </div>
  {:else}
    <p class="px-4 py-5 text-sm text-c-muted sm:px-5">No reading in this period.</p>
  {/each}
  {#if pages > 1}
    <ListPager {page} {pages} label="Days" testid="stats-days" on:go={(e) => goTo(e.detail)} />
  {/if}
</div>

<style>
  .c-log {
    scroll-margin-top: 9rem;
  }

  .c-day + .c-day {
    border-top: 1px solid var(--c-line);
  }

  .c-day-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.25rem 1rem;
    align-items: center;
    width: 100%;
    min-height: 3rem;
    padding: 0.75rem 1rem;
    text-align: left;
  }

  @media (min-width: 640px) {
    .c-day-head {
      grid-template-columns: 9rem minmax(0, 1fr) auto;
      padding: 0.75rem 1.25rem;
    }
  }

  @media (hover: hover) {
    :global(html:not(.eink)) .c-day-head:hover {
      background-color: var(--c-tint);
    }
  }

  .c-day-head:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -2px;
  }

  .c-day-date {
    font-family: 'Shippori Mincho', 'Noto Serif JP', serif;
    font-size: 1rem;
    font-weight: 700;
  }

  .c-day-sum {
    grid-column: 1 / -1;
    grid-row: 2;
    font-size: 0.875rem;
    color: var(--c-muted);
    font-variant-numeric: tabular-nums;
  }

  .c-day-sum b {
    color: var(--c-ink);
    font-weight: 600;
  }

  @media (min-width: 640px) {
    .c-day-sum {
      grid-column: auto;
      grid-row: auto;
    }
  }

  .c-chev {
    color: var(--c-muted);
    font-size: 1.25rem;
    line-height: 1;
    transition: transform 0.15s ease;
  }

  [aria-expanded='true'] > .c-chev {
    transform: rotate(90deg);
  }

  :global(html.eink) .c-chev {
    transition: none;
  }

  .c-sessions {
    padding: 0 1rem 0.5rem;
  }

  @media (min-width: 640px) {
    .c-sessions {
      padding: 0 1.25rem 0.5rem;
    }
  }

  .c-session {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 0.25rem 0.75rem;
    align-items: center;
    padding: 0.5rem 0;
    border-top: 1px dashed var(--c-line);
    font-size: 0.875rem;
  }

  .c-session:first-child {
    border-top: 0;
  }

  .c-when {
    grid-column: 1 / -1;
    font-size: 0.75rem;
    color: var(--c-muted);
    font-variant-numeric: tabular-nums;
  }

  @media (min-width: 640px) {
    .c-session {
      grid-template-columns: 7.5rem minmax(0, 1fr) auto auto;
    }

    .c-when {
      grid-column: auto;
      font-size: 0.8125rem;
    }
  }

  .c-figures {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .c-out .c-figures > span:first-child {
    color: var(--c-muted);
  }
</style>
