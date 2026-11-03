import { prepareFiles, sendFiles, receiveFiles } from 'croc-sdk/client';
import { hashFileContents } from 'croc-sdk/hash';
import type { PreparedFile } from 'croc-sdk/types';
import { route } from './croc-socket';
import { startUploadHash } from './croc-hash';
import type { CrocTicket, DownloadSink } from './transfer-types';

export async function prepare(payload: Blob, name: string, signal: AbortSignal): Promise<PreparedFile[]> {
  const file = payload instanceof File ? payload : new File([payload], name);
  try {
    // Croc receives into a fresh directory; Orbit verifies the final digest before import.
    return await prepareFiles([file], {}, signal, async () => new Uint8Array());
  } catch (error) {
    if (signal.aborted) throw error;
    const detail = error instanceof Error || error instanceof DOMException ? error.message || error.name : String(error);
    throw new Error(`Could not prepare file: ${detail}`);
  }
}

export async function transfer(
  pc: RTCPeerConnection, ticket: CrocTicket, signal: AbortSignal,
  progress: (done: number, total: number) => void, prepared?: PreparedFile[], sink?: DownloadSink,
): Promise<Blob> {
  if (!/^[a-f0-9-]{36}$/.test(ticket.id) || !/^[a-f0-9]{64}$/.test(ticket.secret) ||
    !/^[a-f0-9]{64}$/.test(ticket.password) || !/^\d{1,5}$/.test(ticket.port) ||
    !Number.isSafeInteger(ticket.size) || ticket.size < 0) throw new Error('Invalid transfer');
  const dispose = route(ticket.id, pc);
  const settings = {
    gatewayURL: `https://orbit.invalid/croc/${ticket.id}`,
    relayAddresses: [`127.0.0.1:${ticket.port}`], relayPassword: ticket.password, storeAPI: '',
  };
  const options = { secret: ticket.secret, settings, signal };
  const onProgress = (value: { totalBytes: number; totalSize: number }) => progress(value.totalBytes, value.totalSize);
  signal.addEventListener('abort', dispose, { once: true });
  try {
    if (prepared) {
      if (ticket.verify !== true || prepared.length !== 1) throw new Error('Streaming upload unavailable');
      const hash = await startUploadHash(prepared[0].file, signal);
      try {
        await sendFiles({ ...options, files: prepared, callbacks: { onProgress } });
        prepared[0].hash = await hash.finish();
      } finally { await hash.close(); }
      return new Blob();
    }
    if (!sink) throw new Error('Download storage unavailable');
    let result: File | undefined;
    let writes = Promise.resolve();
    await receiveFiles({ ...options, callbacks: {
      onProgress,
      async onOffer(offer) {
        if (offer.kind !== 'files' || offer.files.length !== 1 || offer.emptyFolders.length ||
          offer.files[0].size !== ticket.size) return false;
        await sink.prepare(ticket.size);
        return {
          async createEmptyFolder() { throw new Error('Unexpected folder'); },
          async openFile() {
            return {
              async writeAt(position, bytes) {
                const data = bytes.slice().buffer;
                writes = writes.then(() => sink.writeAt(position, data));
                await writes;
              },
              async finalize() { await writes; result = await sink.finish(); },
              async hash(algorithm = 'xxhash', hashingSignal) {
                if (!result) throw new Error('Incomplete file');
                return hashFileContents(result, algorithm, hashingSignal);
              },
              async abort() { sink.abort(); },
              async commit() {},
            };
          },
        };
      },
    } });
    if (!result) throw new Error('Incomplete file');
    return result;
  } finally {
    signal.removeEventListener('abort', dispose);
    dispose();
  }
}
