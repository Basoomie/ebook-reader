<script lang="ts">
  import { faFont } from '@fortawesome/free-solid-svg-icons';
  import Popover from '$lib/components/popover/popover.svelte';
  import { LocalFont } from '$lib/data/fonts';
  import { dummyFn } from '$lib/functions/utils';
  import Fa from 'svelte-fa';

  /** Bundled fonts, then custom ones (server-synced, WP13, and this browser's own). */
  export let availableFonts: string[] = [LocalFont.NOTOSANSJP];
  export let fontValue: string;

  let element: Popover;
</script>

<Popover bind:this={element} placement="bottom">
  <div
    slot="icon"
    class="flex h-12 w-12 items-center justify-center"
    title="Pick a font"
    aria-label="Pick a font"
  >
    <Fa icon={faFont} />
  </div>
  <!-- Many custom fonts: the list scrolls instead of running off the screen. -->
  <div slot="content" class="max-h-72 overflow-y-auto">
    {#each availableFonts as font (font)}
      <div
        tabindex="0"
        role="button"
        class="px-4 py-2 hover:bg-gray-900"
        on:click={() => {
          fontValue = font;
          element.toggleOpen();
        }}
        on:keyup={dummyFn}
      >
        {font}
      </div>
    {/each}
  </div>
</Popover>
