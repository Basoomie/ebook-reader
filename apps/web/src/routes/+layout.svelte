<script lang="ts">
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import DomainHint from '$lib/components/domain-hint.svelte';
  import { basePath, clearConsoleOnReload } from '$lib/data/env';
  import { dialogManager, type Dialog } from '$lib/data/dialog-manager';
  import {
    customThemes$,
    darkTheme$,
    einkMode$,
    followSystemTheme$,
    fontFamilyGroupOne$,
    fontFamilyGroupTwo$,
    fontSize$,
    isOnline$,
    lightTheme$,
    theme$
  } from '$lib/data/store';
  import { startAppearanceEffects } from '$lib/data/appearance-effects';
  import { dummyFn, isMobile, isMobile$ } from '$lib/functions/utils';
  import { MetaTags } from 'svelte-meta-tags';
  import { onMount } from 'svelte';
  import '../app.scss';

  let path = '';
  let dialogs: Dialog[] = [];
  let clickOnCloseDisabled = false;
  let zIndex = '';

  $: if (browser) {
    isMobile$.next(isMobile(window));
  }

  // WP10d: follow the system light/dark setting, theme fonts, E-ink mode. App-wide.
  onMount(() => {
    try {
      return startAppearanceEffects(
        {
          theme: theme$,
          customThemes: customThemes$,
          followSystemTheme: followSystemTheme$,
          lightTheme: lightTheme$,
          darkTheme: darkTheme$,
          einkMode: einkMode$,
          fontFamilyGroupOne: fontFamilyGroupOne$,
          fontFamilyGroupTwo: fontFamilyGroupTwo$,
          fontSize: fontSize$
        },
        window.matchMedia?.('(prefers-color-scheme: dark)'),
        document.documentElement,
        (message) => console.warn(message)
      );
    } catch (error) {
      console.warn('Appearance: not started', error);
      return undefined;
    }
  });

  // Server-synced custom fonts (WP13): registers the fonts saved on this device, then
  // downloads new ones. Loaded separately; a failure only leaves the bundled fonts.
  onMount(() => {
    import('$lib/fonts/server-fonts-browser')
      .then(({ startServerFonts }) => startServerFonts())
      .catch((error) => console.warn('Fonts: not started', error));
  });

  // Record sync (WP4) runs in the background. Loaded separately so that no
  // problem in it can affect the rest of the app.
  onMount(() => {
    import('$lib/sync/sync-service')
      .then(({ startSync }) => startSync())
      .catch((error) => console.warn('Sync: not started', error));
  });

  if (clearConsoleOnReload && import.meta.hot) {
    // eslint-disable-next-line no-console
    import.meta.hot.on('vite:beforeUpdate', () => console.clear());
  }

  function closeAllDialogs() {
    dialogManager.dialogs$.next([]);
    clickOnCloseDisabled = false;
    zIndex = '';
  }

  dialogManager.dialogs$.subscribe((d) => {
    clickOnCloseDisabled = d[0]?.disableCloseOnClick ?? false;
    zIndex = d[0]?.zIndex ?? '';
    dialogs = d;
  });

  page.subscribe((p) => (path = p.url.pathname));
</script>

<svelte:window bind:online={$isOnline$} />

<MetaTags
  title="ッツ Ebook Reader"
  description="Online e-book reader that supports dictionary extensions like Yomitan"
  canonical="{basePath}{path !== '/' ? path : ''}"
  openGraph={{
    type: 'website',
    images: [
      {
        url: `${basePath}/icons/regular-icon@512x512.png`,
        width: 512,
        height: 512
      }
    ]
  }}
/>

<slot />

{#if dialogs.length > 0}
  <div class="writing-horizontal-tb fixed inset-0 z-50 h-full w-full" style:z-index={zIndex}>
    <div
      tabindex="0"
      role="button"
      class="tap-highlight-transparent absolute inset-0 bg-black/[.32]"
      on:click={() => {
        if (!clickOnCloseDisabled) {
          closeAllDialogs();
        }
      }}
      on:keyup={dummyFn}
    />

    <div
      class="relative top-1/2 left-1/2 inline-block max-w-[80vw] -translate-x-1/2 -translate-y-1/2"
    >
      {#each dialogs as dialog}
        {#if typeof dialog.component === 'string'}
          {@html dialog.component}
        {:else}
          <svelte:component this={dialog.component} {...dialog.props} on:close={closeAllDialogs} />
        {/if}
      {/each}
    </div>
  </div>
{/if}

<span style={`font-family: ${$fontFamilyGroupOne$ || 'Noto Serif JP'}`} />

<DomainHint />
