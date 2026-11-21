<script lang="ts">
	// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
	// 2026-11-21: the frame is the app's modal (lib/components/modal/modal.svelte) in the reader
	// theme's colours: ✕, Esc and a click outside dispatch `close`, which each dialog maps to
	// its own Cancel. The footer shows only the dialog's action (Save, Reopen files).
	import Modal from '$lib/components/modal/modal.svelte';
	import { createEventDispatcher } from 'svelte';

	export let size: 'sm' | 'md' | 'lg' | 'xl' = 'md';
	/** Unsaved changes: a close request asks before discarding them. */
	export let dirty = false;

	const dispatch = createEventDispatcher<{ close: void }>();
</script>

{#if $$slots.footer}
	<Modal {size} {dirty} surface="inherit" zIndex={70} on:close={() => dispatch('close')}>
		<svelte:fragment slot="title"><slot name="header" /></svelte:fragment>
		<div class="slot-content pt-3">
			<slot name="content" />
			<slot />
		</div>
		<svelte:fragment slot="footer"><slot name="footer" /></svelte:fragment>
	</Modal>
{:else}
	<Modal {size} {dirty} surface="inherit" zIndex={70} on:close={() => dispatch('close')}>
		<svelte:fragment slot="title"><slot name="header" /></svelte:fragment>
		<div class="slot-content pt-3">
			<slot name="content" />
			<slot />
		</div>
	</Modal>
{/if}
