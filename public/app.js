'use strict';

const status = document.getElementById('status');
const scanButton = document.getElementById('scan');
let session;
let camera;
let scanning = false;
let installPrompt;
let active = 0;
let pairs = [];
let pairingDB;
const deviceID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function pairStore(action, value) {
  pairingDB ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('orbit-pairing', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('devices', { keyPath: 'fingerprint' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not open device storage'));
  });
  const db = await pairingDB;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('devices', action === 'list' ? 'readonly' : 'readwrite');
    const store = transaction.objectStore('devices');
    const request = action === 'put' ? store.put(value) : action === 'delete' ? store.delete(value) : store.getAll();
    let result;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = transaction.onabort = () => reject(new Error('Could not save device'));
  });
}

function renderPairs() {
  const root = document.getElementById('paired');
  root.replaceChildren();
  for (const info of pairs) {
    const row = document.createElement('article');
    const name = document.createElement('span');
    name.className = 'computer';
    name.textContent = info.name || 'Computer';
    const button = document.createElement('button');
    button.textContent = 'Connect';
    button.disabled = active > 0 || session && (!session.ready || session.forgotten) && session.pc.connectionState !== 'closed';
    button.addEventListener('click', () => connect(info).catch(error => { status.textContent = error.message; }));
    const forget = document.createElement('button');
    forget.textContent = 'Forget';
    forget.disabled = active > 0 || session?.forgotten && session.info.fingerprint === info.fingerprint;
    forget.addEventListener('click', async () => {
      forget.disabled = true;
      const current = session?.info.fingerprint === info.fingerprint ? session : undefined;
      if (current) current.forgotten = true;
      try {
        if (current?.ready) await revokeDevice(current);
        await pairStore('delete', info.fingerprint);
        pairs = pairs.filter(pair => pair.fingerprint !== info.fingerprint);
        if (session?.info.fingerprint === info.fingerprint) {
          session.forgotten = true;
          session.pc.close();
          status.textContent = 'Forgotten';
        }
        renderPairs();
      } catch (error) {
        if (current) current.forgotten = false;
        forget.disabled = false;
        status.textContent = error.message;
      }
    });
    row.append(name, button, forget);
    root.append(row);
  }
}

function revokeDevice(current) {
  return new Promise((resolve, reject) => {
    const control = current.control;
    const cleanup = () => {
      clearTimeout(timer);
      control.removeEventListener('message', message);
      control.removeEventListener('close', closed);
    };
    const closed = () => { cleanup(); reject(new Error('Could not forget device. Try again.')); };
    const message = event => {
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

async function rememberDevice(message, current) {
  if (session !== current || current.forgotten || !current.ready || !deviceID.test(message.id) ||
    message.fingerprint?.toUpperCase() !== current.info.fingerprint.toUpperCase()) throw new Error('Invalid device');
  let key = current.info.key;
  if (message.token) {
    if (!/^[0-9a-f]{64}$/i.test(message.token)) throw new Error('Invalid device');
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
  if (current.forgotten) return;
  await pairStore('put', info);
  if (current.forgotten) { await pairStore('delete', info.fingerprint); return; }
  current.info = info;
  pairs = [info, ...pairs.filter(pair => pair.fingerprint !== info.fingerprint)];
  renderPairs();
}

function invitation(value) {
  const url = new URL(value);
  if (url.origin !== location.origin || url.hash.length > 2048) throw new Error('Invalid QR');
  const data = atob(url.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/'));
  let info;
  if (data.charCodeAt(0) === 1) {
    if (data.length !== 71) throw new Error('Invalid QR');
    const bytes = Uint8Array.from(data, char => char.charCodeAt(0));
    const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
    info = {
      host: Array.from(bytes.slice(1, 5)).join('.'),
      port: bytes[5] * 256 + bytes[6],
      fingerprint: hex(bytes.slice(7, 39)).join(':'),
      token: hex(bytes.slice(39)).join(''),
    };
  } else {
    info = JSON.parse(data);
  }
  return validateInfo(info);
}

function validateInfo(info) {
  if (!info || typeof info.host !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(info.host)) throw new Error('Invalid address');
  const octets = info.host.split('.').map(Number);
  if (octets.some(n => n > 255) || !(octets[0] === 10 || octets[0] === 192 && octets[1] === 168 ||
    octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 169 && octets[1] === 254)) throw new Error('Local network required');
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 ||
    typeof info.fingerprint !== 'string' || !/^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(info.fingerprint)) throw new Error('Invalid QR');
  if (info.key) {
    if (!deviceID.test(info.id) || !(info.key instanceof CryptoKey) || info.key.extractable ||
      info.key.type !== 'secret' || info.key.algorithm.name !== 'HMAC' ||
      info.key.algorithm.hash?.name !== 'SHA-256' || !info.key.usages.includes('sign')) throw new Error('Invalid device');
  } else if (!/^[0-9a-f]{64}$/i.test(info.token)) throw new Error('Invalid QR');
  if (info.mdns && (typeof info.mdns !== 'string' || !info.mdns.endsWith('.local') ||
    !deviceID.test(info.mdns.slice(0, -6)))) throw new Error('Invalid device');
  info.fingerprint = info.fingerprint.toUpperCase();
  return info;
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

async function connect(info) {
  info = validateInfo(info);
  stopCamera();
  session?.pc.close();
  scanButton.disabled = true;
  document.getElementById('connected').hidden = true;
  status.textContent = 'Connecting…';
  const pc = new RTCPeerConnection({ iceServers: [] });
  const control = pc.createDataChannel('orbit', { ordered: true });
  const current = { pc, control, info, ready: false };
  session = current;
  renderPairs();
  control.addEventListener('message', event => {
    if (event.data === 'device-info' || event.data === 'pairing') {
      current.name ??= deviceName();
      current.name.then(name => {
        if (control.readyState === 'open' && (name || event.data === 'pairing')) {
          control.send(JSON.stringify({ type: event.data === 'pairing' ? 'pair' : 'device', name }));
        }
      }).catch(() => {});
    } else if (typeof event.data === 'string' && event.data.startsWith('{')) {
      (async () => {
        const message = JSON.parse(event.data);
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
          status.textContent = 'Could not remember device';
        }
      })().catch(error => {
        if (session !== current) return;
        status.textContent = error.message;
        if (!current.ready) { current.error = error.message; pc.close(); }
      });
    }
  });
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pc.close(); reject(new Error('Could not connect. Open Orbit Share, or scan again.')); }, 15000);
    const closed = () => { clearTimeout(timer); reject(new Error('Disconnected')); };
    control.addEventListener('close', closed, { once: true });
    control.addEventListener('open', () => control.send(info.key ? JSON.stringify({ type: 'auth', id: info.id }) : info.token), { once: true });
    control.addEventListener('message', function ready(event) {
      if (event.data === 'rejected' || event.data === 'unavailable') {
        clearTimeout(timer);
        reject(new Error(event.data === 'rejected' ? 'Device not paired. Scan again.' : 'Open Orbit Share.'));
        pc.close();
        return;
      }
      if (event.data !== 'ready') return;
      clearTimeout(timer);
      control.removeEventListener('message', ready);
      current.ready = true;
      resolve();
    });
  });
  opened.catch(() => {});
  pc.addEventListener('connectionstatechange', () => {
    if (session !== current || !['disconnected', 'failed', 'closed'].includes(pc.connectionState)) return;
    current.ready = false;
    document.getElementById('connected').hidden = true;
    status.textContent = current.forgotten ? 'Forgotten' : current.error || 'Disconnected';
    if (pc.connectionState !== 'closed') pc.close();
    renderPairs();
  });
  try {
    await pc.setLocalDescription(await pc.createOffer());
    const password = pc.localDescription.sdp.match(/^a=ice-pwd:(.+)$/m)?.[1].trim();
    if (!password || !/^[a-zA-Z0-9+/]{22,239}$/.test(password)) throw new Error('Unsupported browser');
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
    await listItems();
    document.getElementById('connected').hidden = false;
    status.textContent = 'Connected';
  } catch (error) {
    current.error = error.message;
    pc.close();
    throw error;
  } finally {
    if (session === current) { scanButton.disabled = active > 0; renderPairs(); }
  }
}

function drain(dc, signal) {
  if (dc.readyState !== 'open') return Promise.reject(new Error('Disconnected'));
  if (dc.bufferedAmount <= 65536) return Promise.resolve();
  return new Promise((resolve, reject) => {
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

async function request(action, fields = {}, payload, progress) {
  if (!session?.ready) throw new Error('Scan the QR first.');
  const pc = session.pc;
  const dc = pc.createDataChannel('request', { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 65536;
  const abort = new AbortController();
  let header;
  let received = 0;
  let finished = false;
  let timer;
  const chunks = [];
  const response = new Promise((resolve, reject) => {
    const fail = error => {
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
          const message = JSON.parse(event.data);
          if (message.type === 'response') {
            if (header || !Number.isInteger(message.status) || !Number.isInteger(message.size) || message.size > 1024 ** 3) throw new Error('Invalid response');
            header = message;
          } else if (message.type === 'error') {
            throw new Error(message.message || 'Transfer failed');
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

async function busy(button, action) {
  active++;
  button.disabled = true;
  scanButton.disabled = true;
  renderPairs();
  try { await action(); status.textContent = 'Done'; }
  catch (error) { status.textContent = error.message || 'Transfer failed'; }
  finally { active--; button.disabled = false; scanButton.disabled = active > 0; renderPairs(); }
}

function progress(label) {
  return (done, total) => {
    status.textContent = label + (total > 0 ? ' · ' + Math.min(100, Math.floor(done * 100 / total)) + '%' : '');
  };
}

async function listItems() {
  const response = await request('list');
  const items = JSON.parse(await response.text());
  if (!Array.isArray(items)) throw new Error('Invalid file list');
  const root = document.getElementById('items');
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
      const field = document.createElement('textarea');
      field.readOnly = true;
      field.value = item.text;
      field.setAttribute('aria-label', 'Content');
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(item.text); status.textContent = 'Copied'; }
        catch { field.focus(); field.select(); status.textContent = 'Select and copy the text.'; }
      });
      row.append(field, copy);
      try {
        const url = new URL(item.text.trim());
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
  document.querySelector('video').srcObject = null;
  document.getElementById('camera').hidden = true;
}

scanButton.addEventListener('click', async () => {
  if (scanning) return;
  try {
    scanning = true;
    camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 960 } }, audio: false });
    if (!scanning) { stopCamera(); return; }
    const video = document.querySelector('video');
    video.srcObject = camera;
    document.getElementById('camera').hidden = false;
    await video.play();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    while (scanning) {
      if (video.readyState >= 2 && video.videoWidth) {
        canvas.width = Math.min(960, video.videoWidth);
        canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
        if (code) {
          let info;
          try { info = invitation(code.data); } catch { status.textContent = 'Scan an Orbit Share QR.'; }
          if (info) { stopCamera(); await connect(info); break; }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  } catch (error) { stopCamera(); status.textContent = error.message || 'Could not open camera'; }
});
document.getElementById('cancel-scan').addEventListener('click', stopCamera);

document.getElementById('files').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  busy(form.querySelector('button'), async () => {
    for (const file of document.getElementById('upload').files) {
      if (file.size > 1024 ** 3) throw new Error('File exceeds 1 GiB.');
      await request('upload', { name: file.name }, file, progress('Uploading'));
    }
    form.reset();
  });
});
document.getElementById('text').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  busy(form.querySelector('button'), async () => {
    const value = document.getElementById('message').value;
    const payload = new Blob([value], { type: 'text/plain;charset=utf-8' });
    if (!value.trim()) throw new Error('Enter text.');
    if (payload.size > 1024 * 1024) throw new Error('Text exceeds 1 MiB.');
    await request('text', {}, payload);
    form.reset();
  });
});
window.addEventListener('pagehide', () => { stopCamera(); session?.pc.close(); });
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  document.getElementById('install').hidden = false;
});
document.getElementById('install').addEventListener('click', async () => {
  await installPrompt?.prompt();
  installPrompt = undefined;
  document.getElementById('install').hidden = true;
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => {
    document.getElementById('offline').textContent = matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'Ready offline' : 'Ready offline · Add to Home Screen';
  }).catch(() => { document.getElementById('offline').textContent = 'Offline setup failed. Reload to retry.'; });
}
async function start() {
  let initial;
  if (location.hash) {
    try { initial = invitation(location.href); }
    catch (error) { status.textContent = error.message; }
    history.replaceState(null, '', location.pathname);
  }
  try {
    const saved = await pairStore('list');
    pairs = saved.filter(info => {
      try { return Boolean(info.key && validateInfo(info)); } catch { return false; }
    }).sort((a, b) => (b.last || 0) - (a.last || 0));
    renderPairs();
  } catch {}
  if (session || scanning) return;
  const info = initial || pairs[0];
  if (info) await connect(info);
}
start().catch(error => { status.textContent = error.message; });
