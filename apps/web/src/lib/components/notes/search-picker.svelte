<script context="module" lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  export interface PickerOption {
    id: string;
    label: string;
    /** A second, muted line (an author, a series). */
    sub?: string;
    count?: number;
  }
</script>

<script lang="ts">
  /**
   * Notes at scale (2026-11-21): a picker you can type into, for lists too long for a
   * plain dropdown (the Notes page's Book and Series filters). Closed it is a field with
   * the picked name; opened, a search box over a list of at most a few rows that scrolls
   * inside (ARIA combobox: ↑/↓ move, Enter picks, Esc closes). Matching folds like the
   * Settings lists (width, case, katakana as hiragana). Plain for E-ink: no animations,
   * 44 px rows.
   */
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import Fa from 'svelte-fa';
  import { faChevronDown, faXmark } from '@fortawesome/free-solid-svg-icons';
  import { matchesQuery, queryWords } from '$lib/settings/paged-list';

  export let label: string;
  export let options: PickerOption[];
  /** The picked option's id; null for "all". */
  export let value: string | null;
  /** The text of the "all" choice ("All books"). */
  export let allLabel: string;
  /** Shown for a value that isn't among the options (a link to a series not loaded yet). */
  export let valueLabel = '';
  export let placeholder = 'Type to search';
  export let testid = 'search-picker';

  /** Rows drawn at once; typing narrows the rest. */
  const MAX_ROWS = 100;
  const dispatch = createEventDispatcher<{ change: string | null }>();
  const uid = `picker-${Math.random().toString(36).slice(2, 9)}`;

  let open = false;
  let query = '';
  let active = 0;
  let root: HTMLDivElement;
  let input: HTMLInputElement;
  let listEl: HTMLUListElement;
  let field: HTMLButtonElement;

  $: picked = options.find((o) => o.id === value);
  $: pickedLabel = value ? (picked?.label ?? (valueLabel || value)) : allLabel;
  $: words = queryWords(query);
  $: matched = words.length
    ? options.filter((o) => matchesQuery(`${o.label}\n${o.sub ?? ''}`, words))
    : options;
  $: rows = [
    ...(words.length ? [] : [{ id: '', label: allLabel } as PickerOption]),
    ...matched.slice(0, MAX_ROWS)
  ];
  $: more = matched.length - Math.min(matched.length, MAX_ROWS);
  $: if (active >= rows.length) active = Math.max(0, rows.length - 1);

  async function show() {
    open = true;
    query = '';
    const at = rows.findIndex((r) => (r.id || null) === value);
    active = at >= 0 ? at : 0;
    await tick();
    input?.focus();
    scrollActive();
  }

  async function hide(focusField = true) {
    open = false;
    if (focusField) {
      await tick();
      field?.focus();
    }
  }

  function pick(option: PickerOption) {
    const next = option.id || null;
    void hide();
    if (next !== value) dispatch('change', next);
  }

  async function scrollActive() {
    await tick();
    listEl?.querySelector<HTMLElement>(`#${uid}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = Math.min(rows.length - 1, active + 1);
      void scrollActive();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(0, active - 1);
      void scrollActive();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (rows[active]) pick(rows[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void hide();
    } else if (event.key === 'Tab') {
      void hide(false);
    }
  }

  function onWindowPointer(event: PointerEvent) {
    if (open && root && !root.contains(event.target as Node)) void hide(false);
  }

  onDestroy(() => {
    open = false;
  });
</script>

<svelte:window on:pointerdown={onWindowPointer} />

<div class="relative flex min-w-0 flex-col gap-1 text-sm text-c-muted" bind:this={root}>
  <span id="{uid}-label">{label}</span>
  {#if !open}
    <div class="flex min-w-0 items-center gap-1">
      <button
        type="button"
        class="c-input c-picker-field flex min-w-0 flex-1 items-center gap-2 text-left"
        aria-haspopup="listbox"
        aria-labelledby="{uid}-label {uid}-value"
        data-testid={testid}
        bind:this={field}
        on:click={show}
      >
        <span id="{uid}-value" class="min-w-0 flex-1 truncate text-c-ink">{pickedLabel}</span>
        <span class="shrink-0 text-c-muted" aria-hidden="true"><Fa icon={faChevronDown} /></span>
      </button>
      {#if value}
        <button
          type="button"
          class="c-btn c-btn-ghost c-btn-icon c-btn-sm"
          title="Show {allLabel.toLowerCase()}"
          aria-label="Clear {label}"
          data-testid="{testid}-clear"
          on:click={() => dispatch('change', null)}
        >
          <Fa icon={faXmark} />
        </button>
      {/if}
    </div>
  {:else}
    <input
      class="c-input c-picker-field w-full"
      type="search"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      aria-expanded="true"
      aria-controls="{uid}-list"
      aria-autocomplete="list"
      aria-labelledby="{uid}-label"
      aria-activedescendant={rows.length ? `${uid}-${active}` : undefined}
      {placeholder}
      data-testid="{testid}-search"
      bind:this={input}
      bind:value={query}
      on:input={() => (active = 0)}
      on:keydown={onKeydown}
    />
    <ul
      id="{uid}-list"
      role="listbox"
      aria-labelledby="{uid}-label"
      class="c-picker-list absolute left-0 right-0 top-full z-30 mt-1 overflow-y-auto rounded"
      data-testid="{testid}-list"
      bind:this={listEl}
    >
      {#each rows as option, i (option.id)}
        <li
          id="{uid}-{i}"
          role="option"
          aria-selected={(option.id || null) === value}
          class="c-picker-option flex min-h-[2.75rem] cursor-pointer items-center gap-2 px-3 py-1"
          class:c-active={i === active}
          data-testid="{testid}-option"
          on:mousedown|preventDefault
          on:click={() => pick(option)}
          on:keydown={onKeydown}
          on:mousemove={() => (active = i)}
        >
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-c-ink" class:font-bold={!option.id}>{option.label}</span>
            {#if option.sub}
              <span class="truncate text-xs text-c-muted">{option.sub}</span>
            {/if}
          </span>
          {#if option.count !== undefined}
            <span class="shrink-0 text-xs tabular-nums text-c-muted">
              {option.count.toLocaleString('en-US')}
            </span>
          {/if}
        </li>
      {/each}
      {#if !rows.length}
        <li class="px-3 py-3 text-c-muted" role="presentation">
          Nothing matches “{query.trim()}”.
        </li>
      {/if}
      {#if more > 0}
        <li class="px-3 py-2 text-xs text-c-muted" role="presentation">
          {more.toLocaleString('en-US')} more: type to narrow the list.
        </li>
      {/if}
    </ul>
  {/if}
</div>

<style>
  .c-picker-field {
    min-height: 2.75rem;
  }

  .c-picker-list {
    max-height: min(22rem, 60vh);
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line-strong);
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.18);
  }

  :global(html.eink) .c-picker-list {
    box-shadow: none;
    border: 2px solid #000;
    background-color: #fff;
  }

  .c-picker-option + .c-picker-option {
    border-top: 1px solid var(--c-line);
  }

  .c-picker-option.c-active {
    background-color: var(--c-tint);
  }

  .c-picker-option[aria-selected='true'] {
    box-shadow: inset 3px 0 0 var(--c-link);
  }

  :global(html.eink) .c-picker-option.c-active {
    background-color: #000;
  }

  :global(html.eink) .c-picker-option.c-active span {
    color: #fff;
  }
</style>
