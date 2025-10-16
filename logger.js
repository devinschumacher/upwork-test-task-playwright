(function initLoomLogger(){
  let existing = null;
  try {
    if (typeof globalThis !== 'undefined') {
      existing = globalThis.__LOOM_LOGGER_SINGLETON__ || globalThis.LoomLogger || null;
    }
  } catch (_) {}

  if (existing && typeof existing === 'object') {
    try { if (typeof globalThis !== 'undefined') globalThis.LoomLogger = existing; } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined' && !globalThis.__LOOM_LOGGER_PATCHED__ && typeof existing.patchConsole === 'function') {
        existing.patchConsole();
        globalThis.__LOOM_LOGGER_PATCHED__ = true;
      }
    } catch (_) {}
    try { if (typeof module !== 'undefined' && module.exports) module.exports = existing; } catch (_) {}
    return;
  }

  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 90 };
  const SITE_CONFIG_MAP = { none: 'silent', error: 'error', warn: 'warn', log: 'info', info: 'info', debug: 'debug' };

  function detectLevel() {
    try {
      if (typeof globalThis !== 'undefined' && globalThis.LOOM_LOG_LEVEL) {
        const lvl = String(globalThis.LOOM_LOG_LEVEL).toLowerCase();
        if (lvl in LEVELS) return lvl;
      }
    } catch (_) {}
    try {
      if (typeof process !== 'undefined' && process.env && process.env.LOOM_LOG_LEVEL) {
        const lvl = String(process.env.LOOM_LOG_LEVEL).toLowerCase();
        if (lvl in LEVELS) return lvl;
      }
    } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined' && globalThis.SiteConfig && globalThis.SiteConfig.LOG_LEVEL) {
        const lvl = SITE_CONFIG_MAP[String(globalThis.SiteConfig.LOG_LEVEL).toLowerCase()];
        if (lvl && lvl in LEVELS) return lvl;
      }
    } catch (_) {}
    return 'info';
  }

  const state = { level: detectLevel(), prefix: 'LOOM' };

  function resolveDynamicLevel() {
    try {
      if (typeof globalThis !== 'undefined' && globalThis.LOOM_LOG_LEVEL) {
        const v = String(globalThis.LOOM_LOG_LEVEL).toLowerCase();
        if (v in LEVELS) return v;
      }
    } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined' && globalThis.SiteConfig && globalThis.SiteConfig.LOG_LEVEL) {
        const v = SITE_CONFIG_MAP[String(globalThis.SiteConfig.LOG_LEVEL).toLowerCase()];
        if (v && v in LEVELS) return v;
      }
    } catch (_) {}
    return state.level;
  }

  function shouldLog(method) {
    const threshold = LEVELS[resolveDynamicLevel()] || LEVELS.info;
    const lvl = LEVELS[method] ?? LEVELS.info;
    return lvl >= threshold;
  }

  function formatArgs(args) {
    const time = new Date().toISOString();
    const tag = `[${state.prefix}]`;
    return [`${time} ${tag}:`, ...args];
  }

  const __orig = (() => {
    try {
      const c = console || {};
      const fallback = function () {};
      return {
        log:   (c.log   || fallback).bind(console),
        info:  (c.info  || c.log || fallback).bind(console),
        warn:  (c.warn  || c.log || fallback).bind(console),
        error: (c.error || c.log || fallback).bind(console),
        debug: (c.debug || c.log || fallback).bind(console),
        trace: (c.trace || c.log || fallback).bind(console),
      };
    } catch (_) {
      const noop = function () {};
      return { log: noop, info: noop, warn: noop, error: noop, debug: noop, trace: noop };
    }
  })();

  const logger = {
    setLevel(lvl) {
      const v = String(lvl || '').toLowerCase();
      if (v in LEVELS) state.level = v;
      return state.level;
    },
    getLevel() { return state.level; },
    setPrefix(p) { state.prefix = String(p || 'LOOM'); return state.prefix; },
    getPrefix() { return state.prefix; },

    debug: (...args) => { if (shouldLog('debug')) __orig.debug(...formatArgs(args)); },
    info:  (...args) => { if (shouldLog('info'))  __orig.info (...formatArgs(args)); },
    warn:  (...args) => { if (shouldLog('warn'))  __orig.warn (...formatArgs(args)); },
    error: (...args) => { if (shouldLog('error')) __orig.error(...formatArgs(args)); },
    trace: (...args) => { if (shouldLog('debug')) __orig.trace(...formatArgs(args)); },

    patchConsole() {
      try {
        const map = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug', trace: 'trace' };
        Object.entries(map).forEach(([from, to]) => {
          const fn = (...args) => logger[to](...args);
          try { Object.defineProperty(fn, 'name', { value: `loomLogger_${to}` }); } catch (_) {}
          try { console[from] = fn; } catch (_) {}
        });
      } catch (_) {}
    },
  };

  try { if (typeof globalThis !== 'undefined') globalThis.LoomLogger = logger; } catch (_) {}
  try { if (typeof globalThis !== 'undefined') globalThis.__LOOM_LOGGER_SINGLETON__ = logger; } catch (_) {}

  try {
    if (typeof globalThis !== 'undefined' && !globalThis.__LOOM_LOGGER_PATCHED__) {
      logger.patchConsole();
      globalThis.__LOOM_LOGGER_PATCHED__ = true;
    }
  } catch (_) {}

  try { if (typeof module !== 'undefined' && module.exports) module.exports = logger; } catch (_) {}
})();
