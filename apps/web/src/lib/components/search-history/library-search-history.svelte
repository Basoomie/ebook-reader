<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Search history (2026-11-24): the library search box's drop-down of remembered searches.
   * The page keeps the text field and gives it the combobox attributes from `open` and
   * `activeId`; it forwards the field's focus, input and keys here (`show`, `onKeydown`).
   * Opens on focus or a tap when there is something to show, narrows as you type, closes on
   * a pick, a search, Esc, Tab or a tap outside. Picking searches; ↖ only fills the box.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import HistoryRows from './history-rows.svelte';
  import { filterEntries, type HistoryEntry } from '$lib/search-history/search-history';
  import { searchHistoryApi } from '$lib/sync/sync-service';

  /** What the box holds now. */
  export let query: string;
  /** The search-history switch: off shows nothing. */
  export let enabled: boolean;
  /** The element around the box and the list: a tap outside it closes the list. */
  export let container: HTMLElement | undefined;
  export let listId = 'library-search-history';
  /** Out: whether the list is shown, and the highlighted row's id (for the field). */
  export let open = false;
  export let activeId: string | undefined = undefined;

  const dispatch = createEventDispatcher<{ pick: string; edit: string }>();
  const api = searchHistoryApi();
  const entriesStore = api.entries;

  let wanted = false;
  let active = -1;

  $: libraryEntries = $entriesStore.filter((e) => e.scope === 'lib');
  $: shown = enabled ? filterEntries(libraryEntries, query) : [];
  $: if (active >= shown.length) active = shown.length - 1;
  $: open = wanted && shown.length > 0;
  $: activeId = open && active >= 0 ? `${listId}-${active}` : undefined;

  /** Shows the list (on focus, a tap or typing); the highlight starts over. */
  export function show() {
    wanted = true;
    active = -1;
  }

  export function hide() {
    wanted = false;
    active = -1;
  }

  function pick(entry: HistoryEntry) {
    hide();
    dispatch('pick', entry.query);
  }

  function edit(entry: HistoryEntry) {
    dispatch('edit', entry.query);
    active = -1;
  }

  function remove(entry: HistoryEntry) {
    void api.remove(entry.id);
  }

  /** The field's keydown. Handles only what the list needs; everything else is the field's. */
  export function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (open) {
        // Closes the list first (and keeps the browser from clearing the box).
        event.preventDefault();
        hide();
      }
      return;
    }
    if (event.key === 'Tab') {
      hide();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open) {
        if (event.key === 'ArrowDown' && enabled) {
          event.preventDefault();
          wanted = true;
        }
        return;
      }
      event.preventDefault();
      const n = shown.length;
      if (event.key === 'ArrowDown') active = active + 1 >= n ? -1 : active + 1;
      else active = active <= -1 ? n - 1 : active - 1;
      return;
    }
    if (!open || active < 0) {
      if (event.key === 'Enter') hide();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      pick(shown[active]);
    } else if (event.key === 'Delete' && event.shiftKey) {
      event.preventDefault();
      remove(shown[active]);
    }
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (!open) return;
    if (container && event.target instanceof Node && container.contains(event.target)) return;
    hide();
  }

  onDestroy(() => {
    open = false;
  });
</script>

<svelte:window on:pointerdown={onWindowPointerDown} />

{#if open}
  <div class="lsh-panel c-panel" data-testid="library-search-history">
    <p class="lsh-head" aria-hidden="true">Recent searches</p>
    <ul id={listId} role="listbox" aria-label="Recent searches">
      <HistoryRows
        entries={shown}
        idPrefix={listId}
        {active}
        showEdit
        on:pick={(e) => pick(e.detail)}
        on:edit={(e) => edit(e.detail)}
        on:remove={(e) => remove(e.detail)}
        on:hover={(e) => (active = e.detail)}
      />
    </ul>
  </div>
{/if}

<style>
  .lsh-panel {
    position: absolute;
    z-index: 30;
    top: calc(100% + 0.375rem);
    left: 0;
    right: 0;
    max-height: min(22rem, 50vh);
    overflow-y: auto;
    padding: 0.375rem;
    border-radius: 0.625rem;
  }

  .lsh-head {
    padding: 0.25rem 0.75rem 0.375rem;
    font-size: 0.75rem;
    color: var(--c-muted);
  }
</style>
