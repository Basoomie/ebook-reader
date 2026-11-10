<script lang="ts">
  /**
   * Group cover (WP7a): one cover for a series, or a collage of up to four (2x2) for
   * authors, tags and "No series". Fewer books give fewer tiles: 1 fills the box, 2 sit
   * side by side, 3 are one tall tile and two small ones.
   */
  import CoverImage from './cover-image.svelte';

  export let tiles: { src: string; blurred: boolean }[];
  export let compact = false;

  $: shown = tiles.slice(0, 4);
  $: anyHidden = shown.some((t) => t.blurred);
</script>

<div class="relative h-full w-full">
  <div
    class="grid h-full w-full gap-px bg-gray-400/30"
    class:grid-cols-2={shown.length >= 2}
    class:grid-rows-2={shown.length >= 3}
    data-testid="collage"
    data-tiles={shown.length}
  >
    {#if shown.length === 0}
      <div class="bg-gray-400/20" />
    {:else if shown.length === 3}
      <div class="row-span-2">
        <CoverImage src={shown[0].src} blurred={shown[0].blurred} compact />
      </div>
      {#each shown.slice(1) as tile}
        <CoverImage src={tile.src} blurred={tile.blurred} compact />
      {/each}
    {:else}
      {#each shown as tile}
        <CoverImage src={tile.src} blurred={tile.blurred} compact={compact || shown.length > 1} />
      {/each}
    {/if}
  </div>
  {#if anyHidden && !compact && shown.length > 1}
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
      <span class="rounded border border-current bg-white px-1.5 text-xs text-black"
        >Hidden cover</span
      >
    </div>
  {/if}
</div>
