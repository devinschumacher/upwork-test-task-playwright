/**
 * Download Task Registry
 *
 * Provides a single source of truth for download queue state, active tasks,
 * progress tracking, and chrome.downloads bookkeeping inside the background
 * service worker.
 */
export class DownloadTaskRegistry {
  constructor(options) {
    const opts = options || {};
    this.maxConcurrent = (opts.maxConcurrent !== undefined && opts.maxConcurrent !== null)
      ? opts.maxConcurrent
      : null;
    this.items = new Map(); // downloadId -> state object
    this.queueOrder = []; // ordered list of queued download IDs
    this.chromeToDownloadId = new Map(); // chrome download id -> downloadId
    this.aliasToDownloadId = new Map(); // temporary/placeholder id -> downloadId
    this.downloadIdCounter = 0;
  }

  generateId() {
    const counter = ++this.downloadIdCounter;
    return `download_${counter}_${Date.now()}`;
  }

  registerDownload(config) {
    const opts = config || {};
    const downloadId = (opts.id != null) ? opts.id : this.generateId();
    const existing = this.items.get(downloadId);
    const timestamp = Date.now();
    if (existing) {
      Object.assign(existing, {
        videoInfo: opts.videoInfo || existing.videoInfo,
        handler: opts.handler || existing.handler,
        handlerMethod: opts.handlerMethod || existing.handlerMethod,
        utils: (opts.utils !== undefined && opts.utils !== null) ? opts.utils : existing.utils,
        lastUpdate: timestamp,
      });
      return existing;
    }
    const entry = {
      id: downloadId,
      status: 'queued',
      videoInfo: opts.videoInfo || {},
      handler: opts.handler,
      handlerMethod: opts.handlerMethod,
      utils: opts.utils,
      queueTimestamp: timestamp,
      startTime: null,
      endTime: null,
      progress: { percentage: 0, status: 'Queued', speed: '', timestamp },
      abortController: null,
      promise: null,
      error: null,
      cancelled: false,
      chromeDownloadIds: new Set(),
      lastUpdate: timestamp,
    };
    this.items.set(downloadId, entry);
    if (!this.queueOrder.includes(downloadId)) {
      this.queueOrder.push(downloadId);
    }
    return entry;
  }

  has(downloadId) { return this.items.has(downloadId); }
  get(downloadId) { return this.items.get(downloadId) || null; }

  remove(downloadId) {
    const entry = this.items.get(downloadId);
    if (!entry) return null;
    this.items.delete(downloadId);
    this.queueOrder = this.queueOrder.filter((id) => id !== downloadId);
    const toDelete = [];
    const iter = this.chromeToDownloadId.entries();
    let item = iter.next();
    while (!item.done) {
      const chromeId = item.value[0];
      const mappedId = item.value[1];
      if (mappedId === downloadId) toDelete.push(chromeId);
      item = iter.next();
    }
    for (let i = 0; i < toDelete.length; i += 1) {
      this.chromeToDownloadId.delete(toDelete[i]);
    }
    return entry;
  }

  markActive(downloadId, options) {
    const opts = options || {};
    const entry = this.items.get(downloadId);
    if (!entry) return null;
    entry.status = 'downloading';
    entry.startTime = entry.startTime || Date.now();
    entry.abortController = opts.abortController || null;
    entry.promise = opts.promise || null;
    entry.lastUpdate = Date.now();
    this.queueOrder = this.queueOrder.filter((id) => id !== downloadId);
    return entry;
  }

  updateProgress(downloadId, update) {
    const entry = this.items.get(downloadId);
    if (!entry) return null;
    const opts = update || {};
    const ts = Date.now();
    const progress = entry.progress || { percentage: 0, status: '', speed: '', timestamp: ts };
    if (typeof opts.percentage === 'number' && Number.isFinite(opts.percentage)) {
      progress.percentage = Math.max(progress.percentage || 0, opts.percentage);
    }
    if (typeof opts.status === 'string') progress.status = opts.status;
    if (typeof opts.speed === 'string') progress.speed = opts.speed;
    if (typeof opts.downloaded === 'number' && Number.isFinite(opts.downloaded)) {
      progress.downloaded = Math.max(0, opts.downloaded);
    }
    if (typeof opts.total === 'number' && Number.isFinite(opts.total)) {
      progress.total = Math.max(0, opts.total);
    }
    if (typeof opts.awaitingUserInteraction === 'boolean') {
      progress.awaitingUserInteraction = opts.awaitingUserInteraction;
    }
    progress.timestamp = ts;
    entry.progress = progress;
    entry.lastUpdate = ts;
    return entry;
  }

  markCompleted(downloadId) {
    const entry = this.items.get(downloadId);
    if (!entry) return null;
    entry.status = 'completed';
    entry.endTime = Date.now();
    entry.cancelled = false;
    entry.error = null;
    entry.abortController = null;
    entry.promise = null;
    entry.lastUpdate = entry.endTime;
    if (!entry.progress) {
      entry.progress = {
        percentage: 100,
        status: 'Completed',
        speed: '',
        downloaded: entry.progress?.downloaded || entry.videoInfo?.downloaded || 0,
        total: entry.progress?.total || entry.videoInfo?.total || 0,
        timestamp: entry.endTime,
      };
    } else {
      entry.progress.percentage = 100;
      entry.progress.status = entry.progress.status || 'Completed';
      entry.progress.timestamp = entry.endTime;
      if (entry.progress.total != null && entry.progress.downloaded == null) {
        entry.progress.downloaded = entry.progress.total;
      }
    }
    return entry;
  }

  markFailed(downloadId, error) {
    const entry = this.items.get(downloadId);
    if (!entry) return null;
    entry.status = 'failed';
    entry.error = (error !== undefined) ? error : null;
    entry.endTime = Date.now();
    entry.abortController = null;
    entry.promise = null;
    entry.lastUpdate = entry.endTime;
    return entry;
  }

  markCancelled(downloadId, reason) {
    const entry = this.items.get(downloadId);
    if (!entry) return null;
    entry.status = 'cancelled';
    entry.cancelled = true;
    entry.error = (reason !== undefined) ? reason : null;
    entry.endTime = Date.now();
    entry.abortController = null;
    entry.promise = null;
    entry.lastUpdate = entry.endTime;
    return entry;
  }

  attachChromeDownload(downloadId, chromeDownloadId) {
    if (!downloadId || !chromeDownloadId) return;
    const entry = this.items.get(downloadId);
    if (!entry) return;
    if (!entry.chromeDownloadIds) entry.chromeDownloadIds = new Set();
    entry.chromeDownloadIds.add(chromeDownloadId);
    this.chromeToDownloadId.set(chromeDownloadId, downloadId);
  }

  detachChromeDownload(chromeDownloadId) {
    const downloadId = this.chromeToDownloadId.get(chromeDownloadId);
    if (!downloadId) return null;
    const entry = this.items.get(downloadId);
    if (entry && entry.chromeDownloadIds) entry.chromeDownloadIds.delete(chromeDownloadId);
    this.chromeToDownloadId.delete(chromeDownloadId);
    return downloadId;
  }

  // Map a temporary/placeholder id (e.g., from popup priming) to the real download id
  attachAlias(downloadId, aliasId) {
    try {
      if (!downloadId || !aliasId) return;
      this.aliasToDownloadId.set(String(aliasId), String(downloadId));
    } catch (error) {}
  }

  getDownloadIdForAlias(aliasId) {
    try {
      return this.aliasToDownloadId.get(String(aliasId)) || null;
    } catch (error) {
      return null;
    }
  }

  detachAlias(aliasId) {
    try {
      this.aliasToDownloadId.delete(String(aliasId));
    } catch (error) {}
  }

  removeAliasesForDownload(downloadId) {
    try {
      const target = String(downloadId);
      const keep = new Map();
      const iterator = this.aliasToDownloadId.entries();
      let entryItem = iterator.next();
      while (!entryItem.done) {
        const aliasKey = entryItem.value[0];
        const mappedId = entryItem.value[1];
        if (mappedId !== target) keep.set(aliasKey, mappedId);
        entryItem = iterator.next();
      }
      this.aliasToDownloadId = keep;
    } catch (error) {}
  }

  getDownloadIdForChromeId(chromeDownloadId) {
    return this.chromeToDownloadId.get(chromeDownloadId) || null;
  }

  getTrackedChromeDownloadIds() {
    return Array.from(this.chromeToDownloadId.keys());
  }

  getActiveEntries() { return Array.from(this.items.values()).filter(e => e.status === 'downloading'); }
  getActiveCount() { return this.getActiveEntries().length; }
  getQueuedEntries() {
    const queued = [];
    for (const id of this.queueOrder) {
      const entry = this.items.get(id);
      if (entry && entry.status === 'queued') queued.push(entry);
    }
    for (const entry of this.items.values()) {
      if (entry.status === 'queued' && !this.queueOrder.includes(entry.id)) queued.push(entry);
    }
    return queued;
  }

  getAllIds() {
    return Array.from(this.items.keys());
  }

  getAllEntries() {
    return Array.from(this.items.values());
  }

  getActiveDownloadIds() {
    return this.getActiveEntries().map((entry) => entry.id);
  }

  getSnapshotEntries() {
    return this.getAllEntries().map((entry) => {
      const progress = entry.progress || {};
      const fallbackTitle = entry.videoInfo?.title || entry.videoInfo?.fileName || entry.videoInfo?.filename || 'Loom Video';
      return {
        id: String(entry.id),
        filename: fallbackTitle,
        status: entry.status || progress.status || 'Queued',
        progress: Number.isFinite(progress.percentage) ? Math.max(0, Math.min(100, progress.percentage)) : 0,
        downloaded: Number.isFinite(progress.downloaded) ? Math.max(0, progress.downloaded) : 0,
        total: Number.isFinite(progress.total) ? Math.max(0, progress.total) : 0,
        speed: progress.speed || '',
        isCompleted: entry.status === 'completed',
        isCancelled: entry.status === 'cancelled',
        awaitingUserInteraction: !!progress.awaitingUserInteraction,
        lastUpdate: entry.lastUpdate || Date.now(),
        queueTimestamp: entry.queueTimestamp || null,
        startTime: entry.startTime || null,
        endTime: entry.endTime || null,
      };
    });
  }
}
