<script lang="ts">
  import Fa from 'svelte-fa';
  import { createEventDispatcher } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { mergeEntries } from '$lib/components/merged-header-icon/merged-entries';
  import Popover from '$lib/components/popover/popover.svelte';
  import { baseIconClasses } from '$lib/css-classes';
  import { pagePath } from '$lib/data/env';
  import { dummyFn } from '$lib/functions/utils';
  import type { Placement } from '@popperjs/core';

  export let leavePageLink = '';
  export let items = [mergeEntries.MANAGE, mergeEntries.SETTINGS, mergeEntries.BUG_REPORT];
  export let mergeTo = mergeEntries.MANAGE;
  export let disableRouteNavigation = false;
  /**
   * Where the collapsed menu opens. (The reader's top bar has its own menu since reader
   * toolbars session 1: lib/components/book-reader/book-reader-header.svelte.)
   */
  export let placement: Placement = 'bottom';
  export let fallbackPlacements: Placement[] = ['bottom-end', 'bottom-start'];

  const dispatch = createEventDispatcher<{ action: string }>();

  const actionItems = items.filter((item) => item.routeId !== $page.route.id);

  let menuElm: Popover;

  function handleActionMenuItem(target: string) {
    dispatch('action', target);

    if (
      !(target === mergeEntries.FILE_IMPORT.label || target === mergeEntries.FOLDER_IMPORT.label)
    ) {
      menuElm.toggleOpen();
    }

    if (!disableRouteNavigation) {
      const action = actionItems.find((item) => item.label === target);

      if (action?.routeId) {
        goto(`${pagePath}${action.routeId}`);
      }
    }
  }

  if (actionItems.length === 1 && actionItems[0].routeId) {
    leavePageLink = actionItems[0].routeId;
  }
</script>

{#if leavePageLink}
  <a href={leavePageLink}>
    <div class={baseIconClasses}>
      <Fa icon={mergeTo.icon} />
    </div>
  </a>
{:else}
  <div class="hidden sm:flex">
    {#each actionItems as actionItem (actionItem.label)}
      <div
        tabindex="0"
        role="button"
        title={actionItem.title}
        class={baseIconClasses}
        on:click={() => handleActionMenuItem(actionItem.label)}
        on:keyup={dummyFn}
      >
        <Fa icon={actionItem.icon} />
      </div>
    {/each}
  </div>
  <div class="flex sm:hidden">
    <Popover {placement} {fallbackPlacements} yOffset={0} bind:this={menuElm}>
      <div slot="icon" class={baseIconClasses}>
        <Fa icon={mergeTo.icon} />
      </div>
      <div
        class="w-40 overflow-y-auto bg-gray-700 md:w-32"
        style="max-height: calc(100vh - 4rem); max-height: calc(100dvh - 4rem)"
        slot="content"
      >
        {#each actionItems as actionItem (actionItem.label)}
          <div
            tabindex="0"
            role="button"
            class="px-4 py-2 text-sm hover:bg-white hover:text-gray-700"
            title={actionItem.title}
            on:click={() => handleActionMenuItem(actionItem.label)}
            on:keyup={dummyFn}
          >
            {actionItem.label}
          </div>
        {/each}
      </div>
    </Popover>
  </div>
{/if}
