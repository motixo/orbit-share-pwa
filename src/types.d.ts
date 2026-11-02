interface PeerAddress {
  host: string;
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
  heartbeat?: boolean;
  forgotten?: boolean;
  error?: string;
  name?: Promise<string>;
  refreshing?: boolean;
  itemsChanged?: boolean;
  itemsTimer?: ReturnType<typeof setTimeout>;
  itemsRevision?: number;
  thumbnails?: Map<number, Promise<string | undefined>>;
}

type RequestAction = 'list' | 'file' | 'upload' | 'text' | 'remove' | 'thumbnail';
interface RequestFields {
  index?: number;
  name?: string;
}
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
  source: 'desktop' | 'mobile';
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
  readonly standalone?: boolean;
  readonly userAgentData?: {
    getHighEntropyValues(hints: string[]): Promise<{ model?: string }>;
  };
}

declare function jsQR(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: { inversionAttempts: 'dontInvert' },
): { data: string } | null;
