import { set, get, remove } from "./indexed-db.js";
import { DownloadTaskRegistry } from "./download-manager/download-task-registry.js";
// Browser-compatible Loom downloader following the original strategy
console.log("🚀 Background script starting...");

// Offscreen document management for FastStream/MediaBunny processing
let offscreenCreated = false;
let activeDownloads = 0;
let downloadCancelled = false;
// Track cancellations per item (if Download Manager sends specific ids)
const __dmCancelledIds = new Set();
let __dmCurrentId = null;
let __dmCurrentName = null;

// Linger completed entries in UI before cleanup (ms)
const COMPLETE_LINGER_MS = 2500;

// Centralized queue/registry (staged rollout)
const maxConcurrentDownloads = 3;
const downloadTaskRegistry = new DownloadTaskRegistry({ maxConcurrent: maxConcurrentDownloads });
// Track offscreen merge requests by queue download id for cancellation
const offscreenRequestsByDownloadId = new Map(); // id -> Set(requestId)

function registerOffscreenRequest(downloadId, requestId) {
  try {
    if (!downloadId || !requestId) return;
    const id = String(downloadId);
    const set = offscreenRequestsByDownloadId.get(id) || new Set();
    set.add(String(requestId));
    offscreenRequestsByDownloadId.set(id, set);
  } catch (_) {}
}

function clearOffscreenRequest(downloadId, requestId) {
  try {
    if (!downloadId || !requestId) return;
    const id = String(downloadId);
    const set = offscreenRequestsByDownloadId.get(id);
    if (!set) return;
    set.delete(String(requestId));
    if (set.size === 0) offscreenRequestsByDownloadId.delete(id);
  } catch (_) {}
}
// Base utils used by isolated utils (proxies to existing functions)
const baseDownloadUtils = {
  sendProgressUpdate: (percentage, status, speed = '', extra = {}) => {
    try {
      const context = extra && typeof extra === 'object' ? extra : {};
      sendProgressToPopup(percentage, status, speed);
      if (context.downloadId) {
        try { downloadTaskRegistry.updateProgress(String(context.downloadId), { percentage, status, speed }); } catch {}
        try { updateGlobalDownloadState(String(context.downloadId), { filename: context.filename, progress: percentage, status, downloaded: context.downloaded, total: context.total }); } catch {}
      }
    } catch {}
  },
  sendProgressToContentScript: (downloadId, filename, downloaded, total, progress, status, extra = {}) => {
    try { sendProgressToContentScript(downloadId, filename, downloaded, total, progress, status, extra); } catch {}
  },
  sendDownloadComplete: (message) => { try { sendDownloadComplete(message); } catch {} },
  sendDownloadError: (message) => { try { sendDownloadError(message); } catch {} },
  sendDownloadCancelled: (message) => { try { sendDownloadCancelled(message); } catch {} },
};

function createIsolatedUtils(downloadId) {
  const id = downloadId != null ? String(downloadId) : null;
  return {
    currentDownloadId: id,
    sendProgressUpdate: (percentage, status, speed = '', extra = {}) => {
      const context = { ...(extra || {}), downloadId: id };
      baseDownloadUtils.sendProgressUpdate(percentage, status, speed, context);
    },
    sendProgressToContentScript: (filename, downloaded = 0, total = 0, progress = 0, status = 'Downloading...', extra = {}) => {
      if (!id) return;
      baseDownloadUtils.sendProgressToContentScript(id, filename, downloaded, total, progress, status, extra);
    },
    sendDownloadComplete: (message) => baseDownloadUtils.sendDownloadComplete(message),
    sendDownloadError: (message) => baseDownloadUtils.sendDownloadError(message),
    sendDownloadCancelled: (message) => baseDownloadUtils.sendDownloadCancelled(message),
  };
}
// Minimal shared state sanitization/pruning (staged)
const DM_STORAGE_KEY = 'downloadManagerGlobalState';
const __dmLastStorageSync = new Map();

function canSyncDownloadState() {
  try { return typeof chrome !== 'undefined' && chrome?.storage?.local; } catch (_) { return false; }
}

function sanitizeDownloadState(rawState) {
  const fallback = { downloads: {}, isCollapsed: false, lastUpdate: Date.now() };
  if (!rawState || typeof rawState !== 'object') return fallback;
  const out = { downloads: {}, isCollapsed: !!rawState.isCollapsed, lastUpdate: rawState.lastUpdate || Date.now() };
  try {
    const entries = rawState.downloads && typeof rawState.downloads === 'object' ? rawState.downloads : {};
    for (const [id, info] of Object.entries(entries)) {
      if (!info || typeof info !== 'object') continue;
      const statusText = typeof info.status === 'string' ? info.status : 'Downloading...';
      const normalized = {
        id: String(id),
        filename: info.filename || 'Video',
        progress: Number.isFinite(info.progress) ? Math.max(0, Math.min(100, info.progress)) : 0,
        status: statusText,
        downloaded: Number.isFinite(info.downloaded) ? Math.max(0, info.downloaded) : 0,
        total: Number.isFinite(info.total) ? Math.max(0, info.total) : 0,
        speed: typeof info.speed === 'string' ? info.speed : '',
        isCompleted: !!info.isCompleted,
        isCancelled: !!info.isCancelled,
        awaitingUserInteraction: !!info.awaitingUserInteraction,
        completedAt: info.completedAt || null,
        lastUpdate: info.lastUpdate || rawState.lastUpdate || Date.now(),
        startTime: info.startTime || Date.now(),
      };
      if (normalized.isCompleted || normalized.isCancelled) normalized.awaitingUserInteraction = false;
      out.downloads[normalized.id] = normalized;
    }
  } catch (_) {}
  return out;
}

async function getPersistedDownloadState() {
  if (!canSyncDownloadState()) return sanitizeDownloadState(null);
  try {
    const result = await chrome.storage.local.get([DM_STORAGE_KEY]);
    return sanitizeDownloadState(result?.[DM_STORAGE_KEY] || null);
  } catch (_) {
    return sanitizeDownloadState(null);
  }
}

async function persistDownloadState(state) {
  if (!canSyncDownloadState()) return;
  try {
    await chrome.storage.local.set({ [DM_STORAGE_KEY]: sanitizeDownloadState(state) });
  } catch (_) {}
}

function isStaleDownloadEntry(info, now = Date.now()) {
  if (!info || typeof info !== 'object') return true;
  const lastUpdate = info.lastUpdate || 0;
  const status = (info.status || '').toLowerCase();
  const isCompleted = !!info.isCompleted || status.includes('completed');
  const isCancelled = !!info.isCancelled || status.includes('cancelled') || status.includes('canceled');
  const isFailed = status.includes('failed') || status.includes('error') || status.includes('interrupted');
  if (isCompleted || isCancelled || isFailed) return now - lastUpdate > 12 * 60 * 60 * 1000; // 12h
  return now - lastUpdate > 2 * 60 * 60 * 1000; // 2h
}

function pruneDownloadEntries(downloads, now = Date.now()) {
  const out = {};
  if (!downloads || typeof downloads !== 'object') return out;
  for (const [id, info] of Object.entries(downloads)) {
    if (isStaleDownloadEntry(info, now)) { __dmLastStorageSync.delete(String(id)); continue; }
    out[id] = info;
  }
  return out;
}

async function pruneGlobalDownloadStateNow() {
  if (!canSyncDownloadState()) return;
  try {
    const state = await getPersistedDownloadState();
    const now = Date.now();
    const before = Object.keys(state.downloads || {});
    const pruned = pruneDownloadEntries(state.downloads || {}, now);
    if (before.length !== Object.keys(pruned).length) {
      await persistDownloadState({ ...state, downloads: pruned, lastUpdate: now });
    }
  } catch (e) {
    console.warn('⚠️ Failed to prune global state:', e?.message || e);
  }
}

setTimeout(() => { try { pruneGlobalDownloadStateNow(); } catch (_) {} }, 500);

async function removeDownloadManagerStorageEntry(downloadId) {
  if (!downloadId || !canSyncDownloadState()) return;
  try {
    const state = await getPersistedDownloadState();
    const downloads = { ...(state.downloads || {}) };
    delete downloads[String(downloadId)];
    await persistDownloadState({ ...state, downloads, lastUpdate: Date.now() });
  } catch (_) {}
}

async function updateGlobalDownloadState(downloadId, payload = {}) {
  if (!downloadId || !canSyncDownloadState()) return;
  const id = String(downloadId);
  try {
    const state = await getPersistedDownloadState();
    const previous = state.downloads?.[id] || {};
    const nextProgress = typeof payload.progress === 'number' && Number.isFinite(payload.progress)
      ? Math.max(previous.progress || 0, payload.progress)
      : (previous.progress || 0);
    const status = payload.status || previous.status || 'Downloading...';
    const entry = {
      ...previous,
      id,
      filename: payload.filename || previous.filename || 'Video',
      downloaded: typeof payload.downloaded === 'number' ? payload.downloaded : (previous.downloaded || 0),
      total: typeof payload.total === 'number' ? payload.total : (previous.total || 0),
      progress: nextProgress,
      status,
      awaitingUserInteraction: !!payload.awaitingUserInteraction,
      isCompleted: !!payload.isCompleted,
      isCancelled: !!payload.isCancelled,
      lastUpdate: Date.now(),
      startTime: previous.startTime || Date.now(),
      completedAt: payload.isCompleted ? (previous.completedAt || Date.now()) : (previous.completedAt || null),
    };
    const downloads = { ...(state.downloads || {}), [id]: entry };
    await persistDownloadState({ ...state, downloads, lastUpdate: Date.now() });
  } catch (_) {}
}

async function cancelDownload(downloadId, reason = 'Cancelled by user') {
  if (downloadId == null) return false;
  let id = String(downloadId);
  // Resolve queue id if a Chrome download id or alias was provided
  try {
    if (/^\d+$/.test(id)) {
      const mapped = downloadTaskRegistry.getDownloadIdForChromeId(Number(id));
      if (mapped) id = String(mapped);
    }
    const aliasMapped = downloadTaskRegistry.getDownloadIdForAlias(id);
    if (aliasMapped) id = String(aliasMapped);
  } catch (_) {}

  const entry = downloadTaskRegistry.get(id);

  try {
    if (entry) {
      if (entry.abortController && !entry.abortController.signal.aborted) {
        try { entry.abortController.abort(new Error(reason)); } catch (_) {}
      }
      // Cancel any native chrome downloads mapped to this task
      if (entry.chromeDownloadIds && entry.chromeDownloadIds.size > 0) {
        for (const chromeId of Array.from(entry.chromeDownloadIds)) {
          try { chrome.downloads.cancel(Number(chromeId), () => {}); } catch (_) {}
        }
      }
    } else if (/^\d+$/.test(String(downloadId))) {
      // If we were given a bare chrome download id with no registry entry, cancel it directly
      try { chrome.downloads.cancel(Number(downloadId), () => {}); } catch (_) {}
    }

    // Cancel any outstanding offscreen merge requests for this (queue or dm) id
    const reqs = offscreenRequestsByDownloadId.get(id) || offscreenRequestsByDownloadId.get(String(downloadId));
    if (reqs && reqs.size > 0) {
      for (const reqId of Array.from(reqs)) {
        try { chrome.runtime.sendMessage({ type: 'CANCEL_OFFSCREEN_REQUEST', requestId: String(reqId) }); } catch (_) {}
      }
    }

    // Notify in-page Download Manager to reflect cancellation immediately
    try { await sendDownloadManagerMessage({ action: 'cancelDownload', downloadId: id }); } catch (_) {}
  } catch (_) {}

  if (entry) {
    try {
      await handleDownloadCompletion(id, { success: false, id, cancelled: true, error: new Error(reason) });
    } catch (_) {}
    return true;
  } else {
    // If no registry entry, still attempt to update/remove any persisted DM entry
    try {
      await updateGlobalDownloadState(String(downloadId), { status: 'Cancelled', isCancelled: true, progress: 0 });
      await removeDownloadManagerStorageEntry(String(downloadId));
      try { await sendDownloadManagerMessage({ action: 'hideDownloadProgress', downloadId: String(downloadId) }); } catch (_) {}
    } catch (_) {}
    return true;
  }
}

function queueDownload(taskPayload = {}) {
  const entry = downloadTaskRegistry.registerDownload({ videoInfo: taskPayload });
  processDownloadQueue();
  return entry.id;
}

function processDownloadQueue() {
  try {
    const activeCount = downloadTaskRegistry.getActiveCount();
    const queued = downloadTaskRegistry.getQueuedEntries();
    if (!queued || queued.length === 0) return;
    const slots = Math.max(0, maxConcurrentDownloads - activeCount);
    if (slots <= 0) return;
    const toStart = queued.slice(0, slots);
    for (const entry of toStart) {
      startQueuedDownload(entry);
    }
  } catch (e) {
    console.warn('⚠️ Failed to process Loom download queue:', e?.message || e);
  }
}

async function startQueuedDownload(entry) {
  if (!entry) return;
  const abortController = new AbortController();
  const marked = downloadTaskRegistry.markActive(entry.id, { abortController });
  if (!marked) return;

  const payload = entry.videoInfo || {};
  const url = payload.url;
  const password = payload.password;
  const utils = createIsolatedUtils(entry.id);

  const promise = (async () => {
    try {
      __dmCurrentId = entry.id; // Legacy progress channel (will be replaced by isolated utils)
      await downloadLoomVideo({ url, password, queueDownloadId: entry.id }, { utils, abortSignal: abortController.signal });
      return { success: true, id: entry.id };
    } catch (error) {
      const cancelled = abortController.signal.aborted || /cancel/i.test(error?.message || '');
      return { success: false, id: entry.id, error, cancelled };
    } finally {
      __dmCurrentId = null;
    }
  })();

  marked.promise = promise;

  promise
    .then((result) => handleDownloadCompletion(entry.id, result))
    .catch((error) => handleDownloadCompletion(entry.id, { success: false, id: entry.id, error }))
    .finally(() => {
      // No-op for now; cleanup in handleDownloadCompletion
    });
}

async function handleDownloadCompletion(downloadId, result) {
  try {
    const entrySnapshot = downloadTaskRegistry.get(downloadId);
    const displayTitle = entrySnapshot?.videoInfo?.title || entrySnapshot?.videoInfo?.fileName || __dmCurrentName || 'Loom Video';
    if (!result?.success) {
      if (result?.cancelled) {
        downloadTaskRegistry.markCancelled(downloadId, result?.error || 'cancelled');
        try {
          sendProgressToContentScript(String(downloadId), displayTitle, 0, 0, 0, 'Cancelled', { awaitingUserInteraction: false });
          await updateGlobalDownloadState(String(downloadId), { filename: displayTitle, status: 'Cancelled', isCancelled: true, progress: 0 });
          try { sendDownloadCancelled(); } catch (_) {}
        } catch (_) {}
      } else {
        downloadTaskRegistry.markFailed(downloadId, result?.error || 'failed');
        try {
          sendProgressToContentScript(String(downloadId), displayTitle, 0, 0, 0, `Failed: ${result?.error?.message || 'Error'}`, { awaitingUserInteraction: false });
          await updateGlobalDownloadState(String(downloadId), { filename: displayTitle, status: 'Failed', progress: 0 });
          try { sendDownloadError(result?.error?.message || 'Download failed'); } catch (_) {}
        } catch (_) {}
      }
    } else {
      downloadTaskRegistry.markCompleted(downloadId);
      try {
        sendProgressToContentScript(String(downloadId), displayTitle, 0, 0, 100, 'Completed', { awaitingUserInteraction: false });
        await updateGlobalDownloadState(String(downloadId), { filename: displayTitle, status: 'Completed', isCompleted: true, progress: 100 });
        try { sendDownloadComplete(`Download completed: ${displayTitle}`); } catch (_) {}
      } catch (_) {}
    }
  } catch (e) {
    console.warn('⚠️ Failed to update registry for completion:', e?.message || e);
  } finally {
    try { downloadTaskRegistry.remove(downloadId); } catch (_) {}
    const delay = result && result.success ? COMPLETE_LINGER_MS : 0;
    setTimeout(async () => {
      try { await removeDownloadManagerStorageEntry(String(downloadId)); } catch (_) {}
    }, Math.max(0, Number(delay) || 0));
    try { downloadTaskRegistry.removeAliasesForDownload(String(downloadId)); } catch (_) {}
    processDownloadQueue();
  }
}

// Ensure offscreen document exists and can receive messages
async function ensureOffscreenReady() {
  try {
    if (!offscreenCreated) {
      await createOffscreenDocument();
      return true;
    }
    // Ping offscreen to confirm it's alive
    const testId = Math.random().toString(36).slice(2);
    const pong = await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, 3000);
      try {
        chrome.runtime
          .sendMessage({ type: "PING", testId })
          .then((resp) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(resp);
            }
          })
          .catch(() => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(null);
            }
          });
      } catch (_) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      }
    });
    if (pong && pong.type === "PONG") {
      return true;
    }
  } catch (_) {}

  // Re-create when ping fails
  try {
    offscreenCreated = false;
    await createOffscreenDocument();
    return true;
  } catch (_) {
    return false;
  }
}

// Progress reporting functions
function sendProgressToPopup(percentage, status, speed = "") {
  try {
    chrome.runtime.sendMessage({
      type: "DOWNLOAD_PROGRESS",
      percentage: percentage,
      status: status,
      speed: speed
    }).catch(() => {
      // Ignore errors if popup is closed
    });
  } catch (error) {
    // Ignore errors if extension context is invalid
  }
}

function sendDownloadComplete(status = "Download completed!") {
  try {
    chrome.runtime.sendMessage({
      type: "DOWNLOAD_COMPLETE",
      status: status
    }).catch(() => {
      // Ignore errors if popup is closed
    });
  } catch (error) {
    // Ignore errors if extension context is invalid
  }
}

function sendDownloadError(error) {
  try {
    chrome.runtime.sendMessage({
      type: "DOWNLOAD_ERROR",
      error: error
    }).catch(() => {
      // Ignore errors if popup is closed
    });
  } catch (error) {
    // Ignore errors if extension context is invalid
  }
}

function sendDownloadCancelled() {
  try {
    chrome.runtime.sendMessage({
      type: "DOWNLOAD_CANCELLED"
    }).catch(() => {
      // Ignore errors if popup is closed
    });
  } catch (error) {
    // Ignore errors if extension context is invalid
  }
}

// Download Manager messaging (in-page UI)
async function broadcastToLoomFrames(message) {
  if (!message || typeof message !== 'object') return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
        for (const frame of frames || []) {
          const u = frame.url || '';
          if (u.includes('loom.com')) {
            try { await chrome.tabs.sendMessage(tab.id, message, { frameId: frame.frameId }); } catch {}
          }
        }
      } catch {}
    }
  } catch {}
}

async function sendDownloadManagerMessage(message) {
  if (!message || typeof message !== 'object') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      try { await chrome.tabs.sendMessage(tab.id, message); } catch {}
    }
  } catch {}
  await broadcastToLoomFrames(message);
}

function sendProgressToContentScript(downloadId, filename, downloaded, total, progress, status, extra = {}) {
  const id = downloadId == null ? null : String(downloadId);
  const safeFilename = filename || __dmCurrentName || 'Video';
  const downloadedNumber = Number(downloaded);
  const totalNumber = Number(total);
  const rawProgress = Number(progress);
  const safeDownloaded = Number.isFinite(downloadedNumber) && downloadedNumber >= 0 ? downloadedNumber : 0;
  const safeTotal = Number.isFinite(totalNumber) && totalNumber >= 0 ? totalNumber : 0;
  const safeProgress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, rawProgress)) : 0;
  const statusString = typeof status === 'string' ? status : 'Downloading...';
  const awaitingUserInteraction = !!extra.awaitingUserInteraction;
  if (!id) return;
  try {
    downloadTaskRegistry.updateProgress(id, {
      percentage: safeProgress,
      status: statusString,
      downloaded: safeDownloaded,
      total: safeTotal,
      awaitingUserInteraction,
      speed: typeof extra.speed === 'string' ? extra.speed : undefined,
    });
  } catch (_) {}
  sendDownloadManagerMessage({
    action: 'showDownloadProgress',
    downloadId: id,
    filename: safeFilename,
    downloaded: safeDownloaded,
    total: safeTotal,
    progress: safeProgress,
    status: statusString,
    awaitingUserInteraction,
  });
  try {
    updateGlobalDownloadState(id, {
      filename: safeFilename,
      downloaded: safeDownloaded,
      total: safeTotal,
      progress: safeProgress,
      status: statusString,
      awaitingUserInteraction,
    });
  } catch (_) {}
}

function buildDownloadManagerSnapshot() {
  try {
    const downloads = downloadTaskRegistry.getSnapshotEntries();
    const activeDownloads = downloads.filter((item) => !item.isCompleted && !item.isCancelled);
    const queueItems = downloadTaskRegistry.getQueuedEntries().map((entry) => ({
      id: String(entry.id),
      status: entry.status,
      filename: entry.videoInfo?.title || entry.videoInfo?.fileName || 'Loom Video',
      lastUpdate: entry.lastUpdate || Date.now(),
    }));
    return {
      downloads,
      activeDownloads,
      queueItems,
      queueSnapshot: downloadTaskRegistry.queueOrder ? [...downloadTaskRegistry.queueOrder] : [],
    };
  } catch (error) {
    console.warn('⚠️ Failed to build download manager snapshot:', error?.message || error);
    return { downloads: [], activeDownloads: [], queueItems: [], queueSnapshot: [] };
  }
}

async function propagateDownloadManagerRemoval(downloadId, options = {}) {
  if (!downloadId) return;
  const id = String(downloadId);
  try { downloadTaskRegistry.remove(id); } catch (_) {}
  try { downloadTaskRegistry.removeAliasesForDownload(id); } catch (_) {}
  if (!options?.skipStorage) {
    try { await removeDownloadManagerStorageEntry(id); } catch (_) {}
  }
  try { await sendDownloadManagerMessage({ action: 'hideDownloadProgress', downloadId: id }); } catch (_) {}
}

// Create offscreen document for offscreen processing (FastStream/MediaBunny)
async function createOffscreenDocument() {
  console.log("Checking for existing offscreen document...");
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });

  if (existingContexts.length > 0) {
    console.log("Offscreen document already exists.");
    offscreenCreated = true;
    return;
  }

  console.log("Creating new offscreen document...");
  await new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(
        new Error("Offscreen document creation timed out after 30 seconds.")
      );
    }, 30000);

    const listener = (message) => {
      if (message.type === "OFFSCREEN_DOCUMENT_READY") {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        offscreenCreated = true;
        console.log("✅ Offscreen document is ready.");
        resolve();
      } else if (message.type === "OFFSCREEN_ERROR") {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        console.error("❌ Offscreen document failed to load:", message.error);
        reject(new Error(`Offscreen document error: ${message.error.message}`));
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "Offscreen media processing (FastStream/MediaBunny) requires a dedicated worker context.",
      });
      console.log("Offscreen document created, waiting for ready signal...");
    } catch (error) {
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
      console.error("❌ Failed to create offscreen document:", error);
      reject(error);
    }
  });
}

// Close offscreen document
async function closeOffscreenDocument() {
  if (!offscreenCreated) return;

  try {
    await chrome.offscreen.closeDocument();
    offscreenCreated = false;
    console.log("✅ Offscreen document closed");
  } catch (error) {
    console.warn("⚠️ Error closing offscreen document:", error);
  }
}

// Convert blob to base64 for message passing
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(result.split(",")[1]); // Remove data:mime;base64, prefix
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Convert base64 to blob
function base64ToBlob(base64, mimeType) {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

// Browser-compatible UUID generator
const uuidv4 = () => {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0,
      v = c == "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

const parseAttributeList = (attributeString = "") => {
  const attributes = {};
  const regex = /([A-Z0-9\-]+)=([^,]*)/gi;
  let match;

  while ((match = regex.exec(attributeString)) !== null) {
    const key = match[1];
    let value = match[2] ? match[2].trim() : "";

    if (value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1);
    }

    attributes[key.toUpperCase()] = value;
  }

  return attributes;
};

const inferSegmentMimeType = (uri = "", isAudio = false) => {
  const lower = uri.toLowerCase();

  if (lower.includes(".m4s") || lower.includes(".mp4") || lower.includes(".ismv")) {
    return isAudio ? "audio/mp4" : "video/mp4";
  }

  if (lower.includes(".webm")) {
    return isAudio ? "audio/webm" : "video/webm";
  }

  if (lower.includes(".aac")) {
    return "audio/aac";
  }

  if (lower.includes(".mp3")) {
    return "audio/mpeg";
  }

  if (lower.includes(".ts") || lower.includes(".m2ts")) {
    return isAudio ? "audio/mp2t" : "video/mp2t";
  }

  return isAudio ? "audio/mp2t" : "video/mp2t";
};

const extractCodecInfo = (codecsString = "") => {
  const codecs = (Array.isArray(codecsString)
    ? codecsString
    : codecsString
        .split(/[,\s]+/)
        .map((part) => part.replace(/"/g, "").trim())
        .filter(Boolean)) || [];

  let videoCodec = null;
  let audioCodec = null;

  codecs.forEach((codec) => {
    const lower = codec.toLowerCase();
    if (
      !videoCodec &&
      (lower.startsWith("avc") ||
        lower.startsWith("hvc") ||
        lower.startsWith("hev1") ||
        lower.startsWith("vp09") ||
        lower.startsWith("av01"))
    ) {
      videoCodec = codec;
    } else if (
      !audioCodec &&
      (lower.includes("mp4a") ||
        lower.startsWith("ac-3") ||
        lower.startsWith("ec-3") ||
        lower.startsWith("opus") ||
        lower.startsWith("vorbis"))
    ) {
      audioCodec = codec;
    }
  });

  return { videoCodec, audioCodec };
};

const selectBestVariant = (variants = []) => {
  if (!Array.isArray(variants) || variants.length === 0) {
    return null;
  }

  return variants.reduce((best, current) => {
    if (!best) return current;

    const bestBandwidth = parseInt(best.bandwidth || best.BANDWIDTH || "0", 10) || 0;
    const currentBandwidth =
      parseInt(current.bandwidth || current.BANDWIDTH || "0", 10) || 0;

    if (currentBandwidth !== bestBandwidth) {
      return currentBandwidth > bestBandwidth ? current : best;
    }

    const parseResolution = (resolution) => {
      if (!resolution) return 0;
      const [width, height] = resolution
        .toString()
        .toLowerCase()
        .split("x")
        .map((value) => parseInt(value, 10));
      return width && height ? width * height : 0;
    };

    const bestPixels = parseResolution(best.resolution || best.RESOLUTION);
    const currentPixels = parseResolution(
      current.resolution || current.RESOLUTION
    );

    if (currentPixels !== bestPixels) {
      return currentPixels > bestPixels ? current : best;
    }

    return current;
  }, null);
};

const selectPreferredAudioTrack = (tracks = []) => {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return null;
  }

  const defaultTrack = tracks.find(
    (track) => track.isDefault === true || track.default === true
  );
  if (defaultTrack) {
    return defaultTrack;
  }

  const autoTrack = tracks.find(
    (track) => track.isAutoSelect === true || track.autoselect === true
  );
  if (autoTrack) {
    return autoTrack;
  }

  return tracks[0];
};

// Simple HLS parser implementation for browser with duration/support metadata
const parseM3U8 = (content) => {
  // Log full manifest to aid debugging (no truncation)
  try {
    console.log(`🔍 Parsing M3U8 content (${content.length} chars):\n` + content);
  } catch (_) {
    console.log("🔍 Parsing M3U8 content (logging failed, showing first 2k chars):", content.substring(0, 2000));
  }

  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const isMasterPlaylist = content.includes("#EXT-X-STREAM-INF");
  const result = {
    isMasterPlaylist,
    variants: [],
    segments: [],
    audioTracks: [],
    targetDuration: null,
    mediaSequence: 0,
    discontinuitySequence: 0,
    totalDuration: 0,
    initializationSegment: null,
    initializationByteRange: null,
    segmentMimeType: null,
  };

  let currentDiscontinuitySequence = 0;
  let pendingDuration = null;
  let pendingTitle = null;
  let pendingByteRange = null;
  let awaitingSegmentUri = false;
  let segmentIndex = 0;
  let mediaSequenceSet = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("#EXTM3U")) {
      continue;
    }

    if (line.startsWith("#EXT-X-TARGETDURATION")) {
      const value = parseFloat(line.split(":")[1] || "");
      if (!Number.isNaN(value)) {
        result.targetDuration = value;
      }
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
      const value = parseInt(line.split(":")[1] || "", 10);
      if (!Number.isNaN(value)) {
        result.mediaSequence = value;
        mediaSequenceSet = true;
      }
      continue;
    }

    if (line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE")) {
      const value = parseInt(line.split(":")[1] || "", 10);
      if (!Number.isNaN(value)) {
        result.discontinuitySequence = value;
        currentDiscontinuitySequence = value;
      }
      continue;
    }

    if (line.startsWith("#EXT-X-DISCONTINUITY")) {
      currentDiscontinuitySequence += 1;
      continue;
    }

    if (line.startsWith("#EXT-X-MAP")) {
      const attributes = parseAttributeList(line.split(":")[1] || "");
      if (attributes.URI) {
        result.initializationSegment = attributes.URI;
        result.segmentMimeType = inferSegmentMimeType(attributes.URI);
      }
      if (attributes.BYTERANGE) {
        result.initializationByteRange = attributes.BYTERANGE;
      }
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE")) {
      pendingByteRange = line.split(":")[1]?.trim() || null;
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA")) {
      const attributes = parseAttributeList(line.split(":")[1] || "");
      const type = attributes.TYPE || attributes["TYPE"];
      if (type && type.toUpperCase() === "AUDIO" && attributes.URI) {
        const audioTrack = {
          uri: attributes.URI,
          groupId: attributes["GROUP-ID"] || null,
          name: attributes.NAME || null,
          language: attributes.LANGUAGE || null,
          characteristics: attributes.CHARACTERISTICS || null,
          isDefault: (attributes.DEFAULT || "NO").toUpperCase() === "YES",
          isAutoSelect: (attributes.AUTOSELECT || "NO").toUpperCase() === "YES",
          codecs: attributes.CODECS || null,
        };
        result.audioTracks.push(audioTrack);
        console.log("🎵 Found audio track:", audioTrack);
      }
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attributes = parseAttributeList(line.split(":")[1] || "");
      let uriLine = null;
      let j = i + 1;
      while (j < lines.length) {
        if (!lines[j].startsWith("#")) {
          uriLine = lines[j];
          break;
        }
        j++;
      }

      if (uriLine) {
        const variant = {
          uri: uriLine,
          bandwidth: attributes.BANDWIDTH || null,
          averageBandwidth: attributes["AVERAGE-BANDWIDTH"] || null,
          codecs: attributes.CODECS || null,
          resolution: attributes.RESOLUTION || null,
          frameRate: attributes["FRAME-RATE"] || null,
          audioGroup: attributes.AUDIO || null,
        };
        result.variants.push(variant);
        console.log("🎬 Found variant:", variant);
        i = j;
        continue;
      }
    }

    if (line.startsWith("#EXTINF")) {
      const durationMatch = line.match(/#EXTINF:([\d.]+)/);
      pendingDuration = durationMatch ? parseFloat(durationMatch[1]) : null;
      if (Number.isNaN(pendingDuration)) {
        pendingDuration = null;
      }

      const commaIndex = line.indexOf(",");
      pendingTitle = commaIndex >= 0 ? line.substring(commaIndex + 1).trim() : null;
      awaitingSegmentUri = true;
      continue;
    }

    if (!line.startsWith("#") && awaitingSegmentUri) {
      const duration = pendingDuration ?? 0;
      const title = pendingTitle;
      const byteRange = pendingByteRange;
      const sequenceNumber =
        (mediaSequenceSet ? result.mediaSequence : 0) + segmentIndex;
      const segment = {
        uri: line,
        duration,
        title,
        byteRange,
        discontinuitySequence: currentDiscontinuitySequence,
        sequenceNumber,
      };

      if (!result.segmentMimeType) {
        result.segmentMimeType = inferSegmentMimeType(line);
      }

      result.segments.push(segment);
      segmentIndex += 1;

      pendingDuration = null;
      pendingTitle = null;
      pendingByteRange = null;
      awaitingSegmentUri = false;
      continue;
    }
  }

  result.totalDuration = result.segments.reduce(
    (sum, segment) => sum + (segment.duration || 0),
    0
  );

  console.log("✅ Parsed M3U8:", {
    isMasterPlaylist: result.isMasterPlaylist,
    variantCount: result.variants.length,
    segmentCount: result.segments.length,
    audioTrackCount: result.audioTracks.length,
    totalDuration: result.totalDuration,
    mediaSequence: result.mediaSequence,
    discontinuitySequence: result.discontinuitySequence,
    segmentMimeType: result.segmentMimeType,
  });

  return result;
};

// Enhanced regex-based XML parser for DASH manifests
const parseXML = (xmlString) => {
  console.log("🔍 Parsing XML content:", xmlString.substring(0, 200) + "...");

  const adaptationSetRegex =
    /<AdaptationSet[^>]*?contentType="(audio|video)"[^>]*?>(.*?)<\/AdaptationSet>/gs;
  const matches = [...xmlString.matchAll(adaptationSetRegex)];

  const adaptationSets = matches.map((match) => {
    const contentType = match[1];
    const content = match[2];

    const representationRegex =
      /<Representation[^>]*?bandwidth="(\d+)"[^>]*?>(.*?)<\/Representation>/gs;
    const repMatches = [...content.matchAll(representationRegex)];

    const representations = repMatches.map((repMatch) => ({
      bandwidth: parseInt(repMatch[1], 10),
      innerHTML: repMatch[2],
    }));

    // Sort representations by bandwidth, descending
    representations.sort((a, b) => b.bandwidth - a.bandwidth);

    return {
      getAttribute: (attr) => (attr === "contentType" ? contentType : null),
      representations: representations,
    };
  });

  const audioAdaptationSet = adaptationSets.find(
    (s) => s.getAttribute("contentType") === "audio"
  );
  const videoAdaptationSet = adaptationSets.find(
    (s) => s.getAttribute("contentType") === "video"
  );

  console.log(
    "✅ Parsed XML - Audio sets:",
    !!audioAdaptationSet,
    "Video sets:",
    !!videoAdaptationSet
  );

  return {
    MPD: {
      Period: [
        {
          AdaptationSet: [audioAdaptationSet, videoAdaptationSet].filter(
            Boolean
          ),
        },
      ],
    },
  };
};

const GRAPHQL_QUERIES = {
  GetVideoSSR: `
        query GetVideoSSR($videoId: ID!, $password: String) {
          getVideo(id: $videoId, password: $password) {
            __typename
            ... on PrivateVideo {
              id
              status
              message
              __typename
            }
            ... on VideoPasswordMissingOrIncorrect {
              id
              message
              __typename
            }
            ... on RegularUserVideo {
              id
              __typename
              createdAt
              description
              download_enabled
              folder_id
              is_protected
              needs_password
              owner {
                display_name
                __typename
              }
              privacy
              s3_id
              name
              video_properties {
                duration
                height
                width
              }
            }
          }
        }\n`,
};

const APOLLO_GRAPHQL_VERSION = "0a1856c";

async function callGraphqlApi(operations, videoId, password) {
  console.log("🔍 callGraphqlApi called with:", {
    operations,
    videoId,
    password: password ? "***" : null,
  });

  const body = JSON.stringify(
    operations.map((operationName) => ({
      operationName,
      variables: {
        videoId,
        password,
      },
      query: GRAPHQL_QUERIES[operationName],
    }))
  );

  console.log("📤 GraphQL request body:", body);

  try {
    console.log("🌐 Making fetch request to Loom GraphQL...");
    const response = await fetch("https://www.loom.com/graphql", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://www.loom.com/",
        Origin: "https://www.loom.com",
        "x-loom-request-source": `loom_web_${APOLLO_GRAPHQL_VERSION}`,
        "apollographql-client-name": "web",
        "apollographql-client-version": APOLLO_GRAPHQL_VERSION,
      },
      body,
    });

    console.log(
      "📥 GraphQL response status:",
      response.status,
      response.statusText
    );

    if (!response.ok) {
      throw new Error(
        `GraphQL request failed: ${response.status} ${response.statusText}`
      );
    }

    const jsonResponse = await response.json();
    console.log("✅ GraphQL response data:", jsonResponse);
    return jsonResponse;
  } catch (error) {
    console.error("❌ GraphQL request error:", error);
    throw error;
  }
}

async function callUrlApi(endpoint, videoId, password) {
  console.log(`🔍 callUrlApi called with:`, {
    endpoint,
    videoId,
    password: password ? "***" : null,
  });

  try {
    const requestBody = {
      anonID: uuidv4(),
      deviceID: null,
      force_original: false,
      password: password,
    };
    console.log(`📤 ${endpoint} request body:`, requestBody);

    const response = await fetch(
      `https://www.loom.com/api/campaigns/sessions/${videoId}/${endpoint}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://www.loom.com/",
          Origin: "https://www.loom.com",
        },
        body: JSON.stringify(requestBody),
      }
    );

    console.log(
      `📥 ${endpoint} response status:`,
      response.status,
      response.statusText
    );

    if (response.status === 204) {
      console.log(`✅ ${endpoint} returned no content, as expected.`);
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `${endpoint} request failed: ${response.status} ${response.statusText}`
      );
    }

    const json = await response.json();
    console.log(`✅ ${endpoint} response:`, json);
    return json.url;
  } catch (error) {
    console.error(`❌ ${endpoint} request error:`, error);
    throw error;
  }
}

// Browser-compatible download function
async function downloadFile(url, fileName, options = {}) {
  const { utils = null, abortSignal = null, queueDownloadId = null } = options || {};
  const sendPopup = (p, s, sp='') => {
    try { utils?.sendProgressUpdate ? utils.sendProgressUpdate(p, s, sp) : sendProgressToPopup(p, s, sp); } catch {}
  };
  const sendContent = (downloadId, filename, downloaded=0, total=0, progress=0, status='Downloading...', extra={}) => {
    try { utils?.sendProgressToContentScript ? utils.sendProgressToContentScript(filename, downloaded, total, progress, status, extra) : sendProgressToContentScript(downloadId, filename, downloaded, total, progress, status, extra); } catch {}
  };
  const sendComplete = (m) => { try { utils?.sendDownloadComplete ? utils.sendDownloadComplete(m) : sendDownloadComplete(m); } catch {} };
  const sendErrorMsg = (m) => { try { utils?.sendDownloadError ? utils.sendDownloadError(m) : sendDownloadError(m); } catch {} };
  console.log(`🔽 Starting direct download from: ${url}`);
  activeDownloads++;
  console.log(`📊 Active downloads: ${activeDownloads}`);
  
  sendPopup(10, "Starting download...");
  try { await sendDownloadManagerMessage({ action: 'openDownloadManager' }); } catch {}

  try {
    // First, try to download directly from the URL using Chrome's download API
    // This is the most memory-efficient approach
    try {
      sendPopup(25, "Initiating file download...");
      
      chrome.downloads.download(
        {
          url: url,
          filename: fileName,
          saveAs: true,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            throw new Error(chrome.runtime.lastError.message);
          }
          console.log(
            `✅ Direct download initiated for: ${fileName} (ID: ${downloadId})`
          );
          const uiId = String(queueDownloadId || downloadId);
          try { __dmCurrentId = uiId; __dmCurrentName = fileName || 'Video'; } catch {}
          try { if (queueDownloadId) downloadTaskRegistry.attachChromeDownload(String(queueDownloadId), downloadId); } catch {}
          // Show an initial entry at 100% while Save As dialog is open
          sendContent(uiId, fileName, 0, 0, 100, 'Waiting for Save As...', { awaitingUserInteraction: true });
          
          // Track download progress
          const progressInterval = setInterval(() => {
            const key = String(queueDownloadId || downloadId);
            if ((abortSignal && abortSignal.aborted) || __dmCancelledIds.has(key)) {
              clearInterval(progressInterval);
              try {
                chrome.downloads.cancel(downloadId, () => {});
                sendContent(key, fileName, 0, 0, 0, 'Cancelled', { awaitingUserInteraction: false });
              } catch {}
              return;
            }
            
            chrome.downloads.search({ id: downloadId }, (downloads) => {
              if (downloads.length > 0) {
                const download = downloads[0];
                if (download.state === 'complete') {
                  clearInterval(progressInterval);
                  activeDownloads--;
                  console.log(`📊 Active downloads: ${activeDownloads}`);
                  sendComplete("Download completed!");
                  sendContent(key, fileName, download.totalBytes || 0, download.totalBytes || 0, 100, 'Completed', { awaitingUserInteraction: false });
                } else if (download.state === 'interrupted') {
                  clearInterval(progressInterval);
                  activeDownloads--;
                  console.log(`📊 Active downloads: ${activeDownloads}`);
                  sendErrorMsg("Download was interrupted");
                  sendContent(key, fileName, download.bytesReceived || 0, download.totalBytes || 0, 0, `Interrupted: ${download.error || 'Error'}`, { awaitingUserInteraction: false });
                } else if (download.totalBytes > 0) {
                  const bytesReceived = download.bytesReceived || 0;
                  const totalBytes = download.totalBytes || 0;
                  const progress = (bytesReceived / totalBytes) * 100;
                  const speed = `${(bytesReceived / 1024 / 1024).toFixed(1)} MB`;
                  sendPopup(Math.min(95, progress), "Downloading...", speed);
                  // Awaiting if still at 0 bytes (save prompt), otherwise normal
                  const awaiting = bytesReceived === 0;
                  const status = awaiting ? 'Waiting for Save As...' : 'Downloading...';
                  const pct = awaiting ? 100 : Math.min(100, progress);
                  sendContent(key, fileName, bytesReceived, totalBytes, pct, status, { awaitingUserInteraction: awaiting });
                }
              }
            });
          }, 1000);
        }
      );
      return;
    } catch (directDownloadError) {
      console.warn(
        "⚠️ Direct download failed, trying blob approach:",
        directDownloadError
      );
    }

    // Fallback: If direct download fails (e.g., CORS issues), use blob approach
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Download failed: ${response.status} ${response.statusText}`
      );
    }

    const blob = await response.blob();
    const blobSize = blob.size;
    console.log(`📊 Blob size: ${(blobSize / 1024 / 1024).toFixed(2)} MB`);

    // For all files, use data URL approach (blob URLs not available in service workers)
    if (blobSize > 100 * 1024 * 1024) {
      console.warn(
        "⚠️ Large file detected:",
        (blobSize / 1024 / 1024).toFixed(2),
        "MB - processing may take time"
      );
    }

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = (error) => {
        console.error("❌ FileReader error:", error);
        reject(new Error("Failed to read blob: " + error));
      };
      reader.readAsDataURL(blob);
    });

    chrome.downloads.download({
      url: dataUrl,
      filename: fileName,
      saveAs: true,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("❌ Blob download failed:", chrome.runtime.lastError.message);
        activeDownloads--;
        console.log(`📊 Active downloads: ${activeDownloads}`);
        return;
      }
      console.log(`✅ Blob download initiated for: ${fileName} (ID: ${downloadId})`);
      try { if (queueDownloadId) downloadTaskRegistry.attachChromeDownload(String(queueDownloadId), downloadId); } catch {}
      
      // Track blob download progress  
      const progressInterval = setInterval(() => {
        if ((abortSignal && abortSignal.aborted)) {
          clearInterval(progressInterval);
          return;
        }
        
        chrome.downloads.search({ id: downloadId }, (downloads) => {
          if (downloads.length > 0) {
            const download = downloads[0];
            if (download.state === 'complete') {
              clearInterval(progressInterval);
              activeDownloads--;
              console.log(`📊 Active downloads: ${activeDownloads}`);
              sendComplete("Download completed!");
            } else if (download.state === 'interrupted') {
              clearInterval(progressInterval);
              activeDownloads--;
              console.log(`📊 Active downloads: ${activeDownloads}`);
              sendErrorMsg("Download was interrupted");
            }
          }
        });
      }, 1000);
    });
  } catch (error) {
    console.error("❌ Download failed:", error);
    activeDownloads--;
    console.log(`📊 Active downloads: ${activeDownloads}`);
    throw error;
  }
}

async function downloadHLSSegments(segments, fileName, options = {}) {
  const { utils = null, abortSignal = null, queueDownloadId = null } = options || {};
  const isCancelled = () => !!(abortSignal && abortSignal.aborted);
  const sendPopup = (p, s, sp='') => { try { utils?.sendProgressUpdate ? utils.sendProgressUpdate(p, s, sp) : sendProgressToPopup(p, s, sp); } catch {} };
  const sendContent = (downloadId, filename, downloaded=0, total=0, progress=0, status='Downloading...', extra={}) => {
    try { utils?.sendProgressToContentScript ? utils.sendProgressToContentScript(filename, downloaded, total, progress, status, extra) : sendProgressToContentScript(downloadId, filename, downloaded, total, progress, status, extra); } catch {}
  };
  console.log(`🔽 Downloading ${segments.length} HLS segments with memory optimization`);
  activeDownloads++;
  console.log(`📊 Active downloads: ${activeDownloads}`);
  
  sendPopup(30, "Downloading video segments...");
  try { await sendDownloadManagerMessage({ action: 'openDownloadManager' }); } catch {}
  
  const requestId = uuidv4();
  const dmId = `hls_${requestId}`;
  const uiId = String(queueDownloadId || dmId);
  try { __dmCurrentId = uiId; __dmCurrentName = fileName || 'Video'; } catch {}
  try { sendContent(uiId, __dmCurrentName, 0, 0, 10, 'Preparing HLS download...'); } catch {}
  const segmentsKey = `segments_${requestId}`;
  let storedSegmentKeys = [];
  
  // Check for cancellation
  if (isCancelled()) {
    console.log("❌ Download cancelled during HLS segment preparation");
    activeDownloads--;
    throw new Error("Download cancelled");
  }

  try {
    console.log(
      "📦 HLS video detected - downloading segments with memory optimization"
    );

    // Create offscreen document first
    await createOffscreenDocument();

    // Smaller batch size to reduce memory pressure
    const BATCH_SIZE = 25;
    
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      // Check for cancellation before each batch
      if (isCancelled()) {
        console.log("❌ Download cancelled during segment download");
        throw new Error("Download cancelled");
      }
      
      const batch = segments.slice(i, i + BATCH_SIZE);
      const segmentPromises = batch.map(async (segment, index) => {
        const segmentNumber = i + index;
        try {
          const response = await fetch(segment.uri);
          if (!response.ok) {
            throw new Error(
              `Segment ${segmentNumber + 1} download failed: ${response.status}`
            );
          }
          return {
            key: `${segmentsKey}_${segmentNumber}`,
            data: await response.arrayBuffer(),
          };
        } catch (error) {
          console.error(`❌ Failed to download segment ${segmentNumber + 1}:`, error);
          return null;
        }
      });
      
      const batchData = await Promise.all(segmentPromises);
      
      // Store valid segments and track keys for cleanup
      for (const item of batchData) {
        if (item) {
          await set(item.key, item.data);
          storedSegmentKeys.push(item.key);
        }
      }
      
      // Clear batch data from memory immediately
      batchData.length = 0;
      
      // Force garbage collection if available
      if (typeof globalThis !== "undefined" && globalThis.gc) {
        globalThis.gc();
      }
      
      // Update progress
      const progress = 30 + ((i + batch.length) / segments.length) * 40; // 30-70% for download
      sendPopup(progress, `Downloaded ${i + batch.length}/${segments.length} segments`);
      try { sendContent(uiId, __dmCurrentName, 0, 0, Math.min(95, progress), 'Downloading segments...'); } catch {}
      
      console.log(
        `📦 Downloaded and stored segments ${i + 1} to ${i + batch.length} of ${
          segments.length
        }`
      );
      
      // Small delay to prevent overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    
    console.log(
      `✅ All ${storedSegmentKeys.length}/${segments.length} segments downloaded and stored in IndexedDB`
    );
    
    sendPopup(75, "Processing and merging segments...");
    try { sendContent(uiId, __dmCurrentName, 0, 0, 90, 'Merging segments...'); } catch {}

    // Create a promise that will be resolved when we receive the response
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(responseListener);
        reject(new Error("Offscreen processing timeout"));
      }, 300000); // 5 minutes

      // Set up listener for response
      const responseListener = (message) => {
        if (
          message.type === "MERGE_SEGMENTS_RESPONSE" &&
          message.requestId === requestId
        ) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(responseListener);
          if (message.success) {
            resolve(message);
          } else {
            reject(
              new Error(message.error?.message || "Offscreen processing failed")
            );
          }
        }
      };

      chrome.runtime.onMessage.addListener(responseListener);

      // Send message without callback to avoid the error
      // Register offscreen merge request for cancellation support
      try { registerOffscreenRequest(queueDownloadId || dmId, requestId); } catch (_) {}
      chrome.runtime.sendMessage({
        type: "MERGE_SEGMENTS",
        requestId,
        segmentsKey,
        fileName,
        totalSegments: storedSegmentKeys.length,
      });
    });

    if (response && response.success) {
      console.log("✅ Offscreen processing completed");
      const { downloadInitiated } = response;

      if (!downloadInitiated) {
        console.error("❌ Download was not initiated by offscreen document");
        throw new Error("Download failed to initiate");
      }

      console.log("✅ Download initiated by offscreen document");
      // Use the same id channel as earlier updates (queue id via utils when available)
      try { sendContent(uiId, __dmCurrentName, 0, 0, 100, 'Completed'); } catch {}
    } else {
      throw new Error("Offscreen processing failed");
    }

    console.log(`✅ Merged HLS download completed: ${fileName}`);
  } catch (error) {
    console.error("❌ HLS segment download failed:", error);
    throw error;
  } finally {
    try { clearOffscreenRequest(queueDownloadId || dmId, requestId); } catch (_) {}
    // Cleanup stored segments from IndexedDB
    console.log("🧹 Cleaning up stored HLS segments...");
    const cleanupTasks = storedSegmentKeys.map(key => 
      remove(key).catch(error => 
        console.warn(`⚠️ Failed to remove segment key ${key}:`, error)
      )
    );
    
    await Promise.all(cleanupTasks);
    console.log("✅ HLS segments cleanup completed");
    
    activeDownloads--;
    console.log(`📊 Active downloads: ${activeDownloads}`);
  }
}

async function downloadHLSSegmentsWithSeparateAV(
  audioSegments,
  videoSegments,
  fileName,
  totalDuration = null,
  manifestContent = null,
  isEmbedSplit = false,
  extraOptions = {},
  options = {}
) {
  console.log(
    `🔽 Downloading separate A/V HLS segments - Audio: ${audioSegments.length}, Video: ${videoSegments.length}`
  );

  activeDownloads++;
  console.log(`📊 Active downloads: ${activeDownloads}`);
  try { await sendDownloadManagerMessage({ action: 'openDownloadManager' }); } catch {}
  const { utils = null, abortSignal = null, queueDownloadId = null } = options || {};
  const isCancelled = () => !!(abortSignal && abortSignal.aborted);
  const sendPopup = (p, s, sp='') => { try { utils?.sendProgressUpdate ? utils.sendProgressUpdate(p, s, sp) : sendProgressToPopup(p, s, sp); } catch {} };
  const sendContent = (id, fn, downloaded=0, total=0, progress=0, status='Downloading...', extra={}) => {
    try { utils?.sendProgressToContentScript ? utils.sendProgressToContentScript(fn, downloaded, total, progress, status, extra) : sendProgressToContentScript(id, fn, downloaded, total, progress, status, extra); } catch {}
  };
  sendPopup(30, "Downloading audio/video segments...");
  const dmId = `hlsav_${uuidv4()}`;
  const uiId2 = String(queueDownloadId || dmId);
  try { __dmCurrentId = uiId2; __dmCurrentName = fileName || 'Video'; } catch {}
  try { sendContent(uiId2, __dmCurrentName, 0, 0, 10, 'Preparing HLS A/V download...'); } catch {}

  const requestId = uuidv4();
  const segmentsKey = `separate_av_${requestId}`;
  const storedKeys = [];
  const {
    streamFormat = null,
    videoCodec = null,
    audioCodec = null,
  } = extraOptions || {};

  console.log("🕒 A/V merge request durations:", {
    providedTotalDuration: totalDuration,
    streamFormat,
    videoCodec,
    audioCodec,
  });

  if (isCancelled()) {
    console.log("❌ Download cancelled before starting A/V segment download");
    activeDownloads--;
    throw new Error("Download cancelled");
  }

  try {
    await ensureOffscreenReady();

    const BATCH_SIZE = 20;

    const storeSegments = async (segments, offset, type) => {
      for (let i = 0; i < segments.length; i += BATCH_SIZE) {
        if (isCancelled()) {
          console.log(`❌ Download cancelled during ${type} segment download`);
          throw new Error("Download cancelled");
        }

        const batch = segments.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (segment, index) => {
          const globalIndex = offset + i + index;
          try {
            const response = await fetch(segment.uri);
            if (!response.ok) {
              throw new Error(
                `${type} segment ${globalIndex + 1} download failed: ${response.status}`
              );
            }

            const arrayBuffer = await response.arrayBuffer();

            const explicitInit =
              segment?.isInitSegment === true || segment?.isInit === true;
            const hasInitMetadata =
              Object.prototype.hasOwnProperty.call(segment || {}, "isInitSegment") ||
              Object.prototype.hasOwnProperty.call(segment || {}, "isInit");
            const fallbackInit = hasInitMetadata
              ? false
              : type === "video"
              ? globalIndex === 0
              : globalIndex === videoSegments.length;
            const isInitSegment = explicitInit || fallbackInit;

            const mimeType =
              segment?.mimeType ||
              inferSegmentMimeType(segment?.uri || "", type === "audio");

            const sequenceNumber =
              typeof segment?.sequenceNumber === "number"
                ? segment.sequenceNumber
                : globalIndex;

            const discontinuitySequence =
              typeof segment?.discontinuitySequence === "number"
                ? segment.discontinuitySequence
                : 0;

            if (segment?.duration) {
              console.log(
                `🕒 ${type.toUpperCase()} segment duration (s):`,
                segment.duration,
                "URI:",
                segment.uri
              );
            }

            return {
              key: `${segmentsKey}_${globalIndex}`,
              payload: {
                data: arrayBuffer,
                segmentType: type,
                segmentIndex: globalIndex,
                isInitSegment,
                isInit: isInitSegment,
                mimeType,
                sequenceNumber,
                discontinuitySequence,
                duration: segment?.duration || null,
              },
            };
          } catch (error) {
            console.error(
              `❌ Failed to download ${type} segment ${globalIndex + 1}:`,
              error
            );
            return null;
          }
        });

        const batchData = await Promise.all(batchPromises);

        for (const item of batchData) {
          if (item) {
            await set(item.key, item.payload);
            storedKeys.push(item.key);
          }
        }

        batchData.length = 0;

        if (typeof globalThis !== "undefined" && globalThis.gc) {
          globalThis.gc();
        }

        const processed = offset + Math.min(i + batch.length, segments.length);
        const total = videoSegments.length + audioSegments.length;
        const progress = 30 + (processed / total) * 40;
        sendPopup(progress, `Downloaded ${processed}/${total} ${type} segments`);
        try { sendContent(uiId2, __dmCurrentName, 0, 0, Math.min(95, progress), `Downloading ${type} segments...`); } catch {}

        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    };

    await storeSegments(videoSegments, 0, "video");
    await storeSegments(audioSegments, videoSegments.length, "audio");

    console.log(
      `✅ Stored ${storedKeys.length} segments (video: ${videoSegments.length}, audio: ${audioSegments.length})`
    );

    console.log("🕒 Stored segment metadata snapshot:", {
      firstVideo: videoSegments.length ? videoSegments[0] : null,
      lastVideo: videoSegments.length
        ? videoSegments[videoSegments.length - 1]
        : null,
      firstAudio: audioSegments.length ? audioSegments[0] : null,
      lastAudio: audioSegments.length
        ? audioSegments[audioSegments.length - 1]
        : null,
    });

    sendPopup(75, "Merging audio and video streams...");
    try { sendContent(uiId2, __dmCurrentName, 0, 0, 90, 'Merging segments...'); } catch {}

    const response = await new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(responseListener);
        reject(new Error("Offscreen processing timeout"));
      }, 300000);

      const responseListener = (message) => {
        if (
          message.type === "MERGE_SEPARATE_AV_RESPONSE" &&
          message.requestId === requestId
        ) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(responseListener);
          if (message.success) {
            resolve(message);
          } else {
            reject(
              new Error(message.error?.message || "Separate A/V merge failed")
            );
          }
        }
      };

      chrome.runtime.onMessage.addListener(responseListener);

      const sendOnce = async () => {
        try {
          // Register offscreen merge request for cancellation support
          try { registerOffscreenRequest(queueDownloadId || dmId, requestId); } catch (_) {}
          await chrome.runtime.sendMessage({
            type: "MERGE_SEPARATE_AV",
            requestId,
            segmentsKey,
            fileName,
            totalSegments: storedKeys.length,
            videoCount: videoSegments.length,
            audioCount: audioSegments.length,
            totalDuration,
            isDashStream: false,
            manifestContent,
            isEmbedSplit,
            streamFormat,
            videoCodec,
            audioCodec,
          });
        } catch (err) {
          console.warn("⚠️ Failed to send MERGE_SEPARATE_AV to offscreen:", err);
          // Try to recover by ensuring offscreen ready, then resend
          const ok = await ensureOffscreenReady();
          if (!ok) throw err;
          await chrome.runtime.sendMessage({
            type: "MERGE_SEPARATE_AV",
            requestId,
            segmentsKey,
            fileName,
            totalSegments: storedKeys.length,
            videoCount: videoSegments.length,
            audioCount: audioSegments.length,
            totalDuration,
            isDashStream: false,
            manifestContent,
            isEmbedSplit,
            streamFormat,
            videoCodec,
            audioCodec,
          });
        }
      };

      await sendOnce();
    });

    if (!response?.success || !response.downloadInitiated) {
      throw new Error("Separate A/V merge did not initiate download");
    }

    console.log("✅ FastStream A/V processing completed successfully");
    sendPopup(100, "Download ready!");
    try { sendContent(uiId2, __dmCurrentName, 0, 0, 100, 'Completed'); } catch {}
  } catch (error) {
    console.error("❌ Separate A/V HLS download failed:", error);
    throw error;
  } finally {
    try { clearOffscreenRequest(queueDownloadId || dmId, requestId); } catch (_) {}
    console.log("🧹 Cleaning up stored A/V segments...");
    await Promise.all(
      storedKeys.map((key) =>
        remove(key).catch((cleanupError) =>
          console.warn(`⚠️ Failed to remove segment key ${key}:`, cleanupError)
        )
      )
    );
    console.log("✅ A/V segment cleanup completed");

    activeDownloads--;
    console.log(`📊 Active downloads: ${activeDownloads}`);
  }
}

// Enhanced offscreen muxer with proper error handling and cleanup
async function mergeAudioVideo(audioBlob, videoBlob, fileName, isEmbedSplit = false) {
  console.log("🔧 Attempting offscreen media merge via offscreen document...");
  const requestId = uuidv4();
  const audioKey = `audio_${requestId}`;
  const videoKey = `video_${requestId}`;
  const mergedKey = `merged_${requestId}`;
  let audioStored = false;
  let videoStored = false;
  let mergedStored = false;

  try {
    console.log(`📊 Audio blob size: ${audioBlob ? audioBlob.size : 0} bytes`);
    console.log(`📊 Video blob size: ${videoBlob ? videoBlob.size : 0} bytes`);

    // Ensure offscreen document is created
    console.log("🔄 Creating offscreen document...");
    await createOffscreenDocument();
    console.log("✅ Offscreen document ready");

    console.log("💾 Storing blobs in IndexedDB...");
    if (audioBlob) {
      await set(audioKey, audioBlob);
      audioStored = true;
    }
    if (videoBlob) {
      await set(videoKey, videoBlob);
      videoStored = true;
    }
    console.log("✅ Blobs stored.");

    console.log("🔄 Sending merge request to offscreen document...");

    // Create a promise that will be resolved when we receive the response
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(responseListener);
        reject(new Error("Offscreen document did not respond within 5 minutes."));
      }, 300000); // 5 minutes timeout for large files and module loading

      // Set up listener for response
      const responseListener = (message) => {
        if (
          message.type === "MERGE_RESPONSE" &&
          message.requestId === requestId
        ) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(responseListener);
          console.log("📩 Received response from offscreen document:", message);
          if (message.success) {
            resolve(message);
          } else {
            reject(
              new Error(message.error?.message || "Offscreen merge failed")
            );
          }
        }
      };

      chrome.runtime.onMessage.addListener(responseListener);

      // Send message without callback to avoid the error
      chrome.runtime.sendMessage({
        type: "MERGE_AUDIO_VIDEO",
        requestId,
        audioKey: audioBlob ? audioKey : null,
        videoKey,
        mergedKey,
        isEmbedSplit,
      });
    });

    console.log("📩 Received response from offscreen document:", response);

    if (!response || !response.success) {
      let errorMsg =
        "Offscreen media merge failed - no response or failure response";
      if (response && response.error) {
        if (typeof response.error === "object") {
          errorMsg = `Offscreen document error: ${response.error.name} - ${response.error.message}`;
          console.error("Full error stack:", response.error.stack);
        } else {
          errorMsg = `Offscreen document error: ${response.error}`;
        }
      }
      console.error("❌ Offscreen merge failed:", errorMsg);
      throw new Error(errorMsg);
    }

    console.log("🔄 Retrieving merged blob from IndexedDB...");
    const mergedBlob = await get(mergedKey);
    if (!mergedBlob) {
      throw new Error("Merged data not found in storage.");
    }
    mergedStored = true;

    console.log(
      `✅ Offscreen media merge completed - Output size: ${mergedBlob.size} bytes`
    );

    // Download the merged blob with proper error handling
    console.log("📥 Downloading merged file from background script...");
    await new Promise((resolve, reject) => {
      const reader = new FileReader();
      const timeout = setTimeout(() => {
        reject(new Error("FileReader timeout after 60 seconds"));
      }, 60000);
      
      reader.onload = function () {
        clearTimeout(timeout);
        try {
          chrome.downloads.download({
            url: reader.result,
            filename: fileName,
            saveAs: true,
          });
          resolve();
        } catch (downloadError) {
          reject(new Error(`Download failed: ${downloadError.message}`));
        }
      };
      
      reader.onerror = function(error) {
        clearTimeout(timeout);
        reject(new Error(`FileReader error: ${error}`));
      };
      
      reader.readAsDataURL(mergedBlob);
    });

    return mergedBlob; // Still return for compatibility
  } catch (error) {
    console.error("❌ Offscreen media merge failed with error:", error);
    console.error("❌ Error details:", {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    throw error;
  } finally {
    // Comprehensive cleanup with individual error handling
    console.log("🧹 Cleaning up IndexedDB...");
    const cleanupTasks = [];
    
    if (audioStored) {
      cleanupTasks.push(
        remove(audioKey).catch(error => 
          console.warn(`⚠️ Failed to remove audio key ${audioKey}:`, error)
        )
      );
    }
    
    if (videoStored) {
      cleanupTasks.push(
        remove(videoKey).catch(error => 
          console.warn(`⚠️ Failed to remove video key ${videoKey}:`, error)
        )
      );
    }
    
    if (mergedStored) {
      cleanupTasks.push(
        remove(mergedKey).catch(error => 
          console.warn(`⚠️ Failed to remove merged key ${mergedKey}:`, error)
        )
      );
    }
    
    // Execute all cleanup tasks in parallel
    await Promise.all(cleanupTasks);
    console.log("✅ IndexedDB cleanup completed");
    
    // Force garbage collection if available
    if (typeof globalThis !== "undefined" && globalThis.gc) {
      globalThis.gc();
    }
  }
}

// Memory-optimized DASH segment download with incremental processing and proper cleanup
async function downloadDASHSegments(audioSegments, videoSegments, fileName, isEmbedSplit = false, options = {}) {
  console.log(
    `🔽 Downloading DASH segments with memory optimization - Audio: ${audioSegments.length}, Video: ${videoSegments.length}`
  );
  activeDownloads++;
  console.log(`📊 Active downloads: ${activeDownloads}`);
  try { await sendDownloadManagerMessage({ action: 'openDownloadManager' }); } catch {}
  const { utils = null, abortSignal = null, queueDownloadId = null } = options || {};
  const isCancelled = () => !!(abortSignal && abortSignal.aborted);
  const sendPopup = (p, s, sp='') => { try { utils?.sendProgressUpdate ? utils.sendProgressUpdate(p, s, sp) : sendProgressToPopup(p, s, sp); } catch {} };
  const sendContent = (id, fn, downloaded=0, total=0, progress=0, status='Downloading...', extra={}) => {
    try { utils?.sendProgressToContentScript ? utils.sendProgressToContentScript(fn, downloaded, total, progress, status, extra) : sendProgressToContentScript(id, fn, downloaded, total, progress, status, extra); } catch {}
  };
  const requestId = uuidv4();
  const dmId = `dash_${requestId}`;
  const uiId3 = String(queueDownloadId || dmId);
  try { __dmCurrentId = uiId3; __dmCurrentName = fileName || 'Video'; } catch {}
  try { sendContent(uiId3, __dmCurrentName, 0, 0, 5, 'Preparing DASH download...'); } catch {}
  const audioKey = `dash_audio_${requestId}`;
  const videoKey = `dash_video_${requestId}`;
  let audioStoredKeys = [];
  let videoStoredKeys = [];

  try {
    // Smaller batch size to reduce memory pressure
    const batchSize = 3;
    
    // Helper function to trigger garbage collection
    const forceGC = () => {
      if (typeof globalThis !== "undefined" && globalThis.gc) {
        globalThis.gc();
      }
    };

    // Incremental download with immediate storage to IndexedDB
    const downloadAndStoreSegments = async (segments, type, baseKey) => {
      const storedKeys = [];
      
      for (let i = 0; i < segments.length; i += batchSize) {
        // Check for cancellation before each batch
        if (isCancelled()) {
          console.log(`❌ Download cancelled during ${type} segment download`);
          throw new Error("Download cancelled");
        }
        
        const batch = segments.slice(i, i + batchSize);
        console.log(
          `🔄 Processing ${type} batch ${
            Math.floor(i / batchSize) + 1
          }/${Math.ceil(segments.length / batchSize)}`
        );

        // Download batch segments
        const batchPromises = batch.map(async (segment, batchIndex) => {
          const globalIndex = i + batchIndex;
          try {
            console.log(
              `📦 Downloading ${type} segment ${globalIndex + 1}/${
                segments.length
              }`
            );
            const response = await fetch(segment.uri);
            if (!response.ok) {
              throw new Error(
                `${type} segment ${globalIndex + 1} download failed: ${
                  response.status
                }`
              );
            }
            return await response.arrayBuffer();
          } catch (error) {
            console.error(
              `❌ Failed to download ${type} segment ${globalIndex + 1}:`,
              error
            );
            return null;
          }
        });

        const batchResults = await Promise.all(batchPromises);
        
        // Immediately store valid results to IndexedDB and track keys
        for (let j = 0; j < batchResults.length; j++) {
          const result = batchResults[j];
          if (result) {
            const segmentIndex = i + j;
            const segmentKey = `${baseKey}_${segmentIndex}`;
            await set(segmentKey, result);
            storedKeys.push(segmentKey);
            console.log(`💾 Stored ${type} segment ${segmentIndex} to IndexedDB`);
          }
        }
        
        // Clear batch results from memory immediately
        batchResults.length = 0;
        
        // Force garbage collection after each batch
        forceGC();
        
        // Update progress
        const progress = 30 + ((i + batch.length) / (audioSegments.length + videoSegments.length)) * 40;
        sendPopup(progress, `Downloaded ${i + batch.length}/${segments.length} ${type} segments`);
        try { sendContent(uiId3, __dmCurrentName, 0, 0, Math.min(95, progress), `Downloading ${type} segments...`); } catch {}

        console.log(
          `✅ ${type} batch ${Math.floor(i / batchSize) + 1} completed and stored`
        );
        
        // Small delay to prevent overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      return storedKeys;
    };

    // Download and store segments incrementally
    console.log("📦 Starting incremental download and storage...");
    
    if (audioSegments.length > 0) {
      audioStoredKeys = await downloadAndStoreSegments(audioSegments, "audio", audioKey);
    }
    
    if (videoSegments.length > 0) {
      videoStoredKeys = await downloadAndStoreSegments(videoSegments, "video", videoKey);
    }

    const failedAudioCount = audioSegments.length - audioStoredKeys.length;
    const failedVideoCount = videoSegments.length - videoStoredKeys.length;

    if (failedAudioCount > 0 || failedVideoCount > 0) {
      console.warn(
        `⚠️ Download incomplete. Failed segments - Audio: ${failedAudioCount}, Video: ${failedVideoCount}`
      );
    }

    console.log(`✅ All DASH segments downloaded and stored incrementally`);
    sendPopup(75, "Processing and merging segments...");
    try { sendContent(uiId3, __dmCurrentName, 0, 0, 90, 'Merging segments...'); } catch {}

    // Create offscreen document for processing
    await createOffscreenDocument();
    
    // Send segments for processing via offscreen document
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(responseListener);
        reject(new Error("DASH processing timeout"));
      }, 300000); // 5 minutes

      const responseListener = (message) => {
        if (
          message.type === "MERGE_DASH_SEGMENTS_RESPONSE" &&
          message.requestId === requestId
        ) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(responseListener);
          if (message.success) {
            resolve(message);
          } else {
            reject(
              new Error(message.error?.message || "DASH processing failed")
            );
          }
        }
      };

      chrome.runtime.onMessage.addListener(responseListener);

      // Send processing request
      // Register offscreen merge request for cancellation support
      try { registerOffscreenRequest(queueDownloadId || dmId, requestId); } catch (_) {}
      chrome.runtime.sendMessage({
        type: "MERGE_DASH_SEGMENTS",
        requestId,
        audioKeys: audioStoredKeys,
        videoKeys: videoStoredKeys,
        fileName,
        isEmbedSplit
      });
    });

    if (response && response.success) {
      console.log("✅ DASH processing completed successfully");
      console.log(`✅ Merged DASH download initiated: ${fileName}`);
    } else {
      throw new Error("DASH processing failed");
    }

  } catch (error) {
    console.error("❌ DASH segment download failed:", error);
    throw error;
  } finally {
    try { clearOffscreenRequest(queueDownloadId || dmId, requestId); } catch (_) {}
    // Cleanup stored segments from IndexedDB
    console.log("🧹 Cleaning up stored DASH segments...");
    try {
      for (const key of audioStoredKeys) {
        await remove(key).catch(() => {});
      }
      for (const key of videoStoredKeys) {
        await remove(key).catch(() => {});
      }
    } catch (cleanupError) {
      console.warn("⚠️ Failed to clean up DASH segments:", cleanupError);
    }
    
    activeDownloads--;
    console.log(`📊 Active downloads: ${activeDownloads}`);
  }
}

async function downloadLoomVideo(taskOrUrl, passwordOrOptions) {
  // Supports old signature (url, password) and new ({ url, password, queueDownloadId }, { utils, abortSignal })
  let url, password, queueDownloadId = null, utils = null, abortSignal = null;
  if (typeof taskOrUrl === 'object' && taskOrUrl) {
    url = taskOrUrl.url;
    password = taskOrUrl.password;
    queueDownloadId = taskOrUrl.queueDownloadId || null;
    const opts = passwordOrOptions || {};
    utils = opts.utils || null;
    abortSignal = opts.abortSignal || null;
  } else {
    url = taskOrUrl;
    password = passwordOrOptions;
  }
  // Reset cancellation flag (legacy path reads this)
  downloadCancelled = false;
  const sendPopup = (p, s, sp = '') => { try { utils?.sendProgressUpdate ? utils.sendProgressUpdate(p, s, sp) : sendProgressToPopup(p, s, sp); } catch {} };
  const sendErr = (m) => { try { utils?.sendDownloadError ? utils.sendDownloadError(m) : sendDownloadError(m); } catch {} };
  sendPopup(5, "Extracting video information...");
  
  const videoIdMatch = url.match(/\/(?:share|embed)\/([a-f0-9]{32})/);
  if (!videoIdMatch) {
    console.error("Could not extract video ID from URL.");
    const error = "Could not extract video ID from URL.";
    sendErr(error);
    throw new Error(error);
  }
  const videoId = videoIdMatch[1];
  const isEmbedUrl = url.includes("/embed/");
  console.log(`🎬 Starting download for: ${url}`);
  console.log(`🆔 Video ID: ${videoId}`);
  console.log(`🔗 Is embed URL: ${isEmbedUrl}`);

  const [metadataResponse] = await callGraphqlApi(
    ["GetVideoSSR"],
    videoId,
    password
  );
  const metadata = metadataResponse.data.getVideo;

  if (metadata.__typename === "VideoPasswordMissingOrIncorrect") {
    const error =
      "This video is password-protected. Please provide the correct password.";
    console.error("🔒", error);
    try { utils?.sendDownloadError ? utils.sendDownloadError(error) : sendDownloadError(error); } catch {}
    throw new Error(error);
  }

  console.log("📝 Video Title:", metadata.name);
  sendPopup(15, "Getting download URLs...");

  const rawUrl = await callUrlApi("raw-url", videoId, password);

  let transcodedUrl = null;
  try {
    transcodedUrl = await callUrlApi("transcoded-url", videoId, password);
  } catch (error) {
    console.warn("⚠️ transcoded-url failed, will use raw-url:", error.message);
  }

  let downloadUrl = rawUrl || transcodedUrl;

  if (!downloadUrl) {
    const error = "Could not retrieve download URL.";
    console.error("❌", error);
    sendErr(error);
    throw new Error(error);
  }

  console.log("🔗 Download URL:", downloadUrl);
  console.log("🔍 URL includes .m3u8?", downloadUrl.includes(".m3u8"));
  console.log("🔍 URL includes .mpd?", downloadUrl.includes(".mpd"));
  console.log("🔍 URL type detection:", {
    isM3U8: downloadUrl.includes(".m3u8"),
    isMPD: downloadUrl.includes(".mpd"),
    rawUrl: downloadUrl,
  });

  const fileName = `${metadata.name
    .replace(/[^a-z0-9]/gi, "_")
    .toLowerCase()}.mp4`;

  if (downloadUrl.includes(".m3u8")) {
    console.log("📺 HLS stream detected. Processing manifest...");

    // Handle -split.m3u8 URLs
    if (downloadUrl.includes("-split.m3u8")) {
      downloadUrl = downloadUrl.replace("-split.m3u8", ".m3u8");
      console.log("🔄 Updated Download URL:", downloadUrl);
    }

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch HLS manifest: ${response.statusText}`);
    }

    const m3u8Content = await response.text();
    console.log("📋 M3U8 Manifest Content:", m3u8Content);
    const m3u8 = parseM3U8(m3u8Content);

    let audioSegments = [];
    let videoSegments = [];
    let audioPlaylist = null;
    let videoPlaylist = null;
    let audioPlaylistContent = null;
    let videoPlaylistContent = null;
    let selectedVariant = null;
    let preferredAudioTrack = null;
    let videoCodec = null;
    let audioCodec = null;
    const manifestParts = [m3u8Content];
    const masterUrl = new URL(downloadUrl);
    const query = masterUrl.search;

    const appendSegmentsFromPlaylist = (
      target,
      playlist,
      playlistUrl,
      type,
      queryString
    ) => {
      if (!playlist) return;

      const baseUrl = playlistUrl.substring(
        0,
        playlistUrl.lastIndexOf("/") + 1
      );
      const mediaSequence =
        typeof playlist.mediaSequence === "number"
          ? playlist.mediaSequence
          : 0;
      const discontinuityBase =
        typeof playlist.discontinuitySequence === "number"
          ? playlist.discontinuitySequence
          : 0;

      let localIndex = 0;

      const pushSegment = (segmentUri, options = {}) => {
        if (!segmentUri) return;
        const segmentUrl = new URL(segmentUri, baseUrl);
        segmentUrl.search = queryString;

        target.push({
          uri: segmentUrl.href,
          duration: options.duration ?? null,
          isInitSegment: options.isInitSegment || false,
          mimeType:
            options.mimeType ||
            playlist.segmentMimeType ||
            inferSegmentMimeType(segmentUri, type === "audio"),
          sequenceNumber:
            typeof options.sequenceNumber === "number"
              ? options.sequenceNumber
              : null,
          discontinuitySequence:
            typeof options.discontinuitySequence === "number"
              ? options.discontinuitySequence
              : discontinuityBase,
        });
      };

      if (playlist.initializationSegment) {
        const sequenceNumber =
          typeof playlist.mediaSequence === "number"
            ? playlist.mediaSequence - 1
            : -1;
        pushSegment(playlist.initializationSegment, {
          isInitSegment: true,
          mimeType:
            playlist.segmentMimeType ||
            inferSegmentMimeType(
              playlist.initializationSegment,
              type === "audio"
            ),
          sequenceNumber,
          discontinuitySequence: discontinuityBase,
        });
      }

      if (Array.isArray(playlist.segments)) {
        for (const segment of playlist.segments) {
          const sequenceNumber =
            typeof segment.sequenceNumber === "number"
              ? segment.sequenceNumber
              : mediaSequence + localIndex;
          const discontinuity =
            typeof segment.discontinuitySequence === "number"
              ? segment.discontinuitySequence
              : discontinuityBase;

          pushSegment(segment.uri, {
            duration: segment.duration,
            sequenceNumber,
            discontinuitySequence: discontinuity,
          });

          localIndex += 1;
        }
      }
    };

    if (m3u8.isMasterPlaylist) {
      console.log("🎯 Master playlist detected.");
      selectedVariant = selectBestVariant(m3u8.variants);
      if (!selectedVariant) {
        throw new Error("No playable variant found in master manifest");
      }
      console.log("🎬 Selected variant:", selectedVariant);

      const playlistUrl = new URL(selectedVariant.uri, downloadUrl);
      playlistUrl.search = query;
      const playlistUrlHref = playlistUrl.href;

      console.log(`📥 Fetching video playlist from: ${playlistUrlHref}`);
      const mediaPlaylistResponse = await fetch(playlistUrlHref);
      videoPlaylistContent = await mediaPlaylistResponse.text();
      manifestParts.push(videoPlaylistContent);
      videoPlaylist = parseM3U8(videoPlaylistContent);
      appendSegmentsFromPlaylist(
        videoSegments,
        videoPlaylist,
        playlistUrlHref,
        "video",
        query
      );

      const candidateAudioTracks = selectedVariant.audioGroup
        ? m3u8.audioTracks.filter(
            (track) => track.groupId === selectedVariant.audioGroup
          )
        : m3u8.audioTracks.slice();
      preferredAudioTrack = selectPreferredAudioTrack(candidateAudioTracks);
      if (!preferredAudioTrack && m3u8.audioTracks.length > 0) {
        preferredAudioTrack = m3u8.audioTracks[0];
      }

      if (preferredAudioTrack && preferredAudioTrack.uri) {
        const audioPlaylistUrl = new URL(preferredAudioTrack.uri, downloadUrl);
        audioPlaylistUrl.search = query;
        const audioPlaylistUrlHref = audioPlaylistUrl.href;

        console.log(`🎵 Fetching audio playlist from: ${audioPlaylistUrlHref}`);
        const audioPlaylistResponse = await fetch(audioPlaylistUrlHref);
        audioPlaylistContent = await audioPlaylistResponse.text();
        manifestParts.push(audioPlaylistContent);
        audioPlaylist = parseM3U8(audioPlaylistContent);
        appendSegmentsFromPlaylist(
          audioSegments,
          audioPlaylist,
          audioPlaylistUrlHref,
          "audio",
          query
        );
      } else {
        console.warn(
          "⚠️ No dedicated audio playlist found for the selected variant"
        );
      }

      const codecInfo = extractCodecInfo(selectedVariant.codecs || "");
      let resolvedVideoCodec = codecInfo.videoCodec || null;
      let resolvedAudioCodec = codecInfo.audioCodec || null;

      if (!resolvedAudioCodec && preferredAudioTrack?.codecs) {
        const audioInfo = extractCodecInfo(preferredAudioTrack.codecs);
        resolvedAudioCodec =
          audioInfo.audioCodec || audioInfo.videoCodec || preferredAudioTrack.codecs;
      }

      if (!resolvedVideoCodec && typeof selectedVariant.codecs === "string") {
        const codecs = selectedVariant.codecs
          .split(",")
          .map((item) => item.replace(/"/g, "").trim())
          .filter(Boolean);
        resolvedVideoCodec =
          codecs.find((codec) => /^(avc|hvc|hev1|vp09|av01)/i.test(codec)) ||
          codecs[0] ||
          null;
      }

      videoCodec = resolvedVideoCodec;
      audioCodec = resolvedAudioCodec;
    } else {
      console.log("📋 Media playlist detected.");
      if (m3u8.segments && m3u8.segments.length > 0) {
        appendSegmentsFromPlaylist(videoSegments, m3u8, downloadUrl, "video", query);
      }
    }

    const videoMime =
      videoPlaylist?.segmentMimeType ||
      (videoSegments[0]
        ? inferSegmentMimeType(videoSegments[0].uri, false)
        : null);
    const audioMime =
      audioPlaylist?.segmentMimeType ||
      (audioSegments[0]
        ? inferSegmentMimeType(audioSegments[0].uri, true)
        : null);
    const streamFormat =
      (videoMime && videoMime.includes("mp4")) ||
      (audioMime && audioMime.includes("mp4"))
        ? "fmp4"
        : "ts";

    const manifestContentForMerge = manifestParts.filter(Boolean).join("\n\n");

    const videoDur = videoPlaylist?.totalDuration || 0;
    const audioDur = audioPlaylist?.totalDuration || 0;
    const masterDur = m3u8.totalDuration || 0;
    const gqlDur = metadata.video_properties?.duration || 0;

    let normalizedTotalDuration = null;
    if (videoDur > 0 || audioDur > 0) {
      // Prefer playlist-derived durations; take the larger of A/V to be safe
      normalizedTotalDuration = Math.max(videoDur || 0, audioDur || 0);
    } else if (masterDur > 0) {
      // Fall back to any total the master might have
      normalizedTotalDuration = masterDur;
    } else if (gqlDur > 0) {
      // Absolute last resort: GraphQL metadata
      normalizedTotalDuration = gqlDur;
    }

    console.log("🕒 Duration candidates:", [
      { label: "videoPlaylist.totalDuration", value: videoDur },
      { label: "audioPlaylist.totalDuration", value: audioDur },
      { label: "master.totalDuration", value: masterDur },
      { label: "graphQL.video_properties.duration", value: gqlDur },
    ]);
    console.log("🕒 Normalized total duration chosen (seconds):", normalizedTotalDuration);

    console.log("🔍 Debug: audio segments:", audioSegments.length);
    console.log("🔍 Debug: video segments:", videoSegments.length);

    if (audioSegments.length === 0 && videoSegments.length === 0) {
      console.error(
        "❌ No audio or video segments found in HLS manifest."
      );
      console.error("🔍 Debug info:", {
        m3u8Content: m3u8Content.substring(0, 500),
        parsedM3U8: m3u8,
        downloadUrl: downloadUrl,
      });
      throw new Error("No segments found in HLS manifest.");
    }

    if (audioSegments.length > 0 && videoSegments.length > 0) {
      console.log(
        `📦 Found ${audioSegments.length} audio + ${videoSegments.length} video HLS segments - processing with FastStream A/V pipeline`
      );
      console.log(
        `🧭 PATH: HLS separate A/V selected (streamFormat=${streamFormat}) → Offscreen MERGE_SEPARATE_AV`
      );
      console.log(
        "🕒 Video segments total duration (EXTINF sum):",
        videoSegments.reduce((sum, seg) => sum + (seg.duration || 0), 0)
      );
      console.log(
        "🕒 Audio segments total duration (EXTINF sum):",
        audioSegments.reduce((sum, seg) => sum + (seg.duration || 0), 0)
      );
      // Update popup with accurate runtime before merging
      try {
        if (typeof normalizedTotalDuration === "number") {
          chrome.runtime.sendMessage({
            type: "VIDEO_INFO_UPDATE",
            duration: Math.round(normalizedTotalDuration),
          }).catch(() => {});
        }
      } catch (e) {}

      await downloadHLSSegmentsWithSeparateAV(
        audioSegments,
        videoSegments,
        fileName,
        normalizedTotalDuration,
        manifestContentForMerge,
        isEmbedUrl,
        {
          streamFormat,
          videoCodec,
          audioCodec,
        },
        { utils, abortSignal, queueDownloadId }
      );
    } else if (videoSegments.length > 0) {
      console.log(`📦 Found ${videoSegments.length} video-only segments`);
      console.log(
        `🧭 PATH: HLS single-stream video-only → Offscreen MERGE_SEGMENTS`
      );
      await downloadHLSSegments(videoSegments, fileName, { utils, abortSignal, queueDownloadId });
    } else if (audioSegments.length > 0) {
      console.log(`📦 Found ${audioSegments.length} audio-only segments`);
      console.log(
        `🧭 PATH: HLS single-stream audio-only → Offscreen MERGE_SEGMENTS`
      );
      await downloadHLSSegments(
        audioSegments,
        fileName.replace('.webm', '_audio.webm'),
        { utils, abortSignal, queueDownloadId }
      );
    }
  } else if (downloadUrl.includes(".mpd")) {
    console.log("📺 DASH stream detected. Processing manifest...");

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch DASH manifest: ${response.statusText}`);
    }

    const mpdContent = await response.text();
    console.log("📋 MPD Manifest Content:", mpdContent);

    const manifest = parseXML(mpdContent);
    console.log("✅ Parsed MPD object:", manifest);

    const periods = manifest.MPD.Period;
    const masterUrl = new URL(downloadUrl);
    const query = masterUrl.search;
    const base_url = downloadUrl.substring(0, downloadUrl.lastIndexOf("/") + 1);

    const audioAdaptationSet = periods[0].AdaptationSet.find(
      (aset) => aset && aset.getAttribute("contentType") === "audio"
    );
    const videoAdaptationSet = periods[0].AdaptationSet.find(
      (aset) => aset && aset.getAttribute("contentType") === "video"
    );

    if (!videoAdaptationSet || !videoAdaptationSet.representations.length) {
      throw new Error(
        "Could not find video adaptation set or representations in DASH manifest"
      );
    }

    // Choose the best representation (highest bandwidth)
    const videoRepresentation = videoAdaptationSet.representations[0];
    const audioRepresentation =
      audioAdaptationSet && audioAdaptationSet.representations?.[0];

    const audioSegments = [];
    const videoSegments = [];

    console.log("🔍 Extracting DASH segments from representations...");

    // Helper function to extract segments
    const extractSegments = (representation, baseUrl, query) => {
      const segments = [];
      if (!representation || !representation.innerHTML) return segments;

      const segmentTemplateRegex =
        /<SegmentTemplate[^>]*initialization="([^"]+)"[^>]*media="([^"]+)"(?:[^>]*startNumber="(\d+)")?/;
      const templateMatch = segmentTemplateRegex.exec(representation.innerHTML);

      if (templateMatch) {
        const initialization = templateMatch[1];
        const media = templateMatch[2];
        const startNumber = templateMatch[3]
          ? parseInt(templateMatch[3], 10)
          : 1;

        const initUrl = new URL(initialization, baseUrl);
        initUrl.search = query;
        segments.push({ uri: initUrl.href });

        const segmentTimelineRegex =
          /<SegmentTimeline[^>]*>(.*?)<\/SegmentTimeline>/s;
        const timelineMatch =
          representation.innerHTML.match(segmentTimelineRegex);

        if (timelineMatch) {
          const timelineContent = timelineMatch[1];
          const sTagRegex = /<S\s*([^>]*)\/>/g;
          const sTagMatches = [...timelineContent.matchAll(sTagRegex)];

          let segmentIndex = startNumber;
          for (const sMatch of sTagMatches) {
            const attrs = sMatch[1] || "";
            const rMatch = attrs.match(/r="(\d+)"/);
            const repeatCount = rMatch ? parseInt(rMatch[1], 10) : 0;

            let segmentUrl = new URL(
              media.replace(/\$Number\$/, segmentIndex),
              baseUrl
            );
            segmentUrl.search = query;
            segments.push({ uri: segmentUrl.href });
            segmentIndex++;

            for (let i = 0; i < repeatCount; i++) {
              segmentUrl = new URL(
                media.replace(/\$Number\$/, segmentIndex),
                baseUrl
              );
              segmentUrl.search = query;
              segments.push({ uri: segmentUrl.href });
              segmentIndex++;
            }
          }
        }
      } else {
        const segmentRegex = /<SegmentURL[^>]*media="([^"]+)"/g;
        let match;
        while ((match = segmentRegex.exec(representation.innerHTML)) !== null) {
          const segmentUrl = new URL(match[1], baseUrl);
          segmentUrl.search = query;
          segments.push({ uri: segmentUrl.href });
        }
      }
      return segments;
    };

    // Extract audio and video segments
    if (audioRepresentation) {
      audioSegments.push(
        ...extractSegments(audioRepresentation, base_url, query)
      );
      console.log(`🎵 Found ${audioSegments.length} audio segments`);
    }
    if (videoRepresentation) {
      videoSegments.push(
        ...extractSegments(videoRepresentation, base_url, query)
      );
      console.log(`🎬 Found ${videoSegments.length} video segments`);
    }

    console.log(`🔍 Debug DASH results:`, {
      audioSegmentsFound: audioSegments.length,
      videoSegmentsFound: videoSegments.length,
      audioAdaptationSetExists: !!audioAdaptationSet,
      videoAdaptationSetExists: !!videoAdaptationSet,
    });

    if (videoSegments.length > 0) {
      console.log(
        `📦 Processing ${audioSegments.length} audio + ${videoSegments.length} video DASH segments`
      );
      await downloadDASHSegments(audioSegments, videoSegments, fileName, isEmbedUrl, { utils, abortSignal, queueDownloadId });
    } else {
      console.error(
        "❌ No DASH segments found, falling back to direct download..."
      );
      console.error(
        "🔍 This explains the 5.7kb file - we're downloading the manifest instead of segments"
      );
      await downloadFile(downloadUrl, fileName, { utils, abortSignal, queueDownloadId });
    }
  } else {
    console.log("📁 Direct file download");
    await downloadFile(downloadUrl, fileName, { utils, abortSignal, queueDownloadId });
  }

  console.log("✅ Download process completed successfully!");
  
  // Send completion message to update progress bar to 100%
  try { utils?.sendDownloadComplete ? utils.sendDownloadComplete("Download completed successfully!") : sendDownloadComplete("Download completed successfully!"); } catch {}
}

// Test function to verify offscreen document communication
async function testOffscreenDocument() {
  console.log("🧪 Testing offscreen document communication...");

  try {
    await createOffscreenDocument();

    // Send a simple ping
    const testId = Math.random().toString(36).substring(7);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Offscreen document test timed out"));
      }, 5000);

      const listener = (message) => {
        if (message.type === "PONG" && message.testId === testId) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          console.log("✅ Offscreen document test passed!");
          resolve(true);
        }
      };

      chrome.runtime.onMessage.addListener(listener);

      chrome.runtime.sendMessage({
        type: "PING",
        testId: testId,
      });
    });
  } catch (error) {
    console.error("❌ Offscreen document test failed:", error);
    throw error;
  }
}

// Function to find Loom iframe on third-party sites
async function findLoomEmbed() {
  console.log("🔍 Searching for Loom embed on current page");

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab) {
      console.error("No active tab found");
      return null;
    }

    if (!tab.id) {
      console.error("Tab has no ID");
      return null;
    }

    console.log("🔍 Executing script on tab:", tab.id, tab.url);

    // Execute script to find Loom iframe
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // This runs in the context of the webpage
        const iframe = document.querySelector(
          'iframe[src*="loom.com/embed"], iframe[src*="loom.com/share"]'
        );
        if (iframe) {
          const src = iframe.src;
          // Extract video ID from iframe src
          const videoIdMatch = src.match(/(?:embed|share)\/([a-f0-9]{32})/);
          return {
            iframeSrc: src,
            videoId: videoIdMatch ? videoIdMatch[1] : null,
            pageUrl: window.location.href,
            pageTitle: document.title,
          };
        }

        // Look for video elements with poster attribute
        const videos = document.querySelectorAll('video[poster]');
        for (const video of videos) {
          const poster = video.poster;
          const src = video.src || '';
          
          // Check if it's a Loom video
          if (poster.includes('loom.com') || src.includes('loom.com')) {
            // Extract video ID from poster or src
            const videoIdMatch = (poster + src).match(/([a-f0-9]{32})/);
            
            return {
              videoId: videoIdMatch ? videoIdMatch[1] : null,
              pageUrl: window.location.href,
              pageTitle: document.title,
              elementType: "video",
              element: video.className || video.id || "video-element",
              thumbnail: poster,
            };
          }
        }

        // Also check for video elements with data-loom-video-id
        const videoElement = document.querySelector(
          "video[data-loom-video-id]"
        );
        if (videoElement) {
          const videoId = videoElement.getAttribute("data-loom-video-id");
          return {
            videoId: videoId,
            pageUrl: window.location.href,
            pageTitle: document.title,
            elementType: "video",
            element:
              videoElement.id || videoElement.className || "video-element",
            thumbnail: videoElement.poster || null,
          };
        }

        // Check for any Loom video elements (including thumbnails in src/poster)
        const loomVideos = document.querySelectorAll('video');
        for (const video of loomVideos) {
          const src = video.src || video.getAttribute('data-src') || '';
          const poster = video.poster || '';
          
          // Check if this is a Loom video by examining src or poster for Loom patterns
          if (src.includes('loom.com') || poster.includes('loom.com') || video.className.includes('Loom') || video.id.includes('Loom')) {
            // Try to extract video ID from src, poster, or page URL
            let videoId = null;
            
            // First try src
            let videoIdMatch = src.match(/([a-f0-9]{32})/);
            if (videoIdMatch) {
              videoId = videoIdMatch[1];
            } else {
              // Try poster
              videoIdMatch = poster.match(/([a-f0-9]{32})/);
              if (videoIdMatch) {
                videoId = videoIdMatch[1];
              } else {
                // Try page URL as fallback
                videoIdMatch = window.location.href.match(/([a-f0-9]{32})/);
                if (videoIdMatch) {
                  videoId = videoIdMatch[1];
                }
              }
            }
            
            // Look for better thumbnail sources if poster is a placeholder
            let thumbnail = poster;
            
            if (!thumbnail || thumbnail.includes('data:image/gif;base64') || thumbnail.length < 50) {
              // Try to find thumbnail in various places
              const thumbnailSelectors = [
                'meta[property="og:image"]',
                'meta[name="twitter:image"]',
                'img[src*="thumbnails"]',
                'img[src*="' + videoId + '"]'
              ];
              
              for (const selector of thumbnailSelectors) {
                const element = document.querySelector(selector);
                if (element && (element.content || element.src)) {
                  const foundThumbnail = element.content || element.src;
                  if (foundThumbnail && !foundThumbnail.includes('data:image/gif;base64')) {
                    thumbnail = foundThumbnail;
                    console.log('🖼️ Found better thumbnail via', selector + ':', thumbnail);
                    break;
                  }
                }
              }
            }
            
            console.log('🎬 Found Loom video element:', {
              src, poster, thumbnail, videoId, 
              element: video.className || video.id || 'video'
            });
            
            return {
              videoId: videoId,
              pageUrl: window.location.href,
              pageTitle: document.title,
              elementType: "video",
              element: video.id || video.className || "loom-video-element",
              thumbnail: thumbnail || null,
            };
          }
        }

        return null;
      },
    });

    console.log("📥 Script execution results:", results);

    if (results && results[0] && results[0].result) {
      console.log("✅ Found Loom embed:", results[0].result);
      return results[0].result;
    }

    console.log("❌ No Loom embed found on page");
    return null;
  } catch (error) {
    console.error("❌ Error finding Loom embed:", error);
    // Check if this is a script injection error
    if (error.message && error.message.includes("Cannot access")) {
      console.error("❌ Cannot access tab - likely permission issue");
    } else if (
      error.message &&
      error.message.includes("Tabs cannot be edited")
    ) {
      console.error(
        "❌ Tab cannot be edited - likely chrome:// page or similar"
      );
    } else if (error.message && error.message.includes("No tab with id")) {
      console.error("❌ Tab no longer exists");
    }
    return null;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("🔔 Background received message:", request);

  // These are fire-and-forget messages from the offscreen document or self.
  // We don't send a response, so we don't return true.
  const fireAndForgetTypes = [
    "MERGE_AUDIO_VIDEO",
    "MERGE_SEGMENTS",
    "MERGE_SEGMENTS_RESPONSE",
    "MERGE_SEPARATE_AV_RESPONSE",
    "MERGE_DASH_SEGMENTS",
    "MERGE_DASH_SEGMENTS_RESPONSE",
    "MERGE_RESPONSE",
    "DEBUG_MESSAGE",
    "OFFSCREEN_DOCUMENT_READY",
    "OFFSCREEN_ERROR",
    "DOWNLOAD_COMPLETE_NOTIFICATION",
  ];

  if (fireAndForgetTypes.includes(request.type)) {
    handleRequest(request, sender, null); // Pass null for sendResponse to indicate no response needed
    return false; // No async response needed for fire-and-forget
  }

  // All other actions are async and require a response.
  const actionsToProtect = [
    "extractVideoInfo",
    "downloadVideo",
    "findLoomEmbed",
  ];

  if (actionsToProtect.includes(request.action)) {
    chrome.storage.local.get("isActivated", (data) => {
      console.log(
        "🔐 Checking activation for action:",
        request.action,
        "Activated:",
        data.isActivated
      );
      try {
        if (data.isActivated) {
          handleRequest(request, sender, sendResponse);
        } else {
          console.log("❌ Extension not activated, sending error response");
          sendResponse({
            success: false,
            error: "Please activate the extension with a valid license key.",
          });
        }
      } catch (error) {
        console.error("❌ Error in activation check:", error);
        sendResponse({
          success: false,
          error: "Error checking activation status.",
        });
      }
    });
    return true; // Indicates async response
  } else if (request.action) {
    // For other async actions that don't require activation
    console.log("🔓 Action doesn't require activation:", request.action);
    handleRequest(request, sender, sendResponse);
    return true; // Indicates async response
  } else {
    // For messages without action, handle them as fire-and-forget
    console.log("🔄 Handling message without action:", request.type || "unknown");
    handleRequest(request, sender, null);
    return false; // No async response needed
  }
});

function handleRequest(request, sender, sendResponse) {
  switch (request.action) {
    case "extractVideoInfo":
      console.log("🎬 Processing extractVideoInfo request");
      const videoIdMatch = request.url.match(
        /\/(?:share|embed)\/([a-f0-9]{32})/
      );
      if (!videoIdMatch) {
        console.error("❌ Could not extract video ID from URL:", request.url);
        sendResponse({
          success: false,
          error: "Could not extract video ID from URL.",
        });
        return;
      }
      const videoId = videoIdMatch[1];
      console.log("✅ Extracted video ID:", videoId);

      callGraphqlApi(["GetVideoSSR"], videoId, request.password)
        .then((response) => {
          console.log("📋 Processing GraphQL response for extractVideoInfo");
          console.log("🔍 Full GraphQL response:", JSON.stringify(response, null, 2));
          const metadata = response[0].data.getVideo;
          console.log("📊 Raw metadata object:", JSON.stringify(metadata, null, 2));
          if (metadata.__typename === "VideoPasswordMissingOrIncorrect") {
            console.warn("🔒 Video is password protected");
            sendResponse({
              success: false,
              error:
                "This video is password-protected. Please provide the correct password.",
            });
          } else if (metadata.status === "error") {
            console.error("❌ Video processing error:", metadata.message);
            sendResponse({
              success: false,
              error: `Video processing error: ${metadata.message}`,
            });
          } else {
            const videoInfo = {
              title: metadata.name,
              owner: metadata.owner.display_name,
              // Don't trust GraphQL for duration; will be updated after manifest parse
              duration: null,
              width: metadata.video_properties.width,
              height: metadata.video_properties.height,
              description: metadata.description,
              url: request.url,
            };
            console.log("✅ Video info extracted successfully:", metadata.name);
            console.log("📦 Final videoInfo object being returned:", JSON.stringify(videoInfo, null, 2));
            sendResponse({
              success: true,
              videoInfo: videoInfo,
            });
          }
        })
        .catch((error) => {
          console.error("❌ Error in extractVideoInfo:", error);
          sendResponse({ success: false, error: error.message });
        });
      break;
    case "loomEmbedDetected":
      console.log("🎬 Loom embed detected on page:", request.videoInfo);
      // This is just a notification, but we should still send a response if requested
      if (sendResponse) {
        sendResponse({ success: true, message: "Embed detected" });
      }
      break;
    case "testOffscreen":
      console.log("🧪 Processing testOffscreen request");
      testOffscreenDocument()
        .then(() => {
          sendResponse({ success: true, message: "Offscreen test passed!" });
        })
        .catch((error) => {
          sendResponse({ success: false, error: error.message });
        });
      break;
    case "downloadVideo":
      console.log("⬇️ Processing downloadVideo request");
      try {
        const id = queueDownload({ url: request.url, password: request.password, videoInfo: request.videoInfo || {} });
        // If popup provided a primed placeholder id, map it to the real queue id and remove the placeholder card
        try {
          const alias = request && request.requestId ? String(request.requestId) : null;
          if (alias) {
            try { downloadTaskRegistry.attachAlias(String(id), alias); } catch (_) {}
            try { sendDownloadManagerMessage({ action: 'hideDownloadProgress', downloadId: alias }).catch(() => {}); } catch (_) {}
          }
        } catch (_) {}
        sendResponse && sendResponse({ success: true, message: "Download queued", downloadId: id });
      } catch (error) {
        console.error("❌ Failed to enqueue Loom download:", error);
        sendResponse && sendResponse({ success: false, error: error?.message || String(error) });
      }
      break;
    case "openPopupForPassword": {
      (async () => {
        try {
          const url = request?.url || null;
          const source = request?.source || 'overlay';
          if (url) {
            try { await chrome.storage.local.set({ loomPendingUrl: String(url), loomPendingSource: String(source), loomPendingRequirePassword: true }); } catch (_) {}
          }
          // Open the regular browser-action popup (anchored to the toolbar icon)
          try {
            if (chrome?.action?.openPopup) {
              await chrome.action.openPopup();
              sendResponse && sendResponse({ success: true });
              return;
            }
          } catch (_) {}
          // If the API isn't available, still report success; the popup can be opened manually
          sendResponse && sendResponse({ success: false, error: 'openPopup unsupported' });
        } catch (e) {
          sendResponse && sendResponse({ success: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }
    case "cancelDownload":
      console.log("❌ Processing cancelDownload request");
      (async () => {
        try {
          let target = request && request.downloadId != null ? String(request.downloadId) : null;
          if (!target) {
            // Try to infer an active id
            if (__dmCurrentId) target = String(__dmCurrentId);
            else {
              // Pick most recently updated active registry entry
              try {
                let latest = null; let latestTs = -1;
                for (const entry of downloadTaskRegistry.items.values()) {
                  const ts = entry.lastUpdate || 0;
                  if (entry.status === 'downloading' && ts >= latestTs) { latest = entry; latestTs = ts; }
                }
                if (latest) target = String(latest.id);
              } catch (_) {}
            }
          }
          if (!target) {
            sendResponse && sendResponse({ success: false, error: "No downloadId provided" });
            return;
          }
          const success = await cancelDownload(target);
          sendResponse && sendResponse(success
            ? { success: true, message: `Cancellation requested for ${target}` }
            : { success: false, error: `No active download for id ${target}` }
          );
        } catch (e) {
          console.error('❌ Error in cancelDownload:', e);
          sendResponse && sendResponse({ success: false, error: e?.message || String(e) });
        }
      })();
      return true;
    case "cancelAllDownloads":
      console.log("❌ Processing cancelAllDownloads request");
      (async () => {
        try {
          const ids = Array.from(downloadTaskRegistry.items.keys());
          const results = await Promise.all(ids.map((id) => cancelDownload(id)));
          const count = results.filter(Boolean).length;
          sendResponse && sendResponse({ success: true, message: `Cancelled ${count} downloads` });
        } catch (e) {
          console.error('❌ Error in cancelAllDownloads:', e);
          sendResponse && sendResponse({ success: false, error: e?.message || String(e) });
        }
      })();
      return true;
    case "getQueueStatus": {
      try {
        const snapshot = buildDownloadManagerSnapshot();
        sendResponse && sendResponse({ success: true, ...snapshot });
      } catch (error) {
        sendResponse && sendResponse({ success: false, error: error?.message || String(error) });
      }
      return true;
    }
    case "downloadManagerRemoveEntries": {
      (async () => {
        try {
          const ids = Array.isArray(request?.ids)
            ? request.ids.map(String)
            : (Array.isArray(request?.downloadIds) ? request.downloadIds.map(String) : []);
          if (ids.length > 0) {
            await Promise.all(ids.map((id) => propagateDownloadManagerRemoval(id)));
            sendResponse && sendResponse({ success: true, removed: ids });
            return;
          }
          if (canSyncDownloadState()) {
            try {
              const state = await getPersistedDownloadState();
              const toRemove = Object.entries(state.downloads || {})
                .filter(([, info]) => !!info.isCompleted || !!info.isCancelled || /(failed|error|interrupted)/i.test(info.status || ''))
                .map(([id]) => String(id));
              await Promise.all(toRemove.map((id) => propagateDownloadManagerRemoval(id, { skipStorage: true })));
              for (const id of toRemove) {
                try { await removeDownloadManagerStorageEntry(id); } catch (_) {}
              }
            } catch (_) {}
          }
          sendResponse && sendResponse({ success: true, removed: [] });
        } catch (e) {
          sendResponse && sendResponse({ success: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }
    case "getDownloadSnapshot": {
      (async () => {
        try {
          const items = [];
          for (const [id, entry] of downloadTaskRegistry.items.entries()) {
            items.push({
              id,
              status: entry.status,
              title: entry.videoInfo?.title || entry.videoInfo?.fileName || 'Loom Video',
              progress: entry.progress?.percentage ?? 0,
              downloaded: entry.progress?.downloaded || 0,
              total: entry.progress?.total || 0,
              lastUpdate: entry.lastUpdate || Date.now(),
            });
          }
          const queued = downloadTaskRegistry.getQueuedEntries().map(e => e.id);
          const downloading = downloadTaskRegistry.getActiveEntries().map(e => e.id);
          const state = await getPersistedDownloadState();
          const persisted = [];
          const liveIds = new Set(items.map(i => String(i.id)));
          for (const [pid, info] of Object.entries(state.downloads || {})) {
            if (liveIds.has(String(pid))) continue; // prefer live registry for active ones
            persisted.push({
              id: String(pid),
              filename: info.filename || 'Loom Video',
              status: info.status || 'Downloading...',
              progress: Number.isFinite(info.progress) ? info.progress : 0,
              downloaded: Number.isFinite(info.downloaded) ? info.downloaded : 0,
              total: Number.isFinite(info.total) ? info.total : 0,
              isCompleted: !!info.isCompleted,
              isCancelled: !!info.isCancelled,
              lastUpdate: info.lastUpdate || state.lastUpdate || Date.now(),
            });
          }
          const snapshot = {
            queued,
            downloading,
            active: items,
            persisted,
            maxConcurrent: maxConcurrentDownloads,
            lastUpdate: Date.now(),
          };
          sendResponse && sendResponse({ success: true, snapshot });
        } catch (e) {
          sendResponse && sendResponse({ success: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }
    case "checkDownloadStatus":
      console.log("📊 Processing checkDownloadStatus request");
      try {
        const inProgress = downloadTaskRegistry.getActiveCount() > 0 || (downloadTaskRegistry.getQueuedEntries()?.length || 0) > 0;
        sendResponse && sendResponse({ success: true, inProgress });
      } catch (e) {
        sendResponse && sendResponse({ success: true, inProgress: false });
      }
      break;
    case "findLoomEmbed":
      console.log("🔍 Processing findLoomEmbed request");
      findLoomEmbed()
        .then((embedInfo) => {
          console.log("📋 findLoomEmbed result:", embedInfo);
          if (embedInfo) {
            // Convert the embed info to a video URL that can be processed
            let videoUrl;
            if (embedInfo.iframeSrc) {
              // For iframe embeds, convert to share URL
              videoUrl = `https://www.loom.com/share/${embedInfo.videoId}`;
            } else if (embedInfo.videoId) {
              // For video elements, create share URL
              videoUrl = `https://www.loom.com/share/${embedInfo.videoId}`;
            }

            console.log("✅ Sending success response for findLoomEmbed");
            sendResponse({
              success: true,
              embedInfo: embedInfo,
              videoUrl: videoUrl,
            });
          } else {
            console.log("❌ No embed found, sending failure response");
            sendResponse({
              success: false,
              error: "No Loom embed found on this page.",
            });
          }
        })
        .catch((error) => {
          console.error("❌ Error in findLoomEmbed promise:", error);
          try {
            sendResponse({
              success: false,
              error: error.message || "Unknown error occurred",
            });
          } catch (responseError) {
            console.error("❌ Failed to send error response:", responseError);
          }
        });
      break;
    default:
      // Handle fire-and-forget messages here
      switch (request.type) {
        case "DEBUG_MESSAGE":
          console.log("🐞 OFFSCREEN DEBUG:", request.message);
          break;
        case "MERGE_AUDIO_VIDEO":
          console.log(
            "🔄 Ignoring MERGE_AUDIO_VIDEO message in background script"
          );
          break;
        case "MERGE_SEGMENTS":
          console.log(
            "🔄 Ignoring MERGE_SEGMENTS message in background script"
          );
          break;
        case "MERGE_SEGMENTS_RESPONSE":
          console.log(
            "🔄 Ignoring MERGE_SEGMENTS_RESPONSE message in background script"
          );
          break;
        case "MERGE_DASH_SEGMENTS":
          console.log(
            "🔄 Ignoring MERGE_DASH_SEGMENTS message in background script"
          );
          break;
        case "MERGE_DASH_SEGMENTS_RESPONSE":
          console.log(
            "🔄 Ignoring MERGE_DASH_SEGMENTS_RESPONSE message in background script"
          );
          break;
        case "MERGE_RESPONSE":
          console.log(
            "🔄 Ignoring MERGE_RESPONSE message in background script"
          );
          // Don't send response for fire-and-forget messages
          break;
        case "MERGE_SEPARATE_AV_RESPONSE":
          console.log(
            "🔄 Ignoring MERGE_SEPARATE_AV_RESPONSE message in background script"
          );
          break;
        case "OFFSCREEN_DOCUMENT_READY":
          console.log("✅ Offscreen document is ready.");
          break;
        case "OFFSCREEN_ERROR":
          console.log("❌ Offscreen document error received.");
          break;
        case "DOWNLOAD_COMPLETE_NOTIFICATION":
          console.log("✅ Download completion notification received:", request.fileName);
          // Do not decrement activeDownloads here; it is decremented in the
          // specific download flow's finally block to avoid double accounting.
          sendDownloadComplete(`Download completed: ${request.fileName}`);
          break;
        default:
          if (request.action) {
            console.warn("❓ Unknown action received:", request.action);
            if (sendResponse) {
              sendResponse({
                success: false,
                error: `Unknown action: ${request.action}`,
              });
            }
          } else {
            console.warn("⚠️ Unhandled message:", request);
            if (sendResponse) {
              sendResponse({
                success: false,
                error: "Unhandled message type",
              });
            }
          }
      }
  }
}

// Listen for download changes to prevent service worker suspension
chrome.downloads.onChanged.addListener((downloadDelta) => {
  if (downloadDelta.state && downloadDelta.state.current === "complete") {
    console.log(`📥 Download completed: ${downloadDelta.id}`);
  }

  if (downloadDelta.state && downloadDelta.state.current === "interrupted") {
    console.log(`❌ Download interrupted: ${downloadDelta.id}`);
  }

  // Keep service worker alive while downloads are active
  if (activeDownloads > 0) {
    console.log(
      `⏳ Keeping service worker alive - ${activeDownloads} active downloads`
    );
  }
});

// Clean up offscreen document when extension shuts down
chrome.runtime.onSuspend.addListener(() => {
  console.log("🧹 Extension suspending, cleaning up offscreen document...");
  closeOffscreenDocument().catch(console.error);
});

console.log("✅ Background script loaded successfully");
