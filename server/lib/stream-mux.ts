// =============================================================================
// StreamMux - HTTP/2-style stream multiplexing over WebSocket
// Phase 4: WebSocket 连接复用
// Migrated to TypeScript (issue #42, Phase 2). ESM syntax; loaded by
// require('./lib/stream-mux.ts') under Node >= 24 type stripping. Runtime
// behaviour is identical to the previous stream-mux.js: stream ids are
// numeric, callers that use them as tunnel keys see string | number.
// =============================================================================
// Frame format (binary):
//   [4 bytes: length] [1 byte: type] [4 bytes: stream_id] [4 bytes: flags] [payload]
//
// Frame types:
//   0x01 HEADERS      - Stream metadata (method, url, headers)
//   0x02 DATA         - Stream payload data
//   0x03 PRIORITY     - Stream priority change
//   0x04 RST_STREAM   - Reset/kill stream
//   0x05 GOAWAY       - Graceful shutdown
//   0x06 WINDOW_UPDATE - Flow control window update
//   0x07 PING         - Keepalive + RTT measurement
//   0x08 PONG         - Ping response
//   0x09 BATCH        - Multiple frames batched together
//   0x0A HEADERS_END  - Final HEADERS frame (no more DATA expected)
//   0x0B TUNNEL_OPEN  - SOCKS5 tunnel open request
//   0x0C TUNNEL_DATA  - Tunnel data
//   0x0D TUNNEL_CLOSE - Tunnel close
// =============================================================================

import type { WebSocket, RawData } from 'ws';
import type { AppLogger } from './logger.ts';

export const FRAME_TYPE = {
  HEADERS: 0x01,
  DATA: 0x02,
  PRIORITY: 0x03,
  RST_STREAM: 0x04,
  GOAWAY: 0x05,
  WINDOW_UPDATE: 0x06,
  PING: 0x07,
  PONG: 0x08,
  BATCH: 0x09,
  HEADERS_END: 0x0a,
  TUNNEL_OPEN: 0x0b,
  TUNNEL_DATA: 0x0c,
  TUNNEL_CLOSE: 0x0d,
} as const;
export type FrameType = (typeof FRAME_TYPE)[keyof typeof FRAME_TYPE];

export const FLAG = {
  END_STREAM: 0x01,
  END_HEADERS: 0x02,
  PRIORITY: 0x04,
  PADDED: 0x08,
} as const;

export const STREAM_STATE = {
  IDLE: 'idle',
  RESERVED: 'reserved',
  OPEN: 'open',
  HALF_CLOSED_LOCAL: 'half_closed_local',
  HALF_CLOSED_REMOTE: 'half_closed_remote',
  CLOSED: 'closed',
} as const;
export type StreamState = (typeof STREAM_STATE)[keyof typeof STREAM_STATE];

export const DEFAULT_INITIAL_WINDOW = 65536; // 64KB per stream
export const DEFAULT_CONNECTION_WINDOW = 1048576; // 1MB total
export const MAX_FRAME_SIZE = 16384; // 16KB max frame payload
export const DEFAULT_PRIORITY = 128;

export interface Frame {
  type: number;
  streamId: number;
  flags: number;
  payload: Buffer;
}

// Ad-hoc hooks installed by the WebSocket/proxy layers plus the outbound API.
// MuxStreamLike is the shape those layers type their callbacks against; the
// concrete class is Stream.
export interface MuxStreamLike {
  id: number;
  headers?: Record<string, unknown> | null;
  state?: string;
  sendHeaders(headers: Record<string, unknown>, endStream?: boolean): void;
  sendData(data: Buffer | string, endStream?: boolean): boolean;
  reset(reason?: number): void;
  close(): void;
  _onHeaders?: ((headers: Record<string, unknown>, endStream: boolean) => void) | null;
  _onData?: ((chunk: Buffer) => void) | null;
  _onEnd?: (() => void) | null;
  _onError?: ((reason: string | number) => void) | null;
  _bufferedData?: Buffer[];
}

export interface FrameStats {
  id: number;
  state: string;
  priority: number;
  sendWindow: number;
  recvWindow: number;
  bufferedSize: number;
  totalBytesSent: number;
  totalBytesReceived: number;
  age: number;
  idle: number;
  headers: string[] | null;
}

interface StreamMuxOptions {
  logger?: AppLogger;
  initialWindow?: number;
  connectionWindow?: number;
}

// =============================================================================
// Stream class - represents a single multiplexed stream
// =============================================================================
export class Stream implements MuxStreamLike {
  id: number;
  mux: StreamMux;
  state: string;
  priority: number;
  sendWindow: number;
  recvWindow: number;
  bufferedData: Buffer[]; // Buffered outgoing data (waiting for window)
  bufferedSize: number;
  _onHeaders: ((headers: Record<string, unknown>, endStream: boolean) => void) | null;
  _onData: ((chunk: Buffer) => void) | null;
  _onEnd: (() => void) | null;
  _onError: ((reason: string | number) => void) | null;
  _onWindowUpdate: ((increment: number) => void) | null;
  headers: Record<string, unknown> | null;
  createdAt: number;
  lastActivity: number;
  totalBytesSent: number;
  totalBytesReceived: number;
  remoteAddress: string;
  localAddress: string;
  _bufferedData?: Buffer[];

  constructor(id: number, mux: StreamMux) {
    this.id = id;
    this.mux = mux;
    this.state = STREAM_STATE.IDLE;
    this.priority = DEFAULT_PRIORITY;
    this.sendWindow = DEFAULT_INITIAL_WINDOW;
    this.recvWindow = DEFAULT_INITIAL_WINDOW;
    this.bufferedData = [];
    this.bufferedSize = 0;
    this._onHeaders = null;
    this._onData = null;
    this._onEnd = null;
    this._onError = null;
    this._onWindowUpdate = null;
    this.headers = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.totalBytesSent = 0;
    this.totalBytesReceived = 0;
    this.remoteAddress = '';
    this.localAddress = '';
  }

  // Set the stream priority (0 = highest, 255 = lowest)
  setPriority(priority: number): void {
    this.priority = Math.max(0, Math.min(255, priority));
    this.lastActivity = Date.now();
    this.mux._reschedule();
  }

  // Send headers to the remote end
  sendHeaders(headers: Record<string, unknown>, endStream = false): void {
    if (this.state === STREAM_STATE.CLOSED) return;
    this.state = endStream ? STREAM_STATE.HALF_CLOSED_LOCAL : STREAM_STATE.OPEN;
    this.headers = headers;
    this.lastActivity = Date.now();
    const flags = endStream ? FLAG.END_STREAM | FLAG.END_HEADERS : FLAG.END_HEADERS;
    this.mux._sendFrame(this.id, FRAME_TYPE.HEADERS, headers, flags);
  }

  // Send data on this stream
  sendData(data: Buffer | string, endStream = false): boolean {
    if (this.state === STREAM_STATE.CLOSED || this.state === STREAM_STATE.HALF_CLOSED_LOCAL) return false;

    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data as string, 'base64');
    const maxChunk = Math.min(this.sendWindow, MAX_FRAME_SIZE);

    if (dataBuf.length <= maxChunk) {
      // Can send immediately
      this.sendWindow -= dataBuf.length;
      this.totalBytesSent += dataBuf.length;
      this.lastActivity = Date.now();
      const flags = endStream ? FLAG.END_STREAM : 0;
      this.mux._sendFrame(this.id, FRAME_TYPE.DATA, dataBuf, flags);
      if (endStream) this.state = STREAM_STATE.HALF_CLOSED_LOCAL;
      return true;
    } else {
      // Need to chunk and/or buffer
      let offset = 0;
      while (offset < dataBuf.length && this.sendWindow > 0) {
        const chunk = dataBuf.slice(offset, offset + Math.min(this.sendWindow, MAX_FRAME_SIZE));
        this.sendWindow -= chunk.length;
        this.totalBytesSent += chunk.length;
        offset += chunk.length;
        const flag = offset >= dataBuf.length && endStream ? FLAG.END_STREAM : 0;
        this.mux._sendFrame(this.id, FRAME_TYPE.DATA, chunk, flag);
      }

      // Buffer remaining data
      if (offset < dataBuf.length) {
        const remaining = dataBuf.slice(offset);
        this.bufferedData.push(remaining);
        this.bufferedSize += remaining.length;
        this.mux._updateStreamPriority(this.id, this.priority + 10); // Boost priority for buffered data
      }

      if (offset >= dataBuf.length && endStream) {
        this.state = STREAM_STATE.HALF_CLOSED_LOCAL;
      }
      return true;
    }
  }

  // Reset the stream
  reset(reason: number | string = 0): void {
    if (this.state === STREAM_STATE.CLOSED) return;
    this.state = STREAM_STATE.CLOSED;
    this.lastActivity = Date.now();
    this.mux._sendFrame(this.id, FRAME_TYPE.RST_STREAM, { reason }, 0);
    this.mux._removeStream(this.id);
    if (this._onError) this._onError(reason);
  }

  // Close the stream gracefully
  close(): void {
    if (this.state === STREAM_STATE.CLOSED) return;
    if (this.state === STREAM_STATE.OPEN) {
      this.state = STREAM_STATE.HALF_CLOSED_LOCAL;
      this.mux._sendFrame(this.id, FRAME_TYPE.DATA, Buffer.alloc(0), FLAG.END_STREAM);
    } else {
      this.state = STREAM_STATE.CLOSED;
      this.mux._removeStream(this.id);
      if (this._onEnd) this._onEnd();
    }
  }

  // Handle incoming frame (payload already parsed by StreamMux)
  _handleFrame(type: number, payload: unknown, flags: number): void {
    this.lastActivity = Date.now();

    if (type === FRAME_TYPE.HEADERS || type === FRAME_TYPE.HEADERS_END) {
      const headers = payload as Record<string, unknown>;
      this.headers = headers;
      if (flags & FLAG.END_STREAM) {
        this.state = STREAM_STATE.HALF_CLOSED_REMOTE;
      } else {
        this.state = STREAM_STATE.OPEN;
      }
      if (this._onHeaders) this._onHeaders(headers, (flags & FLAG.END_STREAM) !== 0);
      return;
    }

    if (type === FRAME_TYPE.DATA) {
      const data = payload as Buffer;
      this.recvWindow -= data.length;
      this.totalBytesReceived += data.length;
      if (this.recvWindow < DEFAULT_INITIAL_WINDOW / 2) {
        // Send window update
        const increment = DEFAULT_INITIAL_WINDOW - this.recvWindow;
        this.recvWindow += increment;
        this.mux._sendFrame(this.id, FRAME_TYPE.WINDOW_UPDATE, { increment });
      }
      if (this._onData) this._onData(data);
      if (flags & FLAG.END_STREAM) {
        this.state = STREAM_STATE.HALF_CLOSED_REMOTE;
        if (this._onEnd) this._onEnd();
      }
      return;
    }

    if (type === FRAME_TYPE.PRIORITY) {
      const p = payload as { priority?: number };
      this.priority = p.priority || DEFAULT_PRIORITY;
      this.mux._reschedule();
      return;
    }

    if (type === FRAME_TYPE.RST_STREAM) {
      this.state = STREAM_STATE.CLOSED;
      this.mux._removeStream(this.id);
      const p = payload as { reason?: number | string };
      if (this._onError) this._onError(p.reason || 0);
      return;
    }

    if (type === FRAME_TYPE.WINDOW_UPDATE) {
      const p = payload as { increment?: number };
      this.sendWindow += p.increment || 0;
      // Flush buffered data
      this._flushBuffered();
      return;
    }
  }

  // Flush buffered data when window opens up
  _flushBuffered(): void {
    while (this.bufferedData.length > 0 && this.sendWindow > 0) {
      const chunk = this.bufferedData[0];
      const sendSize = Math.min(chunk.length, this.sendWindow, MAX_FRAME_SIZE);
      const sendChunk = chunk.slice(0, sendSize);
      this.sendWindow -= sendChunk.length;
      this.totalBytesSent += sendChunk.length;
      this.mux._sendFrame(this.id, FRAME_TYPE.DATA, sendChunk, 0);

      if (sendSize < chunk.length) {
        this.bufferedData[0] = chunk.slice(sendSize);
        this.bufferedSize -= sendSize;
      } else {
        this.bufferedData.shift();
        this.bufferedSize -= chunk.length;
      }
    }
  }

  get stats(): FrameStats {
    return {
      id: this.id,
      state: this.state,
      priority: this.priority,
      sendWindow: this.sendWindow,
      recvWindow: this.recvWindow,
      bufferedSize: this.bufferedSize,
      totalBytesSent: this.totalBytesSent,
      totalBytesReceived: this.totalBytesReceived,
      age: Date.now() - this.createdAt,
      idle: Date.now() - this.lastActivity,
      headers: this.headers ? Object.keys(this.headers).slice(0, 5) : null,
    };
  }
}

// =============================================================================
// StreamMux class - manages multiple streams over a single WebSocket
// =============================================================================
export class StreamMux {
  ws: WebSocket;
  logger: AppLogger | null;
  _nextId: number;
  streams: Map<number, Stream>;
  _pendingFrames: Frame[];
  _sendBuffer: Buffer[];
  _sending: boolean;
  _closed: boolean;
  _lastPing: number;
  _rtt: number;
  _onStream: ((stream: Stream) => void) | null;
  _onGoaway: ((lastStreamId: number) => void) | null;
  _onError: ((err: unknown) => void) | null;
  connectionSendWindow: number;
  connectionRecvWindow: number;
  initialWindow: number;
  _priorityQueue: number[];
  _schedulingTimer: ReturnType<typeof setTimeout> | null;
  _windowCheckInterval: ReturnType<typeof setInterval> | null;
  _pingCallback: ((rtt: number) => void) | null;
  _buffer: Buffer;

  constructor(ws: WebSocket, options: StreamMuxOptions = {}) {
    this.ws = ws;
    this.logger = options.logger || null;
    this._nextId = 1;
    this.streams = new Map();
    this._pendingFrames = [];
    this._sendBuffer = [];
    this._sending = false;
    this._closed = false;
    this._lastPing = 0;
    this._rtt = 0;
    this._onStream = null;
    this._onGoaway = null;
    this._onError = null;

    // Flow control
    this.connectionSendWindow = options.connectionWindow || DEFAULT_CONNECTION_WINDOW;
    this.connectionRecvWindow = options.connectionWindow || DEFAULT_CONNECTION_WINDOW;
    this.initialWindow = options.initialWindow || DEFAULT_INITIAL_WINDOW;

    // Priority scheduling
    this._priorityQueue = [];
    this._schedulingTimer = null;

    // Flow control: send window updates periodically
    this._windowCheckInterval = setInterval(() => {
      this._checkConnectionWindow();
    }, 1000);

    // Start reading from WebSocket
    this._buffer = Buffer.alloc(0);
    this._pingCallback = null;
    this._setupRead();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Create a new stream on this mux connection
   * @param priority - Stream priority (0-255, lower = higher)
   */
  createStream(priority: number = DEFAULT_PRIORITY): Stream | null {
    if (this._closed) return null;
    const id = this._nextId;
    this._nextId += 2; // Client-initiated streams use odd IDs

    const stream = new Stream(id, this);
    stream.priority = Math.max(0, Math.min(255, priority));
    this.streams.set(id, stream);
    this._priorityQueue.push(id);
    this._reschedule();

    if (this.logger) {
      this.logger.debug({ streamId: id, priority }, 'Stream created');
    }

    return stream;
  }

  /**
   * Open a tunnel (for SOCKS5)
   * @param host - Target hostname
   * @param port - Target port
   * @param priority - Stream priority
   */
  openTunnel(host: string, port: number, priority: number = DEFAULT_PRIORITY): Stream | null {
    const stream = this.createStream(priority);
    if (!stream) return null;

    const payload = { host, port };
    this._sendFrame(stream.id, FRAME_TYPE.TUNNEL_OPEN, payload, 0);
    stream.state = STREAM_STATE.OPEN;
    stream.headers = { host, port };

    // Forward incoming HEADERS frames (tunnel_ready, tunnel_error) to the
    // application-level onStream callback so the mux.onStream dispatcher in
    // ws-server.ts can route them to handleTunnelReady / handleTunnelError.
    // Without this, the stream already exists in this.streams (created above)
    // and StreamMux._handleFrame only calls _onHeaders (which is null by
    // default) instead of _onStream, silently dropping the response. The
    // handler is an arrow function, so `this` here lexically is the mux.
    stream._onHeaders = (_headers: Record<string, unknown>, _endStream: boolean) => {
      if (this._onStream) {
        this._onStream(stream);
      }
    };

    if (this.logger) {
      this.logger.debug({ streamId: stream.id, host, port }, 'Tunnel opened');
    }

    return stream;
  }

  /**
   * Send tunnel data
   */
  sendTunnelData(streamId: number, data: Buffer | string): boolean {
    const stream = this.streams.get(streamId);
    if (!stream) return false;
    return stream.sendData(data);
  }

  /**
   * Close a tunnel
   */
  closeTunnel(streamId: number, reason: number | string = 0): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this._sendFrame(streamId, FRAME_TYPE.TUNNEL_CLOSE, { reason }, 0);
    stream.state = STREAM_STATE.CLOSED;
    this._removeStream(streamId);
  }

  /**
   * Send a PING to measure RTT
   */
  ping(callback: (rtt: number) => void): void {
    if (this._closed) return;
    this._lastPing = Date.now();
    this._pingCallback = callback;
    this._sendFrame(0, FRAME_TYPE.PING, { time: this._lastPing }, 0);
  }

  /**
   * Get stream statistics
   */
  getStats(): {
    activeStreams: number;
    totalStreams: number;
    connectionSendWindow: number;
    connectionRecvWindow: number;
    rtt: number;
    bufferedFrames: number;
    streams: FrameStats[];
  } {
    const streamStats: FrameStats[] = [];
    for (const stream of this.streams.values()) {
      streamStats.push(stream.stats);
    }

    return {
      activeStreams: streamStats.filter(
        (s) => s.state === 'open' || s.state === 'half_closed_local' || s.state === 'half_closed_remote'
      ).length,
      totalStreams: streamStats.length,
      connectionSendWindow: this.connectionSendWindow,
      connectionRecvWindow: this.connectionRecvWindow,
      rtt: this._rtt,
      bufferedFrames: this._sendBuffer.length,
      streams: streamStats,
    };
  }

  /**
   * Graceful shutdown
   */
  goaway(lastStreamId = 0): void {
    this._sendFrame(0, FRAME_TYPE.GOAWAY, { lastStreamId }, 0);
    this._closed = true;
    // Close all streams
    for (const stream of this.streams.values()) {
      stream.state = STREAM_STATE.CLOSED;
      if (stream._onError) stream._onError('goaway');
    }
    this.streams.clear();
    if (this._windowCheckInterval) {
      clearInterval(this._windowCheckInterval);
      this._windowCheckInterval = null;
    }
    if (this._schedulingTimer) {
      clearTimeout(this._schedulingTimer);
      this._schedulingTimer = null;
    }
  }

  /**
   * Force close everything
   */
  destroy(): void {
    this._closed = true;
    for (const stream of this.streams.values()) {
      stream.state = STREAM_STATE.CLOSED;
    }
    this.streams.clear();
    this._sendBuffer = [];
    this._pendingFrames = [];
    if (this._windowCheckInterval) {
      clearInterval(this._windowCheckInterval);
      this._windowCheckInterval = null;
    }
    if (this._schedulingTimer) {
      clearTimeout(this._schedulingTimer);
      this._schedulingTimer = null;
    }
  }

  // ===========================================================================
  // Event handlers
  // ===========================================================================

  onStream(callback: (stream: Stream) => void): void {
    this._onStream = callback;
  }

  onGoaway(callback: (lastStreamId: number) => void): void {
    this._onGoaway = callback;
  }

  onError(callback: (err: unknown) => void): void {
    this._onError = callback;
  }

  // ===========================================================================
  // Internal: Frame encoding/decoding
  // ===========================================================================

  _sendFrame(streamId: number, type: number, payload: Buffer | object, flags = 0): void {
    if (this._closed) return;

    let payloadBuf: Buffer;
    if (Buffer.isBuffer(payload)) {
      payloadBuf = payload;
    } else if (typeof payload === 'object') {
      payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
    } else {
      payloadBuf = Buffer.alloc(0);
    }

    // Frame header: length(4) + type(1) + stream_id(4) + flags(4)
    const header = Buffer.alloc(13);
    header.writeUInt32BE(payloadBuf.length, 0); // payload length
    header[4] = type; // frame type
    header.writeUInt32BE(streamId, 5); // stream ID
    header.writeUInt32BE(flags, 9); // flags

    this._sendBuffer.push(Buffer.concat([header, payloadBuf]));

    // Schedule sending
    if (!this._sending) {
      this._sending = true;
      setImmediate(() => this._flushSendBuffer());
    }
  }

  _flushSendBuffer(): void {
    if (this._sendBuffer.length === 0) {
      this._sending = false;
      return;
    }

    // Batch multiple small frames together
    const batch: Buffer[] = [];
    let totalSize = 0;
    const maxBatchSize = 65536; // 64KB max per batch

    while (this._sendBuffer.length > 0) {
      const frame = this._sendBuffer[0];
      if (totalSize + frame.length > maxBatchSize && batch.length > 0) break;
      batch.push(this._sendBuffer.shift() as Buffer);
      totalSize += frame.length;
    }

    // Send as single batch if multiple frames, or individually
    const sendData = batch.length === 1 ? batch[0] : this._encodeBatch(batch);

    try {
      // Check if we have connection window
      if (this.connectionSendWindow <= 0 && batch.some((f) => f[4] === FRAME_TYPE.DATA)) {
        // Wait for window update - put frames back
        this._sendBuffer.unshift(...batch);
        this._sending = false;
        return;
      }

      this.ws.send(sendData, { binary: true }, (err?: Error) => {
        if (err) {
          this.logger?.error({ error: err.message }, 'StreamMux send error');
          if (this._onError) this._onError(err);
        }
        // Continue sending remaining frames
        setImmediate(() => this._flushSendBuffer());
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.logger?.error({ error: e.message }, 'StreamMux send exception');
      this._sending = false;
      this._sendBuffer.unshift(...batch);
    }
  }

  _encodeBatch(frames: Buffer[]): Buffer {
    const count = frames.length;
    const countBuf = Buffer.alloc(2);
    countBuf.writeUInt16BE(count, 0);
    return Buffer.concat([countBuf, ...frames]);
  }

  _decodeBatch(buf: Buffer): Frame[] {
    const frames: Frame[] = [];
    let offset = 2; // Skip 2-byte count field
    while (offset < buf.length) {
      if (offset + 13 > buf.length) break;
      const length = buf.readUInt32BE(offset);
      if (offset + 13 + length > buf.length) break;
      const type = buf[offset + 4];
      const streamId = buf.readUInt32BE(offset + 5);
      const flags = buf.readUInt32BE(offset + 9);
      const payload = buf.slice(offset + 13, offset + 13 + length);
      frames.push({ type, streamId, flags, payload });
      offset += 13 + length;
    }
    return frames;
  }

  // ===========================================================================
  // Internal: WebSocket read handler
  // ===========================================================================

  _setupRead(): void {
    this.ws.on('message', (data: RawData, isBinary: boolean) => {
      if (this._closed) return;

      // Legacy JSON support (backward compatibility)
      // NOTE: ws 8.x passes text frames as Buffer with isBinary=false
      if (isBinary === false || typeof data === 'string') {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          this._handleLegacyMessage(msg);
        } catch (_) {
          // ignore
        }
        return;
      }

      let buf: Buffer;
      if (Buffer.isBuffer(data)) {
        buf = data;
      } else if (data instanceof ArrayBuffer) {
        buf = Buffer.from(data);
      } else {
        return;
      }

      // Check if it's a batch (multiple frames)
      // Batch format: [2 bytes count][frame][frame]...
      // Single frame: [4 bytes length][type][stream_id][flags][payload]
      if (buf.length >= 2) {
        const count = buf.readUInt16BE(0);
        if (count >= 2) {
          // Multiple frames batched together - count field at offset 0
          const frames = this._decodeBatch(buf);
          for (const frame of frames) {
            this._handleFrame(frame);
          }
        } else {
          // Single frame
          const firstFrameLen = buf.readUInt32BE(0);
          this._handleFrame({
            type: buf[4],
            streamId: buf.readUInt32BE(5),
            flags: buf.readUInt32BE(9),
            payload: buf.slice(13, 13 + firstFrameLen),
          });
        }
      }
    });

    this.ws.on('close', () => {
      this._closed = true;
      for (const stream of this.streams.values()) {
        stream.state = STREAM_STATE.CLOSED;
        if (stream._onError) stream._onError('connection_closed');
      }
      this.streams.clear();
    });
  }

  _handleFrame(frame: Frame): void {
    const { type, streamId, flags, payload } = frame;

    // Connection-level frames (streamId = 0)
    if (streamId === 0) {
      this._handleConnectionFrame(type, payload);
      return;
    }

    // Stream-level frames
    let stream = this.streams.get(streamId);

    if (type === FRAME_TYPE.HEADERS || type === FRAME_TYPE.HEADERS_END) {
      // New incoming stream
      if (!stream) {
        stream = new Stream(streamId, this);
        this.streams.set(streamId, stream);
        this._priorityQueue.push(streamId);
      }
      stream._handleFrame(type, this._parsePayload(type, payload), flags);

      // Notify listener
      if (this._onStream) {
        this._onStream(stream);
      }
      return;
    }

    if (type === FRAME_TYPE.TUNNEL_OPEN) {
      // New tunnel
      if (!stream) {
        const payloadObj = this._parsePayload(type, payload) as Record<string, unknown>;
        stream = new Stream(streamId, this);
        stream.headers = payloadObj;
        stream.state = STREAM_STATE.OPEN;
        this.streams.set(streamId, stream);
        this._priorityQueue.push(streamId);

        if (this._onStream) {
          this._onStream(stream);
        }
      }
      return;
    }

    if (!stream) return;
    stream._handleFrame(type, this._parsePayload(type, payload), flags);
  }

  _handleConnectionFrame(type: number, payload: Buffer): void {
    const p = JSON.parse(payload.toString('utf8')) as { time?: number; lastStreamId?: number; increment?: number };

    if (type === FRAME_TYPE.PING) {
      // Respond with PONG
      this._sendFrame(0, FRAME_TYPE.PONG, p, 0);
      return;
    }

    if (type === FRAME_TYPE.PONG) {
      if (this._pingCallback) {
        this._rtt = Date.now() - (p.time || this._lastPing);
        this._pingCallback(this._rtt);
        this._pingCallback = null;
      }
      return;
    }

    if (type === FRAME_TYPE.GOAWAY) {
      this._closed = true;
      if (this._onGoaway) this._onGoaway(p.lastStreamId || 0);
      return;
    }

    if (type === FRAME_TYPE.WINDOW_UPDATE) {
      this.connectionSendWindow += p.increment || 0;
      return;
    }
  }

  _parsePayload(type: number, buf: Buffer): unknown {
    switch (type) {
      case FRAME_TYPE.DATA:
      case FRAME_TYPE.TUNNEL_DATA:
        return buf;
      default:
        try {
          return JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
        } catch (_) {
          return buf.toString('utf8');
        }
    }
  }

  _handleLegacyMessage(msg: Record<string, unknown>): void {
    // Handle legacy JSON messages for backward compatibility
    if (msg.type === 'ping') {
      this._sendFrame(0, FRAME_TYPE.PONG, { time: Date.now() }, 0);
    }
  }

  // ===========================================================================
  // Internal: Flow control
  // ===========================================================================

  _checkConnectionWindow(): void {
    if (this.connectionRecvWindow < DEFAULT_CONNECTION_WINDOW / 2) {
      const increment = DEFAULT_CONNECTION_WINDOW - this.connectionRecvWindow;
      this.connectionRecvWindow += increment;
      this._sendFrame(0, FRAME_TYPE.WINDOW_UPDATE, { increment }, 0);
    }
  }

  _updateStreamPriority(streamId: number, priority: number): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.priority = Math.max(0, Math.min(255, priority));
      this._reschedule();
    }
  }

  _reschedule(): void {
    // Sort priority queue by priority (lower = higher priority)
    this._priorityQueue.sort((a, b) => {
      const sa = this.streams.get(a);
      const sb = this.streams.get(b);
      if (!sa || !sb) return 0;
      // Prioritize by: priority, then age (older = higher priority)
      if (sa.priority !== sb.priority) return sa.priority - sb.priority;
      return sa.createdAt - sb.createdAt;
    });
  }

  _removeStream(streamId: number): void {
    this.streams.delete(streamId);
    const idx = this._priorityQueue.indexOf(streamId);
    if (idx >= 0) this._priorityQueue.splice(idx, 1);
  }
}
