import { protocolEngine } from 'croc-sdk/engine';

export async function startHash(size: number, signal: AbortSignal) {
  const engine = protocolEngine();
  const handle = await engine.hashInit(signal);
  let offset = 0;
  let buffer: Uint8Array | undefined;
  let buffered = 0;
  let pending = Promise.resolve();
  let finalized = false;
  let closed = false;
  const flush = async () => {
    if (!buffer || !buffered) return;
    await pending;
    pending = engine.hashUpdate(handle, buffer.subarray(0, buffered));
    void pending.catch(() => {});
    buffer = undefined;
    buffered = 0;
  };
  return {
    async writeAt(position: number, bytes: Uint8Array) {
      // Browser transfers use one ordered channel, with no resume or missing chunks.
      if (closed || finalized || signal.aborted || position !== offset || !bytes.byteLength || offset + bytes.byteLength > size) {
        throw new Error('Invalid transfer chunk');
      }
      let at = 0;
      while (at < bytes.byteLength) {
        buffer ??= new Uint8Array(1024 * 1024);
        const length = Math.min(bytes.byteLength - at, buffer.length - buffered);
        buffer.set(bytes.subarray(at, at + length), buffered);
        buffered += length;
        at += length;
        if (buffered === buffer.length) await flush();
      }
      offset += bytes.byteLength;
    },
    async finish() {
      if (closed || finalized || signal.aborted || offset !== size) throw new Error('Incomplete transfer');
      await flush();
      await pending;
      const digest = await engine.hashFinal(handle);
      finalized = true;
      return digest;
    },
    async close() {
      if (closed) return;
      closed = true;
      buffer = undefined;
      await pending.catch(() => {});
      if (!finalized) await engine.hashRelease(handle).catch(() => {});
    },
  };
}

const uploads = new WeakMap<Blob, {
  hash: Awaited<ReturnType<typeof startHash>>;
  block?: Uint8Array;
  start: number;
}>();

export async function startUploadHash(file: File, signal: AbortSignal) {
  if (uploads.has(file)) throw new Error('File is already uploading');
  const hash = await startHash(file.size, signal);
  if (uploads.has(file)) {
    await hash.close();
    throw new Error('File is already uploading');
  }
  uploads.set(file, { hash, start: 0 });
  return {
    finish: hash.finish,
    async close() { uploads.delete(file); await hash.close(); },
  };
}

export async function hashUploadChunk(file: Blob, position: number, bytes: Uint8Array) {
  await uploads.get(file)?.hash.writeAt(position, bytes);
}

export async function readUploadChunk(file: Blob, position: number, length: number): Promise<Uint8Array> {
  const upload = uploads.get(file);
  if (!upload) throw new Error('Upload is not active');
  if (!upload.block || position < upload.start || Math.min(file.size, position + length) > upload.start + upload.block.byteLength) {
    upload.block = new Uint8Array(await file.slice(position, position + 1024 * 1024).arrayBuffer());
    upload.start = position;
  }
  return upload.block.subarray(position - upload.start, position - upload.start + length);
}
