// =============================================================================
// ACME - Auto certificate management (Let's Encrypt)
// Migrated to TypeScript (issue #42, Phase 2).
//
// NOTE: CJS-style TS on purpose - acme-client is an optional dependency loaded
// inside try/catch (ACME degrades to disabled when it is missing) and
// __dirname resolves the cert directory. Node type stripping loads this file
// as CommonJS; callers use require('./lib/acme.ts').
// =============================================================================

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('fs');
const path = require('path');
const { X509Certificate } = require('crypto');
import type { IncomingMessage, ServerResponse } from 'http';

// --- Structural contract for the optional acme-client dependency -------------
interface AcmeChallenge {
  token: string;
}

interface AcmeStringable {
  toString(): string;
}

interface AcmeAutoOptions {
  csr: AcmeStringable;
  email?: string;
  termsOfServiceAgreed: boolean;
  challengeCreateFn(authz: unknown, challenge: AcmeChallenge, keyAuthorization: string): Promise<void>;
  challengeRemoveFn(authz: unknown, challenge: AcmeChallenge, keyAuthorization: string): Promise<void>;
  challengePriority: string[];
}

interface AcmeClientLike {
  auto(opts: AcmeAutoOptions): Promise<AcmeStringable>;
}

interface AcmeLibrary {
  Client: new (opts: { directoryUrl: string; accountKey: unknown }) => AcmeClientLike;
  forge: {
    createPrivateKey(): Promise<AcmeStringable>;
    createCsr(opts: { commonName: string; altNames: string[] }): Promise<[AcmeStringable, AcmeStringable]>;
  };
}

function toStringable(v: unknown): AcmeStringable {
  if (v && typeof (v as AcmeStringable).toString === 'function') {
    return v as AcmeStringable;
  }
  return { toString: () => String(v) };
}

interface CertificatePair {
  cert: string;
  key: string;
}

class ACMEManager {
  config: Record<string, unknown>;
  log: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
  enabled = false;
  domains: string[] = [];
  private certDir: string;
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  private _challenges: Map<string, string> | null = null;
  private email = '';
  private directoryUrl = 'https://acme-v02.api.letsencrypt.org/directory';

  constructor(config: Record<string, unknown>, logger: ACMEManager['log']) {
    this.config = config;
    this.log = logger;

    const tlsSection = config.tls as { cert_dir?: string } | undefined;
    this.certDir = tlsSection?.cert_dir || path.join(__dirname, '..', 'certs');

    let acme: AcmeLibrary | null = null;
    try {
      acme = require('acme-client') as AcmeLibrary;
    } catch (_) {
      // acme-client not installed
    }

    if (!acme) {
      this.log.info({}, 'acme-client not available. Run: npm install acme-client');
      return;
    }

    const acmeConfig = (config.acme || {}) as {
      enabled?: boolean;
      email?: string;
      domains?: string[];
      staging?: boolean;
    };
    if (!acmeConfig.enabled) return;
    if (!acmeConfig.email) {
      this.log.warn({}, 'ACME email not configured, skipping');
      return;
    }

    this.domains = acmeConfig.domains || [];
    if (this.domains.length === 0) {
      this.log.warn({}, 'ACME domains not configured, skipping');
      return;
    }

    this.email = acmeConfig.email;
    const staging = acmeConfig.staging !== false;
    this.directoryUrl = staging
      ? 'https://acme-staging-v02.api.letsencrypt.org/directory'
      : 'https://acme-v02.api.letsencrypt.org/directory';

    this.enabled = true;
    this.log.info({ domains: this.domains, staging }, 'ACME auto-certificate enabled');

    // Auto-renewal check every 24 hours
    this.renewalTimer = setInterval(() => this._checkRenewal(), 86400000);
    // Initial check after 5 seconds
    setTimeout(() => this._checkRenewal(), 5000);
  }

  private async _checkRenewal() {
    for (const domain of this.domains) {
      const certPath = path.join(this.certDir, `${domain}.pem`);
      const keyPath = path.join(this.certDir, `${domain}-key.pem`);

      // Check if certificate exists and is still valid
      if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        try {
          const cert = fs.readFileSync(certPath, 'utf8');
          const certObj = new X509Certificate(cert);
          const daysLeft = Math.floor((certObj.validTo.getTime() - Date.now()) / 86400000);
          if (daysLeft > 30) {
            this.log.info({ domain, daysLeft }, 'Certificate still valid, skipping renewal');
            continue;
          }
          this.log.info({ domain, daysLeft }, 'Certificate expiring soon, renewing...');
        } catch (_) {
          this.log.info({ domain }, 'Could not read certificate, re-issuing');
        }
      }

      try {
        await this._issueCertificate(domain);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error({ domain, error: message }, 'Failed to issue certificate');
      }
    }
  }

  private async _issueCertificate(domain: string) {
    this.log.info({ domain }, 'Issuing certificate...');

    let acme: AcmeLibrary;
    try {
      acme = require('acme-client') as AcmeLibrary;
    } catch (_) {
      throw new Error('acme-client not available');
    }

    const client = new acme.Client({
      directoryUrl: this.directoryUrl,
      accountKey: await acme.forge.createPrivateKey(),
    });

    // Create CSR
    const [key, csr] = await acme.forge.createCsr({
      commonName: domain,
      altNames: this.domains.filter((d) => d !== domain),
    });

    // Complete the challenge (HTTP-01)
    const cert = await client.auto({
      csr,
      email: this.email,
      termsOfServiceAgreed: true,
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        const token = challenge.token;
        // Store challenge response
        this._challenges = this._challenges || new Map();
        this._challenges.set(token, keyAuthorization);
      },
      challengeRemoveFn: async (_authz, challenge) => {
        const token = challenge.token;
        if (this._challenges) this._challenges.delete(token);
      },
      challengePriority: ['http-01'],
    });

    // Save certificate and key
    try {
      fs.mkdirSync(this.certDir, { recursive: true });
    } catch (_) {
      // ignore
    }
    fs.writeFileSync(path.join(this.certDir, `${domain}.pem`), toStringable(cert).toString());
    fs.writeFileSync(path.join(this.certDir, `${domain}-key.pem`), toStringable(key).toString());

    this.log.info(
      { domain, certPath: path.join(this.certDir, `${domain}.pem`) },
      'Certificate issued successfully'
    );
  }

  // Handle HTTP-01 challenge requests
  handleChallenge(req: IncomingMessage, res: ServerResponse): boolean {
    const pathname = req.url || '';
    if (!pathname.startsWith('/.well-known/acme-challenge/')) {
      return false;
    }
    const token = pathname.split('/').pop() || '';
    if (this._challenges && this._challenges.has(token)) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(this._challenges.get(token));
      return true;
    }
    return false;
  }

  getCertificate(domain: string): CertificatePair | null {
    const certPath = path.join(this.certDir, `${domain}.pem`);
    const keyPath = path.join(this.certDir, `${domain}-key.pem`);
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      return {
        cert: fs.readFileSync(certPath, 'utf8'),
        key: fs.readFileSync(keyPath, 'utf8'),
      };
    }
    return null;
  }

  destroy() {
    if (this.renewalTimer) clearInterval(this.renewalTimer);
  }
}

module.exports = { ACMEManager };
