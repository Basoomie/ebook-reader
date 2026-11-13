<script lang="ts">
  /** What the library search box understands (WP7a), in plain words. */
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher<{ close: void }>();
  const buttonClass =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-5 font-medium';

  const rows: [string, string][] = [
    ['薬屋 外伝', 'Words in the title, an author or the series (all of them)'],
    ['"Jane Doe"', 'Words that belong together'],
    ['author:日向', 'Author name contains the text'],
    ['series:薬屋', 'Series name contains the text'],
    ['tag:SF', 'Tag contains the text'],
    ['tag:=SF', 'Exactly this tag (= works for author: and series: too)'],
    ['tag:SF tag:BL', 'Books with both tags'],
    ['tag:SF,BL', 'Books with either tag'],
    ['chars:<150000', 'Fewer than 150,000 characters (also >, <=, >=, 50k-150k)'],
    ['status:reading', 'Unread, reading, completed or dropped (commas for either)'],
    ['favorite:yes', 'Your favorites'],
    ['-status:completed', 'A minus leaves out what follows'],
    ['/^薬屋.*[0-9]$/', 'A pattern (regular expression); add i for any case: /abc/i']
  ];

  function close() {
    dispatch('close');
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 max-h-[90vh] max-w-xl overflow-y-auto rounded bg-white p-6"
  data-testid="search-help"
>
  <h2 class="weight-medium mb-3 text-xl">Searching the library</h2>
  <table class="mb-3 w-full text-sm">
    <tbody>
      {#each rows as [example, meaning]}
        <tr class="border-b border-gray-400/40 align-top">
          <td class="whitespace-nowrap py-1.5 pr-3 font-mono">{example}</td>
          <td class="py-1.5">{meaning}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="text-sm">
    Mix them freely: <span class="font-mono">tag:SF chars:&lt;100k -status:completed</span>. Books
    not counted yet are left out of <span class="font-mono">chars:</span> searches.
  </p>
  <p class="mt-2 text-sm" data-testid="search-help-width">
    Full-width and half-width letters and digits match alike, and case doesn't matter:
    <span class="font-mono">gj</span> finds <span class="font-mono">ＧＪ部</span>. Patterns match
    the text exactly as written.
  </p>
  <footer class="flex justify-end pt-4">
    <button class={buttonClass} on:click={close}>Close</button>
  </footer>
</section>
