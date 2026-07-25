/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

// vendored from ttu-whispersync — MIT License — https://github.com/Renji-XD/ttu-whispersync
// Uses extendable-media-recorder + @breezystack/lamejs. Dynamic imports used for SSR safety —
// media-encoder-host uses Worker at module load time.

let audioContext: AudioContext | undefined;
let mediaRecorder: any;
let audioChunks: Blob[] = [];
let sourceNode: MediaElementAudioSourceNode | undefined;
let sourceElement: HTMLAudioElement | undefined;
let destinationNode: MediaStreamAudioDestinationNode | undefined;
let encoderRegistered = false;

async function ensureEncoderRegistered(): Promise<void> {
  if (encoderRegistered) {
    return;
  }

  const [{ register }, { connect }] = await Promise.all([
    import('extendable-media-recorder'),
    import('extendable-media-recorder-wav-encoder')
  ]);

  await register(await connect());

  encoderRegistered = true;
}

/**
 * createMediaElementSource permanently reroutes the elements output into the graph: from that
 * point on the element is silent unless the graph stays connected to a destination and calling
 * it a second time for the same element throws. The context/source pair is therefore created
 * once per element and kept alive - only the recording branch is torn down after an export.
 */
async function ensureAudioGraph(audioElement: HTMLAudioElement) {
  if (sourceElement !== audioElement || !audioContext || !sourceNode) {
    disposeAudioGraph();

    const context = new AudioContext({ sampleRate: 44100 });
    const source = context.createMediaElementSource(audioElement);

    source.connect(context.destination);

    context.addEventListener('statechange', onContextStateChange);

    audioContext = context;
    sourceNode = source;
    sourceElement = audioElement;
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  return { context: audioContext, source: sourceNode };
}

function onContextStateChange() {
  if (audioContext?.state === 'suspended' && sourceElement && !sourceElement.paused) {
    audioContext.resume().catch(() => {
      // no-op
    });
  }
}

function disposeAudioGraph(): void {
  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (_) {
      // no-op
    }
  }

  if (audioContext) {
    audioContext.removeEventListener('statechange', onContextStateChange);

    try {
      audioContext.close();
    } catch (_) {
      // no-op
    }
  }

  sourceNode = undefined;
  sourceElement = undefined;
  audioContext = undefined;
}

/**
 * Called when the audio element goes away for good - the element is unusable for playback
 * afterwards, so only call this if it is being discarded.
 */
export function releaseRecorderGraph(audioElement?: HTMLAudioElement): void {
  if (audioElement && sourceElement !== audioElement) {
    return;
  }

  cleanupRecorder();
  disposeAudioGraph();
}

export async function startRecording(audioElement: HTMLAudioElement): Promise<void> {
  await ensureEncoderRegistered();

  const { MediaRecorder: Recorder } = await import('extendable-media-recorder');

  const { context, source } = await ensureAudioGraph(audioElement);

  cleanupRecorder();

  try {
    destinationNode = context.createMediaStreamDestination();
    source.connect(destinationNode);

    audioChunks = [];
    mediaRecorder = new Recorder(destinationNode.stream, { mimeType: 'audio/wav' });

    mediaRecorder.addEventListener('dataavailable', (event: any) => {
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    });

    mediaRecorder.start();
  } catch (error) {
    cleanupRecorder();

    throw error;
  }
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

/**
 * Tears down the recording branch only - the source node stays connected to the context
 * destination so the element keeps playing audible output after an export.
 */
function cleanupRecorder(): void {
  if (destinationNode) {
    if (sourceNode) {
      try {
        sourceNode.disconnect(destinationNode);
      } catch (_) {
        // no-op
      }
    }

    for (const track of destinationNode.stream.getTracks()) {
      try {
        track.stop();
      } catch (_) {
        // no-op
      }
    }

    destinationNode = undefined;
  }

  mediaRecorder = undefined;
  audioChunks = [];
}
