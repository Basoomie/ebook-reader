<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 §6: the book page's expanded view of the cover and the illustrations. The
   * picture fits the screen; ‹ › , a swipe or ←/→ go to the others. It closes on ✕, Esc,
   * the phone's Back (opening adds a history entry) or a tap anywhere outside the picture,
   * but not at the end of a swipe. A hidden picture stays blurred until its ネタバレ is tapped.
   *
   * On a touch screen, dragging up or down moves the picture with the finger and fades the
   * background, like a phone's photo viewer: let go far enough (or flick) and it closes,
   * otherwise it springs back (2026-11-21). The view takes every touch (`touch-action:
   * none`), so the page behind never scrolls or pulls to refresh.
   */
  import { pushState } from '$app/navigation';
  import { page } from '$app/stores';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { releaseSpeed } from '$lib/components/modal/sheet-swipe';

  export let pictures: { src: string; hidden: boolean; caption: string }[];
  export let index: number;

  const dispatch = createEventDispatcher<{ close: void; reveal: number }>();
  const SWIPE_PX = 50;
  /** Movement before a drag has a direction. */
  const SLOP_PX = 8;
  /** Let go this far up or down (share of the screen, within the px bounds) and it closes. */
  const DISMISS_SHARE = 0.15;
  const DISMISS_MIN_PX = 80;
  const DISMISS_MAX_PX = 160;
  /** A flick: this fast (px/ms) and at least this far also closes. */
  const FLICK_SPEED = 0.55;
  const FLICK_MIN_PX = 32;
  const ANIMATION_MS = 200;

  let closeButton: HTMLButtonElement;
  let returnFocus: Element | null = null;
  let startX: number | null = null;
  let startY = 0;
  let swiped = false;
  let pushed = false;
  let seenEntry = false;
  let closing = false;
  let pointerId: number | null = null;
  let axis: 'x' | 'y' | null = null;
  let dismissable = false;
  let samples: { t: number; y: number }[] = [];
  /** The picture's offset while it is dragged up or down. */
  let dragX = 0;
  let dragY = 0;
  let animating = false;
  let leaving = false;

  $: dragShare = Math.min(
    1,
    Math.abs(dragY) / (typeof innerHeight === 'number' ? innerHeight / 2 : 400)
  );

  $: current = pictures[index];
  $: hasPrev = index > 0;
  $: hasNext = index < pictures.length - 1;
  $: onOurEntry = !!($page.state as { illustrations?: boolean }).illustrations;
  // The page state follows pushState a moment later: closing waits until our entry was seen.
  $: if (pushed && onOurEntry) seenEntry = true;
  // Back pressed (or the entry otherwise left): close.
  $: if (seenEntry && !closing && !onOurEntry) {
    closing = true;
    dispatch('close');
  }

  onMount(() => {
    returnFocus = document.activeElement;
    closeButton?.focus();
    pushState('', { ...($page.state as object), illustrations: true });
    pushed = true;
  });

  onDestroy(() => {
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
  });

  function close() {
    if (closing) return;
    // Leaving our history entry closes the view (above), like the phone's Back.
    if (seenEntry && onOurEntry) history.back();
    else {
      closing = true;
      dispatch('close');
    }
  }

  function go(step: number) {
    const next = index + step;
    if (next >= 0 && next < pictures.length) index = next;
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') close();
    else if (ev.key === 'ArrowRight') go(1);
    else if (ev.key === 'ArrowLeft') go(-1);
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  }

  function reducedMotion() {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function pointerDown(ev: PointerEvent) {
    if (pointerId !== null || leaving) {
      // A second finger (a pinch): no swipe at all.
      cancelDrag();
      return;
    }
    pointerId = ev.pointerId;
    startX = ev.clientX;
    startY = ev.clientY;
    axis = null;
    dismissable = ev.pointerType !== 'mouse';
    samples = [];
    swiped = false;
  }

  function pointerMove(ev: PointerEvent) {
    if (ev.pointerId !== pointerId || startX === null) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!axis) {
      if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
      axis = Math.abs(dx) > Math.abs(dy) || !dismissable ? 'x' : 'y';
      // A drag never ends in a tap that closes.
      swiped = true;
      animating = false;
    }
    if (axis !== 'y') return;
    dragX = dx;
    dragY = dy;
    samples.push({ t: ev.timeStamp, y: ev.clientY });
    if (samples.length > 12) samples.shift();
  }

  function pointerUp(ev: PointerEvent) {
    if (ev.pointerId !== pointerId || startX === null) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const lockedAxis = axis;
    pointerId = null;
    startX = null;
    axis = null;
    if (lockedAxis === 'y') {
      endVerticalDrag(dy, releaseSpeed(samples));
    } else if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      swiped = true;
      go(dx < 0 ? 1 : -1);
    }
  }

  function cancelDrag() {
    pointerId = null;
    startX = null;
    if (axis === 'y') springBack();
    axis = null;
  }

  function endVerticalDrag(dy: number, speed: number) {
    const distance = Math.min(
      DISMISS_MAX_PX,
      Math.max(DISMISS_MIN_PX, innerHeight * DISMISS_SHARE)
    );
    const flick = Math.abs(speed) >= FLICK_SPEED && Math.abs(dy) >= FLICK_MIN_PX;
    // A flick back towards the middle at the end means "never mind".
    const backwards = Math.sign(speed) === -Math.sign(dy) && Math.abs(speed) > FLICK_SPEED / 2;
    const away =
      !backwards && (Math.abs(dy) >= distance || (flick && Math.sign(speed) === Math.sign(dy)));
    if (!away) {
      springBack();
      return;
    }
    leaving = true;
    if (reducedMotion()) {
      close();
      return;
    }
    animating = true;
    dragY = Math.sign(dy) * innerHeight;
    setTimeout(close, ANIMATION_MS);
  }

  function springBack() {
    animating = !reducedMotion();
    dragX = 0;
    dragY = 0;
  }

  function backdropClick() {
    if (swiped) {
      swiped = false;
      return;
    }
    close();
  }
</script>

<svelte:window on:keydown|capture={onKeydown} />

<!-- The backdrop's click closes (a tap outside the picture); every control is a button. -->
<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div
  class="c-lightbox"
  role="dialog"
  aria-modal="true"
  aria-label="Illustrations"
  data-testid="illustrations-lightbox"
  class:c-lb-dragging={dragY !== 0 || leaving}
  class:c-lb-settling={animating || leaving}
  style:--lb-fade={leaving ? 0 : 1 - dragShare}
  on:pointerdown={pointerDown}
  on:pointermove={pointerMove}
  on:pointerup={pointerUp}
  on:pointercancel={cancelDrag}
  on:click={backdropClick}
>
  <div class="c-lb-top">
    <span class="c-lb-caption" data-testid="lightbox-caption">{current?.caption ?? ''}</span>
    <button
      type="button"
      class="c-lb-btn"
      aria-label="Close"
      data-testid="lightbox-close"
      bind:this={closeButton}
      on:click|stopPropagation={close}
    >
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
        <path
          d="M6 6l12 12M18 6L6 18"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>
  <div class="c-lb-stage">
    {#if current}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <div
        class="c-lb-pic"
        class:c-lb-hidden={current.hidden}
        class:c-lb-animating={animating}
        style:transform={dragX || dragY
          ? `translate(${dragX}px, ${dragY}px) scale(${1 - 0.25 * dragShare})`
          : undefined}
        on:transitionend={() => (animating = false)}
        data-testid="lightbox-picture"
        on:click|stopPropagation
      >
        <img src={current.src} alt="" draggable="false" />
        {#if current.hidden}
          <button
            type="button"
            class="c-lb-spoiler"
            data-testid="lightbox-reveal"
            on:click|stopPropagation={() => dispatch('reveal', index)}
          >
            ネタバレ
          </button>
        {/if}
      </div>
    {/if}
    {#if hasPrev}
      <button
        type="button"
        class="c-lb-btn c-lb-nav c-lb-prev"
        aria-label="Previous"
        data-testid="lightbox-prev"
        on:click|stopPropagation={() => go(-1)}
      >
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path
            d="M15 5l-7 7 7 7"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    {/if}
    {#if hasNext}
      <button
        type="button"
        class="c-lb-btn c-lb-nav c-lb-next"
        aria-label="Next"
        data-testid="lightbox-next"
        on:click|stopPropagation={() => go(1)}
      >
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path
            d="M9 5l7 7-7 7"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    {/if}
  </div>
</div>

<style>
  .c-lightbox {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: flex;
    flex-direction: column;
    background-color: rgba(8, 11, 20, calc(0.95 * var(--lb-fade, 1)));
    color: #f3ede0;
    /* Every touch is the view's own (swipes); the page behind never scrolls or refreshes. */
    touch-action: none;
    overscroll-behavior: none;
    user-select: none;
  }

  /* Sliding away or back (never while the finger moves it). */
  .c-lb-settling {
    transition: background-color 0.2s ease-out;
  }

  /* While the picture is dragged away, the controls step back. */
  .c-lb-top,
  .c-lb-nav {
    transition: opacity 0.15s ease-out;
  }

  .c-lb-dragging .c-lb-top,
  .c-lb-dragging .c-lb-nav {
    opacity: 0;
  }

  .c-lb-animating {
    transition: transform 0.2s ease-out;
  }

  @media (prefers-reduced-motion: reduce) {
    .c-lb-settling,
    .c-lb-animating {
      transition: none;
    }
  }

  .c-lb-top {
    display: flex;
    height: 3.5rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    padding: 0 0.25rem 0 1rem;
  }

  .c-lb-caption {
    font-size: 14px;
    font-weight: 500;
    color: #c9cfdb;
  }

  .c-lb-btn {
    display: flex;
    width: 3rem;
    height: 3rem;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    color: #f3ede0;
  }

  @media (hover: hover) {
    .c-lb-btn:hover {
      background-color: rgba(255, 255, 255, 0.12);
    }
  }

  .c-lb-stage {
    position: relative;
    display: flex;
    min-height: 0;
    flex: 1;
    align-items: center;
    justify-content: center;
    padding: 0 5rem 1.5rem;
  }

  .c-lb-pic {
    position: relative;
    display: flex;
    max-width: 100%;
    max-height: 100%;
    overflow: hidden;
  }

  .c-lb-pic img {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 5.5rem);
    max-height: calc(100dvh - 5.5rem);
    object-fit: contain;
  }

  .c-lb-hidden img {
    filter: blur(28px);
  }

  .c-lb-spoiler {
    position: absolute;
    top: 50%;
    left: 50%;
    min-height: 3rem;
    transform: translate(-50%, -50%);
    border-radius: 9999px;
    background-color: rgba(0, 0, 0, 0.6);
    padding: 0 1rem;
    color: #dcddde;
    font-family: 'Noto Sans JP', sans-serif;
    font-size: 15px;
    font-weight: 700;
    white-space: nowrap;
  }

  .c-lb-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    background-color: rgba(255, 255, 255, 0.12);
  }

  .c-lb-prev {
    left: 1rem;
  }

  .c-lb-next {
    right: 1rem;
  }

  @media (max-width: 599px) {
    .c-lb-stage {
      padding: 0 0.75rem 1.5rem;
    }

    .c-lb-prev {
      left: 0.25rem;
    }

    .c-lb-next {
      right: 0.25rem;
    }
  }

  :global(html.eink) .c-lightbox {
    background-color: rgb(0 0 0 / var(--lb-fade, 1));
  }
</style>
