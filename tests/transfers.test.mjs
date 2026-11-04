import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('completed ticket requests let the server close the response channel', async () => {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function requestControl(');
  const end = source.indexOf('\nasync function busy(', begin);
  let released = 0;
  const dc = Object.assign(new EventTarget(), {
    readyState: 'open', sent: [],
    send(value) { this.sent.push(value); },
    close() {
      this.readyState = 'closed';
      this.dispatchEvent(new Event('close'));
    },
  });
  const { requestControl } = runInNewContext(source.slice(begin, end) + '\n({ requestControl })', {
    session: { ready: true, pc: { createDataChannel: () => dc } },
    requestSlot: async () => () => { released++; },
    Blob, ArrayBuffer, AbortController, setTimeout, clearTimeout,
    isRecord: value => value !== null && typeof value === 'object',
  });
  const pending = requestControl('croc-upload', { name: 'photo.jpg', size: 42 });
  await Promise.resolve();
  dc.dispatchEvent(new Event('open'));
  for (const data of [
    JSON.stringify({ type: 'response', status: 200, size: 2 }),
    new TextEncoder().encode('{}').buffer,
    JSON.stringify({ type: 'end' }),
  ]) dc.dispatchEvent(new MessageEvent('message', { data }));
  assert.equal(await (await pending).text(), '{}');
  assert.equal(dc.readyState, 'open');
  assert.equal(released, 0);
  dc.close();
  assert.equal(released, 1);
});

test('uploads and dropped text preserve payloads and accept large files while rejecting oversized or empty text', async () => {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function uploadFiles(');
  const end = source.indexOf("\ndocument.querySelector('#files')", begin);
  assert.ok(begin > 0 && end > begin);
  const requests = [];
  let refreshes = 0;
  const { uploadFiles, sendText } = runInNewContext(source.slice(begin, end) + '\n({ uploadFiles, sendText })', {
    Blob, session: {}, progress: () => () => {},
    async request(action, fields, payload) { requests.push({ action, fields, payload }); },
    async refreshItems() { refreshes++; },
  });
  const file = Object.assign(new Blob(['file']), { name: 'note.txt' });
  await uploadFiles([file]);
  await sendText('first\nsecond');
  assert.equal(requests[0].action, 'upload');
  assert.equal(requests[0].fields.name, file.name);
  assert.equal(requests[0].payload, file);
  assert.equal(requests[1].action, 'text');
  assert.equal(await requests[1].payload.text(), 'first\nsecond');
  assert.equal(refreshes, 2);
  const large = { name: 'large', size: 4 * 1024 ** 3 };
  await uploadFiles([large]);
  assert.equal(requests[2].payload, large);
  await assert.rejects(sendText(' \n '), /Enter text/);
  await assert.rejects(sendText('x'.repeat(1024 * 1024 + 1)), /1 MiB/);
  assert.equal(requests.length, 3);
});
