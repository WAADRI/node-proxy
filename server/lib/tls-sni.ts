// =============================================================================
// TLS SNI extraction for the request log (issue #107).
//
// The proxy only ever sees an HTTPS session as `CONNECT host:port` followed by
// opaque bytes, so a log entry can show nothing but the address the client asked
// for. The first flight is a plaintext ClientHello, and its server_name (SNI)
// extension names the site the client is actually visiting - the whole story
// when the CONNECT target is a literal IP, which is the usual crawler case.
//
// Extraction is best-effort by design: anything malformed, truncated or simply
// not TLS returns null instead of throwing, because this runs in the proxy data
// path. Callers hand the bytes back with socket.unshift() and must never let
// extraction delay or fail the tunnel.
//
// Known limits, which callers should not try to work around:
//   - HTTP/3 (QUIC) carries TLS over UDP, so there is no TCP hello to read;
//   - TLS 1.3 with Encrypted Client Hello hides the SNI on purpose.
// Both fall back to the CONNECT target.
// =============================================================================

// A ClientHello is normally well under 2 KiB. This caps what a caller may
// accumulate while waiting for a fragmented hello to become readable.
export const MAX_CLIENT_HELLO_BYTES = 8192;

const CONTENT_TYPE_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXTENSION_SERVER_NAME = 0x0000;

// True when the buffer starts a TLS handshake record, i.e. still worth
// accumulating. Non-TLS traffic (a plain HTTP request to port 443, for example)
// is rejected immediately.
export function looksLikeTlsHandshake(buf: Buffer): boolean {
  return Buffer.isBuffer(buf) && buf.length >= 1 && buf[0] === CONTENT_TYPE_HANDSHAKE;
}

// Returns the SNI host name, or null when it cannot be determined.
export function parseSni(buf: Buffer): string | null {
  if (!Buffer.isBuffer(buf) || buf.length < 9) return null;
  if (buf[0] !== CONTENT_TYPE_HANDSHAKE) return null; // not a handshake record
  if (buf[5] !== HANDSHAKE_CLIENT_HELLO) return null; // not a ClientHello

  const recordLen = buf.readUInt16BE(3);
  // The handshake length is THREE bytes (RFC 5246 7.4 / RFC 8446 4.4). Reading
  // only two silently yields a tiny bound and the parse fails with "no SNI".
  const handshakeLen = (buf[6] << 16) | (buf[7] << 8) | buf[8];
  const end = Math.min(buf.length, 5 + Math.min(recordLen, handshakeLen));

  let p = 9 + 2 + 32; // handshake header, client version, random
  if (p + 1 > end) return null;
  const sessionIdLen = buf[p];
  p += 1 + sessionIdLen;

  if (p + 2 > end) return null;
  const cipherSuitesLen = buf.readUInt16BE(p);
  p += 2 + cipherSuitesLen;

  if (p + 1 > end) return null;
  const compressionLen = buf[p];
  p += 1 + compressionLen;

  if (p + 2 > end) return null;
  const extensionsLen = buf.readUInt16BE(p);
  p += 2;
  const extensionsEnd = Math.min(end, p + extensionsLen);

  while (p + 4 <= extensionsEnd) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    p += 4;
    if (p + len > extensionsEnd) return null; // truncated extension
    if (type === EXTENSION_SERVER_NAME) {
      // server_name: list length (2), name type (1), name length (2), name
      if (len < 5) return null;
      const nameLen = buf.readUInt16BE(p + 3);
      if (p + 5 + nameLen > p + len) return null;
      const name = buf.toString('utf8', p + 5, p + 5 + nameLen);
      return name || null;
    }
    p += len;
  }
  return null;
}

// Minimal structural view of a socket, so this module does not need to import
// net and can be exercised with a plain EventEmitter in tests.
interface DataSource {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  once(event: 'error', listener: () => void): unknown;
}

// Observes the first bytes of a CONNECT tunnel and reports the SNI once.
//
// This only ADDS a 'data' listener: every listener on a socket receives the same
// chunks, so nothing is consumed, nothing is unshifted and the tunnel pipe is
// untouched. The listener detaches itself as soon as the answer is known (name
// found, traffic turns out not to be TLS, or the accumulation cap is reached),
// so a long-lived tunnel does not keep parsing bytes.
//
// `initial` is the CONNECT `head`, which the HTTP parser already consumed and
// which is handed to the node separately - it is inspected here, not modified.
export function watchSni(
  socket: DataSource,
  onSni: (name: string) => void,
  initial?: Buffer | null
): void {
  // Explicitly the generic Buffer type: chunks arrive as Buffer<ArrayBufferLike>.
  let acc: Buffer = Buffer.alloc(0);
  let settled = false;

  const detach = () => {
    settled = true;
    socket.removeListener('data', onData);
  };

  // Returns true when no further bytes can change the outcome.
  const inspect = (): boolean => {
    const name = parseSni(acc);
    if (name) {
      onSni(name);
      detach();
      return true;
    }
    // A non-TLS first byte (plain HTTP on port 443, for instance) means there is
    // no ClientHello coming; anything else just needs more bytes.
    if (acc.length > 0 && acc[0] !== CONTENT_TYPE_HANDSHAKE) {
      detach();
      return true;
    }
    if (acc.length >= MAX_CLIENT_HELLO_BYTES) {
      detach();
      return true;
    }
    return false;
  };

  function onData(chunk: Buffer): void {
    if (settled) return;
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
    inspect();
  }

  if (Buffer.isBuffer(initial) && initial.length > 0) {
    acc = initial;
    if (inspect()) return;
  }
  socket.on('data', onData);
  // The socket going away ends the observation; without this the listener would
  // outlive the tunnel on a half-open socket.
  socket.once('close', detach);
  socket.once('error', detach);
}
