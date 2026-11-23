<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Settings > Library > Links (docs/design/calibre-metadata-display.md): this device's list of
   * the book page's links, as Settings > Reader > Toolbars (toolbar-settings.svelte): each link
   * Button / Menu / Hidden, ordered by the drag handle or ↑ / ↓ (Alt+↑ / Alt+↓ on a focused
   * row), and Reset to default. Every change is stored at once in `bookLinks` (link-edit.ts).
   * Rows carry `setting-book-link-<id>` so Settings search can point at them.
   */
  import { faArrowDown, faArrowUp, faGripVertical } from '@fortawesome/free-solid-svg-icons';
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import SettingChoice from '$lib/components/settings/setting-choice.svelte';
  import { resetLinksCopy } from '$lib/confirm/confirm-copy';
  import { moveLink, moveLinkTo, resetLinks, setLinkPlace } from '$lib/book-links/link-edit';
  import { LINK_LABELS } from '$lib/book-links/link-labels';
  import { resolveLinks } from '$lib/book-links/link-layout';
  import { linkDef, type LinkId, type LinkPlace } from '$lib/book-links/links';
  import { bookLinks$ } from '$lib/book-links/settings';
  import { settingDomId } from '$lib/settings/settings-catalog';
  import type Sortable from 'sortablejs';
  import { onDestroy, onMount, tick } from 'svelte';
  import Fa from 'svelte-fa';

  const PLACE_OPTIONS: { id: LinkPlace; text: string }[] = [
    { id: 'button', text: 'Button' },
    { id: 'menu', text: 'Menu' },
    { id: 'hidden', text: 'Hidden' }
  ];

  $: links = resolveLinks($bookLinks$);

  function place(id: LinkId, where: LinkPlace) {
    bookLinks$.next(setLinkPlace(bookLinks$.getValue(), id, where));
  }

  function move(id: LinkId, delta: -1 | 1, focus: Refocus['what']) {
    refocus = { id, what: focus };
    bookLinks$.next(moveLink(bookLinks$.getValue(), id, delta));
  }

  function drop(from: number, to: number) {
    bookLinks$.next(moveLinkTo(bookLinks$.getValue(), from, to));
  }

  let confirmReset = false;

  function reset() {
    confirmReset = false;
    bookLinks$.next(resetLinks());
  }

  // ---- Focus after a move: the moved row's button (or the row) keeps it ------------------

  interface Refocus {
    id: LinkId;
    what: 'up' | 'down' | 'row';
  }

  let refocus: Refocus | null = null;
  let list: HTMLElement | undefined;

  $: if (links && refocus) void restoreFocus(refocus);

  async function restoreFocus(target: Refocus) {
    await tick();
    const row = list?.querySelector<HTMLElement>(`[data-link-row="${target.id}"]`);
    if (!row) return;
    // Moved with Alt+↑ / Alt+↓: the row itself keeps the focus, so the next press moves it again.
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
    const row = (ev.target as HTMLElement | null)?.closest?.('[data-link-row]');
    if (refocus && row?.getAttribute('data-link-row') !== refocus.id) refocus = null;
  }

  function onRowKeydown(ev: KeyboardEvent, id: LinkId, index: number) {
    if (ev.target !== ev.currentTarget) return;
    if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
    ev.preventDefault();
    const delta = ev.key === 'ArrowUp' ? -1 : 1;
    if (index + delta < 0 || index + delta >= links.length) return;
    move(id, delta, 'row');
  }

  // ---- Dragging by the handle (sortablejs, no animation) -------------------------------

  let sortable: Sortable | undefined;

  onMount(async () => {
    await tick();
    const { default: SortableJs } = await import('sortablejs');
    if (!list) return;
    sortable = SortableJs.create(list, {
      handle: '[data-drag-handle]',
      animation: 0,
      ghostClass: 'opacity-40',
      onEnd(evt) {
        const { oldIndex, newIndex, item, from } = evt;
        if (oldIndex === undefined || newIndex === undefined || oldIndex === newIndex) return;
        // Put the row back: Svelte owns the DOM and draws the new order itself.
        from.insertBefore(item, from.children[oldIndex + (oldIndex > newIndex ? 1 : 0)] ?? null);
        drop(oldIndex, newIndex);
      }
    });
  });

  onDestroy(() => sortable?.destroy());
</script>

<div class="lk-card" data-testid="links-settings">
  <div class="lk-head">
    <button
      type="button"
      class="c-btn c-btn-secondary c-btn-sm shrink-0"
      data-testid="links-reset"
      on:click={() => (confirmReset = true)}
    >
      Reset to default
    </button>
  </div>
  {#if confirmReset}
    <div class="px-4 py-3">
      <InlineConfirm
        {...resetLinksCopy()}
        testid="links-reset-confirm"
        confirmTestid="links-reset-confirm-ok"
        on:cancel={() => (confirmReset = false)}
        on:confirm={reset}
      />
    </div>
  {/if}
  <ol bind:this={list} class="lk-list" data-testid="links-rows" on:focusin={onFocusIn}>
    {#each links as entry, i (entry.id)}
      <!-- Focusable so Alt+Up/Down can move the row (the buttons do the same). -->
      <!-- svelte-ignore a11y-no-noninteractive-tabindex a11y-no-noninteractive-element-interactions -->
      <li
        class="s-row lk-row"
        class:lk-hidden={entry.place === 'hidden'}
        id={settingDomId(`book-link-${entry.id}`)}
        tabindex="0"
        aria-label="{i + 1}. {linkDef(entry.id).name}"
        data-link-row={entry.id}
        data-place={entry.place}
        on:keydown={(ev) => onRowKeydown(ev, entry.id, i)}
      >
        <span class="lk-handle" title="Drag to move" data-drag-handle aria-hidden="true">
          <Fa icon={faGripVertical} />
        </span>
        <div class="lk-text">
          <div class="font-semibold" id="lk-{entry.id}">{linkDef(entry.id).name}</div>
          <p class="lk-desc">{LINK_LABELS[entry.id].description}</p>
        </div>
        <div class="lk-choice">
          <SettingChoice
            options={PLACE_OPTIONS}
            value={entry.place}
            labelledby="lk-{entry.id}"
            testid="links-choice-{entry.id}"
            on:change={({ detail }) => place(entry.id, detail)}
          />
        </div>
        <div class="lk-move">
          <button
            type="button"
            class="c-btn c-btn-secondary c-btn-icon"
            title="Move up"
            aria-label="Move up: {linkDef(entry.id).name}"
            disabled={i === 0}
            data-move="up"
            data-testid="links-up"
            on:click={() => move(entry.id, -1, 'up')}
          >
            <Fa icon={faArrowUp} />
          </button>
          <button
            type="button"
            class="c-btn c-btn-secondary c-btn-icon"
            title="Move down"
            aria-label="Move down: {linkDef(entry.id).name}"
            disabled={i === links.length - 1}
            data-move="down"
            data-testid="links-down"
            on:click={() => move(entry.id, 1, 'down')}
          >
            <Fa icon={faArrowDown} />
          </button>
        </div>
      </li>
    {/each}
  </ol>
</div>

<style>
  .lk-card {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
    border-radius: 0.5rem;
    overflow: hidden;
  }

  .lk-head {
    display: flex;
    justify-content: flex-end;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--c-line);
  }

  .lk-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* Phone: handle and the name with what it does on one line; the choice and ↑↓ under it.
     From 640 px everything sits on one line (as the Toolbars screen). */
  .lk-row {
    display: grid;
    grid-template-columns: 2.75rem minmax(0, 1fr) auto;
    grid-template-areas:
      'handle text text'
      'choice choice move';
    gap: 0.5rem 0.5rem;
    align-items: center;
    padding: 0.625rem 0.75rem 0.625rem 0.25rem;
    outline-offset: -2px;
  }

  @media (min-width: 640px) {
    .lk-row {
      grid-template-columns: 2.75rem minmax(0, 1fr) auto auto;
      grid-template-areas: 'handle text choice move';
      gap: 0.5rem 0.75rem;
      padding: 0.625rem 1rem;
    }
  }

  /* A hidden link's name and description are dimmed (as in the mock); its controls stay full. */
  .lk-hidden .lk-text {
    opacity: 0.6;
  }

  :global(html.eink) .lk-hidden .lk-text {
    opacity: 1;
  }

  .lk-handle {
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

  .lk-text {
    grid-area: text;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .lk-desc {
    margin-top: 0.15rem;
    font-size: 0.875rem;
    line-height: 1.4;
    color: var(--c-muted);
  }

  .lk-choice {
    grid-area: choice;
    min-width: 0;
    padding-left: 0.5rem;
  }

  @media (max-width: 639.98px) {
    .lk-choice :global(.s-choice button) {
      padding-left: 0.375rem;
      padding-right: 0.375rem;
    }
  }

  @media (min-width: 640px) {
    .lk-choice {
      padding-left: 0;
    }
  }

  .lk-move {
    grid-area: move;
    display: flex;
    gap: 0.375rem;
  }

  .lk-row:focus-visible {
    outline: 2px solid var(--c-link);
  }

  :global(html.eink) .lk-handle,
  :global(html.eink) .lk-desc {
    color: #000;
  }
</style>
