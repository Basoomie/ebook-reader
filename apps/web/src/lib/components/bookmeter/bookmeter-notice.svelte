<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * One line on Home while Bookmeter sync has changes waiting for Review (the first sync of an
   * account, or more changes than Settings › Library › 読書メーター allows at once).
   */
  import { onMount } from 'svelte';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { bookmeterApi } from '$lib/sync/sync-service';
  import BookmeterReviewDialog from './bookmeter-review-dialog.svelte';

  const api = bookmeterApi();
  const view = api.view;

  onMount(() => void api.reload());

  $: pending = $view.pending;

  async function review() {
    await dialogManager.open(BookmeterReviewDialog, { changes: pending });
  }
</script>

{#if pending.length}
  <p class="c-notice flex flex-wrap items-center gap-3" data-testid="bookmeter-notice">
    <span class="grow">
      読書メーター has {pending.length.toLocaleString()}
      {pending.length === 1 ? 'change' : 'changes'} for your library.
    </span>
    <button type="button" class="c-btn c-btn-secondary c-btn-sm" on:click={review}>Review…</button>
  </p>
{/if}
