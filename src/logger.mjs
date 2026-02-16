const LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 }

const noopLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {}
}

const consoleLogger = (level = LEVELS.INFO) => ({
  error: (...args) => LEVELS.ERROR <= level && console.error('[matrix-client]', ...args),
  warn:  (...args) => LEVELS.WARN  <= level && console.warn('[matrix-client]', ...args),
  info:  (...args) => LEVELS.INFO  <= level && console.log('[matrix-client]', ...args),
  debug: (...args) => LEVELS.DEBUG <= level && console.log('[matrix-client]', ...args)
})

let currentLogger = consoleLogger()

const setLogger = (logger) => {
  currentLogger = logger || noopLogger
}

const getLogger = () => currentLogger

export { LEVELS, setLogger, getLogger, consoleLogger, noopLogger }
