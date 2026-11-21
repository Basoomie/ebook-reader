<script lang="ts" context="module">
  let nextLabel = 0;

  export type SettingModeTag = 'pages' | 'scroll' | 'vertical' | 'horizontal';

  const TAG_TEXT: Record<SettingModeTag, string> = {
    pages: 'Pages mode only',
    scroll: 'Scrolling mode only',
    vertical: 'Vertical text only',
    horizontal: 'Horizontal text only'
  };
</script>

<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * One setting on the Settings page: its name and what it does (always written out, no
   * "?" popups), tags (All devices for a shared setting, from the sync registry; the
   * reading mode it applies in), and its control: beside the text on wider screens, under
   * it on phones. Switches and buttons stay beside the text everywhere (`inline`); wide
   * controls (theme swatches, lists) go under it everywhere (`stack`). A `child` row
   * belongs to the row above (shown while that one is on) and is indented under it.
   * Title and description come from the settings catalog by id unless given.
   */
  import { catalogSetting, settingDomId } from '$lib/settings/settings-catalog';
  import { settingScope } from '$lib/sync/settings-registry';

  export let id = '';
  export let title = '';
  /** Replaces the catalog's description (e.g. one that follows the value). */
  export let description = '';
  /** The localStorage key behind the row: a shared (global) key shows "All devices". */
  export let settingKey = '';
  /** Force the "All devices" tag (server-stored settings). */
  export let shared = false;
  export let tags: SettingModeTag[] = [];
  export let child = false;
  export let disabled = false;
  export let layout: 'auto' | 'inline' | 'stack' | 'info' = 'auto';
  export let testid = '';

  const labelId = `setting-label-${++nextLabel}`;

  $: entry = id ? catalogSetting(id) : undefined;
  $: shownTitle = title || entry?.title || '';
  $: shownDescription = description || entry?.description || '';
  $: allDevices = shared || (settingKey ? settingScope(settingKey) === 'global' : false);
</script>

<div
  class="s-row s-{layout}"
  class:s-child={child}
  class:s-disabled={disabled}
  id={id ? settingDomId(id) : undefined}
  data-testid={testid || undefined}
>
  <div class="s-text">
    <div class="s-title" id={labelId}>
      <span>{shownTitle}</span>
      {#if allDevices}
        <span class="s-tag s-tag-all">All devices</span>
      {/if}
      {#each tags as tag (tag)}
        <span class="s-tag">{TAG_TEXT[tag]}</span>
      {/each}
    </div>
    {#if shownDescription}
      <p class="s-desc">{shownDescription}</p>
    {/if}
    <slot name="description" />
  </div>
  {#if $$slots.default}
    <div class="s-control">
      <slot {labelId} />
    </div>
  {/if}
  {#if $$slots.below}
    <div class="s-below">
      <slot name="below" {labelId} />
    </div>
  {/if}
</div>

<style>
  .s-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.625rem 1.5rem;
    align-items: center;
    padding: 0.875rem 1rem;
    position: relative;
  }

  /* Rows in one wrapper are divided like rows of the card. */
  :global(.s-row + .s-row) {
    border-top: 1px solid var(--c-line);
  }

  .s-inline {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  @media (min-width: 640px) {
    .s-row {
      padding: 0.875rem 1.25rem;
    }

    .s-auto {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .s-auto .s-control {
      justify-self: end;
    }

    .s-info {
      grid-template-columns: minmax(8rem, 14rem) minmax(0, 1fr);
    }
  }

  .s-info .s-title {
    font-weight: 400;
    color: var(--c-muted);
  }

  .s-info .s-control {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .s-inline .s-control {
    justify-self: end;
  }

  .s-text {
    min-width: 0;
  }

  .s-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.5rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .s-desc {
    margin-top: 0.2rem;
    max-width: 62ch;
    font-size: 0.875rem;
    line-height: 1.45;
    color: var(--c-muted);
  }

  .s-below {
    grid-column: 1 / -1;
    min-width: 0;
  }

  .s-child {
    padding-left: 2.5rem;
  }

  .s-child::before {
    content: '';
    position: absolute;
    left: 1.25rem;
    top: 0;
    bottom: 0;
    width: 2px;
    background-color: var(--c-gold);
  }

  .s-disabled .s-text,
  .s-disabled .s-control {
    opacity: 0.55;
  }

  .s-tag {
    display: inline-flex;
    align-items: center;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    border: var(--c-border-width) solid var(--c-line-strong);
    color: var(--c-muted);
    font-size: 0.72rem;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
  }

  .s-tag-all {
    background-color: var(--c-count-bg);
    color: var(--c-count-ink);
    border-color: transparent;
  }

  :global(html.eink) .s-tag-all {
    border-color: #000;
  }

  /* Focused by "Search settings" (the flash shows where), not by Tab. */
  :global(.s-row:focus),
  :global(.s-group-head:focus) {
    outline: none;
  }

  /* "Search settings" points here for a moment. */
  :global(.s-flash) {
    animation: s-flash 2s ease-out;
  }

  @keyframes -global-s-flash {
    0%,
    40% {
      background-color: var(--c-tint);
      box-shadow: inset 0 0 0 2px var(--c-link);
    }

    100% {
      background-color: transparent;
      box-shadow: inset 0 0 0 2px transparent;
    }
  }

  :global(html.eink .s-flash) {
    animation: none;
    outline: 3px solid #000;
    outline-offset: -3px;
  }
</style>
