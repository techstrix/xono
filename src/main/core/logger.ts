import log from 'electron-log'

let debugEnabled = false

export function initLogger(debug: boolean): void {
  debugEnabled = debug
  log.transports.file.level = debug ? 'debug' : 'info'
  log.transports.console.level = debug ? 'debug' : 'warn'
  if (process.env.NODE_ENV === 'test') log.transports.file.level = false
}

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled
  log.transports.file.level = enabled ? 'debug' : 'info'
  log.transports.console.level = enabled ? 'debug' : 'warn'
}

export interface ScopedLogger {
  info(...a: unknown[]): void
  warn(...a: unknown[]): void
  error(...a: unknown[]): void
  debug(...a: unknown[]): void
}

function makeScope(scope: string): ScopedLogger {
  return {
    info: (...a) => log.info(`[${scope}]`, ...a),
    warn: (...a) => log.warn(`[${scope}]`, ...a),
    error: (...a) => log.error(`[${scope}]`, ...a),
    debug: (...a) => log.debug(`[${scope}]`, ...a)
  }
}

export const logger: ScopedLogger = makeScope('xono')

export const loggerScope = (scope: string): ScopedLogger => makeScope(scope)