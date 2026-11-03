import { protocolEngine } from 'croc-sdk/engine';

interface UploadHash {
  handle: number;
  offset: number;
}

const uploads = new WeakMap<Blob, UploadHash>();

export async function startUploadHash(file: File, signal: AbortSignal) {
  if (uploads.has(file)) throw new Error('File is already uploading');
  const engine = protocolEngine();
  const state: UploadHash = { handle: await engine.hashInit(signal), offset: 0 };
  if (uploads.has(file)) {
    await engine.hashRelease(state.handle);
    throw new Error('File is already uploading');
  }
  uploads.set(file, state);
  let finalized = false;
  return {
    async finish() {
      if (state.offset !== file.size) throw new Error('Incomplete upload');
      const digest = await engine.hashFinal(state.handle);
      finalized = true;
      return digest;
    },
    async close() {
      uploads.delete(file);
      if (!finalized) await engine.hashRelease(state.handle).catch(() => {});
    },
  };
}

export async function hashUploadChunk(file: Blob, position: number, bytes: Uint8Array) {
  const state = uploads.get(file);
  if (!state) return;
  // Orbit uses one ordered Croc data channel and never resumes a private upload.
  if (position !== state.offset || bytes.byteLength === 0 || position + bytes.byteLength > file.size) {
    throw new Error('Invalid upload chunk');
  }
  await protocolEngine().hashUpdate(state.handle, bytes);
  state.offset += bytes.byteLength;
}
