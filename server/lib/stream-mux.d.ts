// Type declarations for the (still JS) server/lib/stream-mux module - issue
// #42 phase 2. The runtime module remains stream-mux.js; callers importing
// types get these structural declarations until stream-mux itself migrates.
import type { WebSocket } from 'ws';
import type { AppLogger } from './logger.ts';

export const FRAME_TYPE: Record<string, number>;
export const DEFAULT_PRIORITY: number;

// A multiplexed stream as observed by ws-server's handlers. The ad-hoc
// `_onData` / `_onEnd` / `_onError` / `_bufferedData` members are assigned by
// the WebSocket layer as data hooks (see stream-mux.js internals).
export interface MuxStreamLike {
  id: string;
  headers?: Record<string, unknown>;
  state?: string;
  reset(code: number): void;
  close(): void;
  sendData(data: Buffer): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
  _onData?: (chunk: Buffer) => void;
  _onEnd?: () => void;
  _onError?: (reason: string) => void;
  _bufferedData?: Buffer[];
}

export class StreamMux {
  constructor(
    ws: WebSocket,
    opts?: {
      logger?: AppLogger;
      initialWindow?: number;
      connectionWindow?: number;
    }
  );
  onStream(cb: (stream: MuxStreamLike) => void): void;
  destroy(): void;
  ping(cb: (rtt: number) => void): void;
}
