// Type declarations for the (still JS) server/lib/stream-mux module - issue
// #42 phase 2. The runtime module remains stream-mux.js; callers importing
// types get these structural declarations until stream-mux itself migrates.
import type { WebSocket } from 'ws';
import type { AppLogger } from './logger.ts';

export const FRAME_TYPE: Record<string, number>;
export const DEFAULT_PRIORITY: number;

// A multiplexed stream as observed by the WebSocket/proxy layers. The ad-hoc
// `_onHeaders` / `_onData` / `_onEnd` / `_onError` / `_bufferedData` members
// are installed by callers as data hooks (see stream-mux.js internals);
// `sendHeaders` / `sendData` / `reset` / `close` are the outbound direction.
export interface MuxStreamLike {
  id: string;
  headers?: Record<string, unknown> | null;
  state?: string;
  sendHeaders(headers: Record<string, unknown>, endStream?: boolean): void;
  sendData(data: Buffer, endStream?: boolean): void;
  reset(code?: number): void;
  close(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
  _onHeaders?: (headers: Record<string, unknown>, endStream: boolean) => void;
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
  createStream(priority?: number): MuxStreamLike;
  destroy(): void;
  ping(cb: (rtt: number) => void): void;
}
