const routes = new Map<string, { pc: RTCPeerConnection; sockets: Set<WebSocket> }>();

export function route(id: string, pc: RTCPeerConnection) {
  const entry = { pc, sockets: new Set<WebSocket>() };
  routes.set(id, entry);
  return () => {
    routes.delete(id);
    for (const socket of entry.sockets) socket.close();
  };
}

// Croc's WebSocket gateway runs over the already authenticated local connection.
export class WebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  binaryType = 'arraybuffer';
  private dc: RTCDataChannel;
  private queued = 0;
  private tail = Promise.resolve();
  private closed = false;
  private opened = false;
  private failed = false;
  private timer: ReturnType<typeof setTimeout>;

  constructor(address: string) {
    super();
    const url = new URL(address);
    const id = url.pathname.slice('/croc/'.length);
    const port = url.searchParams.get('port');
    const entry = routes.get(id);
    if (!entry || !port || !/^\d{1,5}$/.test(port)) throw new Error('Unknown croc transfer');
    this.dc = entry.pc.createDataChannel(`croc:${id}:${port}`, { ordered: true });
    this.dc.binaryType = 'arraybuffer';
    this.dc.bufferedAmountLowThreshold = 512 * 1024;
    entry.sockets.add(this);
    this.timer = setTimeout(() => this.fail(), 15000);
    this.dc.addEventListener('open', () => { this.opened = true; clearTimeout(this.timer); this.dispatchEvent(new Event('open')); });
    this.dc.addEventListener('message', event => this.dispatchEvent(new MessageEvent('message', { data: event.data })));
    this.dc.addEventListener('error', () => this.fail());
    this.dc.addEventListener('close', () => {
      clearTimeout(this.timer);
      entry.sockets.delete(this);
      if (!this.closed) {
        if (!this.opened) this.fail();
        this.closed = true;
        this.dispatchEvent(new Event('close'));
      }
    });
  }

  get readyState() {
    return this.dc.readyState === 'open' ? WebSocket.OPEN : this.dc.readyState === 'connecting' ? WebSocket.CONNECTING : this.dc.readyState === 'closing' ? WebSocket.CLOSING : WebSocket.CLOSED;
  }
  get bufferedAmount() { return this.queued + this.dc.bufferedAmount; }

  consume(bytes: number) {
    if (this.readyState === WebSocket.OPEN) this.dc.send(`read:${bytes}`);
  }

  send(data: ArrayBuffer) {
    if (this.readyState !== WebSocket.OPEN) throw new Error('Disconnected');
    this.queued += data.byteLength;
    this.tail = this.tail.then(async () => {
      for (let offset = 0; offset < data.byteLength; offset += 16384) {
        if (this.dc.bufferedAmount > 1024 * 1024) await this.drain();
        if (this.readyState !== WebSocket.OPEN) throw new Error('Disconnected');
        const chunk = data.slice(offset, offset + 16384);
        this.dc.send(chunk);
        this.queued -= chunk.byteLength;
      }
    }).catch(() => this.fail());
  }

  private drain(): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.dc.removeEventListener('bufferedamountlow', finish);
        this.dc.removeEventListener('close', finish);
        this.readyState === WebSocket.OPEN ? resolve() : reject(new Error('Disconnected'));
      };
      const timer = setTimeout(() => { this.fail(); finish(); }, 60000);
      this.dc.addEventListener('bufferedamountlow', finish, { once: true });
      this.dc.addEventListener('close', finish, { once: true });
      if (this.dc.bufferedAmount <= this.dc.bufferedAmountLowThreshold || this.readyState !== WebSocket.OPEN) finish();
    });
  }

  private fail() {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.dispatchEvent(new Event('error'));
    this.close();
  }

  close() { clearTimeout(this.timer); this.dc.close(); }
}
