<script lang="ts">
  import { baseHeaderClasses, pxScreen } from '$lib/css-classes';
  import AppNavLinks from './app-nav-links.svelte';

  /**
   * A page's fixed gray header with the app navigation (wider screens). Pages put
   * <AppBottomBar /> at their end for phones (it also leaves room for itself there).
   */
  export let title: string;
</script>

<div class="elevation-4 fixed inset-x-0 top-0 z-10">
  <div class={baseHeaderClasses}>
    <div class="{pxScreen} flex h-full items-center justify-between gap-2">
      <h1 class="truncate text-lg font-medium">{title}</h1>
      <div class="flex h-full items-center">
        <slot />
        <AppNavLinks />
      </div>
    </div>
  </div>
</div>
