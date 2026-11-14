<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /** One proposed (or written) change of one field of one book, stage 2 (WP20b). */
  import type { Proposal } from '$lib/cleanup/cleanup-api';
  import {
    fieldEvidence,
    fieldLabel,
    fieldStateText,
    sourceText,
    valueText
  } from '$lib/cleanup/stage2-text';

  export let item: Proposal;
  /** A batch item's own state (else the proposal's). */
  export let state: string | null = null;
  /** A batch item's note (why it was skipped or failed). */
  export let detail: string | null = null;

  $: ev = fieldEvidence(item);
  $: note = detail ?? item.review_reason ?? ev?.reason ?? null;
  $: shown = state ?? item.state ?? 'proposed';
  $: done = ['applied', 'undone', 'written', 'restored'].includes(shown);
  $: oldLabel = done ? 'Before' : 'Now';
  // A review item only proposes; an auto change still to write becomes the new value.
  $: newLabel = done
    ? 'Written'
    : (shown === 'proposed' || shown === 'queued') && item.class !== 'review'
      ? 'Becomes'
      : 'Proposed';
</script>

<li class="c-tile flex flex-col gap-1 rounded p-3 text-sm" data-testid="cleanup-field-change">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <span class="font-bold break-all">{ev?.title || `Calibre #${item.calibre_id}`}</span>
    <span class="c-count">{fieldStateText(state ?? item.state, item.class)}</span>
  </div>
  <div class="text-c-muted">
    Calibre #{item.calibre_id} · {fieldLabel(item.field)} · {sourceText(item.source)}
  </div>
  <div class="grid gap-1 sm:grid-cols-[auto_1fr] sm:gap-x-3">
    <span class="text-c-muted">{oldLabel}</span>
    <span class="break-all" data-testid="cleanup-field-old">{valueText(item.field, item.old)}</span>
    <span class="text-c-muted">{newLabel}</span>
    <span class="break-all font-medium" data-testid="cleanup-field-new"
      >{valueText(item.field, item.new)}</span
    >
  </div>
  {#if note}<div class="text-c-muted">{note}</div>{/if}
</li>
