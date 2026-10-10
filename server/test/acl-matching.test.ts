// =============================================================================
// ACL matching correctness (issue #116).
//
// Four defects, all silent:
//   * sourceIp rules never matched an IPv4 client on a dual-stack listener
//     (server.ts binds '::', so the peer reads ::ffff:1.2.3.4 and net.isIPv4
//     rejects it) - a deny rule simply did not apply;
//   * an unparseable condition was stored as an EMPTY list and _isInCIDR treated
//     an empty list as "matches everything" - so `deny sourceIp: "notanip"`
//     denied all traffic while the same typo in an allow rule allowed all of it,
//     and any IPv6 CIDR landed in exactly that hole;
//   * /33 shifted into a /1 mask instead of being rejected;
//   * targetDomain comma lists (as documented in config.yaml) were compiled as a
//     single literal pattern, so they matched nothing;
//   * '80-' became an empty port range (Number('') is 0, not NaN) and the rule
//     stopped matching, while '80-abc' became 80-65535.
//
// CJS-style module, matching the other tests: Node type-strips it in place.
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

export type {};

import type * as NodeAssert from 'assert/strict';

const test = require('node:test');
const assert: typeof NodeAssert = require('node:assert/strict');
const aclModule = require('../lib/acl.ts');

type Manager = {
  _ipToLong(ip: string): number | null;
  _parseCIDR(value: string): unknown[];
  _isInCIDR(ip: string, nets: unknown[]): boolean;
  _wildcardToRegex(value: string): RegExp | null;
  _parsePortRange(value: string): unknown[] | null;
  addRule(rule: { action: string; match: Record<string, string> }): boolean;
};

const ACLManager = (aclModule.ACLManager || aclModule.default || aclModule) as new (
  config: unknown,
  logger: unknown
) => Manager;

function silentLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => silentLogger() };
}

function manager(): Manager {
  return new ACLManager({ acl: { enabled: true, rules: [] } }, silentLogger());
}

test('an IPv4 client on a dual-stack listener still matches sourceIp rules', () => {
  const m = manager();
  assert.equal(
    m._ipToLong('::ffff:192.168.1.5'),
    m._ipToLong('192.168.1.5'),
    'the IPv4-mapped form is the same host'
  );
  const nets = m._parseCIDR('192.168.1.0/24');
  assert.equal(m._isInCIDR('::ffff:192.168.1.5', nets), true, 'the deny rule must apply');
  assert.equal(m._isInCIDR('192.168.1.5', nets), true, 'and so must the plain form');
  assert.equal(m._isInCIDR('10.0.0.1', nets), false, 'while other hosts stay unmatched');
});

test('an unparseable condition never matches everything', () => {
  const m = manager();
  assert.equal(m._isInCIDR('1.2.3.4', []), false, 'an empty list must not match');
  assert.deepEqual(m._parseCIDR('notanip'), [], 'a bad address parses to nothing');
  assert.deepEqual(m._parseCIDR('10.0.0.0/33'), [], 'a prefix above 32 is rejected');
  assert.deepEqual(m._parseCIDR('2001:db8::/32'), [], 'IPv6 is not supported and must not fall through');
  // ...and the rule is refused instead of being stored half-compiled.
  assert.equal(m.addRule({ action: 'deny', match: { sourceIp: 'notanip' } }), false, 'a bad sourceIp rule is rejected');
  assert.equal(m.addRule({ action: 'allow', match: { sourceIp: '2001:db8::/32' } }), false, 'so is an IPv6 one');
  assert.equal(m.addRule({ action: 'deny', match: { sourceIp: '10.0.0.0/8' } }), true, 'a valid rule is still accepted');
});

test('targetDomain supports the documented comma list', () => {
  const m = manager();
  const re = m._wildcardToRegex('*.facebook.com,*.twitter.com');
  assert.ok(re, 'the list must compile');
  assert.equal(re.test('www.facebook.com'), true);
  assert.equal(re.test('api.twitter.com'), true);
  assert.equal(re.test('evil-facebook.com'), false, 'no partial-domain matches');
  assert.equal(re.test('facebook.com'), false, 'and the wildcard still needs its label');
});

test('port ranges are validated instead of coerced', () => {
  const m = manager();
  assert.equal(m._parsePortRange('80-'), null, "'80-' must be refused, not become an empty range");
  assert.equal(m._parsePortRange('80-abc'), null, "'80-abc' must be refused, not become 80-65535");
  assert.equal(m._parsePortRange('abc'), null, 'a non-numeric port must be refused');
  assert.equal(m._parsePortRange('70000'), null, 'an out-of-range port must be refused');
  assert.equal(m._parsePortRange('443-80'), null, 'an inverted range must be refused');
  assert.deepEqual(m._parsePortRange('80,443-445'), [{ start: 80, end: 80 }, { start: 443, end: 445 }]);
  assert.equal(m.addRule({ action: 'deny', match: { targetPort: '80-' } }), false, 'a bad port rule is rejected');
});
