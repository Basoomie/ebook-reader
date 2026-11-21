<script lang="ts">
  import { browser, version } from '$app/environment';
  import { base } from '$app/paths';
  import { page } from '$app/stores';
  import type { AppUpdate } from '$lib/app-update/app-update';
  import AppUpdateNotice from '$lib/components/app-update-notice.svelte';
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
  import { libraryLook$ } from '$lib/library/settings';
  import { isMobile, isMobile$ } from '$lib/functions/utils';
  import { MetaTags } from 'svelte-meta-tags';
  import { onMount } from 'svelte';
  import '../app.scss';

  let path = '';
  let dialogs: Dialog[] = [];
  let appUpdate: AppUpdate | undefined;

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
          fontSize: fontSize$,
          libraryLook: libraryLook$
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

  // Enrich while offline (Season 2 §3): sentence audio that waited is added to its card
  // once the library server answers again. Loaded separately; nothing is shown here.
  onMount(() => {
    import('$lib/anki/pending/pending-service')
      .then(({ startPendingClips }) => startPendingClips())
      .catch((error) => console.warn('Anki: waiting sentence audio not started', error));
  });

  // Offline app loading and the "New version available" notice (Season 2 §2): the
  // service worker is registered here (HTTPS only). Loaded separately; a failure
  // only means no notice.
  onMount(() => {
    let stopped = false;
    import('$lib/app-update/app-update')
      .then(({ startAppUpdate }) => {
        if (stopped) return;
        appUpdate = startAppUpdate(version, base);
      })
      .catch((error) => console.warn('App update: not started', error));
    return () => {
      stopped = true;
      appUpdate?.stop();
    };
  });

  if (clearConsoleOnReload && import.meta.hot) {
    // eslint-disable-next-line no-console
    import.meta.hot.on('vite:beforeUpdate', () => console.clear());
  }

  function closeAllDialogs() {
    dialogManager.close();
  }

  dialogManager.dialogs$.subscribe((d) => {
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

<!-- Dialogs draw their own frame (lib/components/modal/modal.svelte: backdrop, Esc, ✕, a
     click outside). A string is only a backdrop that blocks the page while the reader runs an
     action or a side menu is open; it never closes on a click. -->
{#each dialogs as dialog}
  {#if typeof dialog.component === 'string'}
    <div class="writing-horizontal-tb fixed inset-0 z-50 h-full w-full">
      <div class="tap-highlight-transparent absolute inset-0 bg-black/[.32]" />
      {@html dialog.component}
    </div>
  {:else}
    <svelte:component this={dialog.component} {...dialog.props} on:close={closeAllDialogs} />
  {/if}
{/each}

<span style={`font-family: ${$fontFamilyGroupOne$ || 'Noto Serif JP'}`} />

<DomainHint />

{#if appUpdate}
  <AppUpdateNotice {appUpdate} />
{/if}
