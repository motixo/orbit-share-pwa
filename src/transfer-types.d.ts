export interface CrocTicket { id: string; secret: string; password: string; port: string; name: string; size: number; verify: boolean }

export interface DownloadSink {
  prepare(size: number): Promise<void>;
  writeAt(position: number, data: ArrayBuffer): Promise<void>;
  finish(): Promise<File>;
  abort(): void;
}
