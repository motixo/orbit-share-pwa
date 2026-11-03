import { protocolEngine } from 'croc-sdk/engine';

export async function shouldCompress(file: Blob, signal?: AbortSignal): Promise<boolean> {
  if (!file.size) return false;
  // A media header can compress well while the rest of the file does not.
  const windows = file.size > 8 * 1024 * 1024 ? 5 : 1;
  const length = Math.min(file.size, Math.floor(256 * 1024 / windows));
  const ratio = windows === 1 ? 0.98 : 0.95;
  let compressible = 0;
  for (let index = 0; index < windows; index++) {
    if (signal?.aborted) throw new DOMException('Transfer cancelled', 'AbortError');
    const position = windows === 1 ? 0 : Math.floor((file.size - length) * index / (windows - 1));
    const bytes = new Uint8Array(await file.slice(position, position + length).arrayBuffer());
    const compressed = await protocolEngine().compress(bytes);
    if (compressed.byteLength < bytes.byteLength * ratio) compressible++;
  }
  return compressible > windows / 2;
}
