/**
 * Download Manager State Management (Loom)
 */

export class DownloadManagerState {
  constructor(config = {}) {
    this.config = config;
    this.activeDownloads = new Map();
    this.autoCollapseTimer = null;
    this.isCollapsed = false;
    this.listeners = new Map();
    // Keep consistent with Vimeo DM to allow a shared hydrator if needed
    this.storageKey = 'downloadManagerGlobalState';
    this.syncInProgress = false;
    this.isStorageLeader = !!(this.config?.behavior?.storageLeader);
    this.initStorageSync();
  }

  async initStorageSync() {
    await this.loadFromStorage();
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes[this.storageKey] && !this.syncInProgress) {
          this.loadFromStorage(true);
        }
      });
    }
  }

  async loadFromStorage(emitEvents = true) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) return;
      const result = await chrome.storage.local.get([this.storageKey]);
      const storedState = result[this.storageKey];
      if (storedState && storedState.downloads) {
        const prevMap = new Map(this.activeDownloads);
        const filteredDownloads = {};
        Object.entries(storedState.downloads).forEach(([id, info]) => {
          const statusStr = (info.status || '').toLowerCase();
          const isCancelled = info.isCancelled || statusStr.includes('cancelled') || statusStr.includes('canceled');
          const isFailed = statusStr.includes('failed') || statusStr.includes('error') || statusStr.includes('interrupted');
          const isCompleted = !!info.isCompleted || (info.progress >= 100);
          if (isCancelled || isFailed || isCompleted) return;
          const prev = prevMap.get(id);
          const isFresher = !prev ||
            (typeof info.lastUpdate === 'number' && typeof prev.lastUpdate === 'number' && info.lastUpdate >= prev.lastUpdate) ||
            ((info.progress || 0) >= (prev.progress || 0));
          if (!prev) {
            this.activeDownloads.set(id, info);
            filteredDownloads[id] = info;
            if (emitEvents) this.emit('downloadAdded', id, info);
          } else if (isFresher) {
            this.activeDownloads.set(id, { ...prev, ...info });
            filteredDownloads[id] = { ...prev, ...info };
            if (emitEvents) this.emit('downloadUpdated', id, this.activeDownloads.get(id), prev);
          } else {
            filteredDownloads[id] = prev;
          }
        });
        const newIds = new Set(Object.keys(filteredDownloads));
        for (const [prevId, prevInfo] of prevMap.entries()) {
          if (!newIds.has(prevId)) {
            this.activeDownloads.delete(prevId);
            if (emitEvents) this.emit('downloadRemoved', prevId, prevInfo);
          }
        }
        this.isCollapsed = storedState.isCollapsed || false;
        if (emitEvents) this.emit('stateChanged');
      }
    } catch (error) {
      console.error('Failed to load state from storage:', error);
    }
  }

  async saveToStorage() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) return;
      if (!this.isStorageLeader) return;
      this.syncInProgress = true;
      const downloadsObj = {};
      this.activeDownloads.forEach((info, id) => { downloadsObj[id] = info; });
      const stateToStore = { downloads: downloadsObj, isCollapsed: this.isCollapsed, lastUpdate: Date.now() };
      await chrome.storage.local.set({ [this.storageKey]: stateToStore });
      setTimeout(() => { this.syncInProgress = false; }, 100);
    } catch (error) {
      console.error('Failed to save state to storage:', error);
      this.syncInProgress = false;
    }
  }

  async persistCollapsedOnly() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) return;
      this.syncInProgress = true;
      const result = await chrome.storage.local.get([this.storageKey]);
      const current = result[this.storageKey] || { downloads: {} };
      await chrome.storage.local.set({ [this.storageKey]: { downloads: current.downloads || {}, isCollapsed: this.isCollapsed, lastUpdate: Date.now() } });
      setTimeout(() => { this.syncInProgress = false; }, 100);
    } catch (e) {
      console.error('Failed to persist collapsed state:', e);
      this.syncInProgress = false;
    }
  }

  async addDownload(downloadId, downloadInfo) {
    const info = {
      id: downloadId,
      filename: downloadInfo.filename || 'Unknown',
      progress: downloadInfo.progress || 0,
      status: downloadInfo.status || 'Downloading...',
      startTime: Date.now(),
      isCompleted: false,
      isCancelled: false,
      downloaded: downloadInfo.downloaded || 0,
      total: downloadInfo.total || 0,
      speed: downloadInfo.speed || '',
      ...downloadInfo
    };
    this.activeDownloads.set(downloadId, info);
    if (this.isStorageLeader) await this.saveToStorage();
    this.emit('downloadAdded', downloadId, info);
    this.emit('stateChanged');
    return info;
  }

  async updateDownload(downloadId, updates) {
    const existing = this.activeDownloads.get(downloadId);
    if (!existing) return null;
    const safeProgress = (typeof updates.progress === 'number') ? Math.max(existing.progress || 0, updates.progress) : existing.progress;
    const updated = { ...existing, ...updates, ...(typeof updates.progress === 'number' ? { progress: safeProgress } : {}), lastUpdate: Date.now() };
    if (updates.progress >= 100 && !existing.isCompleted) {
      updated.isCompleted = true;
      updated.completedTime = Date.now();
      updated.status = this.config.labels?.completed || 'Completed';
      this.emit('downloadCompleted', downloadId, updated);
    }
    if (updates.isCancelled && !existing.isCancelled) {
      updated.isCancelled = true;
      updated.status = this.config.labels?.cancelled || 'Cancelled';
      this.emit('downloadCancelled', downloadId, updated);
    }
    this.activeDownloads.set(downloadId, updated);
    if (this.isStorageLeader) await this.saveToStorage();
    this.emit('downloadUpdated', downloadId, updated, existing);
    this.emit('stateChanged');
    return updated;
  }

  async removeDownload(downloadId) {
    const downloadInfo = this.activeDownloads.get(downloadId);
    if (!downloadInfo) return false;
    this.activeDownloads.delete(downloadId);
    if (this.isStorageLeader) await this.saveToStorage();
    this.emit('downloadRemoved', downloadId, downloadInfo);
    this.emit('stateChanged');
    return true;
  }

  getDownload(downloadId) { return this.activeDownloads.get(downloadId) || null; }
  getAllDownloads() { return new Map(this.activeDownloads); }
  getDownloadsByFilter(filter) {
    const filterFn = typeof filter === 'string' ? ([, info]) => info.status === filter : filter;
    return Array.from(this.activeDownloads.entries()).filter(filterFn);
  }
  getActiveDownloads() {
    return this.getDownloadsByFilter(([, info]) => {
      const s = (info.status || '').toLowerCase();
      const isFailed = s.includes('failed') || s.includes('error') || s.includes('interrupted');
      return !info.isCompleted && !info.isCancelled && !isFailed;
    });
  }
  async clearCompletedDownloads() {
    const completed = this.getDownloadsByFilter(([, info]) => info.isCompleted);
    const cancelled = this.getDownloadsByFilter(([, info]) => info.isCancelled);
    const failed = this.getDownloadsByFilter(([, info]) => {
      const s = (info.status || '').toLowerCase();
      return s.includes('failed') || s.includes('error') || s.includes('interrupted');
    });
    const removedIds = [];
    for (const [id] of [...completed, ...cancelled, ...failed]) {
      const ok = await this.removeDownload(id);
      if (ok) removedIds.push(id);
    }
    return removedIds;
  }
  cancelAllDownloads() {
    const active = this.getActiveDownloads();
    const cancelledIds = [];
    active.forEach(([id]) => { if (this.updateDownload(id, { isCancelled: true })) cancelledIds.push(id); });
    return cancelledIds;
  }
  getStats() {
    const all = Array.from(this.activeDownloads.values());
    const active = all.filter(info => !info.isCompleted && !info.isCancelled);
    const completed = all.filter(info => info.isCompleted);
    const cancelled = all.filter(info => info.isCancelled);
    const failed = all.filter(info => {
      const s = (info.status || '').toLowerCase();
      return s.includes('failed') || s.includes('error') || s.includes('interrupted');
    });
    return { total: all.length, active: active.length, completed: completed.length, cancelled: cancelled.length, failed: failed.length, isEmpty: all.length === 0, hasActive: active.length > 0 };
  }
  async setCollapsed(collapsed) { if (this.isCollapsed !== collapsed) { this.isCollapsed = collapsed; await this.persistCollapsedOnly(); this.emit('collapseChanged', collapsed); } }
  toggleCollapsed() { const s = !this.isCollapsed; this.setCollapsed(s); return s; }
  startAutoCollapseTimer(delay = null) {
    this.clearAutoCollapseTimer();
    const timeout = delay || this.config.ui?.autoHideAfterComplete || 8000;
    if (timeout <= 0) return; const stats = this.getStats();
    this.autoCollapseTimer = setTimeout(async () => {
      const currentStats = this.getStats();
      if (!currentStats.hasActive && this.config.behavior?.autoHideWhenEmpty) {
        // Proactively clear completed/cancelled/failed items so the list is empty when collapsing
        try { await this.clearCompletedDownloads(); } catch {}
        await this.setCollapsed(true);
        this.emit('autoCollapsed');
      }
    }, timeout);
  }
  clearAutoCollapseTimer() { if (this.autoCollapseTimer) { clearTimeout(this.autoCollapseTimer); this.autoCollapseTimer = null; } }
  on(event, callback) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(callback); }
  off(event, callback) { const ls = this.listeners.get(event); if (ls) ls.delete(callback); }
  emit(event, ...args) { const ls = this.listeners.get(event); if (ls) { ls.forEach((cb) => { try { cb(...args); } catch (_) {} }); } }
}
