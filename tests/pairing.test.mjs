import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

function element(hidden = false) {
  return {
    hidden, disabled: false, value: '', attributes: new Map(), events: new Map(),
    addEventListener(name, callback) { this.events.set(name, callback); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
    focus() { this.focused = true; },
  };
}

test('manual pairing replaces scanning and validates pasted links without requesting a camera', async () => {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('const connectionForm =');
  const end = source.indexOf("\ndocument.querySelector('#files')", begin);
  assert.ok(begin > 0 && end > begin);
  const form = element(true);
  const input = element();
  const toggle = element();
  const help = element();
  const scan = element();
  const status = { textContent: '' };
  const elements = { 'pair-link': form, 'connection-link': input, 'use-link': toggle, 'pair-help': help };
  const connections = [];
  let stopped = 0;
  runInNewContext(readFileSync(new URL('../dist/protocol.js', import.meta.url), 'utf8') + '\n' + source.slice(begin, end), {
    URL, atob, Uint8Array, location: { origin: 'https://share.example' },
    document: { querySelector: selector => elements[selector.slice(1)], getElementById: id => elements[id] },
    scanButton: scan, statusElement: status, session: undefined,
    stopCamera() { stopped++; }, resumeConnection() {},
    async connect(info) { connections.push(info); },
    errorMessage: error => error.message,
  });
  toggle.events.get('click')();
  assert.equal(scan.hidden, true);
  assert.equal(form.hidden, false);
  assert.equal(help.hidden, true);
  assert.equal(input.focused, true);
  assert.equal(toggle.attributes.get('aria-expanded'), 'true');
  assert.equal(stopped, 1);

  const address = { host: '192.168.1.2', port: 49152, fingerprint: Array(32).fill('00').join(':'), token: 'ab'.repeat(32) };
  const link = 'https://share.example/#' + Buffer.from(JSON.stringify(address)).toString('base64url');
  const submit = () => form.events.get('submit')({ preventDefault() {} });
  input.value = link.replace('share.example', 'other.example');
  await submit();
  assert.equal(connections.length, 0);
  assert.equal(status.textContent, 'Invalid connection link.');
  assert.equal(input.attributes.get('aria-invalid'), 'true');
  input.events.get('input')();
  assert.equal(input.attributes.has('aria-invalid'), false);
  input.value = '  ' + link + '\n';
  scan.disabled = true;
  await submit();
  assert.equal(connections.length, 0);
  scan.disabled = false;
  await submit();
  assert.equal(connections.length, 1);
  assert.equal(connections[0].host, address.host);
  assert.equal(connections[0].token, address.token);

  toggle.events.get('click')();
  assert.equal(scan.hidden, false);
  assert.equal(form.hidden, true);
  assert.equal(help.hidden, false);
  assert.equal(scan.focused, true);
});
