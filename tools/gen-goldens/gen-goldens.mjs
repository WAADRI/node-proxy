// Generates golden wire vectors for the Go StreamMux codec using the REAL
// TypeScript encoder from a WAADRI/node-proxy checkout. The Go golden test
// (internal/streammux/golden_test.go) asserts that the Go codec decodes and
// re-encodes these exact bytes, which is the byte-level compatibility gate.
//
// Usage:
//
//	node tools/gen-goldens/gen-goldens.mjs <path-to-node-proxy-clone> <out-json>
//
// Requires Node >= 23.6 (native TS type stripping, no flag needed). The mux
// import is type-only in its dependencies, so no npm install of the clone is
// required.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , cloneDir, outPath] = process.argv;
if (!cloneDir || !outPath) {
  console.error('usage: node gen-goldens.mjs <clone-dir> <out-json>');
  process.exit(2);
}

const { StreamMux, FRAME_TYPE, FLAG } = await import(
  pathToFileURL(`${cloneDir}/server/lib/stream-mux.ts`).href
);

// Minimal stand-in for the ws WebSocket: capture everything the mux emits.
function fakeWS() {
  return {
    sent: [],
    bufferedAmount: 0,
    on() {},
    send(data, _opts, cb) {
      this.sent.push(Buffer.from(data));
      if (cb) queueMicrotask(() => cb());
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

// Drive the mux with a fixed send sequence and capture the WS messages.
// Payload values are hardcoded (never Date.now()) so the output is stable.
function capture(drive) {
  const ws = fakeWS();
  const mux = new StreamMux(ws);
  drive(mux);
  return new Promise((resolve) => {
    setImmediate(() => {
      clearInterval(mux._windowCheckInterval);
      resolve(ws.sent.map((b) => Buffer.from(b).toString('hex')));
      mux.close?.();
    });
  });
}

// Local structural parse of one WS message, for documentation in the golden
// file. The authoritative byte comparison happens in the Go test.
function parseMessage(hex) {
  const buf = Buffer.from(hex, 'hex');
  const frames = [];
  const push = (offset) => {
    const length = buf.readUInt32BE(offset);
    frames.push({
      type: buf[offset + 4],
      stream_id: buf.readUInt32BE(offset + 5),
      flags: buf.readUInt32BE(offset + 9),
      payload_hex: buf.subarray(offset + 13, offset + 13 + length).toString('hex'),
    });
    return offset + 13 + length;
  };
  if (buf.length >= 2 && buf.readUInt16BE(0) >= 2) {
    let offset = 2;
    while (offset < buf.length && offset + 13 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      if (length > 16384 || offset + 13 + length > buf.length) break;
      offset = push(offset);
    }
  } else if (buf.length >= 13) {
    push(0);
  }
  return frames;
}

const cases = [];
async function addCase(name, kind, drive) {
  const messages = await capture(drive);
  if (messages.length !== 1) {
    throw new Error(`${name}: expected exactly 1 WS message, got ${messages.length}`);
  }
  cases.push({ name, kind, wire_hex: messages[0], frames: parseMessage(messages[0]) });
  console.log(`${name}: ${messages[0].length} bytes`);
}

const F = FRAME_TYPE;
const headersObj = { method: 'GET', url: 'http://example.com/', headers: { host: 'example.com' } };

await addCase('headers_end_headers', 'single', (m) =>
  m._sendFrame(1, F.HEADERS, headersObj, FLAG.END_HEADERS)
);
await addCase('data_payload', 'single', (m) => m._sendFrame(1, F.DATA, Buffer.from('hello tunnel'), 0));
await addCase('data_empty_end_stream', 'single', (m) =>
  m._sendFrame(1, F.DATA, Buffer.alloc(0), FLAG.END_STREAM)
);
await addCase('data_max_frame_size', 'single', (m) =>
  m._sendFrame(2, F.DATA, Buffer.alloc(16384, 0xAB), 0)
);
await addCase('ping', 'single', (m) => m._sendFrame(0, F.PING, { time: 1700000000123 }, 0));
await addCase('pong', 'single', (m) => m._sendFrame(0, F.PONG, { time: 1700000000123 }, 0));
await addCase('window_update_stream', 'single', (m) =>
  m._sendFrame(3, F.WINDOW_UPDATE, { increment: 32768 }, 0)
);
await addCase('window_update_connection', 'single', (m) =>
  m._sendFrame(0, F.WINDOW_UPDATE, { increment: 1048576 }, 0)
);
await addCase('tunnel_open', 'single', (m) => m._sendFrame(5, F.TUNNEL_OPEN, { host: 'example.com', port: 443 }, 0));
await addCase('tunnel_data_binary', 'single', (m) =>
  m._sendFrame(5, F.TUNNEL_DATA, Buffer.from([0x00, 0x01, 0x02, 0xfd, 0xfe, 0xff]), 0)
);
await addCase('tunnel_close_numeric_reason', 'single', (m) => m._sendFrame(5, F.TUNNEL_CLOSE, { reason: 0 }, 0));
await addCase('tunnel_close_string_reason', 'single', (m) =>
  m._sendFrame(5, F.TUNNEL_CLOSE, { reason: 'target_closed' }, 0)
);
await addCase('goaway', 'single', (m) => m._sendFrame(0, F.GOAWAY, { lastStreamId: 99 }, 0));
await addCase('rst_stream', 'single', (m) => m._sendFrame(7, F.RST_STREAM, { reason: 'boom' }, 0));
await addCase('priority', 'single', (m) => m._sendFrame(9, F.PRIORITY, { priority: 64 }, 0));

// Batch: three frames queued in one tick are flushed as a single BATCH
// message ([2B count][frame][frame]...), the format real deployments use.
await addCase('batch_mixed_json_binary', 'batch', (m) => {
  m._sendFrame(0, F.PING, { time: 1700000000123 }, 0);
  m._sendFrame(11, F.DATA, Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05]), 0);
  m._sendFrame(5, F.TUNNEL_OPEN, { host: 'example.com', port: 443 }, 0);
});
await addCase('batch_many_small', 'batch', (m) => {
  for (let i = 0; i < 8; i++) {
    m._sendFrame(2 * i + 1, F.DATA, Buffer.from(`chunk-${i}`), 0);
  }
});

// Provenance: record which commit the vectors were generated from.
let source = { repo: 'github.com/WAADRI/node-proxy', file: 'server/lib/stream-mux.ts' };
try {
  source.commit = execFileSync('git', ['-C', cloneDir, 'rev-parse', '--short', 'HEAD']).toString().trim();
} catch {
  source.commit = 'unknown';
}

writeFileSync(
  outPath,
  JSON.stringify(
    {
      comment: 'Golden wire vectors generated by tools/gen-goldens/gen-goldens.mjs with the real TypeScript StreamMux encoder. Do not edit by hand; regenerate instead.',
      source,
      cases,
    },
    null,
    2
  ) + '\n'
);
console.log(`wrote ${cases.length} cases to ${outPath}`);
process.exit(0); // the mux constructors arm setInterval; end the process explicitly
