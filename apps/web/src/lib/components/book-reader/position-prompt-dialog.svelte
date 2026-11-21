<script lang="ts">
  /**
   * "Continue from...?" (WP9). A question (modal.svelte, role="alertdialog"): "Stay here"
   * beside "Continue there" (one place) or a "Continue there" on each place's row. Enter
   * continues (one place); Esc or a click outside stay here. No timer, no transitions on
   * e-ink.
   */
  import {
    chapterLabelAt,
    formatAge,
    formatPlace,
    formatWhen,
    type SectionLike
  } from '$lib/sync/position-prompt';
  import type { PositionPrompt, PromptRow } from '$lib/sync/position-prompt-service';
  import { createEventDispatcher } from 'svelte';
  import Modal from '$lib/components/modal/modal.svelte';

  export let prompt: PositionPrompt;
  export let livePos: number;
  export let total: number;
  export let sections: SectionLike[] = [];
  export let resolver: (row: PromptRow | null) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const now = Date.now();

  let done = false;

  function answer(row: PromptRow | null) {
    if (done) return;
    done = true;
    resolver(row);
    dispatch('close');
  }

  function deviceLabel(row: PromptRow) {
    if (row.isOwn) return 'This device (earlier)';
    return row.deviceName ?? 'Another device';
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Enter' && prompt.rows.length === 1) {
      ev.preventDefault();
      answer(prompt.rows[0]);
    }
  }

  $: single = prompt.rows.length === 1 ? prompt.rows[0] : undefined;
  $: header = !single
    ? 'Continue from another device?'
    : single.isOwn
      ? 'Continue from your earlier place?'
      : `Continue from ${single.deviceName ?? 'another device'}?`;
  $: syncNote = prompt.lastSyncAt
    ? `Last synced ${formatAge(now - prompt.lastSyncAt)}${prompt.lastError ? '; the last attempt failed' : ''}.`
    : 'Not synced with the server yet.';
</script>

<svelte:window on:keydown={onKeydown} />

<Modal
  title={header}
  size="md"
  role="alertdialog"
  testid="position-prompt"
  initialFocus="[data-prompt-continue]"
  on:close={() => answer(null)}
>
  <ul class="pt-2">
    {#each prompt.rows as row (row.recordId)}
      <li class="c-modal-row" data-testid="position-prompt-row">
        <div class="c-modal-row-main">
          <p class="c-modal-row-title">
            {deviceLabel(row)} · {formatWhen(row.localAt, now)} ({formatAge(now - row.localAt)})
          </p>
          <p class="c-modal-row-meta" data-testid="position-prompt-place">
            {row.approximate ? '≈ ' : ''}{formatPlace(
              row.target,
              total,
              chapterLabelAt(sections, row.target)
            )}
            {#if row.approximate}<span>(different copy of the book)</span>{/if}
          </p>
        </div>
        {#if !single}
          <div class="c-modal-row-actions">
            <button
              type="button"
              class="c-btn c-btn-secondary c-btn-sm"
              data-prompt-continue
              on:click={() => answer(row)}
            >
              Continue there
            </button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  <div class="mt-1 border-t border-c-line pt-3">
    <p>You are here: {formatPlace(livePos, total, chapterLabelAt(sections, livePos))}</p>
    <p class="pt-1 text-sm text-c-muted">{syncNote}</p>
  </div>
  <svelte:fragment slot="footer">
    <button type="button" class="c-btn c-btn-secondary" on:click={() => answer(null)}>
      Stay here
    </button>
    {#if single}
      <button
        type="button"
        class="c-btn c-btn-primary"
        data-prompt-continue
        on:click={() => single && answer(single)}
      >
        Continue there
      </button>
    {/if}
  </svelte:fragment>
</Modal>
