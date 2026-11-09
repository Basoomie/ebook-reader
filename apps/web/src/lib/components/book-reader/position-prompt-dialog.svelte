<script lang="ts">
  /**
   * "Continue from...?" (WP9). Plain on purpose for e-ink: no transitions, no
   * ripple, no timer, full-size bordered buttons. Closes only through its
   * buttons, Enter (one row) or Esc; the backdrop is inert. Same frame as
   * dialog-template.svelte, written out (that file has no types).
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

  export let prompt: PositionPrompt;
  export let livePos: number;
  export let total: number;
  export let sections: SectionLike[] = [];
  export let resolver: (row: PromptRow | null) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const now = Date.now();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-5 font-medium';

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
    if (ev.key === 'Escape') {
      ev.preventDefault();
      answer(null);
    } else if (ev.key === 'Enter' && prompt.rows.length === 1) {
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

<section class="mdc-elevation--z24 rounded bg-white p-6" data-testid="position-prompt">
  <h2 class="weight-medium mb-5 text-xl">{header}</h2>
  <div class="max-w-xl">
    <ul>
      {#each prompt.rows as row (row.recordId)}
        <li class="border-t border-gray-400 py-3" data-testid="position-prompt-row">
          <p class="font-medium">
            {deviceLabel(row)} · {formatWhen(row.localAt, now)} ({formatAge(now - row.localAt)})
          </p>
          <p class="mb-2" data-testid="position-prompt-place">
            {row.approximate ? '≈ ' : ''}{formatPlace(
              row.target,
              total,
              chapterLabelAt(sections, row.target)
            )}
            {#if row.approximate}<span>(different copy of the book)</span>{/if}
          </p>
          <button class={buttonClass} on:click={() => answer(row)}>Continue there</button>
        </li>
      {/each}
    </ul>
    <p class="border-t border-gray-400 pt-3">
      You are here: {formatPlace(livePos, total, chapterLabelAt(sections, livePos))}
    </p>
    <p class="pt-2 text-sm">{syncNote}</p>
  </div>
  <footer class="flex flex-wrap items-center justify-end pt-5">
    <button class={buttonClass} on:click={() => answer(null)}>Stay here</button>
  </footer>
</section>
