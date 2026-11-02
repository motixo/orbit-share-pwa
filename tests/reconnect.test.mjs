import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

function connection() {
  const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
  const boundary = source.indexOf("scanButton.addEventListener('click'");
  assert.ok(boundary > 0);
  const timers = new Map();
  const elements = new Map();
  const makeElement = () => ({
    children: [], hidden: false, textContent: '',
    replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); },
    addEventListener() {},
  });
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  let next = 0;
  const app = runInNewContext(source.slice(0, boundary) + `
    ({
      select(value) { session = value; },
      attempt(callback) { connect = callback; },
      list(callback) { listItems = callback; },
      saved(value) { pairs = value; renderPairs(); },
      pairs: () => pairs,
      disconnect,
      refresh: refreshItems,
      closePage() { pageClosed = true; },
      schedule: scheduleReconnect, disconnected, resume: resumeConnection,
    })`, {
    document: { getElementById: getElement, querySelector: selector => getElement(selector), createElement: makeElement },
    performance: { now: () => 1000 },
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval() {},
  });
  const current = {
    pc: { connectionState: 'connected', close() { this.connectionState = 'closed'; } },
    control: { readyState: 'open', send() {} },
    info: { fingerprint: 'desktop' }, ready: true, retry: true, connecting: false,
  };
  app.select(current);
  app.list(() => Promise.resolve());
  return { app, current, timers, element: getElement('connected'), paired: getElement('paired') };
}

test('disconnect keeps saved devices, clears retries, and hides the connected view', () => {
  const { app, current, timers, element, paired } = connection();
  const devices = [{ ...current.info, name: 'Computer' }];
  app.saved(devices);
  assert.equal(paired.children.length, 2);
  app.schedule(current);
  app.disconnect();
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
