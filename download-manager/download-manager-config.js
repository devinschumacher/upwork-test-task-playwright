/**
 * Download Manager Configuration (Loom)
 */

export const DEFAULT_CONFIG = {
  ui: {
    position: 'right',
    theme: 'dark',
    maxVisibleDownloads: 5,
    autoHideAfterComplete: 0,
    enableAnimations: true,
    compactMode: false,
  },
  behavior: {
    autoShowOnDownload: true,
    autoHideWhenEmpty: true,
    // Remove entries as soon as they complete
    autoRemoveOnComplete: true,
    // Linger time before auto-removing a completed item (ms)
    completeRemovalDelayMs: 2500,
    maxCompletedToKeep: 3,
    enableCrossTabSync: true,
    // Background is the single writer to chrome.storage for downloads
    storageLeader: false,
  },
  integration: {
    parentSelector: 'body',
    messageNamespace: 'loom',
    globalFunctionPrefix: '',
    cssPrefix: 'loom',
    zIndexBase: 2147483647,
  },
  labels: {
    title: '📥 Downloads',
    noActiveDownloads: '(none)',
    activeDownloads: '({count} active)',
    cancelAll: 'Cancel All',
    clearCompleted: 'Clear',
    collapse: 'Collapse',
    downloading: 'Downloading...',
    completed: 'Completed',
    cancelled: 'Cancelled',
    failed: 'Failed',
  },
  styles: {
    primaryColor: '#625df5',
    backgroundColor: '#1b1b1b',
    textColor: '#ffffff',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
    fontSize: '13px',
    border: '2px solid #625df5',
    headerBackground: 'linear-gradient(135deg, #333, #222)',
    headerBorder: '1px solid #444',
  },
  callbacks: {
    onDownloadStart: null,
    onDownloadProgress: null,
    onDownloadComplete: null,
    onDownloadCancelled: null,
    onDownloadFailed: null,
    onPanelShow: null,
    onPanelHide: null,
  }
};

export const PRESETS = {
  minimal: {
    ui: { position: 'bottom', theme: 'light', compactMode: true, enableAnimations: false },
    behavior: { autoShowOnDownload: false, enableCancelAll: false, enableClearCompleted: false }
  },
  mobile: {
    ui: { position: 'bottom', compactMode: true, maxVisibleDownloads: 3 },
    behavior: { autoHideAfterComplete: 5000 }
  },
  enterprise: {
    ui: { maxVisibleDownloads: 10, autoHideAfterComplete: 0 },
    behavior: { maxCompletedToKeep: 10, enableCrossTabSync: true }
  }
};

export function createConfig(customConfig = {}, preset = null) {
  let baseConfig = { ...DEFAULT_CONFIG };
  if (preset && PRESETS[preset]) {
    baseConfig = deepMerge(baseConfig, PRESETS[preset]);
  }
  return deepMerge(baseConfig, customConfig);
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
