<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Reader toolbars session 2 (docs/design/reader-toolbar.md, "Where it's edited"): Settings >
   * Reader > Toolbars, this device's two lists. Top bar: each entry Bar / Menu / Hidden (Bar /
   * Hidden for the gap, the speed readout and the menu button). Bottom bar: Shown / Hidden.
   * Order by the drag handle or by ↑ / ↓ (the buttons are for the Boox: dragging on E-ink is
   * unreliable); Alt+↑ / Alt+↓ move a focused row. Each list has Reset to default. Every change
   * is stored at once in readerToolbar / readerBottomBar (toolbar-edit.ts), which the reader
   * reads when it opens. Rows carry `setting-<id>` so Settings search can point at them.
   */
  import { faBookmark as farBookmark } from '@fortawesome/free-regular-svg-icons';
  import {
    faArrowDown,
    faArrowLeft,
    faArrowUp,
    faArrowsLeftRight,
    faBars,
    faCrosshairs,
    faGaugeHigh,
    faGripVertical,
    faHeadphones,
    faNoteSticky,
    faPause,
    faReply,
    faStopwatch,
    faVolumeHigh,
    type IconDefinition
  } from '@fortawesome/free-solid-svg-icons';
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import SettingChoice from '$lib/components/settings/setting-choice.svelte';
  import { resetToolbarCopy } from '$lib/confirm/confirm-copy';
  import { readerBottomBar$, readerToolbar$ } from '$lib/data/store';
  import {
    menuButtonHiddenWithEntries,
    moveBottom,
    moveBottomTo,
    moveTop,
    moveTopTo,
    resetBottom,
    resetTop,
    setBottomShown,
    setTopPlace,
    topChoices
  } from '$lib/reader-toolbar/toolbar-edit';
  import { STATISTICS, TOOLBAR_ACTIONS } from '$lib/reader-toolbar/toolbar-entries';
  import {
    AUDIOBOOK_OWN_BUTTONS,
    BOTTOM_LABELS,
    TOP_LABELS
  } from '$lib/reader-toolbar/toolbar-labels';
  import {
    resolveBottomBar,
    resolveTopBar,
    type BottomId,
    type TopId,
    type TopPlace
  } from '$lib/reader-toolbar/toolbar-layout';
  import { settingDomId } from '$lib/settings/settings-catalog';
  import type Sortable from 'sortablejs';
  import { onDestroy, onMount, tick } from 'svelte';
  import Fa from 'svelte-fa';

  type Bar = 'top' | 'bottom';

  const LISTS: { bar: Bar; title: string; note: string }[] = [
    {
      bar: 'top',
      title: 'Top bar',
      note: 'Opens with a tap at the top edge of the page. Entries set to Menu are listed behind the menu button.'
    },
    {
      bar: 'bottom',
      title: 'Bottom bar',
      note: 'The buttons at the left of the bottom bar. The progress text and the goals dot stay at the right.'
    }
  ];

  const PLACE_TEXT: Record<TopPlace, string> = { bar: 'Bar', menu: 'Menu', hidden: 'Hidden' };
  const SHOWN_OPTIONS = [
    { id: true, text: 'Shown' },
    { id: false, text: 'Hidden' }
  ];

  const TOP_ICONS: Partial<Record<TopId, IconDefinition>> = {
    jumpBackForward: faArrowLeft,
    speed: faStopwatch,
    gap: faArrowsLeftRight,
    menu: faBars,
    savePlace: farBookmark,
    readingPoint: faCrosshairs,
    statistics: STATISTICS.icon
  };

  const BOTTOM_ICONS: Record<BottomId, IconDefinition> = {
    tracker: faPause,
    anki: faNoteSticky,
    pacer: faGaugeHigh,
    readAloud: faVolumeHigh,
    returnMarker: faReply,
    audiobook: faHeadphones
  };

  const topIcon = (id: TopId) => TOOLBAR_ACTIONS[id]?.icon ?? TOP_ICONS[id] ?? faBars;
  const topOptions = (id: TopId) =>
    topChoices(id).map((place) => ({ id: place, text: PLACE_TEXT[place] }));

  $: top = resolveTopBar($readerToolbar$);
  $: bottom = resolveBottomBar($readerBottomBar$);
  $: menuHint = menuButtonHiddenWithEntries($readerToolbar$);

  // ---- Changes: each one stored at once -------------------------------------------------

  function placeTop(id: TopId, place: TopPlace) {
    readerToolbar$.next(setTopPlace(readerToolbar$.getValue(), id, place));
  }

  function showBottom(id: BottomId, shown: boolean) {
    readerBottomBar$.next(setBottomShown(readerBottomBar$.getValue(), id, shown));
  }

  function move(bar: Bar, id: string, delta: -1 | 1, focus: Refocus['what']) {
    refocus = { bar, id, what: focus };
    if (bar === 'top') {
      readerToolbar$.next(moveTop(readerToolbar$.getValue(), id as TopId, delta));
    } else {
      readerBottomBar$.next(moveBottom(readerBottomBar$.getValue(), id as BottomId, delta));
    }
  }

  function drop(bar: Bar, from: number, to: number) {
    if (bar === 'top') {
      readerToolbar$.next(moveTopTo(readerToolbar$.getValue(), from, to));
    } else {
      readerBottomBar$.next(moveBottomTo(readerBottomBar$.getValue(), from, to));
    }
  }

  // ---- Reset ----------------------------------------------------------------------------

  let confirmReset: Bar | null = null;

  function reset(bar: Bar) {
    confirmReset = null;
    if (bar === 'top') readerToolbar$.next(resetTop());
    else readerBottomBar$.next(resetBottom());
  }

  // ---- Focus after a move: the moved row's button (or the row) keeps it ------------------

  interface Refocus {
    bar: Bar;
    id: string;
    what: 'up' | 'down' | 'row';
  }

  let refocus: Refocus | null = null;
  let topList: HTMLElement | undefined;
  let bottomList: HTMLElement | undefined;

  $: if ((top || bottom) && refocus) void restoreFocus(refocus);

  async function restoreFocus(target: Refocus) {
    await tick();
    const list = target.bar === 'top' ? topList : bottomList;
    const row = list?.querySelector<HTMLElement>(`[data-toolbar-row="${target.id}"]`);
    if (!row) return;
    // Moved with Alt+↑ / Alt+↓: the row itself keeps the focus, so the next press moves it again
    // (it went to the ↑ button, whose keys the row ignores).
    if (target.what === 'row') {
      if (document.activeElement !== row) row.focus({ preventScroll: true });
      return;
    }
    const wanted = row.querySelector<HTMLButtonElement>(`[data-move="${target.what}"]`);
    const other = row.querySelector<HTMLButtonElement>(
      `[data-move="${target.what === 'up' ? 'down' : 'up'}"]`
    );
    // At an end the pressed button is disabled: the other one, else the row, takes the focus.
    const el = wanted && !wanted.disabled ? wanted : other && !other.disabled ? other : row;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
  }

  function onFocusIn(ev: FocusEvent) {
    const row = (ev.target as HTMLElement | null)?.closest?.('[data-toolbar-row]');
    if (refocus && row?.getAttribute('data-toolbar-row') !== refocus.id) refocus = null;
  }

  function onRowKeydown(ev: KeyboardEvent, bar: Bar, id: string, index: number, length: number) {
    if (ev.target !== ev.currentTarget) return;
    if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
    ev.preventDefault();
    const delta = ev.key === 'ArrowUp' ? -1 : 1;
    if (index + delta < 0 || index + delta >= length) return;
    move(bar, id, delta, 'row');
  }

  // ---- Dragging by the handle (sortablejs, no animation) -------------------------------

  let sortables: Sortable[] = [];

  onMount(async () => {
    await tick();
    const { default: SortableJs } = await import('sortablejs');
    for (const [bar, el] of [
      ['top', topList],
      ['bottom', bottomList]
    ] as const) {
      if (!el) continue;
      sortables.push(
        SortableJs.create(el, {
          handle: '[data-drag-handle]',
          animation: 0,
          ghostClass: 'opacity-40',
          onEnd(evt) {
            const { oldIndex, newIndex, item, from } = evt;
            if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) return;
            // Put the row back: Svelte owns the DOM and draws the new order itself.
            from.insertBefore(
              item,
              from.children[oldIndex + (oldIndex > newIndex ? 1 : 0)] ?? null
            );
            drop(bar, oldIndex, newIndex);
          }
        })
      );
    }
  });

  onDestroy(() => sortables.forEach((s) => s.destroy()));
</script>

<div class="space-y-6" data-testid="toolbar-settings">
  {#each LISTS as list (list.bar)}
    <div class="tb-card" data-testid="toolbar-list-{list.bar}">
      <div class="tb-head">
        <div class="min-w-0">
          <h3 class="font-bold">{list.title}</h3>
          <p class="text-sm text-c-muted">{list.note}</p>
        </div>
        <button
          type="button"
          class="c-btn c-btn-secondary c-btn-sm shrink-0"
          data-testid="toolbar-reset-{list.bar}"
          on:click={() => (confirmReset = list.bar)}
        >
          Reset to default
        </button>
      </div>
      {#if confirmReset === list.bar}
        <div class="px-4 py-3">
          <InlineConfirm
            {...resetToolbarCopy(list.bar)}
            testid="toolbar-reset-confirm"
            confirmTestid="toolbar-reset-confirm-ok"
            on:cancel={() => (confirmReset = null)}
            on:confirm={() => reset(list.bar)}
          />
        </div>
      {/if}

      {#if list.bar === 'top'}
        <ol
          bind:this={topList}
          class="tb-list"
          data-testid="toolbar-rows-top"
          on:focusin={onFocusIn}
        >
          {#each top as entry, i (entry.id)}
            <!-- Focusable so Alt+Up/Down can move the row (the buttons do the same). -->
            <!-- svelte-ignore a11y-no-noninteractive-tabindex a11y-no-noninteractive-element-interactions -->
            <li
              class="s-row tb-row"
              id={settingDomId(`toolbar-top-${entry.id}`)}
              tabindex="0"
              aria-label="{i + 1}. {TOP_LABELS[entry.id].name}"
              data-toolbar-row={entry.id}
              data-place={entry.place}
              on:keydown={(ev) => onRowKeydown(ev, 'top', entry.id, i, top.length)}
            >
              <span class="tb-handle" title="Drag to move" data-drag-handle aria-hidden="true">
                <Fa icon={faGripVertical} />
              </span>
              <span class="tb-icon" aria-hidden="true"><Fa icon={topIcon(entry.id)} /></span>
              <div class="tb-text">
                <div class="font-semibold" id="tb-top-{entry.id}">{TOP_LABELS[entry.id].name}</div>
                <p class="tb-desc">{TOP_LABELS[entry.id].description}</p>
                {#if entry.id === 'menu' && menuHint}
                  <p class="tb-desc tb-hint" data-testid="toolbar-menu-hint">
                    ⚠ Some buttons are set to Menu. They show only while the menu button is set to
                    Bar.
                  </p>
                {/if}
              </div>
              <div class="tb-choice">
                <SettingChoice
                  options={topOptions(entry.id)}
                  value={entry.place}
                  labelledby="tb-top-{entry.id}"
                  testid="toolbar-choice-top-{entry.id}"
                  on:change={({ detail }) => placeTop(entry.id, detail)}
                />
              </div>
              <div class="tb-move">
                <button
                  type="button"
                  class="c-btn c-btn-secondary c-btn-icon"
                  title="Move up"
                  aria-label="Move up: {TOP_LABELS[entry.id].name}"
                  disabled={i === 0}
                  data-move="up"
                  data-testid="toolbar-up"
                  on:click={() => move('top', entry.id, -1, 'up')}
                >
                  <Fa icon={faArrowUp} />
                </button>
                <button
                  type="button"
                  class="c-btn c-btn-secondary c-btn-icon"
                  title="Move down"
                  aria-label="Move down: {TOP_LABELS[entry.id].name}"
                  disabled={i === top.length - 1}
                  data-move="down"
                  data-testid="toolbar-down"
                  on:click={() => move('top', entry.id, 1, 'down')}
                >
                  <Fa icon={faArrowDown} />
                </button>
              </div>
            </li>
          {/each}
        </ol>
      {:else}
        <ol
          bind:this={bottomList}
          class="tb-list"
          data-testid="toolbar-rows-bottom"
          on:focusin={onFocusIn}
        >
          {#each bottom as entry, i (entry.id)}
            <!-- svelte-ignore a11y-no-noninteractive-tabindex a11y-no-noninteractive-element-interactions -->
            <li
              class="s-row tb-row"
              id={settingDomId(`toolbar-bottom-${entry.id}`)}
              tabindex="0"
              aria-label="{i + 1}. {BOTTOM_LABELS[entry.id].name}"
              data-toolbar-row={entry.id}
              data-shown={entry.shown ? '1' : '0'}
              on:keydown={(ev) => onRowKeydown(ev, 'bottom', entry.id, i, bottom.length)}
            >
              <span class="tb-handle" title="Drag to move" data-drag-handle aria-hidden="true">
                <Fa icon={faGripVertical} />
              </span>
              <span class="tb-icon" aria-hidden="true"><Fa icon={BOTTOM_ICONS[entry.id]} /></span>
              <div class="tb-text">
                <div class="font-semibold" id="tb-bottom-{entry.id}">
                  {BOTTOM_LABELS[entry.id].name}
                </div>
                <p class="tb-desc">{BOTTOM_LABELS[entry.id].description}</p>
                {#if entry.id === 'audiobook'}
                  <p class="tb-desc" data-testid="toolbar-audiobook-note">
                    {AUDIOBOOK_OWN_BUTTONS}
                  </p>
                {/if}
              </div>
              <div class="tb-choice">
                <SettingChoice
                  options={SHOWN_OPTIONS}
                  value={entry.shown}
                  labelledby="tb-bottom-{entry.id}"
                  testid="toolbar-choice-bottom-{entry.id}"
                  on:change={({ detail }) => showBottom(entry.id, detail)}
                />
              </div>
              <div class="tb-move">
                <button
                  type="button"
                  class="c-btn c-btn-secondary c-btn-icon"
                  title="Move up"
                  aria-label="Move up: {BOTTOM_LABELS[entry.id].name}"
                  disabled={i === 0}
                  data-move="up"
                  data-testid="toolbar-up"
                  on:click={() => move('bottom', entry.id, -1, 'up')}
                >
                  <Fa icon={faArrowUp} />
                </button>
                <button
                  type="button"
                  class="c-btn c-btn-secondary c-btn-icon"
                  title="Move down"
                  aria-label="Move down: {BOTTOM_LABELS[entry.id].name}"
                  disabled={i === bottom.length - 1}
                  data-move="down"
                  data-testid="toolbar-down"
                  on:click={() => move('bottom', entry.id, 1, 'down')}
                >
                  <Fa icon={faArrowDown} />
                </button>
              </div>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  {/each}
</div>

<style>
  .tb-card {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
    border-radius: 0.5rem;
    overflow: hidden;
  }

  .tb-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    padding: 0.875rem 1rem;
    border-bottom: 1px solid var(--c-line);
  }

  .tb-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* Phone: handle, icon and the name with what it does on one line; the choice and ↑↓
     under it. From 640 px everything sits on one line. */
  .tb-row {
    display: grid;
    grid-template-columns: 2.75rem 1.5rem minmax(0, 1fr) auto;
    grid-template-areas:
      'handle icon text text'
      'choice choice choice move';
    gap: 0.5rem 0.5rem;
    align-items: center;
    padding: 0.625rem 0.75rem 0.625rem 0.25rem;
    outline-offset: -2px;
  }

  @media (min-width: 640px) {
    .tb-row {
      grid-template-columns: 2.75rem 1.75rem minmax(0, 1fr) auto auto;
      grid-template-areas: 'handle icon text choice move';
      gap: 0.5rem 0.75rem;
      padding: 0.625rem 1rem;
    }
  }

  .tb-handle {
    grid-area: handle;
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: stretch;
    min-height: 2.75rem;
    cursor: grab;
    color: var(--c-muted);
    touch-action: none;
  }

  .tb-icon {
    grid-area: icon;
    display: flex;
    justify-content: center;
    color: var(--c-muted);
  }

  .tb-text {
    grid-area: text;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .tb-desc {
    margin-top: 0.15rem;
    font-size: 0.875rem;
    line-height: 1.4;
    color: var(--c-muted);
  }

  .tb-hint {
    color: var(--c-ink);
    font-weight: 600;
  }

  .tb-choice {
    grid-area: choice;
    min-width: 0;
    padding-left: 0.5rem;
  }

  /* On a phone "Bar / Menu / Hidden" share the line with ↑↓: narrower sides, whole words. */
  @media (max-width: 639.98px) {
    .tb-choice :global(.s-choice button) {
      padding-left: 0.375rem;
      padding-right: 0.375rem;
    }
  }

  @media (min-width: 640px) {
    .tb-choice {
      padding-left: 0;
    }
  }

  .tb-move {
    grid-area: move;
    display: flex;
    gap: 0.375rem;
  }

  .tb-row:focus-visible {
    outline: 2px solid var(--c-link);
  }

  :global(html.eink) .tb-handle,
  :global(html.eink) .tb-icon,
  :global(html.eink) .tb-desc {
    color: #000;
  }
</style>
