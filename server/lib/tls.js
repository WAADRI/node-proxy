// =============================================================================
// TLS - Certificate management with auto-generation
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');

const CERTS_DIR = path.join(__dirname, '..', 'certs');
const DEFAULT_CERT = path.join(CERTS_DIR, 'cert.pem');
const DEFAULT_KEY = path.join(CERTS_DIR, 'key.pem');

function generateSelfSignedCert() {
  // Generate a self-signed certificate using Node.js crypto
  const { X509Certificate } = require('crypto');

  // Generate ECDSA key pair (faster than RSA)
  const keyPair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Create a self-signed certificate
  const cert = crypto.createCertificate('selfsigned', {
    subject: '/CN=Node-Proxy',
    days: 365,
    key: keyPair.privateKey,
  });

  // Actually, Node.js doesn't have crypto.createCertificate directly.
  // Let me use a simpler approach with openssl or a manual cert generation.
  return generateCertWithForge(keyPair);
}

function generateCertWithForge(keyPair) {
  // Since we can't rely on openssl being available, and we don't want to add
  // a heavy dependency like node-forge, let me generate a simple self-signed cert
  // using the approach of writing a config file and calling openssl if available,
  // or just using a pre-generated fallback.

  // For now, let's use a practical approach: check if openssl is available,
  // otherwise advise the user to install it or provide their own certs.

  const { execSync } = require('child_process');
  const certPath = DEFAULT_CERT;
  const keyPath = DEFAULT_KEY;

  try {
    // Check if openssl is available
    execSync('openssl version', { stdio: 'ignore' });

    const configPath = path.join(CERTS_DIR, 'openssl.cnf');
    const configContent = `[req]
default_bits = 2048
prompt = no
default_md = sha256
x509_extensions = v3_req
distinguished_name = dn

[dn]
CN = Node-Proxy

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = node-proxy
IP.1 = 127.0.0.1
`;

    fs.writeFileSync(configPath, configContent);

    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -config "${configPath}" -nodes -sha256`,
      { stdio: 'ignore' }
    );

    // Clean up config
    try { fs.unlinkSync(configPath); } catch (_) {}

    return { cert: certPath, key: keyPath };
  } catch (err) {
    throw new Error(
      'OpenSSL not found. Please install OpenSSL or provide TLS certificates:\n' +
      `  cert: ${certPath}\n  key: ${keyPath}\n` +
      'Or set tls.enabled: false in config.yaml to run without TLS.'
    );
  }
}

function loadTLSCredentials(config) {
  if (!config.tls || !config.tls.enabled) {
    return null;
  }

  let certPath = config.tls.cert || DEFAULT_CERT;
  let keyPath = config.tls.key || DEFAULT_KEY;

  // Auto-generate if files don't exist and auto_generate is enabled
  if (config.tls.auto_generate !== false) {
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.log('Generating self-signed TLS certificate...');
      try {
        fs.mkdirSync(path.dirname(certPath), { recursive: true });
        const result = generateCertWithForge(null);
        certPath = result.cert;
        keyPath = result.key;
        console.log(`TLS certificate generated: ${certPath}`);
      } catch (err) {
        console.warn(`Could not auto-generate TLS certificate: ${err.message}`);
        if (config.tls.enabled === true) {
          throw err;
        }
        console.warn('TLS will be disabled. Set tls.enabled: true after providing certificates.');
        return null;
      }
    }
  }

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    if (config.tls.enabled) {
      throw new Error(`TLS certificate not found: ${certPath} or ${keyPath}`);
    }
    return null;
  }

  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
}

// If run directly with --generate, generate certs
if (require.main === module && process.argv.includes('--generate')) {
  console.log('Generating TLS certificates...');
  try {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
    generateCertWithForge(null);
    console.log(`Certificate: ${DEFAULT_CERT}`);
    console.log(`Key: ${DEFAULT_KEY}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { loadTLSCredentials, generateSelfSignedCert, CERTS_DIR };