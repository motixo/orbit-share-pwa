const statusElement = document.getElementById('status')!;
const scanButton = document.querySelector<HTMLButtonElement>('#scan')!;
let session: ShareSession | undefined;
let camera: MediaStream | undefined;
let scanning = false;
let cameraGeneration = 0;
let installPrompt: BeforeInstallPromptEvent | undefined;
let active = 0;
let pairs: PairedDevice[] = [];
let pairingDB: Promise<IDBDatabase> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let retryDelay = 1000;
let pageClosed = false;
let downloadNavigationUntil = 0;
let downloadReady: Promise<void> | undefined;
let applyUpdate = () => {};

function scheduleReconnect(current: ShareSession) {
  if (session !== current || current.forgotten || !current.retry || pageClosed || scanning || reconnectTimer !== undefined) return;
  statusElement.textContent = 'Reconnecting…';
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (session === current && !current.forgotten && current.retry && !pageClosed && !scanning) {
      void connect(current.info, true);
    }
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 5000);
}

function disconnected(current: ShareSession, close = true) {
  if (session !== current) return;
  clearTimeout(current.itemsTimer);
  clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  current.ready = false;
  pumpRequests(current);
  document.getElementById('connected')!.hidden = true;
  clearThumbnails(current);
  statusElement.textContent = current.forgotten ? 'Forgotten' : current.error || 'Disconnected';
  if (close && current.pc.connectionState !== 'closed') current.pc.close();
  renderPairs();
  scheduleReconnect(current);
}

function resumeConnection() {
  const current = session;
  if (!current || current.forgotten || !current.retry || current.connecting || pageClosed || scanning) return;
  if (current.ready && current.control.readyState === 'open') {
    try { current.control.send('ping'); } catch { disconnected(current); }
    void refreshItems(current);
  } else {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    retryDelay = 1000;
    void connect(current.info, true);
  }
}

function pairStore(action: 'list'): Promise<unknown[]>;
function pairStore(action: 'put', value: PairedDevice): Promise<void>;
function pairStore(action: 'delete', value: string): Promise<void>;
async function pairStore(action: 'list' | 'put' | 'delete', value?: PairedDevice | string): Promise<unknown[] | void> {
  pairingDB ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('orbit-pairing', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('devices', { keyPath: 'fingerprint' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not open device storage'));
  });
  const db = await pairingDB;
  return new Promise<unknown[] | void>((resolve, reject) => {
    const transaction = db.transaction('devices', action === 'list' ? 'readonly' : 'readwrite');
    const store = transaction.objectStore('devices');
    let result: unknown;
    if (action === 'list') {
      const request = store.getAll();
      request.onsuccess = () => { result = request.result; };
    } else if (action === 'put' && typeof value === 'object') store.put(value);
    else if (action === 'delete' && typeof value === 'string') store.delete(value);
    else throw new Error('Invalid device');
    transaction.oncomplete = () => {
      if (action !== 'list') resolve();
      else if (Array.isArray(result)) resolve(result);
      else reject(new Error('Invalid device storage'));
    };
    transaction.onerror = transaction.onabort = () => reject(new Error('Could not save device'));
  });
}

function renderPairs() {
  document.querySelector<HTMLButtonElement>('#pair-link-submit')!.disabled = scanButton.disabled;
  document.getElementById('connection-bar')!.hidden = !session?.ready;
  document.querySelector<HTMLButtonElement>('#disconnect')!.disabled = active > 0;
  const device = document.getElementById('connected-device')!;
  device.hidden = !session?.ready;
  device.textContent = session?.ready ? `${'name' in session.info && session.info.name || 'Computer'} · ${session.info.host}` : '';
  const root = document.getElementById('paired')!;
  root.replaceChildren();
  if (pairs.length) {
    const heading = document.createElement('h2');
    heading.textContent = 'Paired devices';
    root.append(heading);
  }
  for (const info of pairs) {
    const row = document.createElement('article');
    const name = document.createElement('span');
    name.className = 'computer';
    name.textContent = info.name || 'Computer';
    const button = document.createElement('button');
    button.textContent = 'Connect';
    button.disabled = active > 0 || Boolean(session && (!session.ready || session.forgotten) && session.pc.connectionState !== 'closed');
    button.addEventListener('click', () => connect(info).catch(error => { statusElement.textContent = errorMessage(error); }));
    const forget = document.createElement('button');
    forget.textContent = 'Forget';
    forget.disabled = active > 0 || Boolean(session?.forgotten && session.info.fingerprint === info.fingerprint);
    forget.addEventListener('click', () => forgetDevice(info, forget));
    row.append(name, button);
    const open = document.createElement('button');
    open.textContent = 'New Orbit';
    open.disabled = button.disabled;
    open.addEventListener('click', () => connect(info, false, true).catch(error => { statusElement.textContent = errorMessage(error); }));
    row.append(open);
    row.append(forget);
    root.append(row);
  }
}

async function forgetDevice(info: DeviceInfo, button: HTMLButtonElement) {
  button.disabled = true;
  const current = session?.info.fingerprint === info.fingerprint ? session : undefined;
  if (current) {
    current.forgotten = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  try {
    if (current?.ready) await revokeDevice(current);
    await pairStore('delete', info.fingerprint);
    pairs = pairs.filter(pair => pair.fingerprint !== info.fingerprint);
    if (session?.info.fingerprint === info.fingerprint) {
      session.forgotten = true;
      disconnected(session);
      statusElement.textContent = 'Forgotten';
    }
    renderPairs();
  } catch (error) {
    if (current) { current.forgotten = false; resumeConnection(); }
    button.disabled = false;
    statusElement.textContent = errorMessage(error);
  }
}

function stopConnection(current: ShareSession, notify: boolean) {
  current.retry = false;
  if (session === current) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    disconnected(current, false);
    session = undefined;
    scanButton.disabled = active > 0;
    renderPairs();
  }
  const control = current.control;
  if (control.readyState !== 'open') { current.pc.close(); return; }
  if (!notify) {
    try { control.send('disconnect-ack'); } catch {}
    current.pc.close();
    return;
  }
  const closed = () => {
    clearTimeout(timer);
    control.removeEventListener('message', acknowledged);
    control.removeEventListener('close', closed);
    current.pc.close();
  };
  const acknowledged = (event: MessageEvent<unknown>) => {
    if (event.data === 'disconnect-ack') closed();
  };
  const timer = setTimeout(closed, 1000);
  control.addEventListener('message', acknowledged);
  control.addEventListener('close', closed, { once: true });
  try { control.send('disconnect'); } catch { closed(); }
}

function disconnect() {
  if (!session) return;
  stopConnection(session, true);
  stopCamera();
  statusElement.textContent = '';
}

function revokeDevice(current: ShareSession): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const control = current.control;
    const cleanup = () => {
      clearTimeout(timer);
      control.removeEventListener('message', message);
      control.removeEventListener('close', closed);
    };
    const closed = () => { cleanup(); reject(new Error('Could not forget device. Try again.')); };
    const message = (event: MessageEvent<unknown>) => {
      if (event.data === 'forgotten') {
        cleanup();
        try { if (control.readyState === 'open') control.send('forget-complete'); } catch {}
        resolve();
      } else if (event.data === '{"type":"forget-error"}') closed();
    };
    const timer = setTimeout(closed, 5000);
    control.addEventListener('message', message);
    control.addEventListener('close', closed, { once: true });
    try { control.send(JSON.stringify({ type: 'forget' })); }
    catch { closed(); }
  });
}

async function rememberDevice(message: Record<string, unknown>, current: ShareSession) {
  if (session !== current || current.forgotten || !current.ready || typeof message.id !== 'string' || !deviceID.test(message.id) ||
    message.share !== current.info.share || typeof message.fingerprint !== 'string' || message.fingerprint.toUpperCase() !== current.info.fingerprint.toUpperCase()) throw new Error('Invalid device');
  let key = current.info.key;
  if (message.token) {
    if (typeof message.token !== 'string' || !/^[0-9a-f]{64}$/i.test(message.token)) throw new Error('Invalid device');
    const secret = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message.token));
    key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    new Uint8Array(secret).fill(0);
    message.token = '';
  } else if (message.id !== current.info.id) {
    throw new Error('Invalid device');
  }
  const info = validateInfo({
    host: message.host, port: message.port, share: message.share, fingerprint: message.fingerprint,
    mdns: message.mdns || '', id: message.id, key,
    name: typeof message.name === 'string' ? message.name.slice(0, 80) : 'Computer', last: Date.now(),
  });
  if (!info.key) throw new Error('Invalid device');
  if (current.forgotten) return;
  current.info = info;
  await pairStore('put', info);
  if (current.forgotten) { await pairStore('delete', info.fingerprint); return; }
  if (session !== current) return;
  pairs = [info, ...pairs.filter(pair => pair.fingerprint !== info.fingerprint)];
  renderPairs();
}


async function deviceName() {
  try {
    const info = await navigator.userAgentData?.getHighEntropyValues(['model']);
    if (info?.model?.trim()) return info.model.trim().slice(0, 80);
  } catch {}
  if (/iPhone/.test(navigator.userAgent)) return 'iPhone';
  if (/iPad/.test(navigator.userAgent)) return 'iPad';
  return '';
}

async function connect(info: DeviceInfo, retry = false, open = false) {
  if (open && (!info.key || retry)) throw new Error('Pair this device first.');
  info = validateInfo(info);
  stopCamera();
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  if (!retry) retryDelay = 1000;
  const previous = session;
  clearTimeout(previous?.itemsTimer);
  if (previous) clearThumbnails(previous);
  if (previous && !retry) stopConnection(previous, true);
  session = undefined;
  if (retry) previous?.pc.close();
  scanButton.disabled = true;
  document.getElementById('connected')!.hidden = true;
  statusElement.textContent = 'Connecting…';
  let peer: RTCPeerConnection | undefined;
  let control: RTCDataChannel;
  try {
    peer = new RTCPeerConnection({ iceServers: [] });
    control = peer.createDataChannel('orbit', { ordered: true });
  } catch (error) {
    peer?.close();
    scanButton.disabled = active > 0;
    renderPairs();
    statusElement.textContent = errorMessage(error) || 'Could not connect';
    return;
  }
  const pc = peer;
  const current: ShareSession = { pc, control, info, ready: false, connecting: true, retry, lastSeen: performance.now() };
  session = current;
  renderPairs();
  control.addEventListener('message', event => {
    if (session !== current) return;
    if (event.data === 'disconnect') {
      stopConnection(current, false);
    } else if (event.data === 'ping' || event.data === 'pong') {
      current.lastSeen = performance.now();
      if (event.data === 'ping' && control.readyState === 'open') {
        try { control.send('pong'); } catch { disconnected(current); }
      }

    } else if (event.data === 'device-info' || event.data === 'pairing') {
      current.name ??= deviceName();
      current.name.then(name => {
        if (control.readyState === 'open' && (name || event.data === 'pairing')) {
          control.send(JSON.stringify({ type: event.data === 'pairing' ? 'pair' : 'device', name }));
        }
      }).catch(() => {});
    } else if (typeof event.data === 'string' && event.data.startsWith('{')) {
      (async () => {
        const message: unknown = JSON.parse(event.data);
        if (!isRecord(message)) throw new Error('Invalid response');
        if (message.type === 'session') {
          if (current.ready || typeof message.share !== 'string' || !deviceID.test(message.share) ||
            (!open && message.share !== current.info.share)) throw new Error('Invalid session');
          current.info = { ...current.info, share: message.share };
        } else if (message.type === 'items') {
          if (typeof message.revision !== 'number' || !Number.isSafeInteger(message.revision) || message.revision < 0) throw new Error('Invalid revision');
          if (current.itemsRevision !== message.revision) {
            current.itemsRevision = message.revision;
            await refreshItems(current);
          }
        } else if (message.type === 'challenge') {
          if (!info.key || typeof message.value !== 'string') throw new Error('Invalid challenge');
          const parts = message.value.split('\n');
          if (parts.length !== 5 || parts[0] !== 'orbit-pair-v3' || parts[1] !== info.fingerprint ||
            !deviceID.test(parts[2]) || retry && parts[2] !== info.share || parts[3] !== (open ? 'open' : 'connect') || !/^[0-9a-f]{64}$/.test(parts[4])) throw new Error('Invalid challenge');
          current.info = { ...current.info, share: parts[2] };
          const proof = await crypto.subtle.sign('HMAC', info.key, new TextEncoder().encode(message.value));
          const signature = btoa(String.fromCharCode(...new Uint8Array(proof))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          if (control.readyState === 'open') control.send(JSON.stringify({ type: 'proof', signature }));
        } else if (message.type === 'paired' && !current.forgotten) {
          await rememberDevice(message, current);
        } else if (message.type === 'pairing-error') {
          statusElement.textContent = 'Could not remember device';
        }
      })().catch(error => {
        if (session !== current) return;
        statusElement.textContent = errorMessage(error);
        if (!current.ready) {
          current.error = errorMessage(error);
          current.retry = false;
          disconnected(current);
        }
      });
    }
  });
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('Could not connect')); disconnected(current); }, open ? 22000 : 8000);
    const closed = () => { clearTimeout(timer); reject(new Error(current.error || 'Disconnected')); };
    control.addEventListener('close', closed, { once: true });
    control.addEventListener('open', () => control.send(info.key ? JSON.stringify({ type: 'auth', id: info.id, share: info.share, resume: retry, open }) : info.token), { once: true });
    control.addEventListener('message', function ready(event) {
      if (session !== current) return;
      if (['rejected', 'unavailable', 'open-denied', 'open-failed'].includes(event.data)) {
        clearTimeout(timer);
        control.removeEventListener('message', ready);
        if (event.data !== 'unavailable') current.retry = false;
        current.error = event.data === 'rejected' ? 'Device not paired. Scan again.'
          : event.data === 'open-denied' ? 'Opening Orbits is not allowed on this computer.'
          : event.data === 'open-failed' ? 'Could not open Orbit.' : 'Open Orbit Share.';
        reject(new Error(current.error));
        disconnected(current);
        return;
      }
      if (event.data !== 'ready') return;
      clearTimeout(timer);
      control.removeEventListener('message', ready);
      current.ready = true;
      current.retry = true;
      current.lastSeen = performance.now();
      resolve();
    });
  });
  opened.catch(() => {});
  pc.addEventListener('connectionstatechange', () => {
    if (['failed', 'closed'].includes(pc.connectionState)) disconnected(current);
  });
  control.addEventListener('close', () => disconnected(current), { once: true });
  control.addEventListener('error', () => disconnected(current), { once: true });
  try {
    await pc.setLocalDescription(await pc.createOffer());
    const password = pc.localDescription?.sdp.match(/^a=ice-pwd:(.+)$/m)?.[1].trim();
    if (!password || !/^[a-zA-Z0-9+/]{22,239}$/.test(password)) {
      current.retry = false;
      throw new Error('Unsupported browser');
    }
    const credentials = 'libp2p+webrtc+v2/' + password;
    const answer = [
      'v=0', 'o=- 0 0 IN IP4 ' + info.host, 's=-', 't=0 0', 'a=ice-lite',
      'm=application ' + info.port + ' UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 ' + info.host, 'a=mid:0', 'a=ice-options:ice2',
      'a=ice-ufrag:' + credentials, 'a=ice-pwd:' + credentials,
      'a=fingerprint:sha-256 ' + info.fingerprint, 'a=setup:passive',
      'a=sctp-port:5000', 'a=max-message-size:65536',
      ...(info.mdns ? ['a=candidate:2 1 UDP 2 ' + info.mdns + ' ' + info.port + ' typ host'] : []),
      'a=candidate:1 1 UDP 1 ' + info.host + ' ' + info.port + ' typ host', 'a=end-of-candidates', '',
    ].join('\r\n');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    await opened;
    if (session !== current) { pc.close(); return; }
    retryDelay = 1000;
    heartbeatTimer = setInterval(() => {
      if (session !== current || current.forgotten) return;
      if (performance.now() - current.lastSeen >= 6000) disconnected(current);
      else {
        try { control.send('ping'); } catch { disconnected(current); }
      }
    }, 2000);
    await refreshItems(current);
    if (session !== current || !current.ready) return;
    document.getElementById('connected')!.hidden = false;
    scanButton.hidden = false;
    document.querySelector<HTMLFormElement>('#pair-link')!.hidden = true;
    document.getElementById('pair-help')!.hidden = false;
    document.getElementById('use-link')!.textContent = 'Use a connection link';
    document.getElementById('use-link')!.setAttribute('aria-expanded', 'false');
    statusElement.textContent = '';
  } catch (error) {
    if (session !== current) return;
    current.error = errorMessage(error);
    disconnected(current);
  } finally {
    current.connecting = false;
    if (session === current) { scanButton.disabled = active > 0; renderPairs(); }
    applyUpdate();
  }
}

function drain(dc: RTCDataChannel, signal: AbortSignal): Promise<void> {
  if (dc.readyState !== 'open') return Promise.reject(new Error('Disconnected'));
  if (dc.bufferedAmount <= 65536) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      dc.removeEventListener('bufferedamountlow', low);
      dc.removeEventListener('close', closed);
      signal.removeEventListener('abort', closed);
    };
    const low = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error('Transfer interrupted')); };
    const timer = setTimeout(closed, 60000);
    dc.addEventListener('bufferedamountlow', low, { once: true });
    dc.addEventListener('close', closed, { once: true });
    signal.addEventListener('abort', closed, { once: true });
    if (signal.aborted || dc.readyState !== 'open') closed();
    else if (dc.bufferedAmount <= 65536) low();
  });
}

async function downloadSink(): Promise<DownloadSink & { save(name: string): void }> {
  const writer = new Worker('/download-worker.js', { type: 'module' });
  let stopped = false;
  let file: File | undefined;
  let buffered: Uint8Array<ArrayBuffer> | undefined;
  let bufferedSize = 0;
  let bufferedPosition = 0;
  let writing = Promise.resolve();
  const batchSize = 1024 * 1024;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let pending: { resolve(value: File | undefined): void; reject(error: Error): void } | undefined;
  writer.onmessage = event => {
    clearTimeout(timeout);
    const request = pending;
    pending = undefined;
    if (event.data.error) request?.reject(new Error(event.data.error));
    else request?.resolve(event.data.file);
  };
  writer.onerror = () => { clearTimeout(timeout); pending?.reject(new Error('Could not save download')); pending = undefined; };
  const command = (type: string, data?: ArrayBuffer, size?: number, position?: number) => new Promise<File | undefined>((resolve, reject) => {
    if (stopped) { reject(new Error('Download cancelled')); return; }
    pending = { resolve, reject };
    timeout = setTimeout(() => { reject(new Error('Saving download timed out')); abort(); }, 60000);
    writer.postMessage({ type, data, size, position }, data ? [data] : []);
  });
  const flush = async () => {
    if (!buffered || !bufferedSize) return;
    await writing;
    const data = bufferedSize === buffered.byteLength ? buffered.buffer : buffered.slice(0, bufferedSize).buffer;
    buffered = undefined;
    bufferedSize = 0;
    writing = command('write', data, undefined, bufferedPosition).then(() => {});
    // The next batch can fill while this write runs; finish still awaits errors.
    void writing.catch(() => {});
  };
  const abort = () => {
    if (stopped) return;
    buffered = undefined;
    bufferedSize = 0;
    clearTimeout(timeout);
    pending?.reject(new Error('Download cancelled'));
    pending = undefined;
    writer.postMessage({ type: 'abort' });
    stopped = true;
    // Give the worker time to close and remove a partial file.
    setTimeout(() => writer.terminate(), 5000);
  };
  try { await command('open'); }
  catch (error) { abort(); throw error; }
  return {
    async prepare(size) { await command('prepare', undefined, size); },
    async writeAt(position, data) {
      if (stopped) throw new Error('Download cancelled');
      if (buffered && (position !== bufferedPosition + bufferedSize || bufferedSize + data.byteLength > batchSize)) await flush();
      if (data.byteLength >= batchSize) { await writing; await command('write', data, undefined, position); return; }
      if (!buffered) { buffered = new Uint8Array(batchSize); bufferedPosition = position; }
      buffered.set(new Uint8Array(data), bufferedSize);
      bufferedSize += data.byteLength;
      if (bufferedSize === batchSize) await flush();
    },
    async finish() {
      await flush();
      await writing;
      file = await command('finish');
      if (!file) throw new Error('Could not save download');
      return file;
    },
    save(name) {
      if (stopped || !file) throw new Error('Download unavailable');
      const types: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
        mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
      };
      const extension = name.split('.').pop()!.toLowerCase();
      const type = Object.hasOwn(types, extension) ? types[extension] : 'application/octet-stream';
      const link = document.createElement('a');
      // Keep the disk-backed URL valid for Safari's download handoff.
      link.href = URL.createObjectURL(new File([file], name, { type }));
      link.download = name;
      link.target = '_blank';
      link.rel = 'noopener';
      document.body.append(link);
      downloadNavigationUntil = performance.now() + 5000;
      try { link.click(); } finally { link.remove(); }
      stopped = true;
      writer.terminate();
    },
    abort,
  };
}

function pumpRequests(current: ShareSession) {
  const requests = current.requests;
  if (!requests) return;
  if (session !== current || !current.ready) {
    for (const queued of requests.queued.splice(0)) queued.reject(new Error('Disconnected'));
    return;
  }
  while (requests.active < 3 && requests.queued.length) {
    let index = requests.queued.findIndex(queued => queued.action !== 'thumbnail');
    if (index < 0) {
      if (requests.thumbnail) return;
      index = 0;
    }
    requests.queued.splice(index, 1)[0].start();
  }
}

function requestSlot(current: ShareSession, action: RequestAction): Promise<() => void> {
  const requests = current.requests ??= { active: 0, thumbnail: false, queued: [] };
  return new Promise((resolve, reject) => {
    requests.queued.push({ action, reject, start() {
      requests.active++;
      if (action === 'thumbnail') requests.thumbnail = true;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        requests.active--;
        if (action === 'thumbnail') requests.thumbnail = false;
        pumpRequests(current);
      });
    } });
    pumpRequests(current);
  });
}

async function request(action: RequestAction, fields: RequestFields = {}, payload?: Blob, progress?: TransferProgress, sink?: DownloadSink): Promise<Blob> {
  if (action !== 'file' && action !== 'upload') return requestControl(action, fields, payload);
  if (!session?.ready) throw new Error('Scan the QR first.');
  const current = session;
  const abort = new AbortController();
  const stopped = () => abort.abort();
  current.control.addEventListener('close', stopped, { once: true });
  let ticket: CrocTicket | undefined;
  try {
    if (payload) statusElement.textContent = 'Preparing';
    const prepared = payload ? await OrbitCroc.prepare(payload, fields.name ?? 'file', abort.signal) : undefined;
    if (session !== current || !current.ready) throw new Error('Disconnected');
    const response = await requestControl(action === 'file' ? 'croc-file' : 'croc-upload', { ...fields, size: payload?.size ?? 0 });
    ticket = JSON.parse(await response.text());
    if (!ticket || session !== current || !current.ready) throw new Error('Disconnected');
    let sampled = 0;
    const report: TransferProgress = (done, total) => {
      if (performance.now() - sampled < 250 && done < total) return;
      sampled = performance.now();
      progress?.(done, total);
      if (current.control.readyState === 'open') current.control.send(JSON.stringify({ type: 'croc-progress', id: ticket!.id, done }));
    };
    const result = await OrbitCroc.transfer(current.pc, ticket, abort.signal, report, prepared, sink);
    if (session !== current || !current.ready) throw new Error('Disconnected');
    const checksum = prepared ? Array.from(prepared[0].hash, byte => byte.toString(16).padStart(2, '0')).join('') : undefined;
    await requestControl('croc-result', { id: ticket.id, checksum });
    ticket = undefined;
    return result;
  } catch (error) { sink?.abort(); throw error; }
  finally {
    abort.abort();
    current.control.removeEventListener('close', stopped);
    if (ticket && session === current && current.ready) void requestControl('croc-cancel', { id: ticket.id }).catch(() => {});
  }
}

async function requestControl(action: ControlAction, fields: RequestFields = {}, payload?: Blob): Promise<Blob> {
  if (!session?.ready) throw new Error('Scan the QR first.');
  const current = session;
  const release = await requestSlot(current, action);
  let dc: RTCDataChannel;
  try {
    if (session !== current || !current.ready) throw new Error('Disconnected');
    dc = current.pc.createDataChannel('request', { ordered: true });
  } catch (error) { release(); throw error; }
  dc.addEventListener('close', release, { once: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 65536;
  const abort = new AbortController();
  let header: ResponseHeader | undefined;
  let received = 0;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const chunks: ArrayBuffer[] = [];
  const response = new Promise<Blob>((resolve, reject) => {
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      abort.abort();
      dc.close();
      reject(error);
    };
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error('Transfer timed out')), 60000);
    };
    reset();
    dc.addEventListener('close', () => fail(new Error('Transfer interrupted')), { once: true });
    dc.addEventListener('error', () => fail(new Error('Transfer failed')), { once: true });
    let messages = Promise.resolve();
    dc.addEventListener('message', event => {
      messages = messages.then(async () => {
        if (finished) return;
        try {
          reset();
          if (typeof event.data === 'string') {
            const message: unknown = JSON.parse(event.data);
            if (!isRecord(message)) throw new Error('Invalid response');
            if (message.type === 'response') {
              if (header || typeof message.status !== 'number' || !Number.isInteger(message.status) ||
                typeof message.size !== 'number' || !Number.isSafeInteger(message.size) || message.size < -1) throw new Error('Invalid response');
              header = { status: message.status, size: message.size };
            } else if (message.type === 'error') {
              throw new Error(typeof message.message === 'string' && message.message || 'Transfer failed');
            } else if (message.type === 'pending') {
              return;
            } else if (message.type === 'end') {
              if (!header || header.size >= 0 && received !== header.size) throw new Error('Incomplete file');
              const body = new Blob(chunks);
              finished = true;
              clearTimeout(timer);
              abort.abort();
              if (header.status < 200 || header.status >= 300) reject(new Error((await body.text()).slice(0, 200) || 'Transfer failed'));
              else resolve(body);
              dc.close();
            } else throw new Error('Invalid response');
          } else {
            if (!header || !(event.data instanceof ArrayBuffer)) throw new Error('Invalid response');
            received += event.data.byteLength;
            if (!Number.isSafeInteger(received) || header.size >= 0 && received > header.size) throw new Error('Invalid file size');
            if (received > 16 * 1024 * 1024) throw new Error('Response too large');
            chunks.push(event.data);
          }
        } catch (error) { fail(error); }
      });
    });
    dc.addEventListener('open', async () => {
      try {
        dc.send(JSON.stringify({ action, size: payload?.size ?? 0, ...fields }));
        if (payload) {
          for (let offset = 0; offset < payload.size; offset += 16384) {
            if (abort.signal.aborted) return;
            await drain(dc, abort.signal);
            const data = await payload.slice(offset, offset + 16384).arrayBuffer();
            if (abort.signal.aborted) return;
            dc.send(data);
            reset();
          }
          await drain(dc, abort.signal);
          dc.send('end');
        }
      } catch (error) { fail(error); }
    }, { once: true });
  });
  return response;
}

async function busy(button: HTMLButtonElement, action: () => Promise<void>) {
  active++;
  button.disabled = true;
  scanButton.disabled = true;
  renderPairs();
  try { await action(); statusElement.textContent = 'Done'; }
  catch (error) { statusElement.textContent = errorMessage(error) || 'Transfer failed'; }
  finally { active--; button.disabled = false; scanButton.disabled = active > 0; renderPairs(); applyUpdate(); }
}

function progress(label: string): TransferProgress {
  return (done, total) => {
    statusElement.textContent = label + (total > 0 ? ' · ' + Math.min(100, Math.floor(done * 100 / total)) + '%' : '');
  };
}

function errorMessage(error: unknown): string {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return error.message || error.name;
  return error instanceof Error ? error.message : '';
}

async function refreshItems(current: ShareSession) {
  if (session !== current || !current.ready) return;
  current.itemsChanged = true;
  if (current.refreshing) return;
  clearTimeout(current.itemsTimer);
  current.refreshing = true;
  try {
    do {
      current.itemsChanged = false;
      await listItems(current);
    } while (current.itemsChanged && session === current && current.ready);
  } catch {
    if (session === current && current.ready) {
      current.itemsTimer = setTimeout(() => { void refreshItems(current); }, 1000);
    }
  } finally {
    current.refreshing = false;
  }
}

function icon(path: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

function clearThumbnails(current: ShareSession) {
  for (const pending of current.thumbnails?.values() ?? []) {
    void pending.then(url => { if (url) URL.revokeObjectURL(url); });
  }
  current.thumbnails?.clear();
}

async function listItems(current: ShareSession) {
  const response = await request('list');
  const items = validateItems(JSON.parse(await response.text()));
  if (session !== current || !current.ready) return;
  const indices = new Set(items.map(item => item.index));
  for (const [index, pending] of current.thumbnails ?? []) {
    if (indices.has(index)) continue;
    current.thumbnails!.delete(index);
    void pending.then(url => { if (url) URL.revokeObjectURL(url); });
  }
  const root = document.getElementById('items')!;
  const expanded = new Set(Array.from(root.querySelectorAll<HTMLDetailsElement>('details[open]'), node => node.dataset.index));
  root.replaceChildren();
  for (const item of items) {
    const row = document.createElement('article');
    row.className = 'item-row';
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'item-action download';
    download.setAttribute('aria-label', `Download ${item.name}`);
    download.append(icon('M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5'));
    download.disabled = !item.downloadable;
    const preview = document.createElement('div');
    preview.className = 'item-preview';
    const glyphs = {
      file: 'M14 2H5v20h14V7zm0 0v5h5',
      text: 'M14 2H5v20h14V7zm0 0v5h5M8 12h8m-8 4h8',
      link: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18',
      image: 'M3 3h18v18H3zM3 17l5-5 4 4 3-3 6 6M16 7h1',
      video: 'M3 3h18v18H3zM10 8l6 4-6 4z',
    };
    preview.append(icon(glyphs[item.kind]));
    const name = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'item-name';
    title.textContent = item.name;
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const detail = document.createElement('span');
    detail.className = 'item-detail';
    detail.textContent = item.size === null ? 'Unavailable' : item.kind === 'link' ? 'Link' : item.text === undefined ? item.filename : 'Text';
    const sender = document.createElement('span');
    sender.className = 'sender';
    sender.textContent = item.sender;
    meta.append(detail, sender);
    name.append(title, meta);
    const info = document.createElement(item.text === undefined ? 'div' : 'details');
    info.className = 'item-info';
    if (info instanceof HTMLDetailsElement) {
      info.dataset.index = String(item.index);
      info.open = expanded.has(String(item.index));
      const summary = document.createElement('summary');
      summary.append(name);
      info.append(summary);
    } else info.append(name);
    download.addEventListener('click', () => busy(download, async () => {
      if (session !== current || !current.ready) throw new Error('Disconnected');
      if (!item.downloadable) return;
      const sink = await downloadSink();
      try {
        await request('file', { index: item.index }, undefined, progress('Downloading'), sink);
        sink.save(item.filename);
      }
      catch (error) { sink.abort(); throw error; }
    }));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'item-action';
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.append(icon('M5 12h14'));
    remove.disabled = !item.removable;
    remove.addEventListener('click', () => busy(remove, async () => {
      if (session !== current || !current.ready) throw new Error('Disconnected');
      await request('remove', { index: item.index });
      await refreshItems(current);
    }));
    row.append(download, preview, info, remove);
    if (typeof item.text === 'string') {
      const text = item.text;
      const field = document.createElement('textarea');
      field.readOnly = true;
      field.value = text;
      field.setAttribute('aria-label', 'Content');
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); statusElement.textContent = 'Copied'; }
        catch { field.focus(); field.select(); statusElement.textContent = 'Select and copy the text.'; }
      });
      info.append(field, copy);
      try {
        const url = new URL(text.trim());
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          const open = document.createElement('a');
          open.className = 'button';
          open.textContent = 'Open';
          open.href = url.href;
          open.target = '_blank';
          open.rel = 'noreferrer noopener';
          info.append(open);
        }
      } catch {}
    }
    root.append(row);
    if (item.kind === 'image' || item.kind === 'video') {
      current.thumbnails ??= new Map();
      let pending = current.thumbnails.get(item.index);
      if (!pending) {
        pending = request('thumbnail', { index: item.index })
          .then(blob => URL.createObjectURL(new Blob([blob], { type: 'image/png' })))
          .catch(() => { current.thumbnails?.delete(item.index); return undefined; });
        current.thumbnails.set(item.index, pending);
      }
      void pending.then(url => {
        if (!url || session !== current || !current.ready || !row.isConnected) return;
        const image = document.createElement('img');
        image.alt = '';
        image.src = url;
        preview.replaceChildren(image);
      });
    }
  }
}

function stopCamera() {
  scanning = false;
  cameraGeneration++;
  camera?.getTracks().forEach(track => track.stop());
  camera = undefined;
  document.querySelector('video')!.srcObject = null;
  document.getElementById('camera')!.hidden = true;
  document.body.classList.remove('scanning');
  applyUpdate();
}

scanButton.addEventListener('click', async () => {
  if (scanning) return;
  const generation = ++cameraGeneration;
  try {
    scanning = true;
    document.body.classList.add('scanning');
    document.getElementById('camera')!.hidden = false;
    statusElement.textContent = '';
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    if (generation !== cameraGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
    camera = stream;
    const video = document.querySelector('video')!;
    video.srcObject = camera;
    await video.play();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not open camera');
    let detector: InstanceType<NonNullable<Window['BarcodeDetector']>> | undefined;
    try { if (window.BarcodeDetector) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch {}
    let frame = 0;
    while (scanning && generation === cameraGeneration) {
      if (video.readyState >= 2 && video.videoWidth) {
        let value: string | undefined;
        if (detector) {
          try { value = (await detector.detect(video))[0]?.rawValue; }
          catch { detector = undefined; }
        }
        if (generation !== cameraGeneration) return;
        if (!value) {
          const crop = ++frame % 2 === 0 ? Math.min(video.videoWidth, video.videoHeight) * .8 : 0;
          const width = crop || video.videoWidth;
          const height = crop || video.videoHeight;
          const scale = Math.min(1, 1280 / Math.max(width, height));
          canvas.width = Math.round(width * scale);
          canvas.height = Math.round(height * scale);
          context.imageSmoothingEnabled = false;
          context.drawImage(video, (video.videoWidth - width) / 2, (video.videoHeight - height) / 2,
            width, height, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          value = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data;
        }
        if (value) {
          let info;
          try { info = invitation(value); } catch { statusElement.textContent = 'Scan an Orbit Share QR.'; }
          if (info) {
            stopCamera();
            await connect(info).catch(error => { statusElement.textContent = errorMessage(error) || 'Could not connect'; });
            break;
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  } catch (error) {
    if (generation !== cameraGeneration) return;
    stopCamera();
    statusElement.textContent = errorMessage(error) || 'Could not open camera';
    resumeConnection();
  }
});
document.getElementById('cancel-scan')!.addEventListener('click', () => {
  stopCamera();
  statusElement.textContent = '';
  scanButton.focus();
  resumeConnection();
});
document.getElementById('disconnect')!.addEventListener('click', disconnect);

const connectionForm = document.querySelector<HTMLFormElement>('#pair-link')!;
const connectionInput = document.querySelector<HTMLInputElement>('#connection-link')!;
const useLink = document.getElementById('use-link')!;
const pairHelp = document.getElementById('pair-help')!;
useLink.addEventListener('click', () => {
  const showLink = connectionForm.hidden;
  stopCamera();
  scanButton.hidden = showLink && document.getElementById('connected')!.hidden;
  connectionForm.hidden = !showLink;
  pairHelp.hidden = showLink;
  useLink.textContent = showLink ? 'Use camera' : 'Use a connection link';
  useLink.setAttribute('aria-expanded', String(showLink));
  if (showLink) connectionInput.focus();
  else scanButton.focus();
  resumeConnection();
});
connectionInput.addEventListener('input', () => connectionInput.removeAttribute('aria-invalid'));
connectionForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (scanButton.disabled) return;
  let info: DeviceInfo;
  try { info = invitation(connectionInput.value.trim()); }
  catch {
    statusElement.textContent = 'Invalid connection link.';
    connectionInput.setAttribute('aria-invalid', 'true');
    connectionInput.focus();
    return;
  }
  connectionInput.removeAttribute('aria-invalid');
  try {
    await connect(info);
    if (session?.ready) connectionInput.value = '';
  } catch (error) {
    statusElement.textContent = errorMessage(error) || 'Could not connect';
  }
});

async function uploadFiles(files: Iterable<File>) {
  for (const file of files) {
    await request('upload', { name: file.name }, file, progress('Uploading'));
  }
  if (session) await refreshItems(session);
}

async function sendText(value: string) {
  const payload = new Blob([value], { type: 'text/plain;charset=utf-8' });
  if (!value.trim()) throw new Error('Enter text.');
  if (payload.size > 1024 * 1024) throw new Error('Text exceeds 1 MiB.');
  await request('text', {}, payload);
  if (session) await refreshItems(session);
}

document.querySelector<HTMLFormElement>('#files')!.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  busy(form.querySelector('button')!, async () => {
    await uploadFiles(document.querySelector<HTMLInputElement>('#upload')!.files ?? []);
    form.reset();
  });
});
document.querySelector<HTMLFormElement>('#text')!.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  busy(form.querySelector('button')!, async () => {
    const value = document.querySelector<HTMLTextAreaElement>('#message')!.value;
    await sendText(value);
    form.reset();
    form.hidden = true;
  });
});

const uploadInput = document.querySelector<HTMLInputElement>('#upload')!;
const chooseFiles = document.querySelector<HTMLButtonElement>('#choose-files')!;
chooseFiles.addEventListener('click', () => uploadInput.click());
uploadInput.addEventListener('change', () => {
  if (uploadInput.files?.length) document.querySelector<HTMLFormElement>('#files')!.requestSubmit();
});
const pasteClipboard = document.querySelector<HTMLButtonElement>('#paste-clipboard')!;
pasteClipboard.addEventListener('click', async () => {
  pasteClipboard.disabled = true;
  try {
    const value = await navigator.clipboard.readText();
    await busy(pasteClipboard, () => sendText(value));
  } catch {
    document.querySelector<HTMLFormElement>('#text')!.hidden = false;
    document.querySelector<HTMLTextAreaElement>('#message')!.focus();
  } finally { pasteClipboard.disabled = false; }
});

const itemBox = document.getElementById('items')!;
let dragDepth = 0;
const acceptsDrop = (data: DataTransfer | null) => !!data && ['Files', 'text/plain', 'text/uri-list'].some(type => data.types.includes(type));
itemBox.addEventListener('dragenter', event => {
  if (!acceptsDrop(event.dataTransfer)) return;
  event.preventDefault();
  dragDepth++;
  itemBox.classList.add('dragging');
});
itemBox.addEventListener('dragover', event => {
  if (!acceptsDrop(event.dataTransfer)) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = 'copy';
});
itemBox.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; itemBox.classList.remove('dragging'); }
});
itemBox.addEventListener('drop', event => {
  event.preventDefault();
  dragDepth = 0;
  itemBox.classList.remove('dragging');
  const data = event.dataTransfer;
  if (!data || !session?.ready) return;
  const files = Array.from(data.files);
  const text = data.getData('text/plain') || data.getData('text/uri-list').split(/\r?\n/).filter(line => line && !line.startsWith('#')).join('\n');
  if (files.length) void busy(chooseFiles, () => uploadFiles(files));
  else if (text.trim()) void busy(pasteClipboard, () => sendText(text));
});
window.addEventListener('pagehide', event => {
  pageClosed = true;
  stopCamera();
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (!session) return;
  const downloadPreview = performance.now() < downloadNavigationUntil;
  if (downloadPreview && session.retry && !session.forgotten) {
    try { sessionStorage.setItem('orbit-download-peer', JSON.stringify({ fingerprint: session.info.fingerprint, share: session.info.share })); } catch {}
  }
  if (event.persisted || downloadPreview) disconnected(session);
  else stopConnection(session, true);
});
window.addEventListener('pageshow', () => {
  pageClosed = false;
  downloadNavigationUntil = 0;
  if (session) { try { sessionStorage.removeItem('orbit-download-peer'); } catch {} }
  resumeConnection();
  applyUpdate();
});
window.addEventListener('online', resumeConnection);
navigator.connection?.addEventListener('change', resumeConnection);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeConnection();
});
const appDisplayMode = matchMedia('(display-mode: standalone)');
const installation = document.getElementById('installation')!;
const installButton = document.querySelector<HTMLButtonElement>('#install')!;
const installTitle = document.getElementById('install-title')!;
const installHelp = document.getElementById('install-help')!;
const welcome = document.getElementById('welcome')!;
const sharePage = document.getElementById('share-page')!;
const pageQuery = new URLSearchParams(location.search);
const shareRequested = pageQuery.get('view') === 'share' || !!location.hash;
let appInstalled = false;
let started = false;

function installationInstructions() {
  const agent = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(agent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const firefox = /Firefox\/|FxiOS\//.test(agent);
  const other = /Edg|OPR|OPiOS|SamsungBrowser|Electron/.test(agent);
  const chrome = !other && /Chrome\/|Chromium\/|CriOS\//.test(agent);
  const safari = !other && !chrome && !firefox && /Safari\//.test(agent);
  if (ios) {
    if (chrome) return 'Chrome: Share → Add to Home Screen → Add.';
    if (safari) return 'Safari: Share → Add to Home Screen → Add.';
    return 'Open in Safari → Share → Add to Home Screen → Add.';
  }
  if (/Android/i.test(agent)) {
    if (firefox) return 'Firefox: ⋮ → Install → Add automatically.';
    if (chrome) return 'Chrome: ⋮ → Install and create shortcut → Install.';
    return 'Open in Chrome → ⋮ → Install and create shortcut → Install.';
  }
  if (firefox && /Windows/.test(agent)) return 'Firefox: Address bar → Add tab to taskbar.';
  if (safari) return 'Safari: File → Add to Dock → Add.';
  if (chrome) return 'Chrome: ⋮ → Cast, save, and share → Install page as app…';
  if (/Macintosh|Mac OS X/.test(agent)) return 'Open in Safari → File → Add to Dock → Add.';
  return 'Open in Chrome → ⋮ → Cast, save, and share → Install page as app…';
}

function updateInstallation() {
  const sharing = shareRequested || appInstalled || appDisplayMode.matches || navigator.standalone === true;
  welcome.hidden = sharing;
  sharePage.hidden = !sharing;
  installation.hidden = sharing;
  installButton.hidden = !installPrompt;
  installTitle.hidden = !!installPrompt;
  installHelp.hidden = !!installPrompt;
  installHelp.textContent = installationInstructions();
  if (sharing) start().catch(error => { statusElement.textContent = errorMessage(error); });
}

appDisplayMode.addEventListener('change', updateInstallation);
window.addEventListener('pageshow', updateInstallation);
window.addEventListener('appinstalled', () => {
  appInstalled = true;
  installPrompt = undefined;
  updateInstallation();
});
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  updateInstallation();
});
installButton.addEventListener('click', async () => {
  const prompt = installPrompt;
  if (!prompt) return;
  installPrompt = undefined;
  updateInstallation();
  try { await prompt.prompt(); }
  catch { statusElement.textContent = 'Use the installation steps above.'; }
});
updateInstallation();

if ('serviceWorker' in navigator) {
  const offline = document.getElementById('offline')!;
  const notice = document.getElementById('update-notice')!;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  let controlled = Boolean(navigator.serviceWorker.controller);
  let pending: ServiceWorker | undefined;
  let reloading = false;
  let changed = false;
  const prepared = new WeakSet<ServiceWorker>();
  const preparing = new WeakSet<ServiceWorker>();
  const notify = (text: string) => { notice.textContent = text; notice.hidden = false; };
  try {
    if (sessionStorage.getItem('orbit-updated')) {
      sessionStorage.removeItem('orbit-updated');
      notify('Updated');
      setTimeout(() => { notice.hidden = true; }, 4000);
    }
  } catch {}
  applyUpdate = () => {
    if ((!pending && !changed) || reloading) return;
    if (pageClosed || document.visibilityState !== 'visible') return;
    if (active || scanning || session?.connecting) { notify('Update ready · waiting'); return; }
    reloading = true;
    notify('Updating…');
    try {
      if (session?.ready) sessionStorage.setItem('orbit-update-peer', session.info.fingerprint);
    } catch {}
    if (changed) {
      try { sessionStorage.setItem('orbit-updated', 'true'); } catch {}
      location.reload();
    }
    else {
      const target = pending!;
      const timeout = setTimeout(() => {
        target.removeEventListener('statechange', activated);
        pending = undefined;
        reloading = false;
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.textContent = 'Reload';
        reload.addEventListener('click', () => { changed = true; applyUpdate(); });
        notice.replaceChildren('Update ready ', reload);
      }, 10000);
      const activated = () => {
        if (target.state !== 'activated') return;
        clearTimeout(timeout);
        target.removeEventListener('statechange', activated);
        if (changed) return;
        changed = true;
        reloading = false;
        applyUpdate();
      };
      target.addEventListener('statechange', activated);
      try { target.postMessage({ type: 'activate' }); }
      catch { clearTimeout(timeout); target.removeEventListener('statechange', activated); pending = undefined; reloading = false; notify('Update unavailable · reload to retry'); }
      activated();
    }
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controlled && !changed) { changed = true; reloading = false; applyUpdate(); }
    controlled = true;
  });
  const prepare = async (target: ServiceWorker, update: boolean) => {
    if (prepared.has(target) || preparing.has(target)) return;
    preparing.add(target);
    if (update) notify('Downloading update…');
    try {
      await new Promise<void>((resolve, reject) => {
        const channel = new MessageChannel();
        const finish = (ready: boolean) => {
          clearTimeout(timer);
          channel.port1.close();
          channel.port2.close();
          ready ? resolve() : reject(new Error('Offline setup failed'));
        };
        const timer = setTimeout(() => finish(false), 30000);
        channel.port1.onmessage = event => finish(event.data?.ready === true);
        try { target.postMessage({ type: 'prepare', update }, [channel.port2]); }
        catch { finish(false); }
      });
      prepared.add(target);
      if (update) { pending = target; applyUpdate(); }
      else { offline.textContent = 'Ready offline'; offline.hidden = local; }
    } catch {
      if (update) notify('Update unavailable · retrying later');
      else { offline.textContent = 'Offline setup failed. Reload to retry.'; offline.hidden = false; }
    } finally { preparing.delete(target); }
  };
  downloadReady = navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(registration => {
    const waiting = () => { if (registration.waiting) void prepare(registration.waiting, true); };
    const installing = () => {
      const target = registration.installing;
      target?.addEventListener('statechange', () => { if (target.state === 'installed') waiting(); });
    };
    registration.addEventListener('updatefound', installing);
    installing();
    waiting();
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      applyUpdate();
      waiting();
      void registration.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', check);
    setInterval(check, 15 * 60 * 1000);
    check();
    return navigator.serviceWorker.ready;
  }).then(async registration => {
    if (registration.active) void prepare(registration.active, false);
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve, reject) => {
      const changed = () => {
        if (!navigator.serviceWorker.controller) return;
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('controllerchange', changed);
        resolve();
      };
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('controllerchange', changed);
        reject(new Error('Downloads unavailable. Reload to retry.'));
      }, 10000);
      navigator.serviceWorker.addEventListener('controllerchange', changed);
      changed();
    });
  });
  void downloadReady.catch(() => { offline.textContent = 'Offline setup failed. Reload to retry.'; offline.hidden = false; });
}
async function start() {
  if (started) return;
  started = true;
  let initial: DeviceInfo | undefined;
  let resume = false;
  if (location.hash) {
    try { initial = invitation(location.href); }
    catch (error) { statusElement.textContent = errorMessage(error); }
    const url = new URL(location.href);
    url.hash = '';
    url.searchParams.set('view', 'share');
    history.replaceState(null, '', url.pathname + url.search);
  }
  try {
    const saved = await pairStore('list');
    pairs = saved.flatMap(value => {
      try {
        const info = validateInfo(value);
        return info.key ? [info] : [];
      } catch { return []; }
    }).sort((a, b) => b.last - a.last);
    renderPairs();
  } catch {}
  try {
    const previous = sessionStorage.getItem('orbit-update-peer');
    sessionStorage.removeItem('orbit-update-peer');
    if (!initial && previous) initial = pairs.find(pair => pair.fingerprint === previous);
  } catch {}
  try {
    const previous = sessionStorage.getItem('orbit-download-peer');
    sessionStorage.removeItem('orbit-download-peer');
    const peer: unknown = previous ? JSON.parse(previous) : undefined;
    if (!initial && isRecord(peer)) {
      initial = pairs.find(pair => pair.fingerprint === peer.fingerprint && pair.share === peer.share);
      resume = true;
    }
  } catch {}
  if (session || scanning) return;
  if (initial) await connect(initial, resume);
}
