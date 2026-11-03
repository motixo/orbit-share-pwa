import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createHash, randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { WebSocket, route } from '../src/croc-socket.ts';

test('Croc channels fail promptly when closed before opening and close normally after opening', () => {
  for (const opened of [false, true]) {
    const channel = Object.assign(new EventTarget(), {
      readyState: 'connecting',
      close() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.dispatchEvent(new Event('close'));
      },
    });
    const dispose = route('transfer', { createDataChannel: () => channel });
    const socket = new WebSocket('https://orbit.invalid/croc/transfer?port=42000');
    const events = [];
    socket.addEventListener('error', () => events.push('error'));
    socket.addEventListener('close', () => events.push('close'));
    if (opened) {
      channel.readyState = 'open';
      channel.dispatchEvent(new Event('open'));
    }
    channel.close();
    assert.deepEqual(events, opened ? ['close'] : ['error', 'close']);
    assert.equal(socket.readyState, WebSocket.CLOSED);
    dispose();
  }
});

test('Croc send queues wake when the channel drains and stop when it closes', async () => {
  const sent = [];
  const channel = Object.assign(new EventTarget(), {
    readyState: 'connecting', bufferedAmount: 2 * 1024 * 1024,
    send(data) { sent.push(data); },
    close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); },
  });
  const dispose = route('drain', { createDataChannel: () => channel });
  const socket = new WebSocket('https://orbit.invalid/croc/drain?port=42000');
  let errors = 0;
  socket.addEventListener('error', () => errors++);
  channel.readyState = 'open';
  channel.dispatchEvent(new Event('open'));
  socket.send(Uint8Array.of(1, 2).buffer);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 0);
  channel.bufferedAmount = 0;
  channel.dispatchEvent(new Event('bufferedamountlow'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...new Uint8Array(sent[0])], [1, 2]);
  channel.bufferedAmount = 2 * 1024 * 1024;
  socket.send(Uint8Array.of(3).buffer);
  await new Promise(resolve => setImmediate(resolve));
  channel.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  dispose();
});

test('streamed upload hashing checks chunk order, completion, and cancellation', async () => {
  const bundled = await build({
    entryPoints: [new URL('../src/croc-hash.ts', import.meta.url).pathname],
    bundle: true, write: false, format: 'cjs', platform: 'node',
    plugins: [{ name: 'engine', setup(bundler) {
      bundler.onResolve({ filter: /^croc-sdk\/engine$/ }, () => ({ path: 'engine', namespace: 'engine' }));
      bundler.onLoad({ filter: /.*/, namespace: 'engine' }, () => ({ contents: 'export const protocolEngine = () => globalThis.engine;' }));
    } }],
  });
  const states = new Map();
  let next = 0;
  let released = 0;
  const engine = {
    async hashInit() { const handle = ++next; states.set(handle, createHash('sha256')); return handle; },
    async hashUpdate(handle, bytes) { states.get(handle).update(bytes); },
    async hashFinal(handle) { const digest = states.get(handle).digest(); states.delete(handle); return digest; },
    async hashRelease(handle) { states.delete(handle); released++; },
  };
  const module = { exports: {} };
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, engine });
  const { startHash, startUploadHash, hashUploadChunk, readUploadChunk } = module.exports;
  const file = new File(['hello'], 'note.txt');
  const signal = new AbortController().signal;
  const hash = await startUploadHash(file, signal);
  await assert.rejects(startUploadHash(file, signal), /already uploading/);
  await hashUploadChunk(file, 0, new TextEncoder().encode('he'));
  await assert.rejects(hashUploadChunk(file, 0, Uint8Array.of(1)), /Invalid transfer chunk/);
  await assert.rejects(hash.finish(), /Incomplete transfer/);
  await hashUploadChunk(file, 2, new TextEncoder().encode('llo'));
  assert.deepEqual(await hash.finish(), createHash('sha256').update('hello').digest());
  await hash.close();
  const cancelled = await startUploadHash(file, signal);
  await cancelled.close();
  assert.equal(states.size, 0);
  assert.equal(released, 1);
  const bytes = new Uint8Array(1024 * 1024 + 33).fill(73);
  const downloaded = await startHash(bytes.length, signal);
  await downloaded.writeAt(0, bytes.subarray(0, 100));
  await downloaded.writeAt(100, bytes.subarray(100));
  assert.deepEqual(await downloaded.finish(), createHash('sha256').update(bytes).digest());
  await downloaded.close();
  assert.equal(states.size, 0);
  const source = new File([bytes], 'large.bin');
  const originalSlice = source.slice.bind(source);
  let reads = 0;
  source.slice = (...args) => { reads++; return originalSlice(...args); };
  const uploading = await startUploadHash(source, signal);
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    const chunk = await readUploadChunk(source, offset, 32768);
    assert.equal(Buffer.from(chunk).equals(Buffer.from(bytes.subarray(offset, offset + 32768))), true);
    await hashUploadChunk(source, offset, chunk);
  }
  assert.equal(reads, 2);
  assert.deepEqual(await uploading.finish(), createHash('sha256').update(bytes).digest());
  await uploading.close();
  await assert.rejects(readUploadChunk(source, 0, 32768), /not active/);
});

test('large media headers do not enable compression for an incompressible body', async () => {
  const built = await build({
    entryPoints: [new URL('../src/croc-compression.ts', import.meta.url).pathname],
    bundle: true, write: false, format: 'cjs', platform: 'node',
    plugins: [{ name: 'engine', setup(bundler) {
      bundler.onResolve({ filter: /^croc-sdk\/engine$/ }, () => ({ path: 'engine', namespace: 'engine' }));
      bundler.onLoad({ filter: /.*/, namespace: 'engine' }, () => ({ contents: 'export const protocolEngine = () => ({ compress: globalThis.compress });' }));
    } }],
  });
  const module = { exports: {} };
  runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, compress: deflateRawSync, DOMException });
  const { shouldCompress } = module.exports;
  assert.equal(await shouldCompress(new File([], 'empty.bin')), false);
  assert.equal(await shouldCompress(new File(['a'.repeat(1024)], 'note.txt')), true);
  const media = new File([new Uint8Array(256 * 1024), randomBytes(9 * 1024 * 1024)], 'video.mov');
  assert.equal(await shouldCompress(media), false);
  assert.equal(await shouldCompress(new File([new Uint8Array(9 * 1024 * 1024)], 'data.bin')), true);
  const signal = AbortSignal.abort();
  await assert.rejects(shouldCompress(media, signal), { name: 'AbortError' });
});
