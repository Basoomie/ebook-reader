<script lang="ts">
  /**
   * WP10a: the `?` cheat sheet, one section per group. `?`, ✕, Esc or a click outside
   * close it (modal.svelte). The rows come from `readerShortcutGroups` (shortcuts.ts).
   */
  import { createEventDispatcher } from 'svelte';
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';
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
    if (ev.key === '?') {
      ev.preventDefault();
      close();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<Modal title="Keyboard shortcuts" size="md" testid="shortcuts-dialog" on:close={close}>
  {#each groups as group (group.title)}
    <ModalSection title={group.title}>
      <table class="w-full text-sm">
        <tbody>
          {#each group.rows as row}
            <tr class="border-t border-c-line first:border-t-0" data-testid="shortcut-row">
              <td class="w-2/5 py-2 pr-3 align-top">
                {#each row.keys as key, index}
                  {#if index > 0}<span class="mx-1 text-c-muted">or</span>{/if}<kbd
                    class="whitespace-nowrap rounded border border-c-strong px-1.5 py-0.5 font-sans"
                    >{key}</kbd
                  >
                {/each}
              </td>
              <td class="py-2 align-top">{row.action}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </ModalSection>
  {/each}
</Modal>
