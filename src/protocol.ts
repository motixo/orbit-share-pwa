const deviceID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invitation(value: string): DeviceInfo {
  const url = new URL(value);
  if (url.origin !== location.origin || url.hash.length > 2048) throw new Error('Invalid QR');
  const data = atob(url.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/'));
  let info: unknown;
  if (data.charCodeAt(0) === 1) {
    if (data.length !== 71) throw new Error('Invalid QR');
    const bytes = Uint8Array.from(data, char => char.charCodeAt(0));
    const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
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

function validateInfo(value: unknown): DeviceInfo {
  if (!isRecord(value) || typeof value.host !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value.host)) throw new Error('Invalid address');
  const octets = value.host.split('.').map(Number);
  if (octets.some(n => n > 255) || !(octets[0] === 10 || octets[0] === 192 && octets[1] === 168 ||
    octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 169 && octets[1] === 254)) throw new Error('Local network required');
  if (typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
    typeof value.fingerprint !== 'string' || !/^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(value.fingerprint)) throw new Error('Invalid QR');
  if (value.mdns !== undefined && (typeof value.mdns !== 'string' || value.mdns !== '' &&
    (!value.mdns.endsWith('.local') || !deviceID.test(value.mdns.slice(0, -6))))) throw new Error('Invalid device');
  const address: PeerAddress = {
    host: value.host, port: value.port, fingerprint: value.fingerprint.toUpperCase(),
    mdns: typeof value.mdns === 'string' ? value.mdns : undefined,
  };
  if (value.key) {
    if (typeof value.id !== 'string' || !deviceID.test(value.id) || !(value.key instanceof CryptoKey) || value.key.extractable ||
      value.key.type !== 'secret' || value.key.algorithm.name !== 'HMAC' ||
      (value.key.algorithm as HmacKeyAlgorithm).hash?.name !== 'SHA-256' || !value.key.usages.includes('sign')) throw new Error('Invalid device');
    return {
      ...address, id: value.id, key: value.key,
      name: typeof value.name === 'string' ? value.name.slice(0, 80) : 'Computer',
      last: typeof value.last === 'number' && Number.isFinite(value.last) ? value.last : 0,
    };
  }
  if (typeof value.token !== 'string' || !/^[0-9a-f]{64}$/i.test(value.token)) throw new Error('Invalid QR');
  return { ...address, token: value.token };
}

function validateItems(value: unknown): SharedItem[] {
  if (!Array.isArray(value)) throw new Error('Invalid file list');
  return value.map((item: unknown) => {
    if (!isRecord(item) || typeof item.index !== 'number' || !Number.isSafeInteger(item.index) || item.index < 0 ||
      typeof item.name !== 'string' || item.size !== null && (typeof item.size !== 'number' ||
        !Number.isSafeInteger(item.size) || item.size < 0) ||
      item.text != null && typeof item.text !== 'string' ||
      item.filename !== undefined && typeof item.filename !== 'string' ||
      item.downloadable !== undefined && typeof item.downloadable !== 'boolean' ||
      item.source !== undefined && item.source !== 'desktop' && item.source !== 'mobile' ||
      item.sender !== undefined && typeof item.sender !== 'string' ||
      item.removable !== undefined && typeof item.removable !== 'boolean' ||
      item.kind !== undefined && (typeof item.kind !== 'string' || !['file', 'text', 'link', 'image', 'video'].includes(item.kind))) throw new Error('Invalid file list');
    return {
      index: item.index, name: item.name, size: item.size,
      filename: typeof item.filename === 'string' ? item.filename : item.name,
      downloadable: item.size !== null && (typeof item.downloadable === 'boolean' ? item.downloadable : item.source !== 'mobile'),
      text: typeof item.text === 'string' ? item.text : undefined,
      source: item.source === 'mobile' ? 'mobile' : 'desktop',
      sender: typeof item.sender === 'string' && item.sender.trim() ? item.sender.slice(0, 256) : item.source === 'mobile' ? 'Mobile' : 'Desktop',
      removable: item.removable === true,
      kind: typeof item.kind === 'string' ? item.kind as SharedItem['kind'] : typeof item.text === 'string' ? 'text' : 'file',
    };
  });
}
