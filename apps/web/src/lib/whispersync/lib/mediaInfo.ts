// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
// Phase 5: restored full MediaInfo implementation (cover art + chapter extraction).

import { type MediaInfo, type MediaInfoType, type ReadChunkFunc } from 'mediainfo.js';
import MediaInfoFactory from 'mediainfo.js';
// ttsu Season 2 Phase 9: the package's own WASM, served with the app's build (and kept by
// its service worker), instead of jsdelivr's copy of the same file: cover and chapters of
// audio downloaded to the device then load offline too.
import MEDIAINFO_WASM_URL from 'mediainfo.js/MediaInfoModule.wasm?url';

const imageMagicNumbers: Map<string, string> = new Map([
	['/9j/', 'image/jpg'],
	['iVBORw0KGgo', 'image/png'],
	['UklGR', 'image/webp'],
	['R0lGODdh', 'image/gif'],
	['R0lGODlh', 'image/gif'],
]);

let mediaInfoInstance: MediaInfo<'object'> | undefined;
let mediaInfoCoverData: boolean | undefined;

function getImageMimeType(base64: string | undefined) {
	if (!base64) {
		return undefined;
	}

	const magicNumberKeys = [...imageMagicNumbers.keys()];
	const imageMagicNumber =
		magicNumberKeys.find((magicNumberKey) => base64.startsWith(magicNumberKey)) || '';

	return imageMagicNumbers.get(imageMagicNumber);
}

export function setMediaInfoInstance(
	coverData: boolean,
	resetInstance: boolean,
	_mediaInfoUrl: string | undefined,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (mediaInfoInstance && (!resetInstance || mediaInfoCoverData === coverData)) {
			return resolve();
		}

		MediaInfoFactory(
			{
				coverData,
				format: 'object',
				locateFile: () => MEDIAINFO_WASM_URL,
			},
			(mediainfo: MediaInfo<'object'>) => {
				if (mediaInfoInstance) {
					try {
						mediaInfoInstance.close();
					} catch (_) {
						// no-op
					}
				}

				mediaInfoInstance = mediainfo;
				mediaInfoCoverData = coverData;

				resolve();
			},
			({ message }: any) => reject(new Error(`Failed to create MediaInfo instance - ${message}`)),
		);
	});
}

export async function getAudioMetadataFromUrl(url: string, coverData: boolean): Promise<MediaInfoType> {
	await setMediaInfoInstance(coverData, false, '');

	const headResponse = await fetch(url, { method: 'HEAD' });
	const fileSize = parseInt(headResponse.headers.get('content-length') ?? '0', 10);

	if (!fileSize) {
		throw new Error('Cannot determine file size for metadata extraction');
	}

	const getSize = () => fileSize;
	const readChunk: ReadChunkFunc = (chunkSize, offset) =>
		fetch(url, {
			headers: { Range: `bytes=${offset}-${Math.min(offset + chunkSize, fileSize) - 1}` },
		})
			.then((r) => r.arrayBuffer())
			.then((buf) => new Uint8Array(buf));

	return new Promise<MediaInfoType>((resolve, reject) => {
		mediaInfoInstance!
			.analyzeData(getSize, readChunk)
			.then(resolve)
			.catch(({ message }: any) =>
				reject(new Error(`Failed to get audio metadata from URL - ${message}`)),
			);
	});
}

export async function getAudioMetadata(
	file: File,
	coverData: boolean,
	mediaInfoUrl = '',
): Promise<MediaInfoType> {
	await setMediaInfoInstance(coverData, false, mediaInfoUrl);

	return new Promise<MediaInfoType>((resolve, reject) => {
		const getSize = () => file.size;
		const readChunk: ReadChunkFunc = (chunkSize, offset) =>
			new Promise((res, rej) => {
				const fileReader = new FileReader();

				fileReader.addEventListener('loadend', (event) => {
					if (!event.target) {
						return rej(new Error('No FileReader data'));
					} else if (event.target.error) {
						return rej(new Error(`Error reading file - ${event.target.error.message}`));
					}

					res(new Uint8Array(event.target.result as ArrayBuffer));
				});

				fileReader.addEventListener('error', () => {
					rej(new Error('Error reading file'));
				});

				fileReader.readAsArrayBuffer(file.slice(offset, offset + chunkSize));
			});

		mediaInfoInstance!
			.analyzeData(getSize, readChunk)
			.then((metadata) => resolve(metadata))
			.catch(({ message }: any) =>
				reject(new Error(`Failed to get audio metadata - ${message}`)),
			);
	});
}

export function getMediaInfoCover(coverData: string | undefined) {
	if (!coverData) {
		return '';
	}

	const coverMimeType = getImageMimeType(coverData);

	return coverMimeType
		? URL.createObjectURL(
				new Blob([Uint8Array.from(atob(coverData), (c) => c.charCodeAt(0))], {
					type: coverMimeType,
				}),
			)
		: '';
}
