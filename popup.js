// Popup script for Loom Downloader extension

let currentTab = null;
let currentVideo = null;

// DOM elements
const statusEl = document.getElementById("status");
const videoInfoEl = document.getElementById("videoInfo");
const licenseKeyInput = document.getElementById("licenseKeyInput");
const activateBtn = document.getElementById("activateBtn");
const activationStatus = document.getElementById("activationStatus");
const videoTitleEl = document.getElementById("videoTitle");
const videoIdEl = document.getElementById("videoId");
const videoDurationEl = document.getElementById("videoDuration");
const downloadBtn = document.getElementById("downloadBtn");
const progressEl = document.getElementById("progress");
const progressFillEl = document.getElementById("progressFill");
const progressTextEl = document.getElementById("progressText");
const progressSpeedEl = document.getElementById("progressSpeed");
const errorEl = document.getElementById("error");
const settingsBtn = document.getElementById("settingsBtn");
const helpBtn = document.getElementById("helpBtn");

let isActivated = false;

// Initialize popup
async function init() {
  try {
    // Check activation status
    await checkActivation();

    // Get current tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0];

    // Check if we're on a Loom page
    if (!currentTab.url || !currentTab.url.includes("loom.com")) {
      updateStatus("Navigate to a Loom video to download", "default");
      return;
    }

    // Send message to content script to get video info
    updateStatus("Detecting video...", "default");

    chrome.tabs.sendMessage(
      currentTab.id,
      { action: "getVideoInfo" },
      (response) => {
        if (chrome.runtime.lastError) {
          // Content script might not be loaded yet
          updateStatus("Refreshing page detection...", "default");
          injectContentScriptAndRetry();
          return;
        }

        if (response && response.success) {
          currentVideo = response.data;
          displayVideoInfo(response.data);
          downloadBtn.disabled = false;
          updateStatus("Video detected! Ready to download", "success");
        } else {
          updateStatus("No video found on this page", "error");
        }
      }
    );
  } catch (error) {
    console.error("Init error:", error);
    updateStatus("Error initializing extension", "error");
  }
}

async function checkActivation() {
  chrome.storage.local.get("isActivated", (data) => {
    isActivated = data.isActivated || false;
    toggleContentVisibility();
  });
}

function toggleContentVisibility() {
  if (isActivated) {
    document.getElementById("mainContent").classList.remove("hidden");
    document.getElementById("activationSection").classList.add("hidden");
  } else {
    document.getElementById("mainContent").classList.add("hidden");
    document.getElementById("activationSection").classList.remove("hidden");
  }
}

// Inject content script if not already loaded
async function injectContentScriptAndRetry() {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      files: ["site-config.js", "logger.js", "content-enhanced.js"],
    });

    // Retry getting video info
    setTimeout(() => {
      chrome.tabs.sendMessage(
        currentTab.id,
        { action: "getVideoInfo" },
        (response) => {
          if (response && response.success) {
            currentVideo = response.data;
            displayVideoInfo(response.data);
            downloadBtn.disabled = false;
            updateStatus("Video detected! Ready to download", "success");
          } else {
            updateStatus("No video found on this page", "error");
          }
        }
      );
    }, 500);
  } catch (error) {
    console.error("Script injection error:", error);
    updateStatus("Failed to detect video", "error");
  }
}

// Display video information
function displayVideoInfo(videoData) {
  videoTitleEl.textContent = videoData.title || "Untitled Video";
  videoIdEl.textContent = `ID: ${videoData.id || "Unknown"}`;
  videoDurationEl.textContent = videoData.duration
    ? formatDuration(videoData.duration)
    : "";
  videoInfoEl.classList.remove("hidden");
}

// Format duration from seconds to readable format
function formatDuration(seconds) {
  if (!seconds) return "";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// Update status message
function updateStatus(message, type = "default") {
  statusEl.textContent = message;
  statusEl.className = "status";
  if (type !== "default") {
    statusEl.classList.add(type);
  }
}

// Show error message
function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
  setTimeout(() => {
    errorEl.classList.add("hidden");
  }, 5000);
}

// Handle download button click
downloadBtn.addEventListener("click", async () => {
  if (!isActivated) {
    showError("Please activate the extension with a valid license key.");
    return;
  }
  if (!currentVideo || !currentVideo.url) {
    showError("No video URL found. Please refresh the page and try again.");
    return;
  }

  try {
    downloadBtn.disabled = true;
    updateStatus("Starting download...", "default");
    progressEl.classList.remove("hidden");

    // Send download request to background script
    chrome.runtime.sendMessage(
      {
        action: "downloadVideo",
        video: currentVideo,
        tabId: currentTab.id,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          showError("Download failed: " + chrome.runtime.lastError.message);
          downloadBtn.disabled = false;
          progressEl.classList.add("hidden");
          return;
        }

        if (response && response.success) {
          updateStatus("Download started!", "success");
        } else {
          showError(response.error || "Download failed");
          downloadBtn.disabled = false;
          progressEl.classList.add("hidden");
        }
      }
    );
  } catch (error) {
    console.error("Download error:", error);
    showError("Download failed: " + error.message);
    downloadBtn.disabled = false;
    progressEl.classList.add("hidden");
  }
});

// Listen for download progress updates
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "downloadProgress") {
    const progress = message.progress;
    progressFillEl.style.width = `${progress.percentage}%`;
    progressTextEl.textContent = `${Math.round(progress.percentage)}%`;

    if (progress.bytesReceived && progress.totalBytes) {
      const mbReceived = (progress.bytesReceived / 1024 / 1024).toFixed(1);
      const mbTotal = (progress.totalBytes / 1024 / 1024).toFixed(1);
      progressSpeedEl.textContent = `${mbReceived} / ${mbTotal} MB`;
    }
  } else if (message.action === "downloadComplete") {
    updateStatus("Download completed!", "success");
    progressFillEl.style.width = "100%";
    progressTextEl.textContent = "100%";
    setTimeout(() => {
      downloadBtn.disabled = false;
      progressEl.classList.add("hidden");
      progressFillEl.style.width = "0%";
    }, 2000);
  } else if (message.action === "downloadError") {
    showError(message.error || "Download failed");
    downloadBtn.disabled = false;
    progressEl.classList.add("hidden");
    progressFillEl.style.width = "0%";
  }
});

// Activate button handler
activateBtn.addEventListener("click", () => {
  const licenseKey = licenseKeyInput.value;
  // In a real-world scenario, you would validate this key against a server
  // For this example, we'll just check against a hardcoded key
  if (licenseKey === "YOUR_LICENSE_KEY") {
    chrome.storage.local.set({ isActivated: true }, () => {
      isActivated = true;
      toggleContentVisibility();
      updateStatus("Loom Downloader Activated!", "success");
    });
  } else {
    activationStatus.textContent = "Invalid license key";
    activationStatus.className = "status error";
  }
});

// Settings button handler
settingsBtn.addEventListener("click", () => {
  // For now, just show a message
  alert(
    "Settings coming soon! Future features:\n- Video quality selection\n- Download location\n- Auto-download options"
  );
});

// Help button handler
helpBtn.addEventListener("click", () => {
  chrome.tabs.create({
    url: "https://github.com/yourusername/loom-downloader#readme",
  });
});

// Initialize when DOM is loaded

// Initialize when DOM is loaded
document.addEventListener("DOMContentLoaded", init);

// Re-check when popup is opened
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "popupOpened") {
    init();
  }
});
