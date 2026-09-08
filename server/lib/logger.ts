// =============================================================================
// Logger - Structured logging with pino
// Migrated to TypeScript (issue #42, Phase 2). ESM module; loaded by callers
// via `require('./lib/logger.ts')` under Node >= 24 type stripping.
// =============================================================================

import fs from 'fs';
import path from 'path';
import pino from 'pino';

export interface LoggerOptions {
  level?: string;
  logDir?: string;
  logFile?: string;
  maxSize?: number;
  maxFiles?: number;
  pretty?: boolean;
}

// pino.Logger plus our file-rotation helper.
export type AppLogger = pino.Logger & { rotate: () => void };

let loggerInstance: AppLogger | null = null;

export function createLogger(opts: LoggerOptions = {}): AppLogger {
  if (loggerInstance) return loggerInstance;

  const level = opts.level || 'info';
  const logDir = opts.logDir || path.join(process.cwd(), 'logs');
  const logFile = opts.logFile || path.join(logDir, 'server.log');
  const maxSize = opts.maxSize || 10 * 1024 * 1024; // 10MB
  const maxFiles = opts.maxFiles || 5;
  const pretty = opts.pretty || false;

  // Ensure log directory exists
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (_) {
    // ignore - pino will surface real permission errors later
  }

  // File transport with rotation
  const fileTransport = pino.transport({
    target: 'pino/file',
    options: {
      destination: logFile,
      mkdir: true,
    },
  });

  const targets: pino.DestinationStream[] = [fileTransport];

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

  const rotate = (): void => {
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
          const files = fs
            .readdirSync(dir)
            .filter((f) => f.startsWith(base + '.'))
            .map((f) => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);

          for (let i = maxFiles; i < files.length; i++) {
            try {
              fs.unlinkSync(path.join(dir, files[i].name));
            } catch (_) {
              // race with external logrotate is fine
            }
          }
        }
      }
    } catch (_) {
      // never let rotation kill the process
    }
  };

  const inst = Object.assign(
    pino(
      {
        level,
        name: 'node-proxy',
        redact: {
          paths: ['req.headers.authorization', 'req.headers["proxy-authorization"]', 'body'],
          censor: '[REDACTED]',
        },
      },
      pino.multistream(targets)
    ),
    { rotate }
  ) as AppLogger;

  loggerInstance = inst;

  // Check rotation periodically
  setInterval(() => {
    try {
      if (loggerInstance) loggerInstance.rotate();
    } catch (_) {
      // ignore
    }
  }, 60000);

  return inst;
}

export function getLogger(): AppLogger {
  if (!loggerInstance) {
    return createLogger({ level: 'info' });
  }
  return loggerInstance;
}
