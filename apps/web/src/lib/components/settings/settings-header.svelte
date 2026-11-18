<script lang="ts">
  /**
   * The Settings page's tabs (Reader, Data, Statistics, Audiobooks, Anki, Notifications, Diagnostics), under the page title in the
   * catalogue's "Archive" look (like the Library's tabs): the current tab underlined in
   * vermilion, a gold rule below. The app navigation and Back live elsewhere (AppHeader,
   * the page title row), so the header bar holds only the navigation.
   */
  import { SETTINGS_TABS, type SettingsTab } from '$lib/settings/settings-tab';
  import { tick } from 'svelte';

  export let activeSettings: SettingsTab;

  const settingItems = SETTINGS_TABS;

  let strip: HTMLDivElement | undefined;

  // On a phone the tabs don't all fit and the strip scrolls sideways: keep the current
  // tab in view (e.g. Diagnostics, the last one, opened from a link). Only the strip
  // scrolls, never the page.
  $: void revealTab(activeSettings);

  async function revealTab(_tab: SettingsTab) {
    await tick();
    const tab = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !tab) return;
    const s = strip.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    if (t.right > s.right) strip.scrollLeft += t.right - s.right + 16;
    else if (t.left < s.left) strip.scrollLeft -= s.left - t.left + 16;
  }
</script>

<div
  bind:this={strip}
  class="c-strip -mx-1 flex max-w-full gap-0 border-b px-1 sm:gap-1"
  style="border-color: var(--c-gold)"
  role="tablist"
  aria-label="Settings"
>
  {#each settingItems as label (label)}
    <button
      type="button"
      class="c-focus flex min-h-[3rem] shrink-0 items-center border-b-2 px-2 text-sm sm:px-3 {activeSettings ===
      label
        ? 'border-c-seal font-bold text-c-ink'
        : 'border-transparent text-c-muted hover:text-c-ink'}"
      role="tab"
      aria-selected={activeSettings === label}
      data-testid="settings-tab-{label.toLowerCase()}"
      on:click={() => (activeSettings = label)}
    >
      {label}
    </button>
  {/each}
</div>
