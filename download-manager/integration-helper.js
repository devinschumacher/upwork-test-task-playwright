/**
 * Download Manager Integration Helper (Loom)
 */

import { DownloadManager } from './download-manager.js';

const INTEGRATION_CONFIG = {
  ui: { position: 'right', theme: 'dark', maxVisibleDownloads: 10, autoHideAfterComplete: 8000 },
  behavior: { autoShowOnDownload: true, autoHideWhenEmpty: true, autoRemoveOnComplete: true, maxCompletedToKeep: 3, enableCrossTabSync: true, storageLeader: false },
  integration: { cssPrefix: 'loom', zIndexBase: 2147483647, parentSelector: 'body' },
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
  labels: { title: '📥 Downloads', noActiveDownloads: '(none)', activeDownloads: '({count} active)', completedDownloads: '({count} completed)', cancelAll: 'Cancel All', clearCompleted: 'Clear', collapse: 'Collapse' },
};

let globalDownloadManagerInstance = null;

export function createModularDownloadManager() {
  if (globalDownloadManagerInstance) return globalDownloadManagerInstance;
  if (typeof window !== 'undefined' && window.globalDownloadManager) {
    globalDownloadManagerInstance = window.globalDownloadManager;
    return globalDownloadManagerInstance;
  }
  const manager = new DownloadManager(INTEGRATION_CONFIG);
  manager.initialize();
  globalDownloadManagerInstance = manager;
  if (typeof window !== 'undefined') window.globalDownloadManager = manager;
  return manager;
}

export function createCompatibilityLayer(manager) {
  const activeDownloads = new Map();
  manager.state.on('downloadAdded', (id, info) => { activeDownloads.set(id, { filename: info.filename, progress: info.progress, status: info.status, downloaded: info.downloaded||0, total: info.total||0, lastUpdate: Date.now(), isCompleted: info.isCompleted }); });
  manager.state.on('downloadUpdated', (id, info) => { const existing = activeDownloads.get(id)||{}; activeDownloads.set(id, { ...existing, progress: info.progress, status: info.status, downloaded: info.downloaded||existing.downloaded||0, total: info.total||existing.total||0, lastUpdate: Date.now(), isCompleted: info.isCompleted }); });
  manager.state.on('downloadRemoved', (id) => { activeDownloads.delete(id); });
  return {
    activeDownloads,
    downloadManagerPanel: manager.ui.panel,
    isDownloadManagerCollapsed: manager.state.isCollapsed,
    showDownloadManager: () => manager.show(),
    hideDownloadManager: () => manager.hide(),
    toggleDownloadManager: () => manager.toggle(),
    showDownloadProgress: async (...args) => await manager.showDownloadProgress(...args),
    hideDownloadProgress: async (id) => await manager.hideDownloadProgress(id),
    removeDownloadItem: async (id) => await manager.removeDownloadItem(id),
    cancelActiveDownload: async (id) => await manager.cancelDownload(id),
    clearCompletedDownloads: async () => await manager.clearCompletedDownloads(),
    cancelAllActiveDownloads: async () => await manager.cancelAllDownloads(),
    updateDownloadManagerHeader: () => manager.updateUI(),
    manager,
  };
}
