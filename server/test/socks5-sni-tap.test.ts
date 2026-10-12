// =============================================================================
// The SOCKS5 tunnel must tap the ClientHello for its SNI, like the HTTP CONNECT path does.
//
// Issue #107 gave the request log the visited site name, but only proxy-http.ts called
// watchSni(). Every SOCKS5 row therefore kept an empty SNI in the panel while the code, the
// log entry and the field mapping all looked present - the classic "green invariant, dead
// behaviour" shape this batch kept hitting. Two halves here:
//   1) behaviour: watchSni really reports the name from a REAL ClientHello, whole or fragmented;
//   2) wiring: proxy-socks5.ts consults it on BOTH tunnel paths (mux and classic).
//
// The hello bytes come from node's own TLS stack: tls.connect() to a plain net server sends the
// ClientHello immediately, so no certificate is needed and the test never hand-builds protocol
// bytes (a hand-built sample once failed to parse while looking correct field by field).
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';
import type * as NodeEvents from 'events';
import type * as NodeFs from 'fs';
import type * as NodePath from 'path';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const events: typeof NodeEvents = require('node:events');
const fs: typeof NodeFs = require('fs');
const path: typeof NodePath = require('path');
const net = require('net');
const tls = require('tls');

type SniModule = {
  watchSni: (socket: unknown, onSni: (name: string) => void, initial?: Buffer | null) => void;
  parseSni: (buf: Buffer) => string | null;
};

const sni = require('../lib/tls-sni.ts') as SniModule;

// Capture the ClientHello node itself sends towards a plain TCP listener (the handshake is never
// completed, which is irrelevant - the first flight is already on the wire).
function captureClientHello(servername: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const server = net.createServer((sock: import('net').Socket) => {
      sock.on('data', (chunk: Buffer) => {
        acc = Buffer.concat([acc, chunk]);
        if (sni.parseSni(acc)) {
          sock.destroy();
          server.close();
          resolve(acc);
        }
      });
      sock.on('error', () => {});
    });
    const bail = setTimeout(() => {
      server.close();
      reject(new Error('no ClientHello was captured'));
    }, 5000);
    bail.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const client = tls.connect({ port, host: '127.0.0.1', servername, rejectUnauthorized: false });
      client.on('error', () => {
        // The fake listener never speaks TLS; the hello is all this test needs.
      });
      client.on('close', () => clearTimeout(bail));
    });
  });
}

test('watchSni reports the name from a real ClientHello, whole or fragmented', async () => {
  const hello = await captureClientHello('example.com');
  assert.ok(hello.length > 40, 'the captured flight must be a real hello');
  assert.equal(sni.parseSni(hello), 'example.com', 'the parser must read the hello node itself sent');

  // Whole hello in one chunk.
  const socketA = new events.EventEmitter();
  const seenA: string[] = [];
  sni.watchSni(socketA, (n) => seenA.push(n), null);
  socketA.emit('data', hello);
  assert.deepEqual(seenA, ['example.com']);

  // Fragmented hello: TCP may split it anywhere, so the tap must accumulate.
  const socketB = new events.EventEmitter();
  const seenB: string[] = [];
  sni.watchSni(socketB, (n) => seenB.push(n), null);
  for (let i = 0; i < hello.length; i += 7) {
    socketB.emit('data', hello.subarray(i, Math.min(i + 7, hello.length)));
  }
  assert.deepEqual(seenB, ['example.com'], 'a fragmented ClientHello must still yield the name');

  // Part of the hello arrives as the CONNECT head (the HTTP path), the rest on the socket.
  const socketC = new events.EventEmitter();
  const seenC: string[] = [];
  sni.watchSni(socketC, (n) => seenC.push(n), hello.subarray(0, 11));
  socketC.emit('data', hello.subarray(11));
  assert.deepEqual(seenC, ['example.com']);

  // Non-TLS traffic on port 443 must settle quietly with no name.
  const socketD = new events.EventEmitter();
  const seenD: string[] = [];
  sni.watchSni(socketD, (n) => seenD.push(n), null);
  socketD.emit('data', Buffer.from('GET / HTTP/1.0\r\n\r\n', 'utf8'));
  assert.deepEqual(seenD, []);
});

test('both SOCKS5 tunnel paths consult the shared SNI tap (issue #107 follow-up)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'proxy-socks5.ts'), 'utf8');
  const taps = (src.match(/watchSni\(/g) || []).length;
  assert.equal(taps, 2, 'the mux path and the classic path must both tap the ClientHello');
  assert.ok(
    /import \{ watchSni \} from '\.\/tls-sni\.ts';/.test(src),
    'and it must import the shared probe rather than reimplementing it'
  );
  assert.ok(
    /record\.sni = name/.test(src),
    'and the observed name must reach the pending record the log entry is built from'
  );
});
