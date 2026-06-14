<script lang="ts">
	// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
	// Phase 5: restored interactive subtitle editor with WaveSurfer waveform visualization.
	// Dynamic imports used for SSR safety — wavesurfer.js uses browser APIs at module level.

	import DialogTemplate from './DialogTemplate.svelte';
	import type { EditSubtitleResult, Subtitle } from '../lib/general';
	import { toTimeStamp } from '../lib/util';
	import { currentAudioSourceUrl$ } from '../lib/stores';
	import { createEventDispatcher, onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';

	export let activeSubtitle: Subtitle;
	export let subtitleRegions: Subtitle[];
	export let resolver: (arg0: EditSubtitleResult) => void;

	const dispatch = createEventDispatcher<{ close: void }>();

	let waveformContainer: HTMLElement;
	let waveSurfer: any;
	let regionsPlugin: any;
	let activeRegion: any;
	let editedSubtitle: Subtitle = { ...activeSubtitle };
	let isLoading = true;
	let loadError = '';

	onMount(async () => {
		const audioUrl = get(currentAudioSourceUrl$);

		if (!audioUrl) {
			loadError = 'No audio file loaded';
			isLoading = false;
			return;
		}

		try {
			const [{ default: WaveSurfer }, { default: RegionsPlugin }] = await Promise.all([
				import('wavesurfer.js'),
				import('wavesurfer.js/dist/plugins/regions.esm.js'),
			]);

			regionsPlugin = RegionsPlugin.create();

			waveSurfer = WaveSurfer.create({
				container: waveformContainer,
				waveColor: '#4f4f4f',
				progressColor: '#1a9cbf',
				plugins: [regionsPlugin],
				url: audioUrl,
			});

			waveSurfer.on('ready', () => {
				for (const region of subtitleRegions) {
					if (region.id === activeSubtitle.id || region.id === '-1') {
						continue;
					}

					regionsPlugin.addRegion({
						start: region.startSeconds,
						end: region.endSeconds,
						color: 'rgba(100, 100, 100, 0.3)',
						drag: false,
						resize: false,
					});
				}

				activeRegion = regionsPlugin.addRegion({
					start: activeSubtitle.startSeconds,
					end: activeSubtitle.endSeconds,
					color: 'rgba(26, 156, 191, 0.4)',
					drag: true,
					resize: true,
				});

				const seekSeconds = Math.max(0, activeSubtitle.startSeconds - 1);
				const duration = waveSurfer.getDuration();

				if (duration > 0) {
					waveSurfer.seekTo(seekSeconds / duration);
				}

				isLoading = false;
			});

			waveSurfer.on('error', (err: any) => {
				loadError = `Failed to load audio: ${err?.message ?? String(err)}`;
				isLoading = false;
			});

			regionsPlugin.on('region-updated', (region: any) => {
				if (region === activeRegion) {
					editedSubtitle = {
						...editedSubtitle,
						startSeconds: region.start,
						startTime: toTimeStamp(region.start),
						endSeconds: region.end,
						endTime: toTimeStamp(region.end),
					};
				}
			});
		} catch (err: any) {
			loadError = `Failed to initialize waveform: ${err?.message ?? String(err)}`;
			isLoading = false;
		}
	});

	onDestroy(() => {
		if (waveSurfer) {
			try {
				waveSurfer.destroy();
			} catch (_) {
				// no-op
			}
		}
	});

	function save() {
		resolver({ wasCanceled: false, subtitle: editedSubtitle });
		dispatch('close');
	}

	function close() {
		resolver({ wasCanceled: true });
		dispatch('close');
	}
</script>

<DialogTemplate on:close={close}>
	<svelte:fragment slot="header">Edit Subtitle</svelte:fragment>
	<div class="interactive-edit-dialog">
		{#if loadError}
			<div class="load-error">{loadError}</div>
		{:else if isLoading}
			<div class="load-status">Loading waveform...</div>
		{/if}
		<div bind:this={waveformContainer} class="waveform" />
		<div class="timing-info">
			<span>Start: {editedSubtitle.startTime}</span>
			<span>End: {editedSubtitle.endTime}</span>
		</div>
		<div class="subtitle-text">{activeSubtitle.text}</div>
		<div class="dialog-actions">
			<button on:click={save} disabled={isLoading || !!loadError}>Save</button>
			<button on:click={close}>Cancel</button>
		</div>
	</div>
</DialogTemplate>

<style>
	.interactive-edit-dialog {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		min-width: 480px;
	}

	.waveform {
		width: 100%;
		min-height: 128px;
		background: #111;
		border-radius: 4px;
	}

	.timing-info {
		display: flex;
		gap: 2rem;
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}

	.subtitle-text {
		font-style: italic;
		opacity: 0.75;
		white-space: pre-wrap;
	}

	.dialog-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
	}

	.load-error {
		color: #e05555;
		font-size: 0.875rem;
	}

	.load-status {
		font-size: 0.875rem;
		opacity: 0.7;
	}
</style>
