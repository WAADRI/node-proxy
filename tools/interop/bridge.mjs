// Interop bridge: runs the REAL TypeScript StreamMux (from a node-proxy
// checkout) against a WebSocket endpoint, controlled via JSON lines on stdio.
// The Go interop test spawns this process and drives both muxes live.
//
// Usage: node tools/interop/bridge.mjs <path-to-node-proxy-checkout>
// Env:   WS_URL=ws://127.0.0.1:PORT/
//
// stdio protocol (JSON lines):
//   -> {"op":"openTunnel","host":"x","port":80,"priority":128}
//   -> {"op":"sendData","id":3,"dataB64":"...","endStream":false}
//   -> {"op":"closeTunnel","id":3,"reason":0}
//   -> {"op":"ping"}
//   -> {"op":"goaway","lastStreamId":7}
//   -> {"op":"exit"}
//   <- {"event":"ready"|"stream"|"data"|"end"|"error"|"opened"|"rtt"|"goaway"|"cmdError",...}
//
// Requires Node >= 23.6 (native TS type stripping for the mux import) with
// the built-in WebSocket (Node >= 22 stable); no npm install needed.
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const [, , tsRepo] = process.argv;
const url = process.env.WS_URL;
if (!tsRepo || !url) {
  console.error('usage: WS_URL=ws://... node bridge.mjs <node-proxy-checkout>');
  process.exit(2);
}

const { StreamMux } = await import(pathToFileURL(`${tsRepo}/server/lib/stream-mux.ts`).href);

const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';

// Adapt the built-in WebSocket to the ws-like surface StreamMux expects:
// .on('message', (data, isBinary)), .on('close'), .send(data, opts, cb),
// .bufferedAmount.
const wsLike = {
  bufferedAmount: 0,
  listeners: { message: [], close: [] },
  on(ev, cb) {
    (wsLike.listeners[ev] ??= []).push(cb);
  },
  send(data, _opts, cb) {
    ws.send(data);
    if (cb) queueMicrotask(() => cb());
  },
};
ws.addEventListener('message', (ev) => {
  if (typeof ev.data === 'string') {
    handleSimText(ev.data);
  }
  const buf = typeof ev.data === 'string' ? Buffer.from(ev.data, 'utf8') : Buffer.from(ev.data);
  for (const cb of wsLike.listeners.message) cb(buf, typeof ev.data !== 'string');
});
ws.addEventListener('close', () => {
  for (const cb of wsLike.listeners.close) cb();
});

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let mux;

// ---------------------------------------------------------------------------
// Server simulation: when armed via {"op":"sim","token":...}, inbound text
// frames are answered like the real node-proxy server (auth/auth_ok) and
// tapped (info/heartbeat/stats) so tests can assert client behavior.
// ---------------------------------------------------------------------------
let sim = null;

function handleSimText(str) {
  if (!sim) return;
  let msg;
  try {
    msg = JSON.parse(str);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'auth':
      if (msg.token === sim.token) {
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        emit({ event: 'authed' });
      } else {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'bad token (sim)' }));
        emit({ event: 'authRejected' });
      }
      break;
    case 'info':
      emit({ event: 'info', info: msg.info ?? null });
      break;
    case 'heartbeat':
      emit({ event: 'heartbeat' });
      break;
    case 'stats':
      emit({ event: 'stats', stats: msg.stats ?? null });
      break;
  }
}

function attach(s) {
  s._onData = (chunk) => emit({ event: 'data', id: s.id, dataB64: chunk.toString('base64') });
  s._onEnd = () => emit({ event: 'end', id: s.id });
  s._onError = (reason) => emit({ event: 'error', id: s.id, reason: String(reason) });
}

ws.addEventListener('open', () => {
  mux = new StreamMux(wsLike);
  // Fires for every inbound HEADERS/HEADERS_END (new or existing) and for
  // TUNNEL_OPEN on new streams - the TS dispatcher contract.
  mux.onStream((stream) => {
    emit({ event: 'stream', id: stream.id, headers: stream.headers ?? null });
    attach(stream);
  });
  mux.onGoaway((lastStreamId) => emit({ event: 'goaway', lastStreamId }));
  emit({ event: 'ready' });
});

function handle(cmd) {
  switch (cmd.op) {
    case 'sim': {
      sim = { token: cmd.token };
      emit({ event: 'simArmed' });
      break;
    }
    case 'openTunnelTo': {
      // Server-sim tunnel toward a target the Go client should dial.
      const s = mux.openTunnel(cmd.host, cmd.port, cmd.priority ?? 128);
      if (s) attach(s);
      emit({ event: 'opened', id: s ? s.id : null });
      break;
    }
    case 'openRequest': {
      // Server-sim HTTP request dispatch (proxy-http.ts mux path): HEADERS
      // {type:'request',...} + optional body; the node answers with a
      // 'response' HEADERS frame on the same stream (surfaced via onStream).
      const s = mux.createStream(50);
      if (!s) throw new Error('createStream failed');
      attach(s);
      const headers = {
        type: 'request',
        id: cmd.id,
        method: cmd.method || 'GET',
        url: cmd.url,
        headers: cmd.headers || {},
      };
      s.sendHeaders(headers, !cmd.bodyB64);
      if (cmd.bodyB64) s.sendData(Buffer.from(cmd.bodyB64, 'base64'), true);
      emit({ event: 'opened', id: s.id });
      break;
    }
    case 'openTunnel': {
      const s = mux.openTunnel(cmd.host, cmd.port, cmd.priority ?? 128);
      if (s) attach(s); // outbound open does not fire onStream (TS behavior)
      emit({ event: 'opened', id: s ? s.id : null });
      break;
    }
    case 'sendData': {
      const s = mux.streams.get(cmd.id);
      if (!s) throw new Error(`no stream ${cmd.id}`);
      const ok = s.sendData(Buffer.from(cmd.dataB64, 'base64'), !!cmd.endStream);
      emit({ event: 'sent', id: cmd.id, ok });
      break;
    }
    case 'closeTunnel':
      mux.closeTunnel(cmd.id, cmd.reason ?? 0);
      break;
    case 'ping':
      mux.ping((rtt) => emit({ event: 'rtt', ms: rtt }));
      break;
    case 'goaway':
      mux.goaway(cmd.lastStreamId ?? 0);
      break;
    case 'exit':
      process.exit(0);
      break;
    default:
      throw new Error(`unknown op ${cmd.op}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  try {
    handle(cmd);
  } catch (e) {
    emit({ event: 'cmdError', op: cmd.op, error: String(e && e.message ? e.message : e) });
  }
});
rl.on('close', () => process.exit(0));
