<script lang="ts">
  import { goto } from '$app/navigation';
  import { pagePath } from '$lib/data/env';
  import { database } from '$lib/data/store';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { appOpenPath } from '$lib/home/open-target';
  import { appOpenTarget$ } from '$lib/home/settings';
  import { firstValueFrom } from 'rxjs';
  import { onMount } from 'svelte';

  // Opening the app (WP7b): the last book (default) or Home, per device.
  onMount(async () => {
    let lastBookId: number | undefined;
    try {
      lastBookId = (await firstValueFrom(database.lastItem$))?.dataId;
    } catch {
      lastBookId = undefined;
    }
    goto(appOpenPath($appOpenTarget$, lastBookId, pagePath), { replaceState: true });
  });
</script>

<svelte:head>
  <title>{formatPageTitle('Home')}</title>
</svelte:head>
