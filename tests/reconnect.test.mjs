import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

function connection() {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const boundary = source.indexOf("scanButton.addEventListener('click'");
  assert.ok(boundary > 0);
  const timers = new Map();
  const events = new Map();
  const storage = new Map();
  const elements = new Map();
  const makeElement = () => ({
    children: [], hidden: false, textContent: '',
    replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); },
    pause() {},
    click() { this.clicked = true; },
    addEventListener() {},
  });
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  let next = 0;
  const lifecycle = source.slice(source.indexOf("window.addEventListener('pagehide'"), source.indexOf('const appDisplayMode ='));
  const app = runInNewContext(source.slice(0, boundary) + lifecycle + `
    ({
      select(value) { session = value; },
      attempt(callback) { connect = callback; },
      list(callback) { listItems = callback; },
      saved(value) { pairs = value; renderPairs(); },
      pairs: () => pairs,
      disconnect,
      refresh: refreshItems,
      closePage() { pageClosed = true; },
      previewDownload() { downloadNavigationUntil = 6000; },
      scanCamera() { scanning = true; },
      schedule: scheduleReconnect, disconnected, resume: resumeConnection, stop: stopConnection,
    })`, {
    document: { getElementById: getElement, querySelector: selector => getElement(selector), createElement: makeElement, addEventListener() {}, body: { classList: { remove() {} } } },
    window: { addEventListener(type, callback) { events.set(type, callback); } },
    navigator: {},
    sessionStorage: { setItem(key, value) { storage.set(key, value); }, removeItem(key) { storage.delete(key); } },
    performance: { now: () => 1000 },
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval() {},
  });
  const listeners = new Map();
  const current = {
    pc: { connectionState: 'connected', close() { this.connectionState = 'closed'; } },
    control: {
      readyState: 'open', sent: [],
      send(message) { this.sent.push(message); },
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(callback);
      },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
      emit(type, data) { for (const callback of [...(listeners.get(type) || [])]) callback({ data }); },
    },
    info: { fingerprint: 'desktop', share: 'shelf' }, ready: true, retry: true, connecting: false,
  };
  app.select(current);
  app.list(() => Promise.resolve());
  return { app, current, timers, events, storage, element: getElement('connected'), paired: getElement('paired'), scan: getElement('#scan') };
}

test('returning from a cached page or a download preview resumes without sending an intentional disconnect', () => {
  for (const preview of [false, true]) {
    const { app, current, timers, events, storage } = connection();
    let attempts = 0;
    app.attempt((info, retry) => { assert.equal(info, current.info); assert.equal(retry, true); attempts++; });
    app.schedule(current);
    if (preview) app.previewDownload();
    events.get('pagehide')({ persisted: !preview });
    assert.equal(current.retry, true);
    assert.equal(current.pc.connectionState, 'closed');
    assert.deepEqual(current.control.sent, []);
    assert.equal(timers.size, 0);
    if (preview) assert.deepEqual(JSON.parse(storage.get('orbit-download-peer')), current.info);
    else assert.equal(storage.size, 0);
    app.resume();
    assert.equal(attempts, 0);
    events.get('pageshow')();
    assert.equal(attempts, 1);
    assert.equal(storage.size, 0);
  }
});

test('closing the page still sends an intentional disconnect', () => {
  const { current, events } = connection();
  events.get('pagehide')({ persisted: false });
  assert.deepEqual(current.control.sent, ['disconnect']);
  assert.equal(current.retry, false);
});

test('returning after a camera page transition restores scanning instead of reconnecting', () => {
  const { app, events, scan } = connection();
  app.scanCamera();
  app.attempt(() => assert.fail('camera restore started a connection'));
  events.get('pagehide')({ persisted: true });
  events.get('pageshow')();
  assert.equal(scan.clicked, true);
});

test('disconnect keeps saved devices, clears retries, and hides the connected view', () => {
  const { app, current, timers, element, paired } = connection();
  const devices = [{ ...current.info, name: 'Computer' }];
  app.saved(devices);
  assert.equal(paired.children.length, 2);
  app.schedule(current);
  app.disconnect();
  assert.deepEqual(current.control.sent, ['disconnect']);
  assert.equal(current.pc.connectionState, 'connected');
  current.control.emit('message', 'disconnect-ack');
  assert.equal(current.pc.connectionState, 'closed');
  assert.equal(element.hidden, true);
  assert.equal(current.retry, false);
  assert.equal(timers.size, 0);
  assert.equal(app.pairs(), devices);
  app.resume();
  assert.equal(timers.size, 0);
  app.saved([]);
  assert.equal(paired.children.length, 0);
});

test('a desktop disconnect stops retries and resume without forgetting the device', () => {
  const { app, current, timers, element, scan } = connection();
  const devices = [{ ...current.info, name: 'Computer' }];
  app.saved(devices);
  scan.disabled = true;
  app.schedule(current);
  app.stop(current, false);
  assert.deepEqual(current.control.sent, ['disconnect-ack']);
  assert.equal(current.retry, false);
  assert.equal(current.pc.connectionState, 'closed');
  assert.equal(element.hidden, true);
  assert.equal(scan.disabled, false);
  app.disconnected(current);
  app.resume();
  app.schedule(current);
  assert.equal(timers.size, 0);
  assert.equal(app.pairs(), devices);
});

test('intentional close is bounded when the peer cannot acknowledge', () => {
  const { app, current, timers } = connection();
  app.disconnect();
  assert.equal(timers.size, 1);
  const [id, timer] = [...timers][0];
  assert.equal(timer.delay, 1000);
  timers.delete(id);
  timer.callback();
  assert.equal(current.pc.connectionState, 'closed');
  assert.equal(timers.size, 0);
  app.resume();
  assert.equal(timers.size, 0);
});

test('retries continue with a capped delay and stop after forgetting or rejection', () => {
  const { app, current, timers } = connection();
  let attempts = 0;
  app.attempt(info => { assert.equal(info, current.info); attempts++; app.schedule(current); });
  app.schedule(current);
  app.schedule(current);
  for (const delay of [1000, 2000, 4000, 5000, 5000]) {
    assert.equal(timers.size, 1);
    const [id, timer] = [...timers][0];
    assert.equal(timer.delay, delay);
    timers.delete(id);
    timer.callback();
  }
  assert.equal(attempts, 5);
  current.forgotten = true;
  const [id, timer] = [...timers][0];
  timers.delete(id);
  timer.callback();
  assert.equal(attempts, 5);
  assert.equal(timers.size, 0);
  current.forgotten = false;
  current.retry = false;
  app.schedule(current);
  assert.equal(timers.size, 0);
});

test('stale connections cannot close a replacement and closing the page stops retries', () => {
  const { app, current, timers, element } = connection();
  const replacement = { ...current, pc: { ...current.pc } };
  app.select(replacement);
  app.disconnected(current);
  assert.equal(replacement.pc.connectionState, 'connected');
  assert.equal(timers.size, 0);
  app.disconnected(replacement);
  assert.equal(replacement.ready, false);
  assert.equal(element.hidden, true);
  assert.equal(timers.size, 1);
  app.closePage();
  const [id, timer] = [...timers][0];
  timers.delete(id);
  timer.callback();
  assert.equal(timers.size, 0);
});

test('returning to the app probes live connections and immediately retries disconnected ones', () => {
  const { app, current, timers } = connection();
  let probes = 0;
  let attempts = 0;
  current.control.send = message => { assert.equal(message, 'ping'); probes++; };
  app.attempt(() => { attempts++; });
  app.resume();
  assert.equal(probes, 1);
  current.ready = false;
  app.schedule(current);
  app.resume();
  assert.equal(attempts, 1);
  assert.equal(timers.size, 0);
  current.connecting = true;
  app.resume();
  assert.equal(attempts, 1);
});

test('network probes preserve the last response time and respect disabled retries', () => {
  const { app, current } = connection();
  let probes = 0;
  current.control.send = message => { assert.equal(message, 'ping'); probes++; };
  current.lastSeen = 50;
  app.resume();
  app.resume();
  assert.equal(current.lastSeen, 50);
  assert.equal(probes, 2);
  current.retry = false;
  app.resume();
  assert.equal(probes, 2);
  current.ready = false;
  let attempts = 0;
  app.attempt(() => { attempts++; });
  app.resume();
  assert.equal(attempts, 0);
});

test('file updates coalesce while a list is loading and retry without reconnecting', async () => {
  const { app, current, timers } = connection();
  let finish;
  let requests = 0;
  app.list(() => {
    requests++;
    return requests === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve();
  });
  const pending = app.refresh(current);
  await app.refresh(current);
  await app.refresh(current);
  assert.equal(requests, 1);
  finish();
  await pending;
  assert.equal(requests, 2);
  assert.equal(timers.size, 0);

  app.list(() => Promise.reject(new Error('Busy')));
  await app.refresh(current);
  assert.equal(current.ready, true);
  assert.equal(timers.size, 1);
  const [id, timer] = [...timers][0];
  timers.delete(id);
  app.select({ ...current });
  let staleRequests = 0;
  app.list(() => { staleRequests++; });
  timer.callback();
  assert.equal(staleRequests, 0);
});
