// Detection of the credential defaults that ship in this repository (issues #121 / #118).
//
// Pulled out of server.ts so it can be tested as BEHAVIOUR instead of as source text. The first
// version of this guard indexed the loaded config with the wrong segment of a dotted path, so
// `config.auth['auth']` was always undefined and the guard was dead code for EVERY
// configuration - while a source-invariant test stayed green (issue #199).
//
// This also removes that bug class entirely: instead of splitting 'auth.web.password' and
// indexing by the pieces, the section and the field are read directly.
//
// Module style follows the sibling lib files (see proxy-socks5.ts): plain ESM exports, loaded
// from server.ts with require(). Adding module.exports as well would make Node treat this file
// as ESM and throw "module is not defined in ES module scope".
'use strict';

export type CredentialSection = { enabled?: boolean; password?: unknown };
export type CredentialDefaultsConfig = { auth?: Record<string, CredentialSection | undefined> };

// [section under auth, the password value shipped in this repository]
const SHIPPED_CREDENTIAL_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['web', 'admin123'],
  ['proxy', 'proxy-pass'],
];

/**
 * Names the shipped password defaults that are still in use, as 'auth.<section>.password = <v>'.
 * A section that is absent or explicitly disabled is skipped: a deployment that turned proxy
 * auth off must not be nagged about a password it does not use.
 */
export function findShippedCredentialDefaults(config: CredentialDefaultsConfig | undefined): string[] {
  const offenders: string[] = [];
  for (const [section, shipped] of SHIPPED_CREDENTIAL_DEFAULTS) {
    const group = config?.auth?.[section];
    if (!group || group.enabled === false) continue;
    if (String(group.password ?? '') === shipped) {
      offenders.push('auth.' + section + '.password = ' + shipped);
    }
  }
  return offenders;
}