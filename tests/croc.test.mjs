import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
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
  const { startUploadHash, hashUploadChunk } = module.exports;
  const file = new File(['hello'], 'note.txt');
  const signal = new AbortController().signal;
  const hash = await startUploadHash(file, signal);
  await assert.rejects(startUploadHash(file, signal), /already uploading/);
  await hashUploadChunk(file, 0, new TextEncoder().encode('he'));
  await assert.rejects(hashUploadChunk(file, 0, Uint8Array.of(1)), /Invalid upload chunk/);
  await assert.rejects(hash.finish(), /Incomplete upload/);
  await hashUploadChunk(file, 2, new TextEncoder().encode('llo'));
  assert.deepEqual(await hash.finish(), createHash('sha256').update('hello').digest());
  await hash.close();
  const cancelled = await startUploadHash(file, signal);
  await cancelled.close();
  assert.equal(states.size, 0);
  assert.equal(released, 1);
});
