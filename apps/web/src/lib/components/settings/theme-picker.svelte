<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Settings page's theme choice: one swatch per theme in its own colours with its
   * name under it, a ring and a tick on the picked one, a "New theme" swatch, and for a
   * picked theme of your own, Edit and Delete buttons (Delete still asks first, in the
   * page's dialog). Built-in themes can't be edited or deleted.
   */
  import { availableThemes } from '$lib/data/theme-option';
  import { createEventDispatcher } from 'svelte';

  export let options: { id: string; style?: Record<string, string> }[] = [];
  export let value: string;
  export let label = '';
  export let labelledby = '';
  /** Show the "New theme" swatch. */
  export let allowNew = false;
  /** Show Edit and Delete for a picked theme of your own. */
  export let allowEdit = true;
  export let testid = '';

  const dispatch = createEventDispatcher<{ new: void; edit: string; delete: string }>();

  const BUILT_IN_NAMES: Record<string, string> = {
    'light-theme': 'Light',
    'ecru-theme': 'Ecru',
    'water-theme': 'Water',
    'gray-theme': 'Gray',
    'dark-theme': 'Dark',
    'black-theme': 'Black'
  };

  function themeName(id: string): string {
    return BUILT_IN_NAMES[id] ?? id.replace(/-theme$/, '').replace(/^./, (c) => c.toUpperCase());
  }

  function swatchStyle(style: Record<string, string> | undefined): string {
    if (!style) return '';
    return Object.entries(style)
      .map(([key, v]) => `${key}: ${v}`)
      .join(';');
  }

  $: picked = options.find((o) => o.id === value);
  $: pickedIsOwn = !!picked && !availableThemes.has(picked.id);
</script>

<div data-testid={testid || undefined}>
  <div
    class="s-themes"
    role="radiogroup"
    aria-label={label || undefined}
    aria-labelledby={label ? undefined : labelledby || undefined}
  >
    {#each options as option (option.id)}
      <button
        type="button"
        role="radio"
        class="s-theme"
        aria-checked={option.id === value}
        title={themeName(option.id)}
        on:click={() => (value = option.id)}
      >
        <span class="s-sample" style={swatchStyle(option.style)}>
          ぁあ
          <span class="s-tick" aria-hidden="true">✓</span>
        </span>
        <span class="s-name">{themeName(option.id)}</span>
      </button>
    {/each}
    {#if allowNew}
      <button
        type="button"
        class="s-theme s-new"
        title="New theme"
        on:click={() => dispatch('new')}
      >
        <span class="s-sample" aria-hidden="true">+</span>
        <span class="s-name">New theme</span>
      </button>
    {/if}
  </div>
  {#if allowEdit && picked && pickedIsOwn}
    <div class="s-theme-actions">
      <span class="mr-auto min-w-0 break-words text-sm">
        <strong>{themeName(picked.id)}</strong> is your own theme.
      </span>
      <button
        type="button"
        class="c-btn c-btn-secondary c-btn-sm"
        data-testid="theme-edit"
        on:click={() => picked && dispatch('edit', picked.id)}
      >
        Edit
      </button>
      <button
        type="button"
        class="c-btn c-btn-secondary c-btn-sm"
        data-testid="theme-delete"
        on:click={() => picked && dispatch('delete', picked.id)}
      >
        Delete…
      </button>
    </div>
  {/if}
</div>

<style>
  .s-themes {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(5.25rem, 1fr));
    gap: 0.875rem 0.75rem;
  }

  .s-theme {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    text-align: center;
    color: var(--c-ink);
  }

  .s-sample {
    position: relative;
    display: grid;
    place-items: center;
    height: 3.5rem;
    border-radius: 0.5rem;
    border: var(--c-border-width) solid var(--c-line-strong);
    font-family: 'Shippori Mincho', 'Noto Serif JP', serif;
    font-size: 1.25rem;
  }

  .s-name {
    font-size: 0.8125rem;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  [aria-checked='true'] .s-sample {
    outline: 3px solid var(--c-link);
    outline-offset: 2px;
  }

  [aria-checked='true'] .s-name {
    font-weight: 700;
  }

  .s-tick {
    position: absolute;
    top: -0.5rem;
    right: -0.5rem;
    display: none;
    place-items: center;
    width: 1.375rem;
    height: 1.375rem;
    border-radius: 50%;
    background-color: var(--c-link);
    color: var(--c-raised);
    font-family: system-ui, sans-serif;
    font-size: 0.8rem;
  }

  [aria-checked='true'] .s-tick {
    display: grid;
  }

  :global(html.eink) .s-tick {
    background-color: #000;
    color: #fff;
  }

  .s-new .s-sample {
    border-style: dashed;
    color: var(--c-muted);
    font-family: system-ui, sans-serif;
    font-size: 1.5rem;
  }

  .s-theme:focus-visible {
    outline: none;
  }

  .s-theme:focus-visible .s-sample {
    outline: 3px solid var(--c-link);
    outline-offset: 2px;
  }

  @media (hover: hover) {
    .s-theme:not([aria-checked='true']):hover .s-sample {
      border-color: var(--c-sec-hover-border);
    }
  }

  .s-theme-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px dashed var(--c-line);
  }
</style>
