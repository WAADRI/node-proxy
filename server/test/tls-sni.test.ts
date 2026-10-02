// =============================================================================
// TLS SNI extraction (issue #107).
//
// The parser is exercised against a ClientHello captured from a real TLS client
// rather than a hand-built buffer: an earlier hand-rolled attempt read the
// handshake length as two bytes instead of three, silently produced a tiny bound
// and reported "no SNI" for every site - a mistake a fixture built from the same
// misunderstanding would have shared.
//
// The watchSni tests pin the property the proxy depends on: observing a tunnel's
// bytes must not remove them from the tunnel.
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';
import type { Socket as NetSocket } from 'net';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');

const { parseSni, watchSni, looksLikeTlsHandshake, MAX_CLIENT_HELLO_BYTES } = require('../lib/tls-sni.ts');

// Capture a real ClientHello: a TLS client against a raw TCP server. The
// handshake never completes; only the first flight matters here. No servername
// (or an IP target) makes Node omit the SNI extension entirely.
function captureClientHello(servername?: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const server = net.createServer((socket: NetSocket) => {
      socket.once('data', (chunk: Buffer) => {
        socket.destroy();
        server.close(() => resolve(chunk));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      const options: { host: string; port: number; rejectUnauthorized: boolean; servername?: string } = {
        host: '127.0.0.1',
        port,
        rejectUnauthorized: false,
      };
      if (servername) options.servername = servername;
      const client = tls.connect(options);
      client.on('error', () => {});
    });
  });
}

test('a real ClientHello yields its SNI', async () => {
  const hello = await captureClientHello('example.test');
  assert.ok(looksLikeTlsHandshake(hello), 'the first byte of a ClientHello is a handshake record');
  assert.equal(parseSni(hello), 'example.test');
});

test('a ClientHello without a server_name extension yields null', async () => {
  const hello = await captureClientHello(undefined);
  assert.ok(looksLikeTlsHandshake(hello));
  assert.equal(parseSni(hello), null);
});

test('a fragmented ClientHello never throws, and is null until it is readable', async () => {
  const hello = await captureClientHello('fragmented.test');
  // Prefixes shorter than the fixed part of a ClientHello cannot contain an SNI.
  for (let i = 0; i < 44; i++) {
    assert.equal(parseSni(hello.subarray(0, i)), null, `prefix of ${i} bytes`);
  }
  // Every prefix must be handled without throwing, whatever it contains.
  for (let i = 44; i < hello.length; i += 7) {
    assert.doesNotThrow(() => parseSni(hello.subarray(0, i)), `prefix of ${i} bytes`);
  }
  assert.equal(parseSni(hello), 'fragmented.test');
});

test('non-TLS and malformed input yields null', () => {
  assert.equal(parseSni(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')), null);
  assert.equal(parseSni(Buffer.alloc(0)), null);
  assert.equal(parseSni(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9])), null);
  // A handshake record whose handshake type is not ClientHello.
  assert.equal(parseSni(Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0x00, 0x10, 0x02]), Buffer.alloc(32)])), null);
  assert.equal(looksLikeTlsHandshake(Buffer.from('GET / HTTP/1.1')), false);
});

test('watchSni reports the SNI and leaves every byte for the tunnel', async () => {
  const hello = await captureClientHello('observed.test');
  const socket = new EventEmitter();
  const piped: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => piped.push(chunk)); // stands in for the tunnel pipe

  let seen: string | null = null;
  watchSni(socket, (name: string) => {
    seen = name;
  });

  // Cut inside the fixed part of the hello: the SNI extension sits further in
  // (a real ClientHello is ~1.5KiB, padded, while the SNI is around byte 190).
  const cut = 40;
  socket.emit('data', hello.subarray(0, cut));
  assert.equal(seen, null, 'a prefix without the extension list is not enough');
  socket.emit('data', hello.subarray(cut));

  assert.equal(seen, 'observed.test');
  assert.equal(socket.listenerCount('data'), 1, 'the observer detaches once settled');
  assert.equal(Buffer.concat(piped).length, hello.length, 'the tunnel listener still sees every byte');
  assert.ok(Buffer.concat(piped).equals(hello));
});

test('watchSni starts from the CONNECT head when the client did not wait', async () => {
  const hello = await captureClientHello('head.test');
  const socket = new EventEmitter();
  let seen: string | null = null;
  watchSni(
    socket,
    (name: string) => {
      seen = name;
    },
    hello as Buffer
  );
  assert.equal(seen, 'head.test');
  assert.equal(socket.listenerCount('data'), 0, 'nothing to listen for when the head already answered');
});

test('watchSni gives up on non-TLS traffic instead of buffering it', () => {
  const socket = new EventEmitter();
  let called = false;
  watchSni(socket, () => {
    called = true;
  });
  socket.emit('data', Buffer.from('GET / HTTP/1.1\r\nHost: example.test\r\n\r\n'));
  assert.equal(called, false);
  assert.equal(socket.listenerCount('data'), 0, 'must detach so a long tunnel is not parsed forever');
});

test('watchSni stops accumulating at the cap', () => {
  const socket = new EventEmitter();
  watchSni(socket, () => {});
  // Looks like a TLS record but the handshake type is not ClientHello, so the
  // only way out is the size cap.
  const junk = Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0x00, 0x00, 0x00]), Buffer.alloc(4096)]);
  for (let sent = 0; sent <= MAX_CLIENT_HELLO_BYTES; sent += junk.length) {
    socket.emit('data', junk);
  }
  assert.equal(socket.listenerCount('data'), 0, 'must detach at MAX_CLIENT_HELLO_BYTES');
});

test('the request log keeps the SNI field', () => {
  // LogHub.record() normalizes a fixed set of fields, so a field that is not
  // declared there would be dropped silently - exactly the kind of gap that
  // makes a feature look implemented while the panel shows nothing.
  const { LogHub } = require('../lib/log-hub.ts');
  const hub = new LogHub(silentLogger(), { maxEntries: 5 });
  hub.record({ kind: 'tunnel', method: 'CONNECT', url: '203.0.113.7:443', sni: 'example.test' });
  hub.record({ kind: 'http', method: 'GET', url: 'http://example.test/' });
  const entries = hub.getRecent(5);
  assert.equal(entries[0].sni, 'example.test');
  assert.equal(entries[1].sni, '', 'a plain HTTP request has no SNI and must not inherit one');
});

function silentLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => silentLogger() };
}
