<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * "Search settings": finds a setting or section in any tab (the settings catalog) and
   * hands the pick to the page, which opens the tab and points at it. Arrow keys move
   * through the results, Enter picks, Escape closes; "/" anywhere on the page focuses it.
   */
  import { searchSettings, type SettingsSearchResult } from '$lib/settings/settings-search';
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher<{ go: SettingsSearchResult }>();

  let input: HTMLInputElement;
  let query = '';
  let open = false;
  let active = 0;

  $: results = searchSettings(query, 10);
  $: if (query) active = Math.min(active, Math.max(0, results.length - 1));
  $: showPanel = open && !!query.trim();

  function go(result: SettingsSearchResult) {
    open = false;
    query = '';
    input?.blur();
    dispatch('go', result);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (showPanel) open = false;
      else query = '';
      return;
    }
    if (!showPanel || !results.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + results.length) % results.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(results[active]);
    }
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    input?.focus();
  }

  /** The title with the query's words marked. */
  function parts(title: string, q: string): { text: string; hit: boolean }[] {
    const words = q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (!words.length) return [{ text: title, hit: false }];
    const lower = title.toLowerCase();
    const out: { text: string; hit: boolean }[] = [];
    let i = 0;
    let plain = '';
    while (i < title.length) {
      const word = words.find((w) => lower.startsWith(w, i));
      if (word) {
        if (plain) out.push({ text: plain, hit: false });
        plain = '';
        out.push({ text: title.slice(i, i + word.length), hit: true });
        i += word.length;
      } else {
        plain += title[i];
        i += 1;
      }
    }
    if (plain) out.push({ text: plain, hit: false });
    return out;
  }
</script>

<svelte:window on:keydown={onWindowKeydown} />

<div class="s-search" data-testid="settings-search">
  <label class="s-search-box">
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"
      ><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" stroke-linecap="round" /></svg
    >
    <input
      bind:this={input}
      bind:value={query}
      type="search"
      placeholder="Search settings"
      aria-label="Search settings"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={showPanel}
      aria-controls="settings-search-results"
      aria-activedescendant={showPanel && results.length
        ? `settings-search-result-${active}`
        : undefined}
      autocomplete="off"
      spellcheck="false"
      data-testid="settings-search-input"
      on:focus={() => (open = true)}
      on:input={() => {
        open = true;
        active = 0;
      }}
      on:blur={() => setTimeout(() => (open = false), 150)}
      on:keydown={onKeydown}
    />
    <kbd class="s-kbd" aria-hidden="true">/</kbd>
  </label>
  {#if showPanel}
    <div class="s-results c-panel" id="settings-search-results" role="listbox">
      {#if results.length}
        {#each results as result, i (result.kind + result.id)}
          <button
            type="button"
            id="settings-search-result-{i}"
            class="s-result"
            role="option"
            aria-selected={i === active}
            data-testid="settings-search-result"
            on:mousedown|preventDefault
            on:click={() => go(result)}
          >
            <span class="block font-semibold">
              {#each parts(result.title, query) as part}{#if part.hit}<mark>{part.text}</mark
                  >{:else}{part.text}{/if}{/each}
            </span>
            <span class="block text-xs text-c-muted">
              {result.kind === 'section' ? `${result.path} · section` : result.path}
            </span>
          </button>
        {/each}
      {:else}
        <p class="px-3 py-2 text-sm text-c-muted">
          No setting matches “{query.trim()}”. Try another word, such as “font”, “swipe” or “sync”.
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .s-search {
    position: relative;
    flex: 1 1 100%;
  }

  @media (min-width: 768px) {
    .s-search {
      flex: 0 1 22rem;
    }
  }

  .s-search-box {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 3rem;
    padding: 0 0.75rem;
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line-strong);
    border-radius: 0.375rem;
    color: var(--c-ink);
  }

  .s-search-box:focus-within {
    outline: 2px solid var(--c-link);
  }

  .s-search-box svg {
    flex: none;
    width: 1.125rem;
    height: 1.125rem;
    color: var(--c-muted);
  }

  .s-search-box input {
    flex: 1;
    min-width: 0;
    min-height: 2.875rem;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    outline: none;
    box-shadow: none;
  }

  .s-search-box input::placeholder {
    color: var(--c-muted);
  }

  .s-kbd {
    display: none;
    padding: 0 0.375rem;
    border: 1px solid var(--c-line-strong);
    border-radius: 0.25rem;
    color: var(--c-muted);
    font-size: 0.75rem;
    font-family: inherit;
  }

  @media (hover: hover) and (pointer: fine) {
    .s-kbd {
      display: inline-block;
    }
  }

  .s-results {
    position: absolute;
    z-index: 30;
    top: calc(100% + 0.375rem);
    left: 0;
    right: 0;
    max-height: min(26rem, 60vh);
    overflow-y: auto;
    padding: 0.375rem;
    border-radius: 0.5rem;
  }

  .s-result {
    display: block;
    width: 100%;
    min-height: 2.75rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    text-align: left;
  }

  .s-result[aria-selected='true'],
  .s-result:hover {
    background-color: var(--c-tint);
  }

  :global(html.eink) .s-result[aria-selected='true'] {
    outline: 2px solid #000;
    outline-offset: -2px;
  }

  mark {
    background-color: transparent;
    color: inherit;
    text-decoration: underline;
    text-decoration-color: var(--c-gold);
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
  }
</style>
