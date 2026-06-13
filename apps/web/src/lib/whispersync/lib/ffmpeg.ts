// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
// TODO(phase5): restore full FFMPEG implementation when enabling Anki audio export.
// All functions below are no-ops / stubs until Phase 5.

import type { AudioChapter, Subtitle } from './general';
import { AudioProcessor } from './settings';
import { throwIfAborted, toTimeString } from './util';
import { get } from 'svelte/store';
import { settings$ } from './stores';

// TODO(phase5): import { FFmpeg } from '@ffmpeg/ffmpeg';
// TODO(phase5): import ffmpegWorker from '../../assets/js/ffmpeg.worker?url';

const chapterTimeMatchRegex = /chapter.+start (\d+\.\d+), end/i;
const chapterLabelMatchRegex = /title.+:(.+)/i;

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

// TODO(phase5): restore full FFMPEG load/init
export async function initializeFFMPEG(): Promise<void> {
	settings$.exportAudioProcessor$.set(AudioProcessor.RECORDER);
}

// TODO(phase5): restore full implementation
export async function putAudioFileInFFMPEG(_audioFile: File | undefined): Promise<void> {
	// no-op until phase5
}

// TODO(phase5): restore full implementation
export async function cleanFiles(_cleanInput = false): Promise<void> {
	// no-op until phase5
}

// TODO(phase5): restore full implementation
export async function getChapterData(_audioFile: File): Promise<AudioChapter[]> {
	resetChapterData(true);
	return parsedChapters;
}

// TODO(phase5): restore full implementation
export async function getAudio(
	_audioFile: File,
	subtitles: Subtitle[],
	_executeCleanFiles = true,
	abortSignal: AbortSignal | undefined = undefined,
	_audioFormat = 'mp3',
	_audioBitrate = 128,
	_forExport = false,
): Promise<ArrayBufferLike | undefined> {
	throwIfAborted(abortSignal);
	const enableFFMPEGLog = get(settings$.enableFFMPEGLog$);

	if (enableFFMPEGLog) {
		console.log('FFMPEG stub: getAudio called with', subtitles.length, 'subtitles');
	}

	return undefined;
}

// TODO(phase5): restore full implementation
export function terminateFFMPEG(): void {
	// no-op until phase5
}
