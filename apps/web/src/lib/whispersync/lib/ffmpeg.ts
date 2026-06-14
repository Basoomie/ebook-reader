// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
// Phase 5: restored full FFMPEG implementation. Simplified for native browser mount —
// Chrome extension / Tampermonkey / Violentmonkey context-switching removed.
// FFMPEG core loaded from jsDelivr CDN; classWorker from the installed @ffmpeg/ffmpeg package.

import type { AudioChapter, Subtitle } from './general';
import { AudioFormat, AudioProcessor } from './settings';
import { throwIfAborted, toTimeString } from './util';

import type { FFmpeg as FFmpegType } from '@ffmpeg/ffmpeg';
import { get } from 'svelte/store';
import { settings$ } from './stores';

// Vite resolves this ?url import at build time to the asset URL for the FFmpeg worker JS.
// This avoids a relative './worker.js' URL that would break when the reader is at a sub-path.
import classWorkerURL from '@ffmpeg/ffmpeg/worker?url';

const FFMPEG_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';

const libMap = new Map<string, string>([
	['ogg', 'libvorbis'],
	['opus', 'opus'],
	['mp3', 'libmp3lame'],
]);
const chapterTimeMatchRegex = /chapter.+start (\d+\.\d+), end/i;
const chapterLabelMatchRegex = /title.+:(.+)/i;

// Module-level singleton. Initialized lazily in initializeFFMPEG() via dynamic import so the
// @ffmpeg/ffmpeg constructor never executes during SvelteKit's Node.js SSR build pass.
let ffmpegInstance: FFmpegType | undefined;

let lastParsedChapter: AudioChapter = { key: '', label: '', startSeconds: 0, startText: '' };
let parsedChapters: AudioChapter[] = [];
let waitForChapter = true;

function handleFFMPEGLogForChapterData(event: { type: string; message: string }) {
	try {
		if (waitForChapter) {
			const chapterTimeMatch = event.message.match(chapterTimeMatchRegex);

			if (chapterTimeMatch?.length === 2) {
				const startSeconds = Number.parseFloat(chapterTimeMatch[1]);

				lastParsedChapter.startSeconds = startSeconds;

				waitForChapter = false;
			}
		} else if (!waitForChapter) {
			const chapterLabelMatch = event.message.match(chapterLabelMatchRegex);

			if (chapterLabelMatch?.length === 2) {
				const label = chapterLabelMatch[1].trim();
				const { startSeconds } = lastParsedChapter;

				lastParsedChapter = {
					key: `${label}_${startSeconds}`,
					label,
					startSeconds,
					startText: toTimeString(startSeconds),
				};

				parsedChapters.push(lastParsedChapter);

				resetChapterData();
			}
		}
	} catch (_) {
		resetChapterData();
	}
}

function resetChapterData(resetParsedChapters = false) {
	lastParsedChapter = { key: '', label: '', startSeconds: 0, startText: '' };
	waitForChapter = true;

	if (resetParsedChapters) {
		parsedChapters = [];
	}
}

function handleFFMPEGLog(event: { type: string; message: string }) {
	console.log(event.type, event.message);
}

export async function initializeFFMPEG(): Promise<void> {
	if (ffmpegInstance?.loaded) {
		return;
	}

	try {
		// Dynamic import: @ffmpeg/ffmpeg exports an empty stub in Node.js (SSR), so we
		// must NOT import it statically at module level.
		const { FFmpeg } = await import('@ffmpeg/ffmpeg');
		const { toBlobURL } = await import('@ffmpeg/util');

		if (!ffmpegInstance) {
			ffmpegInstance = new FFmpeg();
		}

		await ffmpegInstance.load({
			coreURL: await toBlobURL(`${FFMPEG_CDN_BASE}/ffmpeg-core.js`, 'text/javascript'),
			wasmURL: await toBlobURL(`${FFMPEG_CDN_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
			classWorkerURL: await toBlobURL(classWorkerURL, 'text/javascript'),
		});
	} catch (error: any) {
		settings$.exportAudioProcessor$.set(AudioProcessor.RECORDER);

		const message = typeof error === 'string' ? error : (error?.message ?? 'Unknown error');

		throw new Error(`Error loading FFMPEG - ${message}`);
	}
}

export async function putAudioFileInFFMPEG(audioFile: File | undefined): Promise<void> {
	if (!ffmpegInstance?.loaded) {
		return;
	}

	try {
		await cleanFiles(true);

		if (audioFile) {
			const fileExtension = audioFile.name.split('.').pop();
			const buffer = await audioFile.arrayBuffer();

			await ffmpegInstance.writeFile(`audio_input.${fileExtension}`, new Uint8Array(buffer));
		}
	} catch ({ message }: any) {
		throw new Error(`Failed to update files in FFMPEG - ${message}`);
	}
}

export async function cleanFiles(cleanInput = false): Promise<void> {
	if (!ffmpegInstance?.loaded) {
		return;
	}

	const entries = await ffmpegInstance.listDir('/');
	const audioFiles = entries.filter(
		(entry) =>
			!entry.isDir &&
			((cleanInput && entry.name.startsWith('audio_input')) ||
				entry.name.startsWith('audio_output')),
	);

	await Promise.allSettled(audioFiles.map((audioFile) => ffmpegInstance!.deleteFile(audioFile.name)));
}

export async function getChapterData(audioFile: File): Promise<AudioChapter[]> {
	resetChapterData(true);

	if (!ffmpegInstance?.loaded) {
		return parsedChapters;
	}

	try {
		const fileExtension = audioFile.name.split('.').pop();
		const ffmpegArguments = ['-hide_banner', '-y', '-i', `audio_input.${fileExtension}`];

		ffmpegInstance.on('log', handleFFMPEGLogForChapterData);

		await ffmpegInstance.exec(ffmpegArguments);
	} catch ({ message }: any) {
		console.log(`Failed to get chapter data with ffmpeg: ${message}`);
	}

	ffmpegInstance.off('log', handleFFMPEGLogForChapterData);

	return parsedChapters;
}

export async function getAudio(
	audioFile: File,
	subtitles: Subtitle[],
	executeCleanFiles = true,
	abortSignal: AbortSignal | undefined = undefined,
	audioFormat = 'mp3',
	audioBitrate = 128,
	forExport = false,
): Promise<ArrayBufferLike | undefined> {
	if (!ffmpegInstance?.loaded) {
		return undefined;
	}

	const fileExtension = audioFile.name.split('.').pop();
	const enableFFMPEGLog = get(settings$.enableFFMPEGLog$);
	const finalOutput =
		subtitles.length === 1 ? `audio_output_0.${audioFormat}` : `audio_output.${audioFormat}`;

	let failure = '';
	let filterInput = '';
	const mergeInputs: string[] = [];
	let buffer: ArrayBufferLike | undefined;

	try {
		if (enableFFMPEGLog) {
			ffmpegInstance.on('log', handleFFMPEGLog);
		}

		for (let index = 0, { length } = subtitles; index < length; index += 1) {
			throwIfAborted(abortSignal);

			const subtitle = subtitles[index];
			const output = `audio_output_${index}.${audioFormat}`;
			const ffmpegArguments = [
				'-hide_banner',
				'-y',
				'-ss',
				`${subtitle.startSeconds}`,
				'-i',
				`audio_input.${fileExtension}`,
				'-t',
				`${subtitle.endSeconds - subtitle.startSeconds}`,
				...(audioFormat === AudioFormat.OPUS ? ['-strict', '-2'] : []),
				'-vn',
				'-acodec',
				libMap.get(audioFormat) || 'libmp3lame',
				...(forExport ? ['-b:a', `${audioBitrate}k`] : []),
				'-write_xing',
				'0',
				output,
			];

			if (enableFFMPEGLog) {
				console.log(ffmpegArguments);
			}

			mergeInputs.push('-i', output);

			filterInput += `[${index}:a]`;

			await ffmpegInstance.exec(ffmpegArguments);
		}

		if (subtitles.length > 1) {
			mergeInputs.push('-filter_complex');

			filterInput = `${filterInput}concat=n=${subtitles.length}:v=0:a=1`;

			const ffmpegArguments = [
				'-hide_banner',
				'-y',
				...mergeInputs,
				filterInput,
				...(audioFormat === AudioFormat.OPUS ? ['-strict', '-2'] : []),
				'-vn',
				'-acodec',
				libMap.get(audioFormat) || 'libmp3lame',
				...(forExport ? ['-b:a', `${audioBitrate}k`] : []),
				'-write_xing',
				'0',
				finalOutput,
			];

			if (enableFFMPEGLog) {
				console.log(ffmpegArguments);
			}

			await ffmpegInstance.exec(ffmpegArguments);
		}

		const data = (await ffmpegInstance.readFile(finalOutput)) as Uint8Array;

		buffer = data.buffer;
	} catch (error: any) {
		if (!(abortSignal && abortSignal.aborted) && error.name !== 'AbortError') {
			failure =
				typeof error === 'string'
					? `Audio creation failed - ${error}`
					: `Audio creation failed${error.message ? ` - ${error.message}` : ''}`;
		}
	}

	if (executeCleanFiles) {
		await cleanFiles();
	}

	if (enableFFMPEGLog) {
		ffmpegInstance.off('log', handleFFMPEGLog);
	}

	if (failure) {
		throw new Error(failure);
	}

	throwIfAborted(abortSignal);

	return buffer;
}

export function terminateFFMPEG(): void {
	if (ffmpegInstance?.loaded) {
		ffmpegInstance.terminate();
		ffmpegInstance = undefined;
	}
}
