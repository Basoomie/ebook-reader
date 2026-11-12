<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The old sync's Book Manager was removed (WP15e). This address stays working (the
   * migration pages' header still links here): it opens the Library in its place.
   * "Remove from this device" is in a book's ⋮ menu and on its details page; the built-in
   * collection "On this device" lists what this device stores.
   */
  import { pagePath } from '$lib/data/env';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { onMount } from 'svelte';

  onMount(() => {
    // A full replace, not goto, so Back never comes back here.
    location.replace(`${pagePath}/library`);
  });
</script>

<svelte:head>
  <title>{formatPageTitle('Library')}</title>
</svelte:head>

<p class="p-8 text-sm" data-testid="manage-redirect">
  The Book Manager is gone. Books are in the <a class="underline" href="{pagePath}/library"
    >Library</a
  >.
</p>
