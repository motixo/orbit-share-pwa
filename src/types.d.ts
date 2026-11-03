interface PeerAddress {
  host: string;
  share: string;
  port: number;
  fingerprint: string;
  mdns?: string;
}

interface Invitation extends PeerAddress {
  token: string;
  key?: never;
  id?: never;
}

interface PairedDevice extends PeerAddress {
  id: string;
  key: CryptoKey;
  name: string;
  last: number;
  token?: never;
}

type DeviceInfo = Invitation | PairedDevice;

interface ShareSession {
  pc: RTCPeerConnection;
  control: RTCDataChannel;
  info: DeviceInfo;
  ready: boolean;
  connecting: boolean;
  retry: boolean;
  lastSeen: number;
  forgotten?: boolean;
  error?: string;
  name?: Promise<string>;
  refreshing?: boolean;
  itemsChanged?: boolean;
  itemsTimer?: ReturnType<typeof setTimeout>;
  itemsRevision?: number;
  thumbnails?: Map<number, Promise<string | undefined>>;
  requests?: {
    active: number;
    thumbnail: boolean;
    queued: Array<{ action: RequestAction; start(): void; reject(error: Error): void }>;
  };
}

type RequestAction = 'list' | 'file' | 'upload' | 'text' | 'remove' | 'thumbnail' | 'croc-file' | 'croc-upload' | 'croc-result' | 'croc-cancel';
type ControlAction = Exclude<RequestAction, 'file' | 'upload'>;
interface RequestFields {
  index?: number;
  name?: string;
  id?: string;
  size?: number;
  checksum?: string;
}

type CrocTicket = import('./transfer-types').CrocTicket;
type DownloadSink = import('./transfer-types').DownloadSink;
interface CrocPreparedFile { file: File; name: string; size: number; hash: Uint8Array; modified: string; compressed?: boolean }
declare const OrbitCroc: {
  prepare(payload: Blob, name: string, signal: AbortSignal): Promise<CrocPreparedFile[]>;
  transfer(pc: RTCPeerConnection, ticket: CrocTicket, signal: AbortSignal, progress: TransferProgress, prepared?: CrocPreparedFile[], sink?: DownloadSink): Promise<Blob>;
};
type TransferProgress = (done: number, total: number) => void;
interface ResponseHeader {
  status: number;
  size: number;
}

interface SharedItem {
  index: number;
  name: string;
  filename: string;
  downloadable: boolean;
  size: number | null;
  text?: string;
  sender: string;
  removable: boolean;
  kind: 'file' | 'text' | 'link' | 'image' | 'video';
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
}
interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent;
}
interface Navigator {
  readonly connection?: EventTarget;
  readonly standalone?: boolean;
  readonly userAgentData?: {
    getHighEntropyValues(hints: string[]): Promise<{ model?: string }>;
  };
}

interface Window {
  BarcodeDetector?: new (options: { formats: string[] }) => {
    detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
  };
}

declare function jsQR(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: { inversionAttempts: 'attemptBoth' },
): { data: string } | null;
