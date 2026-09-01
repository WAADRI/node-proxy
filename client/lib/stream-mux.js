// =============================================================================
// StreamMux - HTTP/2-style stream multiplexing over WebSocket
// Phase 4: WebSocket 连接复用
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
'use strict';

const FRAME_TYPE = {
  HEADERS: 0x01,
  DATA: 0x02,
  PRIORITY: 0x03,
  RST_STREAM: 0x04,
  GOAWAY: 0x05,
  WINDOW_UPDATE: 0x06,
  PING: 0x07,
  PONG: 0x08,
  BATCH: 0x09,
  HEADERS_END: 0x0A,
  TUNNEL_OPEN: 0x0B,
  TUNNEL_DATA: 0x0C,
  TUNNEL_CLOSE: 0x0D,
};

const FLAG = {
  END_STREAM: 0x01,
  END_HEADERS: 0x02,
  PRIORITY: 0x04,
  PADDED: 0x08,
};

const STREAM_STATE = {
  IDLE: 'idle',
  RESERVED: 'reserved',
  OPEN: 'open',
  HALF_CLOSED_LOCAL: 'half_closed_local',
  HALF_CLOSED_REMOTE: 'half_closed_remote',
  CLOSED: 'closed',
};

const DEFAULT_INITIAL_WINDOW = 65536; // 64KB per stream
const DEFAULT_CONNECTION_WINDOW = 1048576; // 1MB total
const MAX_FRAME_SIZE = 16384; // 16KB max frame payload
const DEFAULT_PRIORITY = 128;

// =============================================================================
// Stream class - represents a single multiplexed stream
// =============================================================================
class Stream {
  constructor(id, mux) {
    this.id = id;
    this.mux = mux;
    this.state = STREAM_STATE.IDLE;
    this.priority = DEFAULT_PRIORITY;
    this.sendWindow = DEFAULT_INITIAL_WINDOW;
    this.recvWindow = DEFAULT_INITIAL_WINDOW;
    this.bufferedData = []; // Buffered outgoing data (waiting for window)
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
  setPriority(priority) {
    this.priority = Math.max(0, Math.min(255, priority));
    this.lastActivity = Date.now();
    this.mux._reschedule();
  }

  // Send headers to the remote end
  sendHeaders(headers, endStream = false) {
    if (this.state === STREAM_STATE.CLOSED) return;
    this.state = endStream ? STREAM_STATE.HALF_CLOSED_LOCAL : STREAM_STATE.OPEN;
    this.headers = headers;
    this.lastActivity = Date.now();
    this.mux._sendFrame(this.id, FRAME_TYPE.HEADERS, headers, endStream ? FLAG.END_STREAM | FLAG.END_HEADERS : FLAG.END_HEADERS);
  }

  // Send data on this stream
  sendData(data, endStream = false) {
    if (this.state === STREAM_STATE.CLOSED || this.state === STREAM_STATE.HALF_CLOSED_LOCAL) return false;

    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
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
        this.mux._sendFrame(this.id, FRAME_TYPE.DATA, chunk, (offset >= dataBuf.length && endStream) ? FLAG.END_STREAM : 0);
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
  reset(reason = 0) {
    if (this.state === STREAM_STATE.CLOSED) return;
    this.state = STREAM_STATE.CLOSED;
    this.lastActivity = Date.now();
    this.mux._sendFrame(this.id, FRAME_TYPE.RST_STREAM, { reason });
    this.mux._removeStream(this.id);
    if (this._onError) this._onError(reason);
  }

  // Close the stream gracefully
  close() {
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

  // Handle incoming frame
  _handleFrame(type, payload, flags) {
    this.lastActivity = Date.now();

    if (type === FRAME_TYPE.HEADERS || type === FRAME_TYPE.HEADERS_END) {
      this.headers = payload;
      if (flags & FLAG.END_STREAM) {
        this.state = STREAM_STATE.HALF_CLOSED_REMOTE;
      } else {
        this.state = STREAM_STATE.OPEN;
      }
      if (this._onHeaders) this._onHeaders(payload, flags & FLAG.END_STREAM);
      return;
    }

    if (type === FRAME_TYPE.DATA) {
      this.recvWindow -= payload.length;
      this.totalBytesReceived += payload.length;
      if (this.recvWindow < DEFAULT_INITIAL_WINDOW / 2) {
        // Send window update
        const increment = DEFAULT_INITIAL_WINDOW - this.recvWindow;
        this.recvWindow += increment;
        this.mux._sendFrame(this.id, FRAME_TYPE.WINDOW_UPDATE, { increment });
      }
      if (this._onData) this._onData(payload);
      if (flags & FLAG.END_STREAM) {
        this.state = STREAM_STATE.HALF_CLOSED_REMOTE;
        if (this._onEnd) this._onEnd();
      }
      return;
    }

    if (type === FRAME_TYPE.PRIORITY) {
      this.priority = payload.priority || DEFAULT_PRIORITY;
      this.mux._reschedule();
      return;
    }

    if (type === FRAME_TYPE.RST_STREAM) {
      this.state = STREAM_STATE.CLOSED;
      this.mux._removeStream(this.id);
      if (this._onError) this._onError(payload.reason || 0);
      return;
    }

    if (type === FRAME_TYPE.WINDOW_UPDATE) {
      this.sendWindow += payload.increment || 0;
      // Flush buffered data
      this._flushBuffered();
      return;
    }
  }

  // Flush buffered data when window opens up
  _flushBuffered() {
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

  get stats() {
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
class StreamMux {
  constructor(ws, options = {}) {
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
    this._setupRead();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Create a new stream on this mux connection
   * @param {number} priority - Stream priority (0-255, lower = higher)
   * @returns {Stream}
   */
  createStream(priority = DEFAULT_PRIORITY) {
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
   * @param {string} host - Target hostname
   * @param {number} port - Target port
   * @param {number} priority - Stream priority
   * @returns {Stream}
   */
  openTunnel(host, port, priority = DEFAULT_PRIORITY) {
    const stream = this.createStream(priority);
    if (!stream) return null;

    const payload = { host, port };
    this._sendFrame(stream.id, FRAME_TYPE.TUNNEL_OPEN, payload, 0);
    stream.state = STREAM_STATE.OPEN;
    stream.headers = { host, port };

    if (this.logger) {
      this.logger.debug({ streamId: stream.id, host, port }, 'Tunnel opened');
    }

    return stream;
  }

  /**
   * Send tunnel data
   */
  sendTunnelData(streamId, data) {
    const stream = this.streams.get(streamId);
    if (!stream) return false;
    return stream.sendData(data);
  }

  /**
   * Close a tunnel
   */
  closeTunnel(streamId, reason = 0) {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this._sendFrame(streamId, FRAME_TYPE.TUNNEL_CLOSE, { reason }, 0);
    stream.state = STREAM_STATE.CLOSED;
    this._removeStream(streamId);
  }

  /**
   * Send a PING to measure RTT
   */
  ping(callback) {
    if (this._closed) return;
    this._lastPing = Date.now();
    this._pingCallback = callback;
    this._sendFrame(0, FRAME_TYPE.PING, { time: this._lastPing }, 0);
  }

  /**
   * Get stream statistics
   */
  getStats() {
    const streamStats = [];
    for (const [id, stream] of this.streams) {
      streamStats.push(stream.stats);
    }

    return {
      activeStreams: streamStats.filter(s => s.state === 'open' || s.state === 'half_closed_local' || s.state === 'half_closed_remote').length,
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
  goaway(lastStreamId = 0) {
    this._sendFrame(0, FRAME_TYPE.GOAWAY, { lastStreamId }, 0);
    this._closed = true;
    // Close all streams
    for (const [id, stream] of this.streams) {
      stream.state = STREAM_STATE.CLOSED;
      if (stream._onError) stream._onError('goaway');
    }
    this.streams.clear();
    if (this._windowCheckInterval) {
      clearInterval(this._windowCheckInterval);
    }
    if (this._schedulingTimer) {
      clearTimeout(this._schedulingTimer);
    }
  }

  /**
   * Force close everything
   */
  destroy() {
    this._closed = true;
    for (const [id, stream] of this.streams) {
      stream.state = STREAM_STATE.CLOSED;
    }
    this.streams.clear();
    this._sendBuffer = [];
    this._pendingFrames = [];
    if (this._windowCheckInterval) {
      clearInterval(this._windowCheckInterval);
    }
    if (this._schedulingTimer) {
      clearTimeout(this._schedulingTimer);
    }
  }

  // ===========================================================================
  // Event handlers
  // ===========================================================================

  onStream(callback) {
    this._onStream = callback;
  }

  onGoaway(callback) {
    this._onGoaway = callback;
  }

  onError(callback) {
    this._onError = callback;
  }

  // ===========================================================================
  // Internal: Frame encoding/decoding
  // ===========================================================================

  _sendFrame(streamId, type, payload, flags = 0) {
    if (this._closed) return;

    let payloadBuf;
    if (Buffer.isBuffer(payload)) {
      payloadBuf = payload;
    } else if (typeof payload === 'object') {
      payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
    } else {
      payloadBuf = Buffer.alloc(0);
    }

    // Frame header: length(4) + type(1) + stream_id(4) + flags(4)
    const header = Buffer.alloc(13);
    header.writeUInt32BE(payloadBuf.length, 0);  // payload length
    header[4] = type;                              // frame type
    header.writeUInt32BE(streamId, 5);             // stream ID
    header.writeUInt32BE(flags, 9);                // flags

    this._sendBuffer.push(Buffer.concat([header, payloadBuf]));

    // Schedule sending
    if (!this._sending) {
      this._sending = true;
      setImmediate(() => this._flushSendBuffer());
    }
  }

  _flushSendBuffer() {
    if (this._sendBuffer.length === 0) {
      this._sending = false;
      return;
    }

    // Batch multiple small frames together
    let batch = [];
    let totalSize = 0;
    const maxBatchSize = 65536; // 64KB max per batch

    while (this._sendBuffer.length > 0) {
      const frame = this._sendBuffer[0];
      if (totalSize + frame.length > maxBatchSize && batch.length > 0) break;
      batch.push(this._sendBuffer.shift());
      totalSize += frame.length;
    }

    // Send as single batch if multiple frames, or individually
    const sendData = batch.length === 1 ? batch[0] : this._encodeBatch(batch);

    try {
      // Check if we have connection window
      if (this.connectionSendWindow <= 0 && batch.some(f => f[4] === FRAME_TYPE.DATA)) {
        // Wait for window update - put frames back
        this._sendBuffer.unshift(...batch);
        this._sending = false;
        return;
      }

      this.ws.send(sendData, { binary: true }, (err) => {
        if (err) {
          this.logger?.error({ error: err.message }, 'StreamMux send error');
          if (this._onError) this._onError(err);
        }
        // Continue sending remaining frames
        setImmediate(() => this._flushSendBuffer());
      });
    } catch (err) {
      this.logger?.error({ error: err.message }, 'StreamMux send exception');
      this._sending = false;
      this._sendBuffer.unshift(...batch);
    }
  }

  _encodeBatch(frames) {
    const count = frames.length;
    const countBuf = Buffer.alloc(2);
    countBuf.writeUInt16BE(count, 0);
    return Buffer.concat([countBuf, ...frames]);
  }

  _decodeBatch(buf) {
    const frames = [];
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

  _setupRead() {
    this.ws.on('message', (data, isBinary) => {
      if (this._closed) return;

      // Legacy JSON support (backward compatibility)
      // NOTE: ws 8.x passes text frames as Buffer with isBinary=false
      if (isBinary === false || typeof data === 'string') {
        try {
          const msg = JSON.parse(data.toString());
          this._handleLegacyMessage(msg);
        } catch (_) {}
        return;
      }

      let buf;
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
      for (const [id, stream] of this.streams) {
        stream.state = STREAM_STATE.CLOSED;
        if (stream._onError) stream._onError('connection_closed');
      }
      this.streams.clear();
    });
  }

  _handleFrame(frame) {
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
        const payloadObj = this._parsePayload(type, payload);
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

  _handleConnectionFrame(type, payload) {
    const p = JSON.parse(payload.toString('utf8'));

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

  _parsePayload(type, buf) {
    switch (type) {
      case FRAME_TYPE.DATA:
      case FRAME_TYPE.TUNNEL_DATA:
        return buf;
      default:
        try {
          return JSON.parse(buf.toString('utf8'));
        } catch (_) {
          return buf.toString('utf8');
        }
    }
  }

  _handleLegacyMessage(msg) {
    // Handle legacy JSON messages for backward compatibility
    if (msg.type === 'ping') {
      this._sendFrame(0, FRAME_TYPE.PONG, { time: Date.now() }, 0);
    }
  }

  // ===========================================================================
  // Internal: Flow control
  // ===========================================================================

  _checkConnectionWindow() {
    if (this.connectionRecvWindow < DEFAULT_CONNECTION_WINDOW / 2) {
      const increment = DEFAULT_CONNECTION_WINDOW - this.connectionRecvWindow;
      this.connectionRecvWindow += increment;
      this._sendFrame(0, FRAME_TYPE.WINDOW_UPDATE, { increment }, 0);
    }
  }

  _updateStreamPriority(streamId, priority) {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.priority = Math.max(0, Math.min(255, priority));
      this._reschedule();
    }
  }

  _reschedule() {
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

  _removeStream(streamId) {
    this.streams.delete(streamId);
    const idx = this._priorityQueue.indexOf(streamId);
    if (idx >= 0) this._priorityQueue.splice(idx, 1);
  }
}

module.exports = { StreamMux, Stream, FRAME_TYPE, STREAM_STATE, FLAG, DEFAULT_INITIAL_WINDOW, DEFAULT_PRIORITY };