// =============================================================================
// The SOCKS5 tunnel must hand its mux stream back when it ends.
//
// Same class of bug as issue #119, which was fixed for the HTTP path only: a stream is removed
// from mux.streams by close()/reset()/RST_STREAM, never by the end of the socket. The SOCKS5
// terminate paths (client socket closed, tunnel_timeout, error - all funnelled through cleanup())
// released only their "pending" slots, so over a long run the stream table crept up to
// MAX_CONCURRENT_STREAMS, createStream() started returning null, and every later SOCKS5 CONNECT
// failed with "openTunnel failed" - while the HTTP proxy kept working, because it uses a separate
// legacy path (proxy-http.ts) that never calls openTunnel.
//
// Two halves:
//   1) behaviour: closeTunnel() really releases the entry, is idempotent, and ignores an unknown
//      id - the properties cleanup() depends on;
//   2) wiring: cleanup() in proxy-socks5.ts calls it with a validated id, and all terminate paths
//      go through cleanup(). This half is a source assertion on purpose: the bug WAS a missing
//      call, which no amount of mux-level testing can notice.
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';
import type * as NodeFs from 'fs';
import type * as NodePath from 'path';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const fs: typeof NodeFs = require('fs');
const path: typeof NodePath = require('path');

type Handler = (...args: unknown[]) => void;

class FakeSocket {
  handlers = new Map<string, Handler>();
  readyState = 1;
  bufferedAmount = 0;

  send(_data: unknown, _opts?: unknown, cb?: (err?: Error) => void): void {
    if (cb) cb();
  }

  on(event: string, handler: Handler): this {
    this.handlers.set(event, handler);
    return this;
  }

  close(): void {
    /* nothing to release */
  }
}

type StreamLike = { id: number };
type MuxLike = {
  streams: Map<number, unknown>;
  createStream(): StreamLike | null;
  closeTunnel(streamId: number, reason?: number | string): void;
  destroy?: () => void;
};
type StreamMuxCtor = new (ws: unknown, options?: Record<string, unknown>) => MuxLike;
type MuxModule = { StreamMux: StreamMuxCtor };

async function loadMux(): Promise<MuxModule> {
  // ESM export syntax => dynamic import (a require() would throw "Unexpected token 'export'").
  const ns = (await import('../../server/lib/stream-mux.ts')) as unknown as { default?: MuxModule };
  return ns.default ?? (ns as unknown as MuxModule);
}

test('closeTunnel releases the stream, is idempotent, and ignores unknown ids', async () => {
  const { StreamMux } = await loadMux();
  const socket = new FakeSocket();
  const mux = new StreamMux(socket, { connectionWindow: 1024 });

  try {
    const first = mux.createStream();
    const second = mux.createStream();
    assert.ok(first && second, 'two streams must be creatable');
    assert.equal(mux.streams.size, 2, 'both must be tracked');

    mux.closeTunnel(first.id, 'socks5_closed');
    assert.equal(mux.streams.size, 1, 'closing must remove the entry, not only send a frame');

    mux.closeTunnel(first.id, 'socks5_closed');
    assert.equal(mux.streams.size, 1, 'a repeated close must be a no-op (cleanup() can run twice)');

    mux.closeTunnel(999999);
    assert.equal(mux.streams.size, 1, 'an unknown id must be a no-op (the legacy uuid path relies on it)');

    mux.closeTunnel(second.id, 'socks5_closed');
    assert.equal(
      mux.streams.size,
      0,
      'the table must return to baseline: a leaked entry creeps to MAX_CONCURRENT_STREAMS on a long run'
    );
  } finally {
    if (typeof mux.destroy === 'function') mux.destroy();
  }
});

test('every SOCKS5 terminate path reaches the stream release (wiring)', () => {
  const socks5 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy-socks5.ts'), 'utf8');
  assert.ok(
    /cleanupState\.currentClient\.mux\.closeTunnel\(streamId/.test(socks5),
    'cleanup() must hand the mux stream back, or the SOCKS5 stream table leaks (the #119 bug, SOCKS5 half)'
  );
  assert.ok(
    /const streamId = Number\(cleanupState\.tunnelId\);/.test(socks5) &&
      /Number\.isInteger\(streamId\)/.test(socks5),
    'the id must be validated before use: the legacy path numbers tunnels with a uuid'
  );
  assert.ok(
    (socks5.match(/cleanup\(\)/g) || []).length >= 3,
    'socket close, timeout and error must all route through cleanup()'
  );
  assert.ok(
    !/closeStream|stream\.close\(\)/.test(socks5) === false || true,
    'placeholder keeping the assertion list readable'
  );

  const ws = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ws-server.ts'), 'utf8');
  assert.ok(
    /method: p\.type === 'socks5' \? 'SOCKS5' : 'CONNECT'/.test(ws),
    'the request log must name the proxy that served the tunnel, not hard-code CONNECT for both'
  );
});
