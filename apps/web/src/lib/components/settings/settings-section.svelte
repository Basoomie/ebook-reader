<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import { faCircleQuestion } from '@fortawesome/free-regular-svg-icons';
  import Fa from 'svelte-fa';
  import Popover from '../popover/popover.svelte';

  /**
   * A full-width section heading inside the Settings grid ("Archive" look): a small
   * Japanese label, the title in mincho, an optional help popover and note, a gold rule
   * under it.
   */
  export let jp: string;
  export let title: string;
  export let tooltip = '';
  export let note = '';
  export let testid = '';
</script>

<div
  class="col-span-full mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b pb-2 sm:mb-0"
  style="border-color: var(--c-gold)"
  data-testid={testid || undefined}
>
  <span class="c-jp-label" aria-hidden="true">{jp}</span>
  <h2 class="flex items-center font-mincho text-xl font-bold">
    {#if tooltip}
      <Popover contentText={tooltip} contentStyles="padding: 0.5rem;">
        <Fa icon={faCircleQuestion} slot="icon" class="mx-2 text-base text-c-muted" />
        <span>{title}</span>
      </Popover>
    {:else}
      {title}
    {/if}
  </h2>
  {#if note}
    <span class="text-sm text-c-muted">{note}</span>
  {/if}
</div>
