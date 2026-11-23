<script lang="ts">
  /**
   * The Settings page's navigation (Reader, Data, Statistics, Audiobooks, Anki,
   * Notifications, Diagnostics) and the open tab's sections:
   * - from 1024 px: a sidebar that stays in view, the tabs in a column and the open tab's
   *   sections under it as jump links, the one you are reading marked;
   * - narrower: the underlined tab strip (it scrolls sideways and keeps the open tab in
   *   view) with a row of section links under it, both staying at the top while you scroll.
   * The tabs stay buttons with their names (role="tab", data-testid="settings-tab-…").
   */
  import { SETTINGS_TABS, type SettingsTab } from '$lib/settings/settings-tab';
  import { sectionDomId } from '$lib/settings/settings-catalog';
  import { tick } from 'svelte';

  export let activeSettings: SettingsTab;
  /** The open tab's sections, in page order. */
  export let sections: { id: string; title: string }[] = [];
  /** The section being read. */
  export let current = '';

  const GLYPHS: Record<SettingsTab, string> = {
    Reader: '読',
    Library: '書',
    Data: '蔵',
    Statistics: '計',
    Audiobooks: '音',
    Anki: '暗',
    AI: '智',
    Notifications: '通',
    Diagnostics: '診'
  };

  let strip: HTMLDivElement | undefined;
  let chips: HTMLDivElement | undefined;

  // On a phone the tabs don't all fit and the strip scrolls sideways: keep the current
  // tab in view (e.g. Diagnostics, the last one, opened from a link). Only the strip
  // scrolls, never the page.
  $: void reveal(strip, '[aria-selected="true"]', activeSettings);
  $: void reveal(chips, '[aria-current="true"]', current);

  async function reveal(row: HTMLElement | undefined, selector: string, _key: string) {
    await tick();
    const item = row?.querySelector<HTMLElement>(selector);
    if (!row || !item || row.scrollWidth <= row.clientWidth) return;
    const s = row.getBoundingClientRect();
    const t = item.getBoundingClientRect();
    if (t.right > s.right) row.scrollLeft += t.right - s.right + 16;
    else if (t.left < s.left) row.scrollLeft -= s.left - t.left + 16;
  }

  function jump(id: string) {
    const target = document.getElementById(sectionDomId(id));
    if (!target) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    current = id;
  }
</script>

<nav class="s-nav" aria-label="Settings sections">
  <div
    bind:this={strip}
    class="s-tabs"
    role="tablist"
    aria-label="Settings"
    data-testid="settings-tabs"
  >
    {#each SETTINGS_TABS as label (label)}
      <div class="s-tab-item" role="presentation">
        <button
          type="button"
          class="s-tab"
          role="tab"
          aria-selected={activeSettings === label}
          data-testid="settings-tab-{label.toLowerCase()}"
          on:click={() => (activeSettings = label)}
        >
          <span class="s-glyph" aria-hidden="true">{GLYPHS[label]}</span>
          <span>{label}</span>
        </button>
        {#if activeSettings === label && sections.length}
          <div class="s-side-sections" role="presentation">
            {#each sections as section (section.id)}
              <a
                href="#{sectionDomId(section.id)}"
                class="s-side-link"
                aria-current={current === section.id ? 'true' : undefined}
                on:click|preventDefault={() => jump(section.id)}
              >
                {section.title}
              </a>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
  {#if sections.length > 1}
    <div bind:this={chips} class="s-chips" aria-label="Sections">
      {#each sections as section (section.id)}
        <a
          href="#{sectionDomId(section.id)}"
          class="s-chip-link"
          aria-current={current === section.id ? 'true' : undefined}
          on:click|preventDefault={() => jump(section.id)}
        >
          {section.title}
        </a>
      {/each}
    </div>
  {/if}
</nav>

<style>
  /* Narrow (phones, tablets): the strip and the section links stay under the header. */
  .s-nav {
    position: sticky;
    top: 3rem;
    z-index: 15;
    margin: 0 -1rem;
    padding: 0 1rem;
    background-color: var(--c-bg);
  }

  @media (min-width: 768px) {
    .s-nav {
      margin: 0 -2rem;
      padding: 0 2rem;
    }
  }

  .s-tabs {
    display: flex;
    gap: 0.125rem;
    overflow-x: auto;
    scrollbar-width: none;
    border-bottom: 1px solid var(--c-gold);
  }

  .s-tabs::-webkit-scrollbar,
  .s-chips::-webkit-scrollbar {
    display: none;
  }

  .s-tab-item {
    flex: none;
  }

  .s-tab {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-height: 3rem;
    padding: 0 0.5rem;
    border-bottom: 2px solid transparent;
    color: var(--c-muted);
    font-size: 0.875rem;
    white-space: nowrap;
  }

  @media (min-width: 640px) {
    .s-tab {
      padding: 0 0.75rem;
    }
  }

  .s-tab:hover {
    color: var(--c-ink);
  }

  .s-tab[aria-selected='true'] {
    border-bottom-color: var(--c-seal);
    color: var(--c-ink);
    font-weight: 700;
  }

  .s-tab:focus-visible,
  .s-side-link:focus-visible,
  .s-chip-link:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -2px;
  }

  .s-glyph {
    display: none;
  }

  .s-side-sections {
    display: none;
  }

  .s-chips {
    display: flex;
    gap: 0.375rem;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 0.375rem 0;
    border-bottom: 1px solid var(--c-line);
  }

  .s-chip-link {
    flex: none;
    display: inline-flex;
    align-items: center;
    min-height: 2.75rem;
    padding: 0 0.75rem;
    border-radius: 999px;
    border: var(--c-border-width) solid var(--c-line-strong);
    background-color: var(--c-raised);
    color: var(--c-ink);
    font-size: 0.8125rem;
    white-space: nowrap;
  }

  .s-chip-link[aria-current='true'] {
    background-color: var(--c-sel-bg);
    border-color: var(--c-sel-bg);
    color: var(--c-sel-ink);
  }

  /* Wide: a sidebar beside the content. */
  @media (min-width: 1024px) {
    .s-nav {
      top: 4rem;
      margin: 0;
      padding: 0 0 1.5rem;
      max-height: calc(100vh - 5rem);
      overflow-y: auto;
      scrollbar-width: thin;
      background-color: transparent;
    }

    .s-tabs {
      flex-direction: column;
      gap: 0.125rem;
      overflow: visible;
      border-bottom: 0;
    }

    .s-tab {
      width: 100%;
      min-height: 2.75rem;
      padding: 0 0.75rem;
      border-bottom: 0;
      border-radius: 0.375rem;
      color: var(--c-ink);
      font-size: 0.9375rem;
    }

    .s-tab:hover {
      background-color: var(--c-tint);
    }

    .s-tab[aria-selected='true'] {
      background-color: var(--c-sel-bg);
      color: var(--c-sel-ink);
      font-weight: 600;
    }

    .s-glyph {
      display: inline-block;
      width: 1.25em;
      text-align: center;
      font-family: 'Shippori Mincho', 'Noto Serif JP', serif;
      font-weight: 700;
      color: var(--c-label);
    }

    .s-tab[aria-selected='true'] .s-glyph {
      color: var(--c-sel-ink);
    }

    .s-side-sections {
      display: flex;
      flex-direction: column;
      margin: 0.375rem 0 0.75rem 1.375rem;
      border-left: 1px solid var(--c-gold);
    }

    .s-side-link {
      margin-left: -1px;
      padding: 0.4rem 0.75rem;
      border-left: 2px solid transparent;
      color: var(--c-muted);
      font-size: 0.875rem;
      line-height: 1.3;
    }

    .s-side-link:hover {
      color: var(--c-ink);
    }

    .s-side-link[aria-current='true'] {
      border-left-color: var(--c-seal);
      color: var(--c-ink);
      font-weight: 600;
    }

    .s-chips {
      display: none;
    }
  }

  @media (min-width: 1280px) {
    .s-nav {
      top: 3.5rem;
    }
  }
</style>
