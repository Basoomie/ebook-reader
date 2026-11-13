<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /** One removed (or to-be-removed) copy beside the copy that stays (WP20a). */
  import type { Proposal } from '$lib/cleanup/cleanup-api';
  import {
    handoffText,
    itemStateText,
    restoreText,
    ruleText,
    tagsMoving,
    tagsText
  } from '$lib/cleanup/cleanup-text';
  import { formatWhen } from '$lib/notes/notes-format';

  export let item: Proposal;
  /** A batch item's own state (else the proposal's). */
  export let state: string | null = null;

  $: ev = item.evidence;
</script>

<li class="c-tile flex flex-col gap-2 rounded p-3 text-sm" data-testid="cleanup-copy">
  {#if ev}
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <span class="font-bold">{ev.removed.title}</span>
      <span class="c-count">{itemStateText(state ?? item.state)}</span>
    </div>
    <div class="grid gap-2 sm:grid-cols-2">
      <div>
        <div class="font-medium">Removed copy · Calibre #{ev.removed.calibreId}</div>
        <div class="text-c-muted">
          Tags: {tagsText(ev.removed.tags)} · {ev.removed.formats.join(', ')}
          {#if ev.removed.addedAt}· added {formatWhen(ev.removed.addedAt)}{/if}
        </div>
      </div>
      <div>
        <div class="font-medium">Stays · Calibre #{ev.kept.calibreId}</div>
        <div class="text-c-muted">
          Tags: {tagsText(ev.kept.tags)} · {ev.kept.formats.join(', ')}
          {#if ev.kept.addedAt}· added {formatWhen(ev.kept.addedAt)}{/if}
        </div>
      </div>
    </div>
    <div class="text-c-muted">
      Identical files ({ruleText(item)}{ev.setSize > 2 ? `; ${ev.setSize} copies in all` : ''}).
      {#if ev.removed.extraFormats?.length}
        Also has {ev.removed.extraFormats.join(', ')}, kept in the quarantine.
      {/if}
      {#if tagsMoving(item).length}
        Your tags {tagsMoving(item).join(', ')}
        {item.state === 'undone'
          ? 'were taken off the copy that stays again'
          : 'go to the copy that stays'}.
      {/if}
      {#if handoffText(item)}{handoffText(item)}{/if}
      {#if restoreText(item.restore_method)}{restoreText(item.restore_method)}{/if}
      {#if item.detail}<span class="font-bold">{item.detail}</span>
      {:else if item.state === 'skipped' && item.review_reason}
        <span class="font-bold" data-testid="cleanup-skip-reason"
          >Skipped: {item.review_reason}.</span
        >
      {/if}
    </div>
  {:else}
    <span>Calibre #{item.calibre_id}</span>
  {/if}
</li>
