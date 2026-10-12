// =============================================================================
// The optional ACME HTTP-01 listener must be opt-in and non-fatal (issue #122).
//
// Let us Encrypt validates over plain HTTP on port 80 while the panel listens elsewhere, so a
// deployment without a reverse proxy needs a way to expose the challenge. ACME_HTTP_PORT opts
// into a listener that serves ONLY the challenge path (404 for everything else, so no extra
// unauthenticated surface appears), that survives a bind failure (privileges, port in use) by
// logging and continuing - a certificate feature must never take the proxy down - and that is
// closed on shutdown.
//
// server.ts is an entry script, so this is a source-level invariant, like the other tests in
// this suite.
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

const src = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');

test('the ACME :80 listener is opt-in, challenge-only, non-fatal and closed', () => {
  assert.ok(/process\.env\.ACME_HTTP_PORT/.test(src), 'it must be opt-in via the environment');
  assert.ok(/if \(acmeManager\.enabled && acmeHttpPort > 0\)/.test(src), 'and only run when ACME is on and a port is given');
  assert.ok(/if \(acmeManager\.handleChallenge\(req, res\)\) return;/.test(src), 'it must try the challenge first');
  assert.ok(/res\.writeHead\(404/.test(src), 'and answer 404 to everything else');
  assert.ok(/ACME HTTP-01 listener failed; continuing without it/.test(src), 'a bind failure must be non-fatal');
  assert.ok(/acmeHttpServer\.close\(\)/.test(src), 'and shutdown must close it');
  const listen = src.indexOf('listener.listen(');
  const close = src.indexOf('acmeHttpServer.close()');
  assert.ok(listen > 0 && close > listen, 'the listener is started before it is closed');
  assert.ok(/IncomingMessage, res: import\('http'\)\.ServerResponse/.test(src), 'the handler must be typed (no implicit any)');
});