// File chunks stay on disk, including on browsers without a save-file picker.
export {};

const downloads = self as unknown as DedicatedWorkerGlobalScope;
let directory: FileSystemDirectoryHandle | undefined;
let entry: FileSystemFileHandle | undefined;
let access: FileSystemSyncAccessHandle | undefined;
let filename = '';
let offset = 0;
let expected: number | null = null;
let queue = Promise.resolve();

async function discard() {
  try { access?.close(); } catch {}
  access = undefined;
  if (directory && filename) await directory.removeEntry(filename).catch(() => {});
}

downloads.addEventListener('message', event => {
  queue = queue.then(async () => {
    switch (event.data.type) {
      case 'open': {
        const root = await navigator.storage.getDirectory();
        directory = await root.getDirectoryHandle('orbit-downloads', { create: true });
        for await (const [name, handle] of directory.entries()) {
          if (handle.kind !== 'file') continue;
          const file = await handle.getFile();
          if (file.lastModified < Date.now() - 86400000) await directory.removeEntry(name).catch(() => {});
        }
        filename = crypto.randomUUID();
        entry = await directory.getFileHandle(filename, { create: true });
        access = await entry.createSyncAccessHandle();
        break;
      }
      case 'prepare': {
        if (!access || !Number.isSafeInteger(event.data.size) || event.data.size < -1) throw new Error('Invalid file size');
        expected = event.data.size < 0 ? null : event.data.size;
        const storage = await navigator.storage.estimate?.().catch(() => undefined);
        if (expected !== null && storage?.quota !== undefined && expected > storage.quota - (storage.usage ?? 0)) {
          throw new Error('Not enough browser storage');
        }
        break;
      }
      case 'write': {
        if (!access || !(event.data.data instanceof ArrayBuffer)) throw new Error('Invalid download');
        const bytes = new Uint8Array(event.data.data);
        const position = event.data.position;
        if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(position + bytes.length) ||
          expected !== null && position + bytes.length > expected) throw new Error('Invalid file position');
        let written = 0;
        while (written < bytes.length) {
          const count = access.write(bytes.subarray(written), { at: position + written });
          if (!count) throw new Error('Not enough browser storage');
          written += count;
        }
        offset = Math.max(offset, position + written);
        if (!Number.isSafeInteger(offset) || expected !== null && offset > expected) throw new Error('Invalid file size');
        break;
      }
      case 'finish': {
        if (!access || !entry || expected !== null && offset !== expected) throw new Error('Incomplete file');
        access.flush();
        access.close();
        access = undefined;
        const file = await entry.getFile();
        downloads.postMessage({ file });
        return;
      }
      case 'abort':
        await discard();
        downloads.close();
        return;
      default: throw new Error('Invalid download');
    }
    downloads.postMessage({});
  }).catch(async error => {
    await discard();
    downloads.postMessage({ error: error instanceof Error ? error.message : 'Could not save download' });
  });
});
