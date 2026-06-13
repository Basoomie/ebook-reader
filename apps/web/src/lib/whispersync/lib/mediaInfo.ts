// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
// TODO(phase5): restore full MediaInfo implementation for cover art and chapter extraction.

// TODO(phase5): import { type MediaInfo, type MediaInfoType, type ReadChunkFunc } from 'mediainfo.js';
// TODO(phase5): import MediaInfoFactory from 'mediainfo.js';

// Minimal type stubs so callers compile without the mediainfo.js package
// TODO(phase5): remove stubs and restore real imports
type MediaInfoType = any;

const imageMagicNumbers: Map<string, string> = new Map([
	['/9j/', 'image/jpg'],
	['iVBORw0KGgo', 'image/png'],
	['UklGR', 'image/webp'],
	['R0lGODdh', 'image/gif'],
	['R0lGODlh', 'image/gif'],
]);

function getImageMimeType(base64: string | undefined) {
	if (!base64) {
		return undefined;
	}

	const magicNumberKeys = [...imageMagicNumbers.keys()];
	const imageMagicNumber = magicNumberKeys.find((magicNumberKey) => base64.startsWith(magicNumberKey)) || '';

	return imageMagicNumbers.get(imageMagicNumber);
}

// TODO(phase5): restore full implementation
export async function setMediaInfoInstance(
	_coverData: boolean,
	_resetInstance: boolean,
	_mediaInfoUrl: string | undefined,
): Promise<void> {
	// no-op until phase5
}

// TODO(phase5): restore full implementation
export async function getAudioMetadata(_file: File, _coverData: boolean, _mediaInfoUrl = ''): Promise<MediaInfoType> {
	throw new Error('MediaInfo not available until phase5');
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
