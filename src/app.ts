const statusElement = document.getElementById('status')!;
const scanButton = document.querySelector<HTMLButtonElement>('#scan')!;
let session: ShareSession | undefined;
let camera: MediaStream | undefined;
let scanning = false;
let installPrompt: BeforeInstallPromptEvent | undefined;
let active = 0;
let pairs: PairedDevice[] = [];
let pairingDB: Promise<IDBDatabase> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let retryDelay = 1000;
let pageClosed = false;

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

function disconnected(current: ShareSession) {
  if (session !== current) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  current.ready = false;
  document.getElementById('connected')!.hidden = true;
  statusElement.textContent = current.forgotten ? 'Forgotten' : current.error || 'Disconnected';
  if (current.pc.connectionState !== 'closed') current.pc.close();
  renderPairs();
  scheduleReconnect(current);
}

function resumeConnection() {
  const current = session;
  if (!current || current.forgotten || !current.retry || current.connecting || pageClosed || scanning) return;
  if (current.ready && current.control.readyState === 'open') {
    current.lastSeen = performance.now();
    try { current.control.send('ping'); } catch { disconnected(current); }
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
  const root = document.getElementById('paired')!;
  root.replaceChildren();
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
    forget.addEventListener('click', async () => {
      forget.disabled = true;
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
        forget.disabled = false;
        statusElement.textContent = errorMessage(error);
      }
    });
    row.append(name, button, forget);
    root.append(row);
  }
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
    typeof message.fingerprint !== 'string' || message.fingerprint.toUpperCase() !== current.info.fingerprint.toUpperCase()) throw new Error('Invalid device');
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
    host: message.host, port: message.port, fingerprint: message.fingerprint,
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

async function connect(info: DeviceInfo, retry = false) {
  info = validateInfo(info);
  stopCamera();
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
  if (!retry) retryDelay = 1000;
  const previous = session;
  session = undefined;
  previous?.pc.close();
  scanButton.disabled = true;
  document.getElementById('connected')!.hidden = true;
  statusElement.textContent = 'Connecting…';
  const pc = new RTCPeerConnection({ iceServers: [] });
  const control = pc.createDataChannel('orbit', { ordered: true });
  const current: ShareSession = { pc, control, info, ready: false, connecting: true, retry: true, lastSeen: performance.now() };
  session = current;
  renderPairs();
  control.addEventListener('message', event => {
    if (session !== current) return;
    if (event.data === 'ping' || event.data === 'pong') {
      current.heartbeat = true;
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
        if (message.type === 'challenge') {
          if (!info.key || typeof message.value !== 'string' ||
            !message.value.startsWith('orbit-pair-v1\n' + info.fingerprint + '\n') ||
            !/^[0-9a-f]{64}$/.test(message.value.split('\n')[2] || '') || message.value.split('\n').length !== 3) throw new Error('Invalid challenge');
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
    const timer = setTimeout(() => { reject(new Error('Could not connect')); disconnected(current); }, 8000);
    const closed = () => { clearTimeout(timer); reject(new Error('Disconnected')); };
    control.addEventListener('close', closed, { once: true });
    control.addEventListener('open', () => control.send(info.key ? JSON.stringify({ type: 'auth', id: info.id }) : info.token), { once: true });
    control.addEventListener('message', function ready(event) {
      if (event.data === 'rejected' || event.data === 'unavailable') {
        clearTimeout(timer);
        current.retry = event.data !== 'rejected';
        current.error = event.data === 'rejected' ? 'Device not paired. Scan again.' : 'Open Orbit Share.';
        reject(new Error(current.error));
        disconnected(current);
        return;
      }
      if (event.data !== 'ready') return;
      clearTimeout(timer);
      control.removeEventListener('message', ready);
      current.ready = true;
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
      'a=sctp-port:5000', 'a=max-message-size:16384',
      ...(info.mdns ? ['a=candidate:2 1 UDP 2 ' + info.mdns + ' ' + info.port + ' typ host'] : []),
      'a=candidate:1 1 UDP 1 ' + info.host + ' ' + info.port + ' typ host', 'a=end-of-candidates', '',
    ].join('\r\n');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    await opened;
    if (session !== current) { pc.close(); return; }
    retryDelay = 1000;
    heartbeatTimer = setInterval(() => {
      if (session !== current || current.forgotten) return;
      if (current.heartbeat && performance.now() - current.lastSeen >= 6000) disconnected(current);
      else {
        try { control.send('ping'); } catch { disconnected(current); }
      }
    }, 2000);
    await listItems(current);
    if (session !== current || !current.ready) return;
    document.getElementById('connected')!.hidden = false;
    statusElement.textContent = 'Connected';
  } catch (error) {
    if (session !== current) return;
    current.error = errorMessage(error);
    disconnected(current);
  } finally {
    current.connecting = false;
    if (session === current) { scanButton.disabled = active > 0; renderPairs(); }
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

async function request(action: RequestAction, fields: RequestFields = {}, payload?: Blob, progress?: TransferProgress): Promise<Blob> {
  if (!session?.ready) throw new Error('Scan the QR first.');
  const pc = session.pc;
  const dc = pc.createDataChannel('request', { ordered: true });
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
    dc.addEventListener('message', async event => {
      try {
        reset();
        if (typeof event.data === 'string') {
          const message: unknown = JSON.parse(event.data);
          if (!isRecord(message)) throw new Error('Invalid response');
          if (message.type === 'response') {
            if (header || typeof message.status !== 'number' || !Number.isInteger(message.status) ||
              typeof message.size !== 'number' || !Number.isInteger(message.size) || message.size < -1 || message.size > 1024 ** 3) throw new Error('Invalid response');
            header = { status: message.status, size: message.size };
          } else if (message.type === 'error') {
            throw new Error(typeof message.message === 'string' && message.message || 'Transfer failed');
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
          if (received > 1024 ** 3 || header.size >= 0 && received > header.size) throw new Error('Invalid file size');
          chunks.push(event.data);
          if (!payload) progress?.(received, header.size);
        }
      } catch (error) { fail(error); }
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
            progress?.(Math.min(offset + data.byteLength, payload.size), payload.size);
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
  finally { active--; button.disabled = false; scanButton.disabled = active > 0; renderPairs(); }
}

function progress(label: string): TransferProgress {
  return (done, total) => {
    statusElement.textContent = label + (total > 0 ? ' · ' + Math.min(100, Math.floor(done * 100 / total)) + '%' : '');
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

async function listItems(current: ShareSession) {
  const response = await request('list');
  const items = validateItems(JSON.parse(await response.text()));
  if (session !== current || !current.ready) return;
  const root = document.getElementById('items')!;
  root.replaceChildren();
  for (const item of items) {
    const row = document.createElement('article');
    const name = document.createElement('div');
    name.className = 'filename';
    name.textContent = item.name;
    row.append(name);
    const download = document.createElement('button');
    download.textContent = 'Download';
    download.disabled = item.size === null;
    download.addEventListener('click', () => busy(download, async () => {
      const blob = await request('file', { index: item.index }, undefined, progress('Downloading'));
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = item.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }));
    row.append(download);
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
      row.append(field, copy);
      try {
        const url = new URL(text.trim());
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          const open = document.createElement('a');
          open.className = 'button';
          open.textContent = 'Open';
          open.href = url.href;
          open.target = '_blank';
          open.rel = 'noreferrer noopener';
          row.append(open);
        }
      } catch {}
    }
    root.append(row);
  }
}

function stopCamera() {
  scanning = false;
  camera?.getTracks().forEach(track => track.stop());
  camera = undefined;
  document.querySelector('video')!.srcObject = null;
  document.getElementById('camera')!.hidden = true;
}

scanButton.addEventListener('click', async () => {
  if (scanning) return;
  try {
    scanning = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 960 } }, audio: false });
    if (!scanning) { stopCamera(); return; }
    const video = document.querySelector('video')!;
    video.srcObject = camera;
    document.getElementById('camera')!.hidden = false;
    await video.play();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not open camera');
    while (scanning) {
      if (video.readyState >= 2 && video.videoWidth) {
        canvas.width = Math.min(960, video.videoWidth);
        canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
        if (code) {
          let info;
          try { info = invitation(code.data); } catch { statusElement.textContent = 'Scan an Orbit Share QR.'; }
          if (info) { stopCamera(); await connect(info); break; }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  } catch (error) {
    stopCamera();
    statusElement.textContent = errorMessage(error) || 'Could not open camera';
    resumeConnection();
  }
});
document.getElementById('cancel-scan')!.addEventListener('click', () => { stopCamera(); resumeConnection(); });

document.querySelector<HTMLFormElement>('#files')!.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  busy(form.querySelector('button')!, async () => {
    for (const file of document.querySelector<HTMLInputElement>('#upload')!.files ?? []) {
      if (file.size > 1024 ** 3) throw new Error('File exceeds 1 GiB.');
      await request('upload', { name: file.name }, file, progress('Uploading'));
    }
    form.reset();
  });
});
document.querySelector<HTMLFormElement>('#text')!.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  busy(form.querySelector('button')!, async () => {
    const value = document.querySelector<HTMLTextAreaElement>('#message')!.value;
    const payload = new Blob([value], { type: 'text/plain;charset=utf-8' });
    if (!value.trim()) throw new Error('Enter text.');
    if (payload.size > 1024 * 1024) throw new Error('Text exceeds 1 MiB.');
    await request('text', {}, payload);
    form.reset();
  });
});
window.addEventListener('pagehide', () => {
  pageClosed = true;
  stopCamera();
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (session) disconnected(session);
});
window.addEventListener('pageshow', () => { pageClosed = false; resumeConnection(); });
window.addEventListener('online', resumeConnection);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeConnection();
});
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  document.querySelector<HTMLButtonElement>('#install')!.hidden = false;
});
document.querySelector<HTMLButtonElement>('#install')!.addEventListener('click', async () => {
  await installPrompt?.prompt();
  installPrompt = undefined;
  document.querySelector<HTMLButtonElement>('#install')!.hidden = true;
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => {
    document.getElementById('offline')!.textContent = matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'Ready offline' : 'Ready offline · Add to Home Screen';
  }).catch(() => { document.getElementById('offline')!.textContent = 'Offline setup failed. Reload to retry.'; });
}
async function start() {
  let initial: DeviceInfo | undefined;
  if (location.hash) {
    try { initial = invitation(location.href); }
    catch (error) { statusElement.textContent = errorMessage(error); }
    history.replaceState(null, '', location.pathname);
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
  if (session || scanning) return;
  const info = initial || pairs[0];
  if (info) await connect(info);
}
start().catch(error => { statusElement.textContent = errorMessage(error); });
