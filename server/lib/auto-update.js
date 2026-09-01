// =============================================================================
// Auto Updater - Client auto-update mechanism
// Phase 3: Client Auto Update
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

class AutoUpdater {
  constructor(config, logger) {
    this.log = logger;
    this.enabled = config.update?.enabled || false;
    this.updateUrl = config.update?.url || '';
    this.updateDir = config.update?.dir || path.join(process.cwd(), 'updates');
    this.currentVersion = config.version || '3.0.0';
    this.checkInterval = (config.update?.check_interval || 3600000); // 1 hour default
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
        this.log.error({ error: err.message }, 'Failed to initialize auto updater');
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
      const client = url.protocol === 'https:' ? https : http;
      
      const data = await new Promise((resolve, reject) => {
        const req = client.get(url.href, {
          headers: {
            'User-Agent': `Node-Proxy/${this.currentVersion}`,
            'X-Node-Proxy-Version': this.currentVersion,
          },
          timeout: 10000,
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
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
      this.log.debug({ error: err.message }, 'Update check failed (server may be unavailable)');
    } finally {
      this._checking = false;
    }
  }

  /**
   * Download update package
   */
  async _downloadUpdate(data) {
    if (this._downloading) return;
    this._downloading = true;

    try {
      const url = new URL(data.download_url);
      const client = url.protocol === 'https:' ? https : http;
      const filename = `node-proxy-${data.version}.zip`;
      const filepath = path.join(this.updateDir, filename);

      this.log.info({ url: data.download_url, file: filename }, 'Downloading update');

      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filepath);
        const req = client.get(url.href, { timeout: 300000 }, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        });
        req.on('error', (err) => { fs.unlink(filepath, () => {}); reject(err); });
        req.on('timeout', () => { req.destroy(); fs.unlink(filepath, () => {}); reject(new Error('Download timeout')); });
      });

      // Verify checksum if provided
      if (data.sha256) {
        const hash = await this._hashFile(filepath);
        if (hash !== data.sha256.toLowerCase()) {
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
      this.log.error({ error: err.message }, 'Failed to download update');
    } finally {
      this._downloading = false;
    }
  }

  /**
   * Apply the downloaded update
   */
  async _applyUpdate(data) {
    if (!this._downloadedPath) return;

    try {
      const { execSync } = require('child_process');
      const extractDir = path.join(this.updateDir, `node-proxy-${this._downloadVersion}`);

      // Extract
      if (this._downloadedPath.endsWith('.zip')) {
        // Use PowerShell for extraction on Windows
        execSync(`powershell -Command "Expand-Archive -Path '${this._downloadedPath}' -DestinationPath '${extractDir}' -Force"`, {
          timeout: 60000,
          stdio: 'pipe',
        });
      } else {
        // tar.gz
        execSync(`tar -xzf "${this._downloadedPath}" -C "${extractDir}"`, {
          timeout: 60000,
          stdio: 'pipe',
        });
      }

      this.log.info({ dir: extractDir }, 'Update extracted');

      // Run post-update script if provided
      if (data.post_update_script) {
        this.log.info('Running post-update script');
        execSync(data.post_update_script, {
          cwd: extractDir,
          timeout: 60000,
          stdio: 'pipe',
        });
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
      this.log.error({ error: err.message }, 'Failed to apply update');
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
  setUpdateUrl(url) {
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

  _hashFile(filepath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filepath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  _compareVersions(a, b) {
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