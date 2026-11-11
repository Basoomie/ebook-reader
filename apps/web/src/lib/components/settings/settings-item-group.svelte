<script lang="ts">
  import { faCircleQuestion } from '@fortawesome/free-regular-svg-icons';
  import Fa from 'svelte-fa';
  import Popover from '../popover/popover.svelte';

  /** One setting on the Settings page: its heading (mincho, "Archive" look), an optional
   * help popover and the control below. */
  export let title: string;
  export let tooltip = '';
  export let applyHeaderClasses = true;
</script>

<section class="pb-8 md:pb-3">
  <div class="flex flex-wrap items-center">
    <h2
      class="mb-2"
      class:font-mincho={applyHeaderClasses}
      class:text-lg={applyHeaderClasses}
      class:font-bold={applyHeaderClasses}
    >
      {#if tooltip}
        <Popover contentText={tooltip} contentStyles="padding: 0.5rem;">
          <Fa icon={faCircleQuestion} slot="icon" class="mx-2 text-c-muted" />
          <span class="capitalize">{title}</span>
        </Popover>
      {:else}
        <span class="capitalize">{title}</span>
      {/if}
    </h2>
    <slot name="header" />
  </div>
  <div>
    <slot />
  </div>
</section>
