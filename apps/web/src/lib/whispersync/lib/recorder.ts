// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
// Phase 5: restored full recorder implementation using extendable-media-recorder + @breezystack/lamejs.
// Dynamic imports used for SSR safety — media-encoder-host uses Worker at module load time.

let audioContext: AudioContext | undefined;
let mediaRecorder: any;
let audioChunks: Blob[] = [];
let sourceNode: MediaElementAudioSourceNode | undefined;
let destinationNode: MediaStreamAudioDestinationNode | undefined;
let encoderRegistered = false;

async function ensureEncoderRegistered(): Promise<void> {
	if (encoderRegistered) {
		return;
	}

	const [{ register }, { connect }] = await Promise.all([
		import('extendable-media-recorder'),
		import('extendable-media-recorder-wav-encoder'),
	]);

	await register(await connect());

	encoderRegistered = true;
}

export async function startRecording(audioElement: HTMLAudioElement): Promise<void> {
	await ensureEncoderRegistered();

	const { MediaRecorder: Recorder } = await import('extendable-media-recorder');

	audioContext = new AudioContext({ sampleRate: 44100 });
	destinationNode = audioContext.createMediaStreamDestination();
	sourceNode = audioContext.createMediaElementSource(audioElement);
	sourceNode.connect(destinationNode);
	sourceNode.connect(audioContext.destination);

	audioChunks = [];
	mediaRecorder = new Recorder(destinationNode.stream, { mimeType: 'audio/wav' });

	mediaRecorder.addEventListener('dataavailable', (event: any) => {
		if (event.data && event.data.size > 0) {
			audioChunks.push(event.data);
		}
	});

	mediaRecorder.start();
}

export function stopRecording(kbps: number, canceled = false): Promise<ArrayBuffer | undefined> {
	return new Promise((resolve, reject) => {
		if (!mediaRecorder || mediaRecorder.state === 'inactive') {
			cleanupRecorder();
			resolve(undefined);
			return;
		}

		mediaRecorder.addEventListener('stop', async () => {
			try {
				if (canceled) {
					cleanupRecorder();
					resolve(undefined);
					return;
				}

				const wavBlob = new Blob(audioChunks, { type: 'audio/wav' });
				const wavBuffer = await wavBlob.arrayBuffer();
				const mp3Buffer = await encodeWavToMp3(wavBuffer, kbps);

				cleanupRecorder();
				resolve(mp3Buffer);
			} catch (error: any) {
				cleanupRecorder();
				reject(error);
			}
		});

		mediaRecorder.stop();
	});
}

async function encodeWavToMp3(wavBuffer: ArrayBuffer, kbps: number): Promise<ArrayBuffer> {
	const lamejs = await import('@breezystack/lamejs');
	const tempContext = new AudioContext();
	const audioBuffer = await tempContext.decodeAudioData(wavBuffer);

	await tempContext.close();

	const channels = audioBuffer.numberOfChannels;
	const sampleRate = audioBuffer.sampleRate;
	const encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);

	const left = audioBuffer.getChannelData(0);
	const right = channels > 1 ? audioBuffer.getChannelData(1) : undefined;
	const leftInt = float32ToInt16(left);
	const rightInt = right ? float32ToInt16(right) : undefined;

	const mp3Data: Uint8Array[] = [];
	const blockSize = 1152;

	for (let i = 0; i < leftInt.length; i += blockSize) {
		const leftChunk = leftInt.subarray(i, i + blockSize);
		const rightChunk = rightInt ? rightInt.subarray(i, i + blockSize) : undefined;
		const encoded = rightChunk
			? encoder.encodeBuffer(leftChunk, rightChunk)
			: encoder.encodeBuffer(leftChunk);

		if (encoded.length > 0) {
			mp3Data.push(encoded);
		}
	}

	const flushed = encoder.flush();

	if (flushed.length > 0) {
		mp3Data.push(flushed);
	}

	const totalLength = mp3Data.reduce((acc, chunk) => acc + chunk.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;

	for (const chunk of mp3Data) {
		result.set(chunk, offset);
		offset += chunk.length;
	}

	return result.buffer;
}

function float32ToInt16(float32: Float32Array): Int16Array {
	const int16 = new Int16Array(float32.length);

	for (let i = 0; i < float32.length; i++) {
		const s = Math.max(-1, Math.min(1, float32[i]));
		int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
	}

	return int16;
}

function cleanupRecorder(): void {
	if (sourceNode) {
		try {
			sourceNode.disconnect();
		} catch (_) {
			// no-op
		}
		sourceNode = undefined;
	}

	destinationNode = undefined;

	if (audioContext) {
		try {
			audioContext.close();
		} catch (_) {
			// no-op
		}
		audioContext = undefined;
	}

	mediaRecorder = undefined;
	audioChunks = [];
}
