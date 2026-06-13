<script lang="ts">
	// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
	// TODO(phase5): restore full implementation (requires wavesurfer.js for waveform visualization)
	// TODO(phase5): import WaveSurfer from 'wavesurfer.js';
	// TODO(phase5): import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js';
	import DialogTemplate from './DialogTemplate.svelte';
	import type { EditSubtitleResult, Subtitle } from '../lib/general';
	import { createEventDispatcher } from 'svelte';

	export let activeSubtitle: Subtitle;
	export let subtitleRegions: Subtitle[];
	export let resolver: (arg0: EditSubtitleResult) => void;

	const dispatch = createEventDispatcher<{ close: void }>();

	function close() {
		resolver({ wasCanceled: true });
		dispatch('close');
	}
</script>

<!-- TODO(phase5): restore full interactive waveform editor -->
<DialogTemplate on:close={close}>
	<svelte:fragment slot="header">Edit Subtitle (Unavailable — Phase 5)</svelte:fragment>
	<div class="p-4 text-center">
		<p>The interactive subtitle editor requires FFMPEG (Phase 5).</p>
		<button class="mt-4" on:click={close}>Close</button>
	</div>
</DialogTemplate>
