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

  // Main-thread destination (SonicBoom) rather than pino.transport(): a transport
  // runs in a worker thread holding its own file descriptor, so rotating by rename
  // left this process writing into the RENAMED file - the size limit never took
  // effect, disk usage kept growing and fresh lines landed in the rotated file
  // (verified: after rename the .ROTATED file grew while server.log stayed gone).
  // pino.destination() exposes reopen(), which is what rotation actually needs.
  const fileStream: pino.DestinationStream & { reopen?: () => void } = pino.destination({
    dest: logFile,
    mkdir: true,
    sync: false,
  });

  const targets: pino.DestinationStream[] = [fileStream];

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
          // Flush, rename, then REOPEN the original path: the next write goes to a
          // fresh server.log while the rotated file keeps what was already written.
          try {
            (fileStream as { flushSync?: () => void }).flushSync?.();
          } catch (_) {
            // nothing buffered
          }
          fs.renameSync(logFile, rotated);
          try {
            fileStream.reopen?.();
          } catch (_) {
            // the next write recreates the file anyway
          }

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

  // Close the file destination (and flush it) - used by shutdown and by tests,
  // so an idle logger cannot keep the event loop alive.
  const close = (): void => {
    try {
      (fileStream as { flushSync?: () => void }).flushSync?.();
      (fileStream as { end?: () => void }).end?.();
    } catch (_) {
      // already closed
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
    { rotate, close }
  ) as AppLogger;

  loggerInstance = inst;

  // Check rotation periodically
  // unref: housekeeping must not be a reason for the process to stay alive.
  const rotateTimer = setInterval(() => {
    try {
      if (loggerInstance) loggerInstance.rotate();
    } catch (_) {
      // ignore
    }
  }, 60000);
  rotateTimer.unref?.();

  return inst;
}

export function getLogger(): AppLogger {
  if (!loggerInstance) {
    return createLogger({ level: 'info' });
  }
  return loggerInstance;
}
