// src/utils/logger.ts

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'security';

const COLORS = {
  debug: '\x1b[36m',    // Cyan
  info: '\x1b[32m',     // Green
  warn: '\x1b[33m',     // Yellow
  error: '\x1b[31m',    // Red
  security: '\x1b[35m', // Magenta
  reset: '\x1b[0m',
};

function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

function formatLevel(level: LogLevel): string {
  return level.toUpperCase().padEnd(8);
}

export function log(level: LogLevel, message: string, meta?: object): void {
  const timestamp = formatTimestamp();
  const levelStr = formatLevel(level);
  const color = COLORS[level];
  const reset = COLORS.reset;

  let output = `[${timestamp}] ${color}[${levelStr}]${reset} ${message}`;

  if (meta) {
    output += ` ${JSON.stringify(meta)}`;
  }

  if (level === 'error') {
    console.error(output);
  } else {
    console.log(output);
  }
}

// Convenience functions
export const logger = {
  debug: (message: string, meta?: object) => log('debug', message, meta),
  info: (message: string, meta?: object) => log('info', message, meta),
  warn: (message: string, meta?: object) => log('warn', message, meta),
  error: (message: string, meta?: object) => log('error', message, meta),

  // Security audit logging for permission grants
  security: (message: string, meta?: object) => log('security', message, meta),

  // Log permission grant for auditing
  permissionGranted: (agentId: string, action: string, details?: object) => {
    log('security', `Permission granted: agent=${agentId} action=${action}`, details);
  },

  // Log permission denied
  permissionDenied: (agentId: string, action: string, reason?: string) => {
    log('security', `Permission denied: agent=${agentId} action=${action}${reason ? ` reason=${reason}` : ''}`);
  },
};

export default logger;
