<script lang="ts">
  /**
   * One cover thumbnail in a fixed 2:3 box (WP7a). Blurred covers show a "Hidden cover"
   * label until revealed; the box never changes size while loading, and nothing
   * animates (e-ink).
   */
  export let src: string;
  export let blurred = false;
  /** Small boxes (collage tiles, list rows) drop the label text. */
  export let compact = false;

  let failed = false;
  $: if (src) failed = false;
</script>

<div class="relative h-full w-full overflow-hidden bg-gray-400/20" data-blurred={blurred}>
  {#if src && !failed}
    <img
      class="h-full w-full object-cover"
      class:cover-hidden={blurred}
      {src}
      alt=""
      draggable="false"
      loading="lazy"
      decoding="async"
      on:error={() => (failed = true)}
    />
  {/if}
  {#if blurred}
    <div class="absolute inset-0 flex items-center justify-center" data-testid="hidden-cover">
      {#if !compact}
        <span class="c-badge px-2"> Hidden cover </span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .cover-hidden {
    filter: blur(14px);
    transform: scale(1.15);
  }
</style>
