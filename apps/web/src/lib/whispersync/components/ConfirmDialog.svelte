<script lang="ts">
	// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
	import DialogTemplate from './DialogTemplate.svelte';
	import { settings$ } from '../lib/stores';
	import { createEventDispatcher } from 'svelte';

	export let dialogHeader: string;
	export let dialogMessage: string;
	export let contentStyles: string;
	export let showCancel = true;
	export let isFileReopen = false;
	/** The action button's words ("Reopen files"); ✕, Esc or a click outside cancel. */
	export let confirmLabel = 'Continue';
	export let resolver: (arg0: boolean) => void;

	const { readerEnableFilesystemApi$ } = settings$;

	const dispatch = createEventDispatcher<{
		close: void;
	}>();

	function closeDialog(wasCanceled = false) {
		resolver(wasCanceled);

		dispatch('close');
	}
</script>

<DialogTemplate size="sm" on:close={() => closeDialog(true)}>
	<svelte:fragment slot="header">{dialogHeader}</svelte:fragment>
	<svelte:fragment slot="content">
		<p style={contentStyles}>{dialogMessage}</p>
		{#if isFileReopen}
			<label class="mt-4 flex min-h-[2.75rem] items-center gap-3">
				<input id="fs-state" class="h-5 w-5" type="checkbox" bind:checked={$readerEnableFilesystemApi$} />
				Enable filesystem api
			</label>
		{/if}
	</svelte:fragment>
	<svelte:fragment slot="footer">
		<button type="button" class="c-btn c-btn-primary" on:click={() => closeDialog()}>{confirmLabel}</button>
	</svelte:fragment>
</DialogTemplate>
