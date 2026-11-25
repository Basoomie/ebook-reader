<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Suggestions while typing a library search (search palette step 1, 2026-11-24): field
   * names ("ta" → tag:), and a field's values (the library's tags, authors, series and
   * illustrators with book counts; statuses; example ranges). The page keeps the text
   * field: it passes the text and the caret (`query`, `cursor`), forwards the field's keys
   * (`onKeydown`, before the history list's) and applies a pick (`pick` event).
   * ↑/↓ move, Tab completes (the highlighted row, else the first), Enter completes only a
   * highlighted row (otherwise it searches), Esc closes the list.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import {
    applySuggestion,
    contextAt,
    fieldSuggestions,
    fixedValueSuggestions,
    nameSuggestions,
    MAX_SUGGESTIONS,
    NAME_FIELDS,
    type NameCount,
    type NameField,
    type SuggestContext,
    type Suggestion
  } from '$lib/library/query/suggest';
  import type { NameListQuery } from '$lib/library/api';

  export let query: string;
  /** The caret's place in `query`. */
  export let cursor: number;
  export let enabled: boolean;
  /** Names from the server or the offline catalog. */
  export let names: ((q: NameListQuery) => Promise<NameCount[]>) | undefined;
  export let library: string | undefined = undefined;
  export let container: HTMLElement | undefined;
  export let listId = 'library-search-suggestions';
  /** Out: whether the list is shown, and the highlighted row's id (for the field). */
  export let open = false;
  export let activeId: string | undefined = undefined;

  const dispatch = createEventDispatcher<{ pick: { text: string; cursor: number } }>();

  let dismissed = false;
  let active = -1;
  let shown: Suggestion[] = [];
  let context: SuggestContext = { kind: 'none' };
  let asked = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cache = new Map<string, NameCount[]>();

  $: context = enabled ? contextAt(query, cursor) : { kind: 'none' };
  $: contextKey = JSON.stringify(context);
  $: void refresh(contextKey, library);
  $: if (active >= shown.length) active = shown.length - 1;
  $: open = enabled && !dismissed && shown.length > 0;
  $: activeId = open && active >= 0 ? `${listId}-${active}` : undefined;
  $: hint =
    context.kind === 'value' && context.afterComma && context.field !== 'favorite'
      ? 'A comma means either: books with any of these'
      : context.kind === 'value' && !context.afterComma && context.partial === ''
        ? valueHint(context.field)
        : '';

  function valueHint(field: string): string {
    if (field === 'chars' || field === 'level') return 'Type a number, or pick an example';
    return '';
  }

  /** A new caret place or text: the list opens again (unless it's the same word). */
  let lastKey = '';
  function refresh(key: string, lib: string | undefined) {
    if (key !== lastKey) {
      dismissed = false;
      active = -1;
      lastKey = key;
    }
    clearTimeout(timer);
    const ctx = context;
    if (ctx.kind === 'none') {
      shown = [];
      return;
    }
    if (ctx.kind === 'field') {
      shown = fieldSuggestions(ctx.partial);
      return;
    }
    const fixed = fixedValueSuggestions(ctx);
    if (fixed !== null) {
      shown = fixed;
      return;
    }
    if (!(NAME_FIELDS as readonly string[]).includes(ctx.field) || !names) {
      shown = [];
      return;
    }
    const field = ctx.field as NameField;
    const cacheKey = JSON.stringify([field, ctx.partial.trim(), lib ?? '']);
    const hit = cache.get(cacheKey);
    if (hit) {
      shown = fromNames(hit, ctx.taken);
      return;
    }
    const ask = ++asked;
    const get = names;
    // A short pause while typing; only the newest answer is shown.
    timer = setTimeout(async () => {
      try {
        const list = await get({
          field,
          text: ctx.partial.trim(),
          library: lib,
          limit: MAX_SUGGESTIONS + ctx.taken.length
        });
        cache.set(cacheKey, list);
        if (ask === asked) shown = fromNames(list, ctx.taken);
      } catch {
        if (ask === asked) shown = [];
      }
    }, 120);
  }

  function fromNames(list: NameCount[], taken: string[]): Suggestion[] {
    const fold = (s: string) => s.normalize('NFKC').toLowerCase();
    return nameSuggestions(list.filter((n) => !taken.includes(fold(n.name)))).slice(
      0,
      MAX_SUGGESTIONS
    );
  }

  /** The library changed (an index or a sync): names are asked again. */
  export function forget() {
    cache.clear();
  }

  export function hide() {
    dismissed = true;
    active = -1;
  }

  function choose(s: Suggestion) {
    if (context.kind === 'none') return;
    const next = applySuggestion(query, context, s);
    dispatch('pick', next);
  }

  /** The field's keydown. Returns true when the list used the key. */
  export function onKeydown(event: KeyboardEvent): boolean {
    if (!open) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      hide();
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const n = shown.length;
      if (event.key === 'ArrowDown') active = active + 1 >= n ? -1 : active + 1;
      else active = active <= -1 ? n - 1 : active - 1;
      return true;
    }
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      choose(shown[Math.max(0, active)]);
      return true;
    }
    if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      choose(shown[active]);
      return true;
    }
    if (event.key === 'Enter') hide();
    return false;
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (!open) return;
    if (container && event.target instanceof Node && container.contains(event.target)) return;
    hide();
  }

  onDestroy(() => {
    clearTimeout(timer);
    open = false;
  });
</script>

<svelte:window on:pointerdown={onWindowPointerDown} />

{#if open}
  <div class="ss-panel c-panel" data-testid="search-suggestions">
    {#if hint}
      <p class="ss-head" data-testid="search-suggestions-hint">{hint}</p>
    {/if}
    <ul id={listId} role="listbox" aria-label="Suggestions">
      {#each shown as s, i (s.label + i)}
        <li
          id="{listId}-{i}"
          class="ss-row"
          class:ss-active={i === active}
          role="option"
          aria-selected={i === active}
        >
          <button
            type="button"
            class="ss-pick"
            tabindex="-1"
            data-testid="search-suggestion"
            on:pointerdown|preventDefault
            on:click={() => choose(s)}
            on:pointermove={() => (active = i)}
          >
            <span class="ss-label">{s.label}</span>
            {#if s.detail}
              <span class="ss-detail">{s.detail}</span>
            {/if}
            {#if s.count !== undefined}
              <span class="ss-count">{s.count.toLocaleString('en-US')}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
    {#if active < 0}
      <p class="ss-foot" aria-hidden="true">Tab completes · Enter searches</p>
    {/if}
  </div>
{/if}

<style>
  .ss-panel {
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

  .ss-head,
  .ss-foot {
    padding: 0.25rem 0.75rem 0.375rem;
    font-size: 0.75rem;
    color: var(--c-muted);
  }

  .ss-foot {
    padding: 0.375rem 0.75rem 0.125rem;
  }

  .ss-row {
    border-radius: 0.625rem;
  }

  .ss-row.ss-active,
  .ss-row:hover {
    background-color: var(--c-tint);
  }

  :global(html.eink) .ss-row.ss-active {
    outline: 2px solid #000;
    outline-offset: -2px;
  }

  :global(html.eink) .ss-row:hover:not(.ss-active) {
    background-color: transparent;
  }

  .ss-pick {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: baseline;
    gap: 0.75rem;
    min-height: var(--c-btn-h);
    padding: 0.375rem 0.75rem;
    text-align: left;
    color: var(--c-ink);
  }

  .ss-label {
    flex: none;
    max-width: 70%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--c-font-mono, ui-monospace, monospace);
    font-size: 0.875rem;
  }

  .ss-detail {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
    color: var(--c-muted);
  }

  .ss-count {
    margin-left: auto;
    flex: none;
    font-size: 0.75rem;
    color: var(--c-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
