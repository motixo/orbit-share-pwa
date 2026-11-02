import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const { invitation, validateInfo, validateItems } = runInNewContext(
  readFileSync(new URL('../dist/protocol.js', import.meta.url), 'utf8') +
    '\n({ invitation, validateInfo, validateItems })',
  { CryptoKey: webcrypto.CryptoKey, URL, atob, Uint8Array, location: { origin: 'https://share.example' } },
);
const address = { host: '192.168.1.2', port: 49152, fingerprint: Array(32).fill('00').join(':') };
const token = 'ab'.repeat(32);

test('QR invitations preserve credentials and reject other origins or public hosts', () => {
  const payload = Buffer.concat([Buffer.from([1, 192, 168, 1, 2, 192, 0]), Buffer.alloc(32), Buffer.from(token, 'hex')]);
  const qr = 'https://share.example/#' + payload.toString('base64url');
  const info = invitation(qr);
  assert.equal(info.host, address.host);
  assert.equal(info.port, address.port);
  assert.equal(info.fingerprint, address.fingerprint);
  assert.equal(info.token, token);
  assert.throws(() => invitation(qr.replace('share.example', 'other.example')));
  for (const invalid of [{ host: '8.8.8.8' }, { port: 0 }, { token: 123 }, { mdns: 'example.com' }]) {
    assert.throws(() => validateInfo({ ...address, token, ...invalid }));
  }
});

test('saved pairings retain their nonextractable key and reject exportable keys', async () => {
  const algorithm = { name: 'HMAC', hash: 'SHA-256' };
  const key = await webcrypto.subtle.generateKey(algorithm, false, ['sign']);
  const device = { ...address, id: 'aabbccdd-1234-4567-8901-123456789abc', name: 'Computer', last: 1, key };
  const info = validateInfo(device);
  assert.equal(info.key, key);
  assert.equal(info.id, device.id);
  const exportable = await webcrypto.subtle.generateKey(algorithm, true, ['sign']);
  assert.throws(() => validateInfo({ ...device, key: exportable }));
});

test('file lists keep ordinary files and unavailable downloads while rejecting malformed entries', () => {
  const files = validateItems([
    { index: 0, name: 'photo.png', size: 2048, text: null },
    { index: 1, name: 'unavailable', size: null },
    { index: 2, name: 'note.txt', size: 5, text: 'hello', source: 'mobile' },
  ]);
  assert.equal(files.length, 3);
  assert.equal(files[1].size, null);
  assert.equal(files[2].text, 'hello');
  assert.equal(files[0].source, 'desktop');
  assert.equal(files[2].source, 'mobile');
  for (const invalid of [null, [{ index: -1, name: 'bad', size: 0 }], [{ index: 0, name: 'bad', size: -1 }],
    [{ index: 0, name: 'bad', size: 0, source: 'other' }]]) {
    assert.throws(() => validateItems(invalid));
  }
});
