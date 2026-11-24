<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries, the Relationships tab (session 4; approved mockups): this device's layout.
   * - list: each pair and what the relationship is;
   * - diagram: the people and a line per relationship, fitted to the width (no scrolling);
   *   each line's label (the relationship's own one or two words, else its number) is a button
   *   that shows what the relationship means under the diagram.
   */
  import { layoutDiagram } from '$lib/summaries/relationship-diagram';
  import type { SummaryRelationshipLayout } from '$lib/summaries/settings';
  import type { SummaryItem } from '$lib/summaries/summary-types';
  import RubyHeading from './ruby-heading.svelte';
  import SummaryExtras from './summary-extras.svelte';

  export let items: SummaryItem[];
  export let layout: SummaryRelationshipLayout = 'list';
  export let ruby = false;
  export let quoteLang = 'ja';
  export let hrefOf: (it: SummaryItem) => string | null = () => null;
  export let linkTextOf: (it: SummaryItem) => string = () => 'Open the book here';

  let width = 0;
  $: withPair = items.filter((it) => it.between);
  $: diagram = layoutDiagram(
    withPair.map((it) => ({ ref: it.ref, between: it.between!, label: it.label })),
    width > 0 && width < 520
  );
  let chosen: string | null = null;
  $: selected = withPair.find((it) => it.ref === chosen) ?? withPair[0] ?? null;
</script>

{#if layout === 'diagram' && withPair.length}
  <div class="wrap" bind:clientWidth={width} data-testid="summary-diagram">
    <div class="box" style="aspect-ratio: {diagram.aspect}">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {#each diagram.edges as e (e.ref)}
          <line
            x1={diagram.nodes[e.from].x}
            y1={diagram.nodes[e.from].y}
            x2={diagram.nodes[e.to].x}
            y2={diagram.nodes[e.to].y}
            class:on={selected?.ref === e.ref}
            vector-effect="non-scaling-stroke"
          />
        {/each}
      </svg>
      {#each diagram.nodes as n (n.name)}
        <span class="node" style="left: {n.x}%; top: {n.y}%" data-testid="summary-diagram-node"
          >{n.name}</span
        >
      {/each}
      {#each diagram.edges as e (e.ref)}
        <button
          type="button"
          class="edge"
          class:numbered={e.numbered}
          style="left: {e.lx}%; top: {e.ly}%"
          aria-pressed={selected?.ref === e.ref}
          aria-label="{diagram.nodes[e.from].name} and {diagram.nodes[e.to].name}: {e.label}"
          data-testid="summary-diagram-label"
          on:click={() => (chosen = e.ref)}>{e.label}</button
        >
      {/each}
    </div>
    {#if selected}
      <div class="chosen" aria-live="polite" data-testid="summary-diagram-chosen">
        <h3 class="font-bold">
          <RubyHeading
            text={selected.between?.[0] ?? ''}
            pieces={ruby ? selected.betweenRuby?.[0] : null}
          />
          –
          <RubyHeading
            text={selected.between?.[1] ?? ''}
            pieces={ruby ? selected.betweenRuby?.[1] : null}
          />
          {#if selected.label}<span class="ml-2 text-sm font-normal text-c-muted"
              >{selected.label}</span
            >{/if}
        </h3>
        <p class="mt-1 leading-relaxed">{selected.text}<SummaryExtras item={selected} /></p>
        <SummaryExtras
          part="quote"
          item={selected}
          {quoteLang}
          href={hrefOf(selected)}
          linkText={linkTextOf(selected)}
        />
      </div>
    {/if}
    <p class="mt-1 text-xs text-c-muted">Tap a label on a line to see what it means.</p>
  </div>
{:else}
  <ul class="list">
    {#each items as it (it.ref)}
      <li data-ref={it.ref} data-testid="summary-relationship">
        {#if it.between}
          <h3 class="font-bold">
            <RubyHeading text={it.between[0]} pieces={ruby ? it.betweenRuby?.[0] : null} />
            –
            <RubyHeading text={it.between[1]} pieces={ruby ? it.betweenRuby?.[1] : null} />
            {#if it.label}<span class="ml-2 text-sm font-normal text-c-muted">{it.label}</span>{/if}
          </h3>
        {/if}
        <p class="mt-1 leading-relaxed">{it.text}<SummaryExtras item={it} /></p>
        <SummaryExtras
          part="quote"
          item={it}
          {quoteLang}
          href={hrefOf(it)}
          linkText={linkTextOf(it)}
        />
      </li>
    {/each}
  </ul>
{/if}

<style>
  .wrap {
    max-width: 44rem;
    container-type: inline-size;
  }
  .box {
    position: relative;
    width: 100%;
    border-radius: 10px;
    border: var(--c-border-width) solid var(--c-line);
    background: var(--c-raised);
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  line {
    stroke: var(--c-line-strong);
    stroke-width: 2;
  }
  line.on {
    stroke: var(--c-ink);
    stroke-width: 3;
  }
  .node {
    position: absolute;
    transform: translate(-50%, -50%);
    max-width: 30%;
    padding: 0.3em 0.75em;
    border-radius: 999px;
    background: var(--c-ink);
    color: var(--c-bg);
    font-size: clamp(11px, 2.6cqw, 15px);
    font-weight: 600;
    line-height: 1.3;
    text-align: center;
    overflow-wrap: anywhere;
    pointer-events: none;
  }
  .edge {
    position: absolute;
    transform: translate(-50%, -50%);
    padding: 0.2em 0.55em;
    border-radius: 6px;
    border: var(--c-border-width) solid var(--c-line-strong);
    background: var(--c-bg);
    color: var(--c-ink);
    font-size: clamp(11px, 2.3cqw, 13px);
    line-height: 1.3;
    white-space: nowrap;
    cursor: pointer;
  }
  /* The label is small to read; its tap area is a full touch target. */
  .edge::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: max(100%, var(--c-btn-h));
    height: var(--c-btn-h);
    transform: translate(-50%, -50%);
  }
  .edge.numbered {
    min-width: 1.8em;
    border-radius: 999px;
  }
  .edge[aria-pressed='true'] {
    background: var(--c-sel-bg);
    color: var(--c-sel-ink);
    border-color: var(--c-ink);
  }
  .edge:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: 2px;
  }
  .chosen {
    margin-top: 0.625rem;
    padding: 0.75rem 1rem;
    border-radius: 10px;
    background: var(--c-tint);
  }
  .list > li {
    padding: 0.75rem 0;
    border-top: var(--c-border-width) dashed var(--c-line);
  }
  .list > li:first-child {
    border-top: 0;
    padding-top: 0;
  }
</style>
