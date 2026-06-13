// Phase 2: NAS audio upload/fetch helpers for the self-hosted storage server.
// MIT-compatible additions to vendored ttu-whispersync code.

import { exporterVersion } from '$lib/functions/replication/replicator';
import { currentDbVersion } from '$lib/data/database/books-db/versions/books-db';

export interface NasServerConfig {
	serverUrl: string;
	authToken: string;
}

export interface NasAudioConfig extends NasServerConfig {
	titleFolder: string;
}

// Prefix shared with the server-side guard on PUT /audio-file.
export const AUDIO_FILE_PREFIX = 'audio_';

// Mirrors BaseStorageHandler.sanitizeForFilename (protected static — cannot import externally).
export function sanitizeTitleForNas(title: string): string {
	return title
		.replace(/ $/, '~ttu-spc~')
		.replace(/\.$/, '~ttu-dend~')
		.replace(/\*/g, '~ttu-star~')
		.replace(/[/?<>\\:*|%"]/g, (match) => encodeURIComponent(match));
}

// Stable audio filename within the book's NAS folder.
// Uses the version constants so the naming convention mirrors other reader files.
export function getAudioFileName(originalName: string): string {
	const ext = originalName.split('.').pop()?.toLowerCase() || 'bin';
	return `${AUDIO_FILE_PREFIX}${exporterVersion}_${currentDbVersion}.${ext}`;
}

export function buildAudioNasUrl(config: NasAudioConfig, filename: string): string {
	const filePath = `${config.titleFolder}/${filename}`;
	return `${config.serverUrl}/file?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(config.authToken)}`;
}

// Returns the filename of an existing audio file in the NAS folder, or undefined.
export async function findNasAudio(config: NasAudioConfig): Promise<string | undefined> {
	const url = `${config.serverUrl}/list?path=${encodeURIComponent(config.titleFolder)}`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${config.authToken}` } });
	if (!res.ok) return undefined;
	const entries: { name: string; isDirectory: boolean }[] = await res.json();
	return entries.find((e) => !e.isDirectory && e.name.startsWith(AUDIO_FILE_PREFIX))?.name;
}

// Stream-uploads a File to the NAS /audio-file endpoint using XHR so upload
// progress is available. The File body is sent directly — no ArrayBuffer read.
export function uploadAudioToNas(
	config: NasAudioConfig,
	file: File,
	onProgress?: (loaded: number, total: number) => void,
): Promise<string> {
	const filename = getAudioFileName(file.name);
	const filePath = `${config.titleFolder}/${filename}`;
	const url = `${config.serverUrl}/audio-file?path=${encodeURIComponent(filePath)}`;

	return new Promise<string>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', url, true);
		xhr.setRequestHeader('Authorization', `Bearer ${config.authToken}`);
		xhr.setRequestHeader('Content-Type', 'application/octet-stream');

		if (onProgress) {
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) onProgress(e.loaded, e.total);
			};
		}

		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve(filename);
			} else {
				reject(new Error(`Audio upload failed: HTTP ${xhr.status}`));
			}
		};

		xhr.onerror = () => reject(new Error('Audio upload network error'));
		xhr.onabort = () => reject(new Error('Audio upload aborted'));

		xhr.send(file);
	});
}
