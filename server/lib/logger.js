// =============================================================================
// Logger - Structured logging with pino
// =============================================================================
'use strict';

const pino = require('pino');
const path = require('path');
const fs = require('fs');

let loggerInstance = null;

function createLogger(opts = {}) {
  if (loggerInstance) return loggerInstance;

  const level = opts.level || 'info';
  const logDir = opts.logDir || path.join(__dirname, '..', 'logs');
  const logFile = opts.logFile || path.join(logDir, 'server.log');
  const maxSize = opts.maxSize || 10 * 1024 * 1024; // 10MB
  const maxFiles = opts.maxFiles || 5;
  const pretty = opts.pretty || false;

  // Ensure log directory exists
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (_) {}

  // File transport with rotation
  const fileTransport = pino.transport({
    target: 'pino/file',
    options: {
      destination: logFile,
      mkdir: true,
    },
  });

  // For rotation, use a simple approach: write to file, external tool handles rotation
  // Or we can use pino-roll, but keeping it simple for now

  const targets = [fileTransport];

  if (pretty) {
    // Pretty print for development
    const prettyTransport = pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    });
    targets.push(prettyTransport);
  }

  loggerInstance = pino(
    {
      level,
      name: 'node-proxy',
      redact: {
        paths: ['req.headers.authorization', 'req.headers["proxy-authorization"]', 'body'],
        censor: '[REDACTED]',
      },
    },
    pino.multistream(targets, { levels: pino.levels })
  );

  // Add file rotation helper
  loggerInstance.rotate = () => {
    // Simple rotation: rename current log and start fresh
    try {
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        if (stats.size > maxSize) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const rotated = `${logFile}.${timestamp}`;
          fs.renameSync(logFile, rotated);

          // Keep only maxFiles recent rotated files
          const dir = path.dirname(logFile);
          const base = path.basename(logFile);
          const files = fs.readdirSync(dir)
            .filter(f => f.startsWith(base + '.'))
            .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);

          for (let i = maxFiles; i < files.length; i++) {
            try { fs.unlinkSync(path.join(dir, files[i].name)); } catch (_) {}
          }
        }
      }
    } catch (_) {}
  };

  // Check rotation periodically
  setInterval(() => {
    try { loggerInstance.rotate(); } catch (_) {}
  }, 60000);

  return loggerInstance;
}

function getLogger() {
  if (!loggerInstance) {
    return createLogger({ level: 'info' });
  }
  return loggerInstance;
}

module.exports = { createLogger, getLogger };