<script lang="ts">
  /** What the library search box understands (WP7a), in plain words. */
  import Modal from '$lib/components/modal/modal.svelte';
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher<{ close: void }>();

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
</script>

<Modal title="Searching the library" size="lg" testid="search-help" on:close={close}>
  <table class="my-3 w-full text-sm">
    <tbody>
      {#each rows as [example, meaning]}
        <tr class="border-b border-c-line align-top">
          <td class="whitespace-nowrap py-1.5 pr-3 font-mono">{example}</td>
          <td class="py-1.5">{meaning}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="text-sm text-c-muted">
    Mix them freely: <span class="font-mono">tag:SF chars:&lt;100k -status:completed</span>. Books
    not counted yet are left out of <span class="font-mono">chars:</span> searches.
  </p>
  <p class="mt-2 text-sm text-c-muted" data-testid="search-help-width">
    Full-width and half-width letters and digits match alike, and case doesn't matter:
    <span class="font-mono">gj</span> finds <span class="font-mono">ＧＪ部</span>. Patterns match
    the text exactly as written.
  </p>
</Modal>
