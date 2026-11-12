<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Audiobooks page moved into Settings as its own tab (user, 2026-11-11). This old
   * address stays working: it opens Settings > Audiobooks in its place.
   */
  import { pagePath } from '$lib/data/env';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { settingsTabHref } from '$lib/settings/settings-tab';
  import { onMount } from 'svelte';

  onMount(() => {
    // A full replace, not goto: Settings' Back would otherwise lead back here, in a loop.
    location.replace(settingsTabHref(pagePath, 'Audiobooks'));
  });
</script>

<svelte:head>
  <title>{formatPageTitle('Audiobooks')}</title>
</svelte:head>

<p class="p-8 text-sm" data-testid="audiobooks-redirect">
  Audiobooks are in <a class="underline" href={settingsTabHref(pagePath, 'Audiobooks')}
    >Settings &gt; Audiobooks</a
  >.
</p>
