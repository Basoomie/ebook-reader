<script lang="ts">
  /**
   * The Settings page's tabs (Reader, Data, Statistics), under the page title in the
   * catalogue's "Archive" look (like the Library's tabs): the current tab underlined in
   * vermilion, a gold rule below. The app navigation and Back live elsewhere (AppHeader,
   * the page title row), so the header bar holds only the navigation.
   */
  export let activeSettings: string;

  const settingItems = ['Reader', 'Data', 'Statistics'];
</script>

<div
  class="c-strip -mx-1 flex max-w-full gap-1 border-b px-1"
  style="border-color: var(--c-gold)"
  role="tablist"
  aria-label="Settings"
>
  {#each settingItems as label (label)}
    <button
      type="button"
      class="c-focus flex min-h-[3rem] shrink-0 items-center border-b-2 px-3 text-sm {activeSettings ===
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
