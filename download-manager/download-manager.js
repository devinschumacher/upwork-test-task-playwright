/**
 * Download Manager (Loom)
 */

import { DownloadManagerState } from './download-manager-state.js';
import { DownloadManagerUI } from './download-manager-ui.js';
import { createConfig } from './download-manager-config.js';

export class DownloadManager {
  constructor(customConfig = {}, preset = null) {
    this.config = createConfig(customConfig, preset);
    this.state = new DownloadManagerState(this.config);
    this.ui = new DownloadManagerUI(this.config);
    this._suppressedIds = new Set();
    this._suppressTimers = new Map();
    this.bindStateToUI();
    this.bindUIEvents();
  }

  dedupeCompletedByFilename(currentId, info) {
    try {
      const name = (info?.filename || '').toString().trim().toLowerCase();
      if (!name) return;
      const all = this.state.getAllDownloads();
      const dups = [];
      all.forEach((inf, id) => {
        const done = !!inf?.isCompleted || (Number(inf?.progress || 0) >= 100) || String(inf?.status || '').toLowerCase().includes('completed');
        if (!done) return;
        const n = (inf?.filename || '').toString().trim().toLowerCase();
        if (n === name) dups.push({ id: String(id), info: inf });
      });
      if (dups.length <= 1) return;
      let keepId = String(currentId);
      const notPlaceholder = dups.filter(d => !/^loom-/i.test(d.id));
      if (notPlaceholder.length > 0) {
        keepId = notPlaceholder.reduce((best, cur) => ((cur.info?.lastUpdate || 0) > (best.info?.lastUpdate || 0) ? cur : best)).id;
      } else if (!dups.some(d => d.id === keepId)) {
        keepId = dups.reduce((best, cur) => ((cur.info?.lastUpdate || 0) > (best.info?.lastUpdate || 0) ? cur : best)).id;
      }
      dups.forEach(d => { if (d.id !== keepId) { try { this.removeDownloadItem(d.id, { silent: true }); } catch (_) {} } });
    } catch (_) {}
  }

  notifyRemoval(ids) {
    try {
      const list = Array.isArray(ids) ? ids : (ids != null ? [ids] : []);
      const payload = list.filter((id) => id != null).map((id) => String(id));
      if (payload.length === 0) return;
      chrome?.runtime?.sendMessage?.({ action: 'downloadManagerRemoveEntries', downloadIds: payload });
    } catch (_) {}
  }

  suppressDownloadId(id, ms = 4000) {
    try {
      const key = id != null ? String(id) : null;
      if (!key) return;
      this._suppressedIds.add(key);
      const prev = this._suppressTimers.get(key);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        this._suppressedIds.delete(key);
        this._suppressTimers.delete(key);
      }, Math.max(500, ms));
      this._suppressTimers.set(key, t);
    } catch (_) {}
  }

  initialize() {
    this.ui.createPanel();
    this.updateUI();
    const stats = this.state.getStats();
    if (this.config.behavior.autoShowOnDownload && stats.total > 0) this.show();
  }

  show() { this.ui.showPanel(); this.state.setCollapsed(false); this.config.callbacks?.onPanelShow?.(); }
  hide() { this.ui.hidePanel(); this.state.setCollapsed(true); this.config.callbacks?.onPanelHide?.(); }
  toggle() { const wasVisible = !this.state.isCollapsed; wasVisible ? this.hide() : this.show(); return !wasVisible; }

  async showDownloadProgress(downloadId, filename, downloaded = 0, total = 0, progress = 0, status = 'Downloading...') {
    if (this.state.isCollapsed || !this.ui.panel || this.ui.panel.style.opacity === '0') this.show();
    const existing = this.state.getDownload(downloadId);
    const statusStr = (status || '').toLowerCase();
    const isCancelledStatus = statusStr.includes('cancelled') || statusStr.includes('canceled');
    const isFailureStatus = statusStr.includes('failed') || statusStr.includes('error') || statusStr.includes('interrupted');
    const isCompletedStatus = statusStr.includes('completed') || (typeof progress === 'number' && progress >= 100);

    // Suppress flicker for locally-cancelled ids
    if (this._suppressedIds.has(String(downloadId))) {
      if (isCancelledStatus || isFailureStatus || isCompletedStatus) {
        try { await this.hideDownloadProgress(downloadId, { silent: true }); } catch {}
      }
      return;
    }

    if (isCancelledStatus) {
      if (existing) await this.state.updateDownload(downloadId, { isCancelled: true, status: this.config.labels?.cancelled || 'Cancelled' });
      this.updateUI();
      return;
    }
    if (existing) {
      await this.state.updateDownload(downloadId, { filename, downloaded, total, progress, status });
    } else {
      try { await this.clearCompletedDownloads(); } catch {}
      await this.state.addDownload(downloadId, { filename, downloaded, total, progress, status });
      this.config.callbacks?.onDownloadStart?.(downloadId, filename);
    }
    this.updateUI();
  }

  hideDownloadProgress(downloadId, options = {}) { const info = this.state.getDownload(downloadId); if (info) { this.state.removeDownload(downloadId); this.ui.removeDownloadItem(downloadId); if (!options?.silent) this.notifyRemoval([downloadId]); this.updateUI(); } }
  removeDownloadItem(downloadId, options = {}) { const removed = this.state.removeDownload(downloadId); this.ui.removeDownloadItem(downloadId); if (removed && !options?.silent) this.notifyRemoval([downloadId]); this.updateUI(); }
  async cancelDownload(downloadId) {
    const id = String(downloadId);
    const info = this.state.getDownload(id);
    // If this is a placeholder or missing from state, just remove it locally
    if (!info || /^loom-/i.test(id)) {
      try { await this.hideDownloadProgress(id, { silent: true }); } catch (_) {}
      try { if (typeof chrome !== 'undefined' && chrome.runtime) { await chrome.runtime.sendMessage({ action: 'downloadManagerRemoveEntries', downloadIds: [id] }); } } catch (_) {}
      this.updateUI();
      return true;
    }
    if (info.isCompleted || info.isCancelled) return false;
    this.suppressDownloadId(id);
    this.state.updateDownload(id, { isCancelled: true, status: this.config.labels?.cancelled || 'Cancelled' });
    try { if (typeof chrome !== 'undefined' && chrome.runtime) { await chrome.runtime.sendMessage({ action: 'cancelDownload', downloadId: id }); } } catch (_) {}
    this.updateUI();
    return true;
  }
  cancelAllDownloads() { try { chrome?.runtime?.sendMessage?.({ action: 'cancelAllDownloads' }); } catch {} return this.state.cancelAllDownloads(); }
  async clearCompletedDownloads() { return await this.state.clearCompletedDownloads(); }

  bindStateToUI() {
    const update = () => this.updateUI();
    this.state.on('downloadAdded', (id, info) => {
      try {
        const s = (info?.status || '').toLowerCase();
        const failed = s.includes('failed') || s.includes('error') || s.includes('interrupted');
        const isCompleted = info?.isCompleted || s.includes('completed') || ((info?.progress ?? 0) >= 100);
        const isCancelled = info?.isCancelled || s.includes('cancelled') || s.includes('canceled');
        const done = isCompleted || isCancelled || failed;
        if (isCompleted) { try { this.dedupeCompletedByFilename(id, info); } catch (_) {} }
        if (!done || !this.config?.behavior?.autoRemoveOnComplete) return update();
        const delay = isCompleted ? Math.max(0, Number(this.config?.behavior?.completeRemovalDelayMs ?? 0)) : 0;
        setTimeout(async () => {
          try {
            const removed = await this.state.removeDownload(id);
            if (removed) {
              this.ui.removeDownloadItem(id);
              this.notifyRemoval([id]);
              const stats = this.state.getStats();
              if (this.config?.behavior?.autoHideWhenEmpty && stats.total === 0) this.hide();
            }
          } catch (_) {}
          update();
        }, delay);
      } catch (_) { update(); }
    });
    // Auto-remove completed/failed/cancelled after updates
    this.state.on('downloadUpdated', (id, info) => {
      try {
        const s = (info?.status || '').toLowerCase();
        const failed = s.includes('failed') || s.includes('error') || s.includes('interrupted');
        const isCompleted = info?.isCompleted || s.includes('completed') || ((info?.progress ?? 0) >= 100);
        const isCancelled = info?.isCancelled || s.includes('cancelled') || s.includes('canceled');
        const done = isCompleted || isCancelled || failed;
        if (isCompleted) { try { this.dedupeCompletedByFilename(id, info); } catch (_) {} }
        if (!done || !this.config?.behavior?.autoRemoveOnComplete) return update();
        const delay = isCompleted ? Math.max(0, Number(this.config?.behavior?.completeRemovalDelayMs ?? 0)) : 0;
        setTimeout(async () => {
          try {
            const removed = await this.state.removeDownload(id);
            if (removed) {
              this.ui.removeDownloadItem(id);
              this.notifyRemoval([id]);
              const stats = this.state.getStats();
              if (this.config?.behavior?.autoHideWhenEmpty && stats.total === 0) this.hide();
            }
          } catch (_) {}
          update();
        }, delay);
      } catch (_) { update(); }
    });
    this.state.on('downloadRemoved', update);
    this.state.on('stateChanged', update);
    // Hide/show the panel when collapsed/expanded state changes
    this.state.on('collapseChanged', (collapsed) => {
      if (collapsed) this.ui.hidePanel(); else this.ui.showPanel();
    });
    // In case consumers listen for auto-collapsed specifically
    this.state.on('autoCollapsed', () => {
      this.ui.hidePanel();
    });
  }

  bindUIEvents() {
    this.ui.onCancelAll = () => this.cancelAllDownloads();
    this.ui.onClearCompleted = () => this.clearCompletedDownloads();
    this.ui.onCancelItem = (id) => this.cancelDownload(id);
    this.ui.onRemoveItem = (id) => this.removeDownloadItem(id);
  }

  updateUI() {
    const stats = this.state.getStats();
    // Hide immediately when empty if configured
    if (this.config?.behavior?.autoHideWhenEmpty && stats.isEmpty) { this.hide(); return; }
    this.ui.updateUI(stats, this.state.getAllDownloads());
    if (!stats.hasActive && this.config.ui?.autoHideAfterComplete > 0) {
      this.state.startAutoCollapseTimer(this.config.ui.autoHideAfterComplete);
    } else {
      this.state.clearAutoCollapseTimer();
    }
  }

  syncDownloads(downloads) {
    // Optional: not used initially; manager can be extended to sync a batch state
  }
}
