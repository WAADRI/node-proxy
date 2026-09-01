// =============================================================================
// ACME - Auto certificate management (Let's Encrypt)
// =============================================================================
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

let acme = null;
try {
  acme = require('acme-client');
} catch (_) {
  // acme-client not installed
}

class ACMEManager {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.enabled = false;
    this.domains = [];
    this.certDir = config.tls?.cert_dir || path.join(__dirname, '..', 'certs');
    this.renewalTimer = null;

    if (!acme) {
      this.log.info('acme-client not available. Run: npm install acme-client');
      return;
    }

    const acmeConfig = config.acme || {};
    if (!acmeConfig.enabled) return;
    if (!acmeConfig.email) {
      this.log.warn('ACME email not configured, skipping');
      return;
    }

    this.domains = acmeConfig.domains || [];
    if (this.domains.length === 0) {
      this.log.warn('ACME domains not configured, skipping');
      return;
    }

    this.email = acmeConfig.email;
    this.staging = acmeConfig.staging !== false;
    this.directoryUrl = this.staging
      ? 'https://acme-staging-v02.api.letsencrypt.org/directory'
      : 'https://acme-v02.api.letsencrypt.org/directory';

    this.enabled = true;
    this.log.info({ domains: this.domains, staging: this.staging }, 'ACME auto-certificate enabled');

    // Auto-renewal check every 24 hours
    this.renewalTimer = setInterval(() => this._checkRenewal(), 86400000);
    // Initial check after 5 seconds
    setTimeout(() => this._checkRenewal(), 5000);
  }

  async _checkRenewal() {
    for (const domain of this.domains) {
      const certPath = path.join(this.certDir, `${domain}.pem`);
      const keyPath = path.join(this.certDir, `${domain}-key.pem`);

      // Check if certificate exists and is still valid
      if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        try {
          const cert = fs.readFileSync(certPath, 'utf8');
          const certObj = new (require('crypto').X509Certificate)(cert);
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
        this.log.error({ domain, error: err.message }, 'Failed to issue certificate');
      }
    }
  }

  async _issueCertificate(domain) {
    this.log.info({ domain }, 'Issuing certificate...');

    const client = new acme.Client({
      directoryUrl: this.directoryUrl,
      accountKey: await acme.forge.createPrivateKey(),
    });

    // Create CSR
    const [key, csr] = await acme.forge.createCsr({
      commonName: domain,
      altNames: this.domains.filter(d => d !== domain),
    });

    // Complete the challenge (HTTP-01)
    const cert = await client.auto({
      csr,
      email: this.email,
      termsOfServiceAgreed: true,
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        const token = challenge.token;
        const keyAuth = keyAuthorization;
        // Store challenge response
        this._challenges = this._challenges || new Map();
        this._challenges.set(token, keyAuth);
      },
      challengeRemoveFn: async (authz, challenge, keyAuthorization) => {
        const token = challenge.token;
        if (this._challenges) this._challenges.delete(token);
      },
      challengePriority: ['http-01'],
    });

    // Save certificate and key
    try { fs.mkdirSync(this.certDir, { recursive: true }); } catch (_) {}
    fs.writeFileSync(path.join(this.certDir, `${domain}.pem`), cert.toString());
    fs.writeFileSync(path.join(this.certDir, `${domain}-key.pem`), key.toString());

    this.log.info({ domain, certPath: path.join(this.certDir, `${domain}.pem`) }, 'Certificate issued successfully');
  }

  // Handle HTTP-01 challenge requests
  handleChallenge(req, res) {
    const pathname = req.url;
    if (!pathname.startsWith('/.well-known/acme-challenge/')) {
      return false;
    }
    const token = pathname.split('/').pop();
    if (this._challenges && this._challenges.has(token)) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(this._challenges.get(token));
      return true;
    }
    return false;
  }

  getCertificate(domain) {
    const certPath = path.join(this.certDir, `${domain}.pem`);
    const keyPath = path.join(this.certDir, `${domain}-key.pem`);
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
    }
    return null;
  }

  destroy() {
    if (this.renewalTimer) clearInterval(this.renewalTimer);
  }
}

module.exports = { ACMEManager };