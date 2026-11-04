import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

function crocRequest(transfer, clock = performance) {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function request(');
  const end = source.indexOf('async function requestControl(', begin);
  const commands = [];
  const ticket = { id: 'transfer' };
  const current = { ready: true, pc: {}, control: Object.assign(new EventTarget(), { readyState: 'open', send() {} }) };
  const prepared = [{ hash: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) }];
  const { request } = runInNewContext(source.slice(begin, end) + '\n({ request })', {
    session: current, AbortController, performance: clock, statusElement: {},
    OrbitCroc: { async prepare() { return prepared; }, transfer },
    async requestControl(action, fields) {
      commands.push({ action, fields });
      return new Blob([JSON.stringify(ticket)]);
    },
  });
  return { request, commands, current, prepared };
}

test('file downloads use Croc without capability negotiation and wait for disk completion', async () => {
  let complete;
  const stored = new Blob(['file']);
  const sink = { async prepare() {}, async writeAt() {}, finish() { return new Promise(resolve => { complete = () => resolve(stored); }); }, abort() { assert.fail('completed download aborted'); } };
  const { request, commands, current } = crocRequest(async (pc, ticket, signal, progress, prepared, target) => {
    assert.equal(pc, current.pc);
    assert.equal(ticket.id, 'transfer');
    assert.equal(prepared, undefined);
    assert.equal(target, sink);
    await target.prepare(4);
    await target.writeAt(0, new ArrayBuffer(4));
    return target.finish();
  });
  const pending = request('file', { index: 1 }, undefined, undefined, sink);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commands.map(command => command.action), ['croc-file']);
  complete();
  assert.equal(await pending, stored);
  assert.deepEqual(commands.map(command => command.action), ['croc-file', 'croc-result']);
});

test('Croc uploads submit their checksum and cancel failures without falling back', async () => {
  for (const fail of [false, true]) {
    let aborted;
    const { request, commands, prepared } = crocRequest(async (pc, ticket, signal, progress, files) => {
      assert.equal(files, prepared);
      aborted = signal;
      if (fail) throw new Error('Transfer interrupted');
      return new Blob();
    });
    const pending = request('upload', { name: 'note.txt' }, new Blob(['file']));
    if (fail) await assert.rejects(pending, /Transfer interrupted/);
    else await pending;
    assert.deepEqual(commands.map(command => command.action), ['croc-upload', fail ? 'croc-cancel' : 'croc-result']);
    if (!fail) assert.equal(commands[1].fields.checksum, '0102030405060708');
    assert.equal(aborted.aborted, true);
  }
});

test('transfer progress updates are throttled without skipping completion', async () => {
  let time = 0;
  const updates = [];
  const { request } = crocRequest(async (pc, ticket, signal, report) => {
    for (const [done, now] of [[1, 0], [2, 100], [3, 250], [4, 300], [5, 500], [6, 501]]) {
      time = now;
      report(done, 6);
    }
    return new Blob();
  }, { now: () => time });
  await request('file', {}, undefined, (done, total) => updates.push([done, total]));
  assert.deepEqual(updates, [[3, 6], [5, 6], [6, 6]]);
});

test('disk downloads tolerate missing estimates and clean up partial files', async () => {
  for (const estimate of [
    async () => ({ quota: 8, usage: 0 }),
    undefined,
    async () => { throw new Error('Estimates unavailable'); },
  ]) {
    const source = readFileSync(new URL('../dist/download-worker.js', import.meta.url), 'utf8').replace('export {};', '');
    const replies = [];
    const stored = [];
    let message, removed, closed = false;
    const access = {
      write(bytes, { at }) { assert.equal(at, stored.length); stored.push(bytes[0]); return 1; },
      flush() {}, close() { closed = true; },
    };
    const entry = { async createSyncAccessHandle() { return access; } };
    const directory = {
      async *entries() {}, async getFileHandle() { return entry; },
      async removeEntry(name) { removed = name; },
    };
    runInNewContext(source, {
      self: { addEventListener(name, handler) { message = handler; }, postMessage(value) { replies.push(value); }, close() {} },
      navigator: { storage: { estimate, async getDirectory() { return { async getDirectoryHandle() { return directory; } }; } } },
      crypto: { randomUUID: () => 'download' }, ArrayBuffer, Uint8Array,
    });
    const send = async data => { message({ data }); await new Promise(resolve => setImmediate(resolve)); };
    await send({ type: 'open' });
    await send({ type: 'prepare', size: 3 });
    await send({ type: 'write', position: 0, data: Uint8Array.of(1, 2, 3).buffer });
    assert.deepEqual(stored, [1, 2, 3]);
    assert.equal(replies.length, 3);
    await send({ type: 'abort' });
    assert.equal(removed, 'download');
    assert.equal(closed, true);
  }
});

test('finalized downloads can still be aborted before they are saved', async () => {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function downloadSink(');
  const end = source.indexOf('\nfunction pumpRequests(', begin);
  const file = new File(['file'], 'download');
  let writer;
  class Worker {
    commands = [];
    constructor() { writer = this; }
    postMessage(message) {
      this.commands.push(message.type);
      if (message.type !== 'abort') queueMicrotask(() => this.onmessage({ data: message.type === 'finish' ? { file } : {} }));
    }
    terminate() { this.terminated = true; }
  }
  const { downloadSink } = runInNewContext(source.slice(begin, end) + '\n({ downloadSink })', {
    Worker, setTimeout, clearTimeout,
  });
  const sink = await downloadSink();
  assert.equal(await sink.finish(), file);
  assert.equal(writer.terminated, undefined);
  sink.abort();
  assert.deepEqual(writer.commands, ['open', 'finish', 'abort']);
});

test('download writes batch small chunks and flush tails and nonsequential positions before finalizing', async () => {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function downloadSink(');
  const end = source.indexOf('\nfunction pumpRequests(', begin);
  const writes = [];
  const file = new File([], 'download');
  const batch = 1024 * 1024;
  let lastWrite;
  let finalized = false;
  class Worker {
    postMessage(message) {
      if (message.type === 'write') writes.push({ position: message.position, bytes: new Uint8Array(message.data).slice() });
      if (message.type === 'write' && message.data.byteLength === 1) {
        lastWrite = () => this.onmessage({ data: {} });
        return;
      }
      if (message.type === 'finish') {
        finalized = true;
        assert.deepEqual(writes.map(write => [write.position, write.bytes.length]), [[0, batch], [batch, 3], [0, 1]]);
      }
      queueMicrotask(() => this.onmessage({ data: message.type === 'finish' ? { file } : {} }));
    }
    terminate() {}
  }
  const { downloadSink } = runInNewContext(source.slice(begin, end) + '\n({ downloadSink })', {
    Worker, setTimeout, clearTimeout,
  });
  const sink = await downloadSink();
  for (let index = 0; index < 32; index++) {
    await sink.writeAt(index * 32768, new Uint8Array(32768).fill(index).buffer);
    assert.equal(writes.length, index === 31 ? 1 : 0);
  }
  await sink.writeAt(batch, Uint8Array.of(1, 2, 3).buffer);
  await sink.writeAt(0, Uint8Array.of(9).buffer);
  const finishing = sink.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof lastWrite, 'function');
  assert.equal(finalized, false);
  lastWrite();
  assert.equal(await finishing, file);
  assert.deepEqual(Array.from(writes[1].bytes), [1, 2, 3]);
  assert.equal(writes[0].bytes[batch - 1], 31);
});

test('saved files keep their media names and bytes without a service-worker download request', async () => {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function downloadSink(');
  const end = source.indexOf('\nfunction pumpRequests(', begin);
  for (const [name, type] of [
    ['IMG_0228.mov', 'video/quicktime'],
    ['Screenshot.PNG', 'image/png'],
    ['عکس.png', 'image/png'],
    ['unknown.bin', 'application/octet-stream'],
  ]) {
    const stored = new File(['content'], '12345678-1234-4123-8123-123456789abc');
    let saved, clicked = false;
    const link = { click() { clicked = true; }, remove() {} };
    class Worker {
      postMessage(message) { queueMicrotask(() => this.onmessage({ data: message.type === 'finish' ? { file: stored } : {} })); }
      terminate() {}
    }
    const { downloadSink } = runInNewContext(source.slice(begin, end) + '\n({ downloadSink })', {
      Worker, File, setTimeout, clearTimeout, performance, downloadNavigationUntil: 0,
      URL: { createObjectURL(file) { saved = file; return 'blob:received-file'; } },
      document: { createElement() { return link; }, body: { append() {} } },
    });
    const sink = await downloadSink();
    await sink.finish();
    sink.save(name);
    assert.equal(clicked, true);
    assert.equal(link.href, 'blob:received-file');
    assert.equal(link.download, name);
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener');
    assert.equal(saved.name, name);
    assert.equal(saved.type, type);
    assert.equal(await saved.text(), 'content');
  }
});


test('request slots reserve room for transfers, prioritize them, and reject stale queues', async () => {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('function pumpRequests(');
  const end = source.indexOf('\nasync function request(', begin);
  const current = { ready: true };
  const { requestSlot, pumpRequests } = runInNewContext(source.slice(begin, end) + '\n({ requestSlot, pumpRequests })', { session: current });
  const first = await requestSlot(current, 'thumbnail');
  let second, transfer;
  const waitingThumbnail = requestSlot(current, 'thumbnail').then(release => { second = release; });
  const file = await requestSlot(current, 'croc-file');
  const upload = await requestSlot(current, 'croc-upload');
  const waitingFile = requestSlot(current, 'croc-file').then(release => { transfer = release; });
  assert.equal(current.requests.active, 3);
  file();
  await waitingFile;
  assert.equal(typeof transfer, 'function');
  assert.equal(second, undefined);
  first();
  await waitingThumbnail;
  assert.equal(typeof second, 'function');
  const stale = requestSlot(current, 'list');
  current.ready = false;
  pumpRequests(current);
  await assert.rejects(stale, /Disconnected/);
  second(); transfer(); upload();
  assert.equal(current.requests.active, 0);
});
