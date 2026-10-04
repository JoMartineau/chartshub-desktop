export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (message, context) => console.info(`[Companion] ${message}`, context ?? ''),
  warn: (message, context) => console.warn(`[Companion] ${message}`, context ?? ''),
  error: (message, context) => console.error(`[Companion] ${message}`, context ?? ''),
};

/** A broken diagnostic sink must not break service or subscriber isolation. */
export function log(logger: Logger, level: keyof Logger, message: string, context?: Record<string, unknown>): void {
  try {
    logger[level](message, context);
  } catch {
    console.error('[Companion] Logger failed while reporting:', message);
  }
}

export function logServiceError(logger: Logger, service: string): void {
  // Raw adapter errors can contain credentials or local paths. Keep diagnostics scoped.
  log(logger, 'error', 'Service error', { service });
}
