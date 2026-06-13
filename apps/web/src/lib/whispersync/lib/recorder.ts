// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
// TODO(phase5): restore full recorder implementation for Anki audio capture.

// TODO(phase5): import * as lamejs from '@breezystack/lamejs';
// TODO(phase5): import { MediaRecorder as Recorder, register } from 'extendable-media-recorder';
// TODO(phase5): import { connect } from 'extendable-media-recorder-wav-encoder';

// TODO(phase5): restore full implementation
export async function startRecording(_audioElement: HTMLAudioElement): Promise<void> {
	throw new Error('Recorder not available until phase5');
}

// TODO(phase5): restore full implementation
export function stopRecording(_kbps: number, _canceled = false): Promise<ArrayBuffer | undefined> {
	return Promise.resolve(undefined);
}
