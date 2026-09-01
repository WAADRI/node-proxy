// =============================================================================
// Binary Protocol - Efficient binary message format replacing JSON+Base64
// Phase 3: Binary Protocol Optimization
// =============================================================================
// Message format:
//   [4 bytes: length] [1 byte: type] [payload]
//
// Types:
//   0x01 - Request (HTTP)
//   0x02 - Response (HTTP)
//   0x03 - Tunnel Open
//   0x04 - Tunnel Data
//   0x05 - Tunnel Close
//   0x06 - UDP Data
//   0x07 - Auth
//   0x08 - Ping
//   0x09 - Pong
//   0x0A - System Info
//   0x0B - Error
//   0x0C - Auth Response
//   0x0D - Tunnel Open Response
// =============================================================================
'use strict';

const MSG_TYPE = {
  REQUEST: 0x01,
  RESPONSE: 0x02,
  TUNNEL_OPEN: 0x03,
  TUNNEL_DATA: 0x04,
  TUNNEL_CLOSE: 0x05,
  UDP_DATA: 0x06,
  AUTH: 0x07,
  PING: 0x08,
  PONG: 0x09,
  SYSTEM_INFO: 0x0A,
  ERROR: 0x0B,
  AUTH_RESPONSE: 0x0C,
  TUNNEL_OPEN_RESPONSE: 0x0D,
};

function encodeMessage(type, payload) {
  // payload is either a Buffer or a plain object (will be JSON-encoded)
  let payloadBuf;
  if (Buffer.isBuffer(payload)) {
    payloadBuf = payload;
  } else if (typeof payload === 'object') {
    payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  } else if (typeof payload === 'string') {
    payloadBuf = Buffer.from(payload, 'utf8');
  } else {
    payloadBuf = Buffer.alloc(0);
  }

  const header = Buffer.alloc(5);
  header.writeUInt32BE(payloadBuf.length + 1, 0); // 1 byte type + payload
  header[4] = type;

  return Buffer.concat([header, payloadBuf]);
}

function decodeMessage(buf) {
  if (buf.length < 5) return null;
  const length = buf.readUInt32BE(0);
  if (buf.length < 5 + length) return null;
  const type = buf[4];
  const payload = buf.slice(5, 5 + length);
  return { type, payload, raw: buf.slice(0, 5 + length) };
}

// =============================================================================
// Binary encoders for each message type
// =============================================================================

// Request: type + id(16) + method(1) + url_len(2) + url + headers(JSON) + body
function encodeRequest(id, method, url, headers, body) {
  const idBuf = Buffer.alloc(16);
  if (typeof id === 'string') {
    Buffer.from(id.replace(/-/g, ''), 'hex').copy(idBuf);
  }

  const methodByte = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'CONNECT'].indexOf(method);
  const methodBuf = Buffer.from([methodByte >= 0 ? methodByte : 0xFF]);

  const urlBuf = Buffer.from(url, 'utf8');
  const urlLenBuf = Buffer.alloc(2);
  urlLenBuf.writeUInt16BE(urlBuf.length, 0);

  const headersBuf = Buffer.from(JSON.stringify(headers), 'utf8');
  const headersLenBuf = Buffer.alloc(2);
  headersLenBuf.writeUInt16BE(headersBuf.length, 0);

  const bodyBuf = body ? Buffer.from(body, 'base64') : Buffer.alloc(0);
  const bodyLenBuf = Buffer.alloc(4);
  bodyLenBuf.writeUInt32BE(bodyBuf.length, 0);

  const payload = Buffer.concat([
    idBuf, methodBuf, urlLenBuf, urlBuf, headersLenBuf, headersBuf, bodyLenBuf, bodyBuf,
  ]);
  return encodeMessage(MSG_TYPE.REQUEST, payload);
}

function decodeRequest(buf) {
  const msg = decodeMessage(buf);
  if (!msg || msg.type !== MSG_TYPE.REQUEST) return null;

  const p = msg.payload;
  let offset = 0;

  const id = p.slice(offset, offset + 16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  offset += 16;

  const methodIdx = p[offset++];
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'CONNECT'];
  const method = methodIdx >= 0 && methodIdx < methods.length ? methods[methodIdx] : 'GET';

  const urlLen = p.readUInt16BE(offset);
  offset += 2;
  const url = p.slice(offset, offset + urlLen).toString('utf8');
  offset += urlLen;

  const headersLen = p.readUInt16BE(offset);
  offset += 2;
  const headers = JSON.parse(p.slice(offset, offset + headersLen).toString('utf8'));
  offset += headersLen;

  const bodyLen = p.readUInt32BE(offset);
  offset += 4;
  const body = bodyLen > 0 ? p.slice(offset, offset + bodyLen).toString('base64') : '';

  return { id, method, url, headers, body };
}

// Response: id(16) + status(2) + headers(JSON) + body
function encodeResponse(id, statusCode, headers, body) {
  const idBuf = Buffer.alloc(16);
  if (typeof id === 'string') {
    Buffer.from(id.replace(/-/g, ''), 'hex').copy(idBuf);
  }

  const statusBuf = Buffer.alloc(2);
  statusBuf.writeUInt16BE(statusCode, 0);

  const headersBuf = Buffer.from(JSON.stringify(headers || {}), 'utf8');
  const headersLenBuf = Buffer.alloc(2);
  headersLenBuf.writeUInt16BE(headersBuf.length, 0);

  const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'base64') : (body || Buffer.alloc(0));
  const bodyLenBuf = Buffer.alloc(4);
  bodyLenBuf.writeUInt32BE(bodyBuf.length, 0);

  const payload = Buffer.concat([
    idBuf, statusBuf, headersLenBuf, headersBuf, bodyLenBuf, bodyBuf,
  ]);
  return encodeMessage(MSG_TYPE.RESPONSE, payload);
}

function decodeResponse(buf) {
  const msg = decodeMessage(buf);
  if (!msg || msg.type !== MSG_TYPE.RESPONSE) return null;

  const p = msg.payload;
  let offset = 0;

  const id = p.slice(offset, offset + 16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  offset += 16;

  const statusCode = p.readUInt16BE(offset);
  offset += 2;

  const headersLen = p.readUInt16BE(offset);
  offset += 2;
  const headers = JSON.parse(p.slice(offset, offset + headersLen).toString('utf8'));
  offset += headersLen;

  const bodyLen = p.readUInt32BE(offset);
  offset += 4;
  const body = bodyLen > 0 ? p.slice(offset, offset + bodyLen).toString('base64') : '';

  return { id, statusCode, headers, body };
}

// Tunnel Open: id(16) + host_len(1) + host + port(2)
function encodeTunnelOpen(id, host, port) {
  const idBuf = Buffer.alloc(16);
  if (typeof id === 'string') {
    Buffer.from(id.replace(/-/g, ''), 'hex').copy(idBuf);
  }
  const hostBuf = Buffer.from(host, 'utf8');
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  const payload = Buffer.concat([idBuf, Buffer.from([hostBuf.length]), hostBuf, portBuf]);
  return encodeMessage(MSG_TYPE.TUNNEL_OPEN, payload);
}

function decodeTunnelOpen(buf) {
  const msg = decodeMessage(buf);
  if (!msg || msg.type !== MSG_TYPE.TUNNEL_OPEN) return null;
  const p = msg.payload;
  const id = p.slice(0, 16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  const hostLen = p[16];
  const host = p.slice(17, 17 + hostLen).toString('utf8');
  const port = p.readUInt16BE(17 + hostLen);
  return { id, host, port };
}

// Tunnel Data: id(16) + data
function encodeTunnelData(id, data) {
  const idBuf = Buffer.alloc(16);
  if (typeof id === 'string') {
    Buffer.from(id.replace(/-/g, ''), 'hex').copy(idBuf);
  }
  const dataBuf = typeof data === 'string' ? Buffer.from(data, 'base64') : data;
  const payload = Buffer.concat([idBuf, dataBuf]);
  return encodeMessage(MSG_TYPE.TUNNEL_DATA, payload);
}

function decodeTunnelData(buf) {
  const msg = decodeMessage(buf);
  if (!msg || msg.type !== MSG_TYPE.TUNNEL_DATA) return null;
  const id = msg.payload.slice(0, 16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  const data = msg.payload.slice(16).toString('base64');
  return { id, data };
}

// Tunnel Close: id(16) + reason(1)
function encodeTunnelClose(id, reason = 0) {
  const idBuf = Buffer.alloc(16);
  if (typeof id === 'string') Buffer.from(id.replace(/-/g, ''), 'hex').copy(idBuf);
  const payload = Buffer.concat([idBuf, Buffer.from([reason])]);
  return encodeMessage(MSG_TYPE.TUNNEL_CLOSE, payload);
}

// Auth: token
function encodeAuth(token) {
  const tokenBuf = Buffer.from(token, 'utf8');
  return encodeMessage(MSG_TYPE.AUTH, tokenBuf);
}

// UDP Data: assocId(16) + host_len(1) + host + port(2) + data
function encodeUdpData(assocId, host, port, data) {
  const idBuf = Buffer.alloc(16);
  if (typeof assocId === 'string') Buffer.from(assocId.replace(/-/g, ''), 'hex').copy(idBuf);
  const hostBuf = Buffer.from(host, 'utf8');
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  const dataBuf = typeof data === 'string' ? Buffer.from(data, 'base64') : data;
  const payload = Buffer.concat([
    idBuf, Buffer.from([hostBuf.length]), hostBuf, portBuf, dataBuf,
  ]);
  return encodeMessage(MSG_TYPE.UDP_DATA, payload);
}

// =============================================================================
// Batch: merge multiple messages into one frame for efficiency
// =============================================================================
function encodeBatch(messages) {
  // messages is an array of encoded Buffers
  const count = messages.length;
  const countBuf = Buffer.alloc(2);
  countBuf.writeUInt16BE(count, 0);
  return Buffer.concat([countBuf, ...messages]);
}

function decodeBatch(buf) {
  if (buf.length < 2) return null;
  const count = buf.readUInt16BE(0);
  const messages = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    const msg = decodeMessage(buf.slice(offset));
    if (!msg) break;
    messages.push(msg);
    offset += msg.raw.length;
  }
  return messages;
}

module.exports = {
  MSG_TYPE,
  encodeMessage,
  decodeMessage,
  encodeRequest,
  decodeRequest,
  encodeResponse,
  decodeResponse,
  encodeTunnelOpen,
  decodeTunnelOpen,
  encodeTunnelData,
  decodeTunnelData,
  encodeTunnelClose,
  encodeAuth,
  encodeUdpData,
  encodeBatch,
  decodeBatch,
};