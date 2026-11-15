<script lang="ts">
  /**
   * Phase 10: add a font from Google Fonts. The library server reads Google's list of
   * Japanese fonts and downloads the chosen one (regular, and bold where it has one); then
   * it is a custom font like an uploaded one: every device downloads it from the server
   * and keeps it for reading offline. Samples are drawn from Google directly while the list
   * is open. Plain for e-ink: no transitions, 48 px controls.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { inputClasses } from '$lib/css-classes';
  import { googleCategory, weightsLabel } from '$lib/fonts/font-names';
  import { GooglePreviews, PREVIEW_TEXT } from '$lib/fonts/google-preview';
  import { fontApi } from '$lib/fonts/server-fonts-browser';
  import { LibraryApiError, type GoogleFontFamily } from '$lib/library/api';

  const dispatch = createEventDispatcher<{ added: string }>();

  /** null: not asked yet; 'loading'; an array once loaded. */
  let families: GoogleFontFamily[] | 'loading' | null = null;
  let query = '';
  let problem = '';
  let notice = '';
  /** The family the message is about (shown under its row), or null (under the list). */
  let messageFor: string | null = null;
  let adding: string | null = null;
  let abort: AbortController | null = null;
  let listAbort: AbortController | null = null;
  /** Sample family names by Google family, once loaded. */
  let samples: Record<string, string> = {};

  const previews = new GooglePreviews();

  onDestroy(() => {
    abort?.abort();
    listAbort?.abort();
    previews.close();
  });

  const message = (error: unknown) => (error as Error)?.message ?? String(error);

  async function show() {
    problem = '';
    notice = '';
    messageFor = null;
    families = 'loading';
    try {
      const api = await fontApi();
      if (!api) {
        families = null;
        problem = 'Connect to your library server (Settings > Library) to add fonts.';
        return;
      }
      listAbort = new AbortController();
      families = await api.googleFonts({ signal: listAbort.signal });
    } catch (error) {
      families = null;
      if (!(error instanceof LibraryApiError && error.kind === 'aborted')) {
        problem = `Could not get the Google Fonts list: ${message(error)}`;
      }
    } finally {
      listAbort = null;
    }
  }

  async function add(family: GoogleFontFamily) {
    problem = '';
    notice = '';
    messageFor = family.family;
    adding = family.family;
    try {
      const api = await fontApi();
      if (!api) {
        problem = 'Connect to your library server (Settings > Library) to add fonts.';
        return;
      }
      abort = new AbortController();
      const font = await api.addGoogleFont(family.family, { signal: abort.signal });
      setStatus(family.family, 'added');
      notice = `Added "${font.name}". Every device downloads it on its next sync. Choose it in the font lists.`;
      dispatch('added', font.name);
    } catch (error) {
      if (error instanceof LibraryApiError && error.kind === 'aborted') {
        notice = `Stopped waiting. The library server still adds "${family.family}"; it shows here after the next sync.`;
      } else {
        problem = `Could not add "${family.family}": ${message(error)}`;
      }
    } finally {
      adding = null;
      abort = null;
    }
  }

  function setStatus(name: string, status: GoogleFontFamily['status']) {
    if (Array.isArray(families)) {
      families = families.map((f) => (f.family === name ? { ...f, status } : f));
    }
  }

  /** Loads a row's sample once the row is on screen. */
  function sample(node: HTMLElement, family: string) {
    const load = () =>
      void previews.load(family).then((name) => {
        if (name) samples = { ...samples, [family]: name };
      });
    if (typeof IntersectionObserver !== 'function') {
      load();
      return {};
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        load();
      }
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  $: shown = Array.isArray(families)
    ? families.filter((f) => f.family.toLowerCase().includes(query.trim().toLowerCase()))
    : [];

  const statusText: Record<Exclude<GoogleFontFamily['status'], 'available'>, string> = {
    added: 'Added',
    built_in: 'Built in',
    name_taken: 'Name in use'
  };

  const button =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium disabled:opacity-50';
</script>

<div data-testid="google-fonts">
  <h3 class="mb-2 font-medium">Add from Google Fonts</h3>
  {#if families === null}
    <p class="mb-3 text-sm">
      Free Japanese fonts. The library server downloads the one you choose, then every device gets
      it like an added font.
    </p>
    <button class={button} on:click={show} data-testid="google-fonts-show">Show Google Fonts</button
    >
  {:else if families === 'loading'}
    <div class="flex items-center gap-3">
      <p>Getting the list from Google Fonts…</p>
      <button class={button} on:click={() => listAbort?.abort()}>Cancel</button>
    </div>
  {:else}
    <label class="mb-1 block" for="google-font-search">Search</label>
    <input
      id="google-font-search"
      type="search"
      class="{inputClasses} mb-3 w-full"
      bind:value={query}
      data-testid="google-fonts-search"
    />
    {#if shown.length}
      <ul class="mb-2" data-testid="google-font-list">
        {#each shown as family (family.family)}
          <li
            class="flex items-center gap-3 border-t border-gray-400 py-2"
            data-testid="google-font"
            data-family={family.family}
          >
            <div class="min-w-0 flex-1">
              <div class="break-words font-medium">{family.family}</div>
              <div
                class="break-words text-lg"
                use:sample={family.family}
                style:font-family={samples[family.family]
                  ? `'${samples[family.family]}', sans-serif`
                  : undefined}
                data-testid="google-font-sample"
                data-loaded={samples[family.family] ? 'true' : 'false'}
              >
                {PREVIEW_TEXT}
              </div>
              <div class="break-words text-sm">
                {googleCategory(family.category)} · {weightsLabel(family.weights)}
              </div>
            </div>
            {#if family.status === 'available'}
              {#if adding === family.family}
                <button class={button} on:click={() => abort?.abort()}>Cancel</button>
              {:else}
                <button
                  class={button}
                  on:click={() => add(family)}
                  disabled={adding !== null}
                  data-testid="google-font-add"
                >
                  Add
                </button>
              {/if}
            {:else}
              <span class="text-sm" data-testid="google-font-status"
                >{statusText[family.status]}</span
              >
            {/if}
          </li>
          {#if adding === family.family}
            <li class="pb-2 text-sm" role="status">Adding… (the library server downloads it)</li>
          {:else if messageFor === family.family && (problem || notice)}
            <li class="pb-2">
              {#if problem}
                <p class="text-red-700" role="alert" data-testid="google-font-problem">{problem}</p>
              {/if}
              {#if notice}
                <p role="status" data-testid="google-font-notice">{notice}</p>
              {/if}
            </li>
          {/if}
        {/each}
      </ul>
    {:else}
      <p class="mb-2">No Japanese Google font matches "{query.trim()}".</p>
    {/if}
  {/if}

  {#if messageFor === null || !shown.some((f) => f.family === messageFor)}
    {#if problem}
      <p class="mt-3 text-red-700" role="alert" data-testid="google-font-problem">{problem}</p>
    {/if}
    {#if notice}
      <p class="mt-3" role="status" data-testid="google-font-notice">{notice}</p>
    {/if}
  {/if}
</div>
