<script lang="ts">
  /**
   * WP10a: the `?` cheat sheet. Plain for e-ink like the WP9 prompt: no transitions, a
   * bordered 48 px Close button, inert backdrop, Esc or `?` closes. The rows come from
   * `readerShortcutGroups` (shortcuts.ts).
   */
  import { createEventDispatcher } from 'svelte';
  import type { ShortcutGroup } from './shortcuts';

  export let groups: ShortcutGroup[];
  export let resolver: () => void;

  const dispatch = createEventDispatcher<{ close: void }>();

  let done = false;

  function close() {
    if (done) return;
    done = true;
    resolver();
    dispatch('close');
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape' || ev.key === '?') {
      ev.preventDefault();
      close();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section
  class="mdc-elevation--z24 flex max-h-[85vh] w-[36rem] max-w-full flex-col rounded bg-white p-6"
  data-testid="shortcuts-dialog"
>
  <h2 class="weight-medium mb-3 text-xl">Shortcuts</h2>
  <div class="min-h-0 overflow-y-auto">
    {#each groups as group (group.title)}
      <h3 class="mt-3 mb-1 font-medium">{group.title}</h3>
      <table class="w-full text-sm">
        <tbody>
          {#each group.rows as row}
            <tr class="border-t border-gray-400" data-testid="shortcut-row">
              <td class="w-2/5 py-2 pr-3 align-top">
                {#each row.keys as key, index}
                  {#if index > 0}<span class="mx-1">or</span>{/if}<kbd
                    class="whitespace-nowrap rounded border border-current px-1 font-sans"
                    >{key}</kbd
                  >
                {/each}
              </td>
              <td class="py-2 align-top">{row.action}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/each}
  </div>
  <footer class="flex justify-end pt-5">
    <button
      class="flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-5 font-medium"
      on:click={close}
    >
      Close
    </button>
  </footer>
</section>
