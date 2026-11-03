import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

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
