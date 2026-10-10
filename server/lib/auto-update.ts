// =============================================================================
// Auto Updater - Client auto-update mechanism
// Phase 3: Client Auto Update
// Migrated to TypeScript (issue #42, Phase 2). CJS-style TS on purpose: the
// module exports its class via module.exports (plus type-only imports, which
// are stripped and never trigger ESM), so Node type stripping loads this file
// as CommonJS; callers use require('./lib/auto-update.ts'). Precedent: acme.ts.
// =============================================================================

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('fs');
const path = require('path');
const https = require('https');
// Plain http is deliberately not imported any more: update metadata and the
// archive itself must come over https (see checkForUpdate / _downloadUpdate).
const crypto = require('crypto');
// NOTE: original JS also destructured an unused `spawn` from 'child_process';
// that binding was dead code and is omitted (execSync is still required lazily
// inside _applyUpdate, exactly as in the original).
import type { ClientRequest, IncomingMessage, RequestOptions } from 'http';
import type { AppLogger } from './logger.ts';
import type { ServerConfig } from './config.ts';

// --- Structural contracts (type-only; mirror what the JS read at runtime) ----
// Update metadata payload returned by the update endpoint.
interface UpdateInfo {
  version?: string;
  download_url?: string;
  sha256?: string;
  apply_immediately?: boolean;
  post_update_script?: string;
}

// config.update section: ServerConfig types it as `unknown`, so narrow it to
// the fields this module reads (structural-narrowing precedent: acme.ts).
interface UpdateSection {
  enabled?: boolean;
  url?: string;
  dir?: string;
  check_interval?: number;
}

// Minimal client surface over the Node http/https modules: both expose the
// same get() shape used below while their full module namespaces differ
// structurally, which prevents calling the union under strict typing.
interface UpdateFetchClient {
  get(
    url: string,
    options: RequestOptions,
    callback: (res: IncomingMessage) => void
  ): ClientRequest;
}

// Catch variables are `unknown` (useUnknownInCatchVariables); keep the
// original `err.message` logging behavior for real Error instances.
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class AutoUpdater {
  log: AppLogger;
  enabled: boolean;
  updateUrl: string;
  updateDir: string;
  currentVersion: string;
  checkInterval: number;
  _timer: ReturnType<typeof setInterval> | null;
  _latestVersion: string | null;
  _updateAvailable: boolean;
  _downloading: boolean;
  _checking: boolean;
  _updateInfo?: UpdateInfo;
  _downloadedPath?: string;
  _downloadVersion?: string;

  constructor(config: ServerConfig, logger: AppLogger) {
    this.log = logger;
    // config.ts declares no `version` field and types the optional `update`
    // section as `unknown`, yet the runtime config object carries both - read
    // them the same way the original JS did (values may legitimately be absent).
    const updateSection = config.update as UpdateSection | undefined;
    this.enabled = updateSection?.enabled || false;
    this.updateUrl = updateSection?.url || '';
    this.updateDir = updateSection?.dir || path.join(process.cwd(), 'updates');
    this.currentVersion = (config as { version?: string }).version || '3.0.0';
    this.checkInterval = (updateSection?.check_interval || 3600000); // 1 hour default
    this._timer = null;
    this._latestVersion = null;
    this._updateAvailable = false;
    this._downloading = false;
    this._checking = false;

    if (this.enabled) {
      try {
        fs.mkdirSync(this.updateDir, { recursive: true });
        this.log.info({
          url: this.updateUrl,
          interval: this.checkInterval,
          currentVersion: this.currentVersion
        }, 'Auto updater enabled');
        // Schedule periodic checks
        this._timer = setInterval(() => this.checkForUpdate(), this.checkInterval);
        this._timer.unref();
        // Check on startup
        setTimeout(() => this.checkForUpdate(), 10000);
      } catch (err) {
        this.log.error({ error: errorMessage(err) }, 'Failed to initialize auto updater');
        this.enabled = false;
      }
    }
  }

  /**
   * Check for updates from the update server
   */
  async checkForUpdate() {
    if (this._checking || !this.updateUrl) return;
    this._checking = true;

    try {
      const url = new URL(this.updateUrl);
      // Update metadata is executable policy (it can name a post-update script and
      // the archive to install), so it must not travel in the clear: over plain
      // http anyone on the path could swap the version, download URL and checksum.
      if (url.protocol !== 'https:') {
        throw new Error(`Refusing update check: ${url.protocol} is not allowed, use https:`);
      }
      const client: UpdateFetchClient = https as UpdateFetchClient;

      const data = await new Promise<UpdateInfo>((resolve, reject) => {
        const req = client.get(url.href, {
          headers: {
            'User-Agent': `Node-Proxy/${this.currentVersion}`,
            'X-Node-Proxy-Version': this.currentVersion,
          },
          timeout: 10000,
        }, (res) => {
          let body = '';
          // Cap it: an endless (or hostile) response used to grow this string until
          // the process ran out of memory. 1 MiB is far more than metadata needs.
          res.on('data', chunk => {
            body += chunk;
            if (body.length > 1024 * 1024) {
              req.destroy();
              reject(new Error('Update metadata too large'));
            }
          });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('Invalid JSON')); }
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      });

      if (data && data.version) {
        this._latestVersion = data.version;
        this._updateAvailable = this._compareVersions(data.version, this.currentVersion) > 0;
        this._updateInfo = data;

        this.log.info({
          currentVersion: this.currentVersion,
          latestVersion: this._latestVersion,
          updateAvailable: this._updateAvailable,
        }, 'Update check completed');

        // Auto-download if update available
        if (this._updateAvailable && data.download_url) {
          this._downloadUpdate(data);
        }
      }
    } catch (err) {
      this.log.debug({ error: errorMessage(err) }, 'Update check failed (server may be unavailable)');
    } finally {
      this._checking = false;
    }
  }

  /**
   * Download update package
   */
  async _downloadUpdate(data: UpdateInfo) {
    if (this._downloading) return;
    this._downloading = true;

    try {
      // Only ever invoked with data.download_url set (see checkForUpdate);
      // the assertion is type-only and matches the original JS exactly.
      const downloadUrl = data.download_url as string;
      const url = new URL(downloadUrl);
      // Same rule as the metadata: a plain-http archive URL let anyone on the path
      // swap the bytes (the checksum comes from the same tamperable metadata).
      if (url.protocol !== 'https:') {
        throw new Error(`Refusing download: ${url.protocol} is not allowed, use https:`);
      }
      const client: UpdateFetchClient = https as UpdateFetchClient;
      const filename = `node-proxy-${this._safeVersion(data.version)}.zip`;
      const filepath = this._insideDir(this.updateDir, filename);

      this.log.info({ url: downloadUrl, file: filename }, 'Downloading update');

      await new Promise<void>((resolve, reject) => {
        const file = fs.createWriteStream(filepath);
        const limit = 512 * 1024 * 1024; // 512 MiB: an update archive is never bigger
        let received = 0;
        let settled = false;
        const fail = (err: Error, req: { destroy(): void }) => {
          if (settled) return;
          settled = true;
          // Destroy both handles BEFORE unlinking: with the stream still open the
          // unlink failed (routinely on Windows) and left a partial file behind.
          req.destroy();
          file.destroy();
          fs.unlink(filepath, () => {});
          reject(err);
        };
        const req = client.get(url.href, { timeout: 300000 }, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            fail(new Error(`Download failed: HTTP ${res.statusCode}`), req);
            return;
          }
          const declared = Number(res.headers['content-length'] || 0);
          if (declared > limit) {
            res.resume();
            fail(new Error(`Download too large: ${declared} bytes`), req);
            return;
          }
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > limit) fail(new Error('Download exceeded the size limit'), req);
          });
          res.pipe(file);
          file.on('finish', () => {
            if (settled) return;
            settled = true;
            file.close();
            resolve();
          });
        });
        req.on('error', (err) => fail(err, req));
        req.on('timeout', () => fail(new Error('Download timeout'), req));
      });

      // The archive must be pinned: without a checksum these bytes are simply
      // whatever the download URL returned.
      const expectedSha256 = data.sha256;
      if (!expectedSha256 || typeof expectedSha256 !== 'string') {
        fs.unlink(filepath, () => {});
        throw new Error('Refusing update: metadata carries no sha256');
      }
      {
        const hash = await this._hashFile(filepath);
        if (hash !== expectedSha256.toLowerCase()) {
          fs.unlink(filepath, () => {});
          throw new Error('Checksum mismatch');
        }
        this.log.info('Update checksum verified');
      }

      this.log.info({ file: filename, version: data.version }, 'Update downloaded successfully');
      this._downloadedPath = filepath;
      this._downloadVersion = data.version;

      // Apply update
      if (data.apply_immediately !== false) {
        await this._applyUpdate(data);
      }
    } catch (err) {
      this.log.error({ error: errorMessage(err) }, 'Failed to download update');
    } finally {
      this._downloading = false;
    }
  }

  // A version string ends up in a file name, a directory name and (indirectly)
  // in shell commands, so validate it before use: anything but a plain dotted
  // version allows path traversal or shell injection (issue #120).
  private _safeVersion(version: unknown): string {
    const v = typeof version === 'string' ? version.trim() : '';
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(v) || v.includes('..')) {
      throw new Error(`Refusing update: unsafe version ${JSON.stringify(String(version)).slice(0, 60)}`);
    }
    return v;
  }

  // Resolve a path inside a directory, refusing anything that escapes it.
  private _insideDir(dir: string, candidate: string): string {
    const base = path.resolve(dir);
    const resolved = path.resolve(base, candidate);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`Refusing update: path escapes ${base}`);
    }
    return resolved;
  }
  /**
   * Apply the downloaded update
   */
  async _applyUpdate(data: UpdateInfo) {
    // Read into a local so TS keeps it narrowed as string across the calls
    // below (the original JS read this._downloadedPath directly).
    const downloadedPath = this._downloadedPath;
    if (!downloadedPath) return;

    try {
      const { execSync } = require('child_process');
      const extractDir = this._insideDir(this.updateDir, `node-proxy-${this._safeVersion(this._downloadVersion)}`);

      // Extract
      if (downloadedPath.endsWith('.zip')) {
        // Use PowerShell for extraction on Windows
        execSync(`powershell -Command "Expand-Archive -Path '${downloadedPath}' -DestinationPath '${extractDir}' -Force"`, {
          timeout: 60000,
          stdio: 'pipe',
        });
      } else {
        // tar.gz
        execSync(`tar -xzf "${downloadedPath}" -C "${extractDir}"`, {
          timeout: 60000,
          stdio: 'pipe',
        });
      }

      this.log.info({ dir: extractDir }, 'Update extracted');

      // Run post-update script if provided
      // Only a script that ships INSIDE the archive may run. The metadata value
      // used to be executed verbatim (execSync(postUpdateScript)), so anyone able
      // to tamper with the update source - or the metadata channel - got arbitrary
      // command execution as the service account (issue #120).
      const postUpdateScript = data.post_update_script;
      if (postUpdateScript) {
        if (typeof postUpdateScript !== 'string' || path.isAbsolute(postUpdateScript)) {
          throw new Error('Refusing update: post_update_script must be a relative path inside the archive');
        }
        const scriptPath = this._insideDir(extractDir, postUpdateScript);
        if (!fs.existsSync(scriptPath)) {
          throw new Error(`Refusing update: post_update_script not found in the archive: ${postUpdateScript}`);
        }
        this.log.info({ script: postUpdateScript }, 'Running post-update script from the archive');
        // execFileSync, not execSync: no shell, so the validated path is an
        // argument rather than a string to be re-parsed.
        const { execFileSync } = require('child_process');
        if (process.platform === 'win32') {
          execFileSync('powershell', ['-NoProfile', '-File', scriptPath], { cwd: extractDir, timeout: 60000, stdio: 'pipe' });
        } else {
          execFileSync('sh', [scriptPath], { cwd: extractDir, timeout: 60000, stdio: 'pipe' });
        }
      }

      // Create update marker for restart
      const markerFile = path.join(this.updateDir, '.update-ready');
      fs.writeFileSync(markerFile, JSON.stringify({
        version: this._downloadVersion,
        extractDir,
        timestamp: Date.now(),
        pid: process.pid,
      }));

      this.log.info({ version: this._downloadVersion }, 'Update ready. Restart to apply.');
    } catch (err) {
      this.log.error({ error: errorMessage(err) }, 'Failed to apply update');
    }
  }

  /**
   * Get update status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      currentVersion: this.currentVersion,
      latestVersion: this._latestVersion,
      updateAvailable: this._updateAvailable,
      updateInfo: this._updateInfo || null,
      downloading: this._downloading,
      checking: this._checking,
    };
  }

  /**
   * Set update URL
   */
  setUpdateUrl(url: string) {
    this.updateUrl = url;
    this.log.info({ url }, 'Update URL changed');
  }

  /**
   * Trigger immediate update check
   */
  triggerCheck() {
    return this.checkForUpdate();
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  _hashFile(filepath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filepath);
      stream.on('data', (chunk: Buffer) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  _compareVersions(a: string, b: string) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  /**
   * Cleanup
   */
  shutdown() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

module.exports = { AutoUpdater };
