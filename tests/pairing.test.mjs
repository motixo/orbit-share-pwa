import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('WebRTC setup failures restore pairing controls and close partially created peers', async () => {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function connect(');
  const end = source.indexOf('\nfunction drain(', begin);
  for (const stage of ['constructor', 'channel']) {
    const scan = { disabled: false };
    const status = { textContent: '' };
    let closed = false;
    let renders = 0;
    class Peer {
      constructor() { if (stage === 'constructor') throw new Error('WebRTC unavailable'); }
      createDataChannel() { throw new Error('Channel unavailable'); }
      close() { closed = true; }
    }
    const app = runInNewContext(source.slice(0, source.indexOf('async function pairStore(')) +
      source.slice(begin, end) + '\n({ connect })', {
      RTCPeerConnection: Peer,
      document: { getElementById: id => id === 'status' ? status : {}, querySelector: () => scan },
      clearTimeout() {}, clearInterval() {}, validateInfo: value => value,
      stopCamera() {}, clearThumbnails() {}, renderPairs() { renders++; },
      errorMessage: error => error.message,
    });
    await app.connect({ token: 'invitation' });
    assert.equal(scan.disabled, false);
    assert.equal(closed, stage === 'channel');
    assert.equal(renders, 1);
    assert.equal(status.textContent, stage === 'constructor' ? 'WebRTC unavailable' : 'Channel unavailable');
  }
});

test('New Orbit shows a remote rejection without retrying or forgetting the device', async () => {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function connect(');
  const end = source.indexOf('\nfunction drain(', begin);
  assert.ok(begin > 0 && end > begin);
  for (const [response, expected] of [
    ['open-denied', 'Opening Orbits is not allowed on this computer.'],
    ['open-failed', 'Could not open Orbit.'],
  ]) {
    const timers = new Map();
    const status = { textContent: '' };
    const scan = { disabled: false };
    let auth;
    let next = 0;
    let peer;
    class Peer extends EventTarget {
      connectionState = 'new';
      control = Object.assign(new EventTarget(), {
        readyState: 'open',
        send(value) {
          auth = JSON.parse(value);
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: response })));
        },
      });
      constructor() { super(); peer = this; }
      createDataChannel() { return this.control; }
      async createOffer() { return {}; }
      async setLocalDescription() { this.localDescription = { sdp: 'a=ice-pwd:' + 'a'.repeat(24) }; }
      async setRemoteDescription() { this.control.dispatchEvent(new Event('open')); }
      close() {
        if (this.connectionState === 'closed') return;
        this.connectionState = 'closed';
        this.control.readyState = 'closed';
        this.dispatchEvent(new Event('connectionstatechange'));
        this.control.dispatchEvent(new Event('close'));
      }
    }
    const app = runInNewContext(source.slice(0, source.indexOf('async function pairStore(')) +
      source.slice(begin, end) + '\n({ connect, current: () => session })', {
      RTCPeerConnection: Peer,
      document: { getElementById: id => id === 'status' ? status : {}, querySelector: () => scan },
      performance: { now: () => 0 },
      setTimeout(callback, delay) { const id = ++next; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); }, clearInterval() {},
      validateInfo: value => value,
      stopCamera() {}, clearThumbnails() {}, pumpRequests() {}, renderPairs() {},
      errorMessage: error => error.message,
    });
    const device = { key: {}, id: 'paired-device', share: 'previous-orbit', host: '192.168.1.2', port: 42000 };
    await app.connect(device, false, true);
    assert.equal(auth.open, true);
    assert.equal(auth.resume, false);
    assert.equal(status.textContent, expected);
    assert.equal(app.current().info, device);
    assert.equal(app.current().retry, false);
    assert.equal(app.current().ready, false);
    assert.equal(peer.connectionState, 'closed');
    assert.equal(timers.size, 0);
    assert.equal(scan.disabled, false);
  }
});

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
  const elements = { 'pair-link': form, 'connection-link': input, 'use-link': toggle, 'pair-help': help, connected: element(true) };
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
  const link = 'https://share.example/#' + Buffer.concat([Buffer.from([2, 192, 168, 1, 2, 192, 0]), Buffer.alloc(32), Buffer.from(address.token, 'hex'), Buffer.from('12345678123441238123123456789abc', 'hex')]).toString('base64url');
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

test('cancelling restores pairing and late camera requests cannot take over a new scan', async () => {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('function stopCamera()');
  const end = source.indexOf("document.getElementById('disconnect')", begin);
  assert.ok(begin > 0 && end > begin);
  const scan = element();
  const cancel = element();
  const camera = element(true);
  const classes = new Set();
  const video = { srcObject: null };
  let resolveCamera;
  let stopped = 0;
  runInNewContext(source.slice(begin, end), {
    scanning: false, camera: undefined, cameraGeneration: 0,
    scanButton: scan, statusElement: { textContent: '' }, reconnectTimer: undefined,
    clearTimeout() {}, resumeConnection() {},
    navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveCamera = resolve; }) } },
    document: {
      body: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } },
      querySelector: () => video,
      getElementById: id => ({ camera, 'cancel-scan': cancel })[id],
    },
  });
  const pending = scan.events.get('click')();
  assert.equal(classes.has('scanning'), true);
  assert.equal(camera.hidden, false);
  cancel.events.get('click')();
  assert.equal(classes.has('scanning'), false);
  assert.equal(camera.hidden, true);
  assert.equal(scan.focused, true);
  const firstCamera = resolveCamera;
  const next = scan.events.get('click')();
  firstCamera({ getTracks: () => [{ stop() { stopped++; } }] });
  await pending;
  assert.equal(stopped, 1);
  assert.equal(classes.has('scanning'), true);
  assert.equal(camera.hidden, false);
  cancel.events.get('click')();
  resolveCamera({ getTracks: () => [{ stop() { stopped++; } }] });
  await next;
  assert.equal(stopped, 2);
  assert.equal(video.srcObject, null);
});

test('opening Pair lists remembered devices without starting a connection', async () => {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const begin = source.indexOf('async function start()');
  assert.ok(begin > 0);
  const saved = { key: {}, last: 1 };
  for (const hash of ['', '#invitation']) {
    const connections = [];
    let rendered = 0;
    const app = runInNewContext(source.slice(begin) + '\n({ start, devices: () => pairs })', {
      started: false, session: undefined, scanning: false, pairs: [],
      location: { hash, href: 'https://share.example/' + hash }, URL,
      invitation: () => ({ token: 'invitation' }),
      history: { replaceState() {} },
      pairStore: async () => [saved], validateInfo: value => value,
      renderPairs() { rendered++; },
      connect: async info => { connections.push(info); },
    });
    await app.start();
    assert.equal(rendered, 1);
    assert.equal(app.devices()[0], saved);
    assert.equal(connections.length, hash ? 1 : 0);
    if (hash) assert.equal(connections[0].token, 'invitation');
  }
});
