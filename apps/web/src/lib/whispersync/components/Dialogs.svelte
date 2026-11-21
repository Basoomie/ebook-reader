<script lang="ts">
	// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
	import type { Dialog } from '../lib/general';
	import { dialogs$, skipKeyListener$ } from '../lib/stores';

	let dialog: Dialog | undefined;
	let zIndex = '';

	$: if ($dialogs$.length && !dialog) {
		nextDialog();
	}

	function closeDialog() {
		$dialogs$ = $dialogs$.slice(0, -1);

		nextDialog();
	}

	function nextDialog() {
		const nextIndex = $dialogs$.length - 1;

		dialog = $dialogs$[nextIndex];
		zIndex = $dialogs$[nextIndex]?.zIndex || '';

		$skipKeyListener$ = !!dialog;
	}
</script>

<!-- 2026-11-21: each dialog draws the app's modal frame itself (DialogTemplate.svelte), with
	its own backdrop, Esc, ✕ and click outside. -->
{#if dialog}
	{#if typeof dialog.component === 'string'}
		<div
			class="ttu-whispersync-dialog writing-horizontal-tb fixed inset-0 w-full h-full"
			style:z-index={zIndex}
			on:wheel|passive|stopPropagation
		>
			<div class="absolute inset-0 tap-highlight-transparent bg-black/[.32]" />
			{@html dialog.component}
		</div>
	{:else}
		<svelte:component this={dialog.component} {...dialog.props} on:close={closeDialog} />
	{/if}
{/if}
