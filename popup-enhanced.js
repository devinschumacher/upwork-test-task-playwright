// popup-enhanced.js

document.addEventListener("DOMContentLoaded", () => {
  console.log("Popup script loaded and DOM ready");

  const statusDiv = document.getElementById("status");
  const videoInfoDiv = document.getElementById("videoInfo");
  const downloadBtn = document.getElementById("downloadBtn");
  const passwordSection = document.getElementById("passwordSection");
  const passwordInput = document.getElementById("passwordInput");
  const passwordSubmitBtn = document.getElementById("passwordSubmitBtn");
  const helpBtn = document.getElementById("helpBtn");
  const helpTextDisplay = document.getElementById("helpTextDisplay");
  const activationSection = document.getElementById("activationSection");
  const mainContent = document.getElementById("mainContent");
  const licenseKeyInput = document.getElementById("licenseKeyInput");
  const emailInput = document.getElementById("emailInput");
  const activateBtn = document.getElementById("activateBtn");
  const activationStatus = document.getElementById("activationStatus");
  const embedDetected = document.getElementById("embedDetected");
  const qualitySection = document.getElementById("qualitySection");
  const qualitySelect = document.getElementById("qualitySelect");
  const progressContainer = document.getElementById("progress");
  const progressFill = document.getElementById("progressFill");
  const progressText = document.getElementById("progressText");
  const progressSpeed = document.getElementById("progressSpeed");
  let lastRequestId = null;
  const cancelBtn = document.getElementById("cancelBtn");
  console.log("🔍 Cancel button element found:", cancelBtn);

  let currentVideoInfo = null;
  let downloadInProgress = false;
  let currentVideoUrl = null;
  let currentPassword = null;
  let lastDetectedThumbnail = null;
  let passwordRetryInProgress = false;
  const embedSummaryCache = new Map();

  function formatEmbedTitle(rawTitle, fallback) {
    if (!rawTitle || !rawTitle.trim()) {
      return fallback;
    }
    let title = rawTitle
      .replace(/^open\s+video:\s*/i, "")
      .replace(/\s*\|\s*loom$/i, "")
      .replace(/\s*\(loom\)$/i, "")
      .replace(/^[\-–\s]+/, "")
      .trim();
    if (!title) {
      return fallback;
    }
    return title;
  }

  function formatEmbedSourceLabel(source) {
    const map = {
      embed: "Embedded player",
      "video-element": "Video element",
      "video-src": "Video element",
      link: "Share link on page",
      direct: "This Loom tab",
      script: "Script reference",
    };
    const key = String(source || "");
    return map[key] || "Detected on page";
  }

  function formatUrlForDisplay(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.length > 42
        ? `${parsed.pathname.slice(0, 39)}…`
        : parsed.pathname;
      return `${parsed.hostname}${path === "/" ? "" : path}`;
    } catch (error) {
      console.warn("⚠️ Unable to format Loom URL for display:", error);
      return url;
    }
  }

  function ensureAbsoluteThumbnail(url) {
    if (!url) return null;
    if (/^https?:/i.test(url)) {
      return url;
    }
    return `https://cdn.loom.com/${url.replace(/^\/+/g, "")}`;
  }

  function decodeJsonString(raw) {
    if (typeof raw !== "string") return raw;
    try {
      const escaped = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return JSON.parse(`"${escaped}"`);
    } catch (error) {
      return raw;
    }
  }

  function extractVideoId(url) {
    if (!url) return null;
    const match = url.match(/([a-f0-9]{32})/i);
    return match ? match[1].toLowerCase() : null;
  }

  function formatDurationLabel(seconds) {
    if (!seconds || Number.isNaN(seconds)) return "";
    const totalSeconds = Math.max(0, Math.round(Number(seconds)));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  async function fetchEmbedSummary(videoId) {
    if (!videoId) return null;

    try {
      const response = await fetch(`https://www.loom.com/share/${videoId}`, {
        credentials: "omit",
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      const summary = {};
      const stateMatch = html.match(/window.__APOLLO_STATE__ = (\{[\s\S]*?\});/);

      if (stateMatch) {
        try {
          const state = JSON.parse(stateMatch[1]);
          const videoKey = Object.keys(state).find(
            (key) =>
              key.includes(videoId) &&
              state[key] &&
              typeof state[key] === "object" &&
              state[key].__typename &&
              state[key].__typename.toLowerCase().includes("video")
          );

          if (videoKey) {
            const entry = state[videoKey];
            summary.title = entry?.name || summary.title;
            summary.thumbnail =
              entry?.thumbnailUrl ||
              entry?.thumbnails?.default ||
              entry?.signedThumbnails?.default ||
              entry?.defaultThumbnails?.static ||
              entry?.defaultThumbnails?.default ||
              summary.thumbnail;
            summary.duration =
              entry?.playable_duration ||
              entry?.source_duration ||
              entry?.video_properties?.duration ||
              (entry?.video_properties?.durationMs
                ? entry.video_properties.durationMs / 1000
                : summary.duration);
          }
        } catch (parseError) {
          console.warn("⚠️ Failed to parse Loom share state:", parseError);
        }
      }

      if (!summary.thumbnail) {
        const thumbMatch = html.match(/"thumbnailUrl"\s*:\s*"([^\"]+)"/);
        if (thumbMatch) {
          summary.thumbnail = decodeJsonString(thumbMatch[1]);
        }
      }

      if (!summary.thumbnail) {
        const preloadMatch = html.match(/<link[^>]+rel="preload"[^>]+href="([^"]*\/sessions\/thumbnails\/[^"]+\.jpg)"/i);
        if (preloadMatch) {
          summary.thumbnail = preloadMatch[1];
        }
      }

      if (!summary.title) {
        const titleMatch = html.match(/"name"\s*:\s*"([^\"]+)"/);
        if (titleMatch) {
          summary.title = decodeJsonString(titleMatch[1]);
        }
      }

      if (!summary.duration) {
        const durationMatch = html.match(/"playable_duration"\s*:\s*([0-9.]+)/);
        if (durationMatch) {
          summary.duration = parseFloat(durationMatch[1]);
        }
      }

      if (summary.thumbnail) {
        summary.thumbnail = ensureAbsoluteThumbnail(summary.thumbnail);
      }

      if (summary.title) {
        summary.title = formatEmbedTitle(summary.title, summary.title);
      }

      return summary;
    } catch (error) {
      console.warn("⚠️ Unable to fetch Loom preview:", error?.message || error);
      return null;
    }
  }

  function getEmbedSummary(videoId) {
    if (!videoId) return Promise.resolve(null);
    if (!embedSummaryCache.has(videoId)) {
      embedSummaryCache.set(videoId, fetchEmbedSummary(videoId));
    }
    return embedSummaryCache.get(videoId);
  }

  function prepareEmbedPayload(embed, overrides = {}) {
    return {
      id: embed.id,
      url: embed.url,
      pageUrl: embed.pageUrl || embed.url,
      title: embed.title,
      source: embed.source,
      thumbnail: embed.thumbnail || null,
      ...overrides,
    };
  }

  function normalizeEmbed(rawEmbed, index) {
    const fallbackTitle = `Loom video ${index + 1}`;
    const videoId = rawEmbed.id || extractVideoId(rawEmbed.url);
    const shareUrl = rawEmbed.url || (videoId ? `https://www.loom.com/share/${videoId}` : "");
    return {
      id: videoId,
      url: shareUrl,
      source: rawEmbed.source || rawEmbed.elementType || "link",
      title: formatEmbedTitle(rawEmbed.title, fallbackTitle),
      originalTitle: rawEmbed.title,
      pageUrl: rawEmbed.pageUrl || shareUrl,
      thumbnail: rawEmbed.thumbnail || null,
    };
  }

  function createVideoOptionCard(embed, index) {
    const card = document.createElement("article");
    card.className = "video-option-card";
    if (embed.id) {
      card.dataset.videoId = embed.id;
    }

    const preview = document.createElement("div");
    preview.className = "video-option-preview";

    const thumbImg = document.createElement("img");
    thumbImg.className = "video-option-thumb hidden";
    thumbImg.alt = embed.title || "Loom video preview";
    thumbImg.loading = "lazy";
    preview.appendChild(thumbImg);

    const placeholder = document.createElement("div");
    placeholder.className = "video-option-thumb-placeholder";

    const placeholderIcon = document.createElement("div");
    placeholderIcon.className = "video-option-thumb-icon";
    placeholder.appendChild(placeholderIcon);

    const placeholderLabel = document.createElement("span");
    placeholderLabel.className = "video-option-thumb-label";
    placeholderLabel.textContent = "Preview loading…";
    placeholder.appendChild(placeholderLabel);

    preview.appendChild(placeholder);

    const durationBadge = document.createElement("span");
    durationBadge.className = "video-option-duration";
    preview.appendChild(durationBadge);

    const indexBadge = document.createElement("span");
    indexBadge.className = "video-option-index";
    indexBadge.textContent = String(index + 1).padStart(2, "0");
    preview.appendChild(indexBadge);

    const body = document.createElement("div");
    body.className = "video-option-body";

    const titleEl = document.createElement("h3");
    titleEl.className = "video-option-title";
    titleEl.textContent = embed.title;
    body.appendChild(titleEl);

    const meta = document.createElement("div");
    meta.className = "video-option-meta";

    const sourceLabel = document.createElement("span");
    sourceLabel.className = "video-option-source";
    sourceLabel.textContent = formatEmbedSourceLabel(embed.source);
    meta.appendChild(sourceLabel);

    let linkEl = null;
    if (embed.url) {
      const separator = document.createElement("span");
      separator.className = "video-option-meta-separator";
      separator.textContent = "•";
      meta.appendChild(separator);

      linkEl = document.createElement("a");
      linkEl.className = "video-option-link";
      linkEl.href = embed.url;
      linkEl.target = "_blank";
      linkEl.rel = "noreferrer noopener";
      linkEl.textContent = formatUrlForDisplay(embed.url);
      meta.appendChild(linkEl);
    }

    body.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "video-option-actions";

    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "video-option-btn ghost";
    previewBtn.textContent = "Details";

    const quickBtn = document.createElement("button");
    quickBtn.type = "button";
    quickBtn.className = "video-option-btn primary";
    quickBtn.textContent = "Download";

    actions.appendChild(previewBtn);
    actions.appendChild(quickBtn);

    card.appendChild(preview);
    card.appendChild(body);
    body.appendChild(actions);

    card.addEventListener("click", (event) => {
      if (event.target.closest("button") || event.target.tagName === "A") {
        return;
      }
      previewBtn.click();
    });

    const context = {
      card,
      preview,
      thumbImg,
      placeholder,
      placeholderLabel,
      durationBadge,
      titleEl,
      sourceLabel,
      linkEl,
      previewBtn,
      quickBtn,
      updateThumbnail(url) {
        if (!url) return;
        context.currentThumbnail = url;
        thumbImg.src = url;
        thumbImg.onload = () => {
          thumbImg.classList.remove("hidden");
          placeholder.classList.add("hidden");
        };
        thumbImg.onerror = () => {
          thumbImg.classList.add("hidden");
          placeholder.classList.remove("hidden");
        };
      },
      setPlaceholderMessage(message) {
        placeholderLabel.textContent = message;
      },
      setDuration(seconds) {
        const label = formatDurationLabel(seconds);
        durationBadge.textContent = label;
        durationBadge.classList.toggle("hidden", !label);
      },
      setTitle(text) {
        if (text) {
          titleEl.textContent = text;
        }
      },
      currentThumbnail: embed.thumbnail || null,
    };

    return context;
  }

  function showStatus(message, type = "info") {
    statusDiv.innerHTML = "";
    statusDiv.className = `status ${type}`;

    if (message === "Navigate to a Loom video page to begin.") {
      const textSpan = document.createElement("span");
      textSpan.textContent = message;
      statusDiv.appendChild(textSpan);

      const refreshBtn = document.createElement("button");
      refreshBtn.textContent = "🔄 Refresh";
      refreshBtn.className = "refresh-btn";
      refreshBtn.style.marginLeft = "10px";
      refreshBtn.style.padding = "4px 8px";
      refreshBtn.style.fontSize = "12px";
      refreshBtn.style.border = "1px solid #ccc";
      refreshBtn.style.borderRadius = "4px";
      refreshBtn.style.background = "#f5f5f5";
      refreshBtn.style.cursor = "pointer";
      refreshBtn.title = "Try to detect Loom video again";
      refreshBtn.addEventListener("click", () => {
        console.log("🔄 Refresh button clicked - retrying video detection");
        showStatus("Checking current page for Loom video...", "loading");
        checkCurrentTabForVideo();
      });

      statusDiv.appendChild(refreshBtn);
    } else {
      statusDiv.textContent = message;
    }

    console.log(`Status [${type}]: ${message}`);
  }

  function showProgress(percentage, status, speed = "") {
    console.log(`📊 [Popup minimized] ${percentage}% - ${status}`);
    downloadInProgress = true;

    try {
      chrome.storage.local.set({
        downloadInProgress: true,
        downloadPercentage: percentage,
        downloadStatus: status,
        downloadSpeed: speed,
      });
    } catch (error) {
      console.warn("⚠️ Unable to persist download progress state:", error);
    }

    // Keep inline progress hidden - Download Manager handles visuals now.
    progressContainer.classList.add("hidden");
    cancelBtn.disabled = true;
    showStatus(
      "Download in progress. Check the Downloads panel.",
      percentage >= 100 ? "success" : "loading"
    );
  }

  function hideProgress() {
    console.log("🔲 Hiding progress");
    downloadInProgress = false;

    chrome.storage.local.remove([
      "downloadInProgress",
      "downloadPercentage",
      "downloadStatus",
      "downloadSpeed",
    ]);

    cancelBtn.disabled = true;
    progressContainer.classList.add("hidden");
    progressFill.style.width = "0%";
    progressText.textContent = "0%";
    progressSpeed.textContent = "";
  }

  function displayVideoInfo(videoInfo) {
    console.log("🎬 displayVideoInfo called with:", videoInfo);
    console.log("🎬 videoInfoDiv element:", videoInfoDiv);
    console.log("🎬 Current videoInfo structure:", {
      title: videoInfo.title,
      thumbnail: videoInfo.thumbnail,
      duration: videoInfo.duration,
      owner: videoInfo.owner,
      width: videoInfo.width,
      height: videoInfo.height,
      description: videoInfo.description
    });
    
    currentVideoInfo = videoInfo;

    // Update thumbnail
    const thumbnailImg = document.getElementById("videoThumbnail");
    const thumbnailPlaceholder = document.getElementById("thumbnailPlaceholder");
    
    console.log("🎬 Thumbnail elements:", { thumbnailImg, thumbnailPlaceholder });
    
    if (videoInfo.thumbnail) {
      thumbnailImg.src = videoInfo.thumbnail;
      thumbnailImg.onload = () => {
        thumbnailImg.classList.remove("hidden");
        thumbnailPlaceholder.style.display = "none";
      };
      thumbnailImg.onerror = () => {
        thumbnailImg.classList.add("hidden");
        thumbnailPlaceholder.style.display = "flex";
      };
    } else {
      thumbnailImg.classList.add("hidden");
      thumbnailPlaceholder.style.display = "flex";
    }

    // Update duration badge on thumbnail
    const durationBadge = document.getElementById("durationBadge");
    if (videoInfo.duration) {
      const minutes = Math.floor(videoInfo.duration / 60);
      const seconds = Math.floor(videoInfo.duration % 60);
      durationBadge.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    } else {
      durationBadge.textContent = "";
    }

    // Update video details
    const videoTitle = document.getElementById("videoTitle");
    const videoOwner = document.getElementById("videoOwner");
    const videoResolution = document.getElementById("videoResolution");
    const videoDuration = document.getElementById("videoDuration");
    const videoDescription = document.getElementById("videoDescription");
    
    console.log("🎬 Video detail elements:", { 
      videoTitle, videoOwner, videoResolution, videoDuration, videoDescription 
    });

    videoTitle.textContent = videoInfo.title || "Untitled Video";

    // Display owner in metadata
    if (videoInfo.owner) {
      videoOwner.textContent = videoInfo.owner;
    } else {
      videoOwner.textContent = "";
    }

    // Display resolution in metadata
    if (videoInfo.width && videoInfo.height) {
      videoResolution.textContent = `${videoInfo.width}x${videoInfo.height}`;
    } else {
      videoResolution.textContent = "";
    }

    // Display duration in metadata
    if (videoInfo.duration) {
      const minutes = Math.floor(videoInfo.duration / 60);
      const seconds = Math.floor(videoInfo.duration % 60);
      videoDuration.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    } else {
      videoDuration.textContent = "";
    }

    // Display description with automatic truncation (handled by CSS -webkit-line-clamp: 3)
    if (videoInfo.description) {
      videoDescription.textContent = videoInfo.description;
      videoDescription.title = videoInfo.description; // Full text on hover
    } else {
      videoDescription.textContent = "";
    }

    console.log("🎬 Making videoInfoDiv visible...");
    videoInfoDiv.classList.remove("hidden");
    videoInfoDiv.style.display = "block";

    downloadBtn.disabled = false;
    cancelBtn.disabled = true;
    showStatus("Video info extracted. Ready to download.", "success");
  }

  async function extractVideoInfoForUrl({
    url,
    password = null,
    thumbnailFromDOM = null,
    statusMessage = null,
  } = {}) {
    if (!url) {
      console.error("❌ No URL provided for extractVideoInfo");
      showStatus("No video URL available for extraction.", "error");
      return { success: false, error: "No URL provided" };
    }

    currentVideoUrl = url;

    const trimmedPassword = password && password.trim() ? password.trim() : null;
    if (statusMessage) {
      showStatus(statusMessage, "loading");
    }

    console.log("📤 Sending extractVideoInfo message to background with URL:", url);
    const message = {
      action: "extractVideoInfo",
      url,
      password: trimmedPassword,
    };
    console.log("📤 Message being sent:", message);

    try {
      const response = await chrome.runtime.sendMessage(message);

      console.log("📥 Received response from background:", response);
      console.log("🔍 Response type:", typeof response);
      console.log("🔍 Response success:", response?.success);
      console.log("🔍 Response error:", response?.error);
      console.log("🔍 Response videoInfo:", response?.videoInfo);

      if (response && response.success && response.videoInfo) {
        console.log("✅ Video info extracted successfully:", response.videoInfo);

        const enrichedVideoInfo = {
          ...response.videoInfo,
          thumbnail: thumbnailFromDOM || response.videoInfo.thumbnail,
        };

        console.log(
          "🖼️ Final enriched video info:",
          JSON.stringify(enrichedVideoInfo, null, 2)
        );

        if (trimmedPassword) {
          currentPassword = trimmedPassword;
          if (passwordInput && passwordInput.value !== trimmedPassword) {
            passwordInput.value = trimmedPassword;
          }
        }

        lastDetectedThumbnail =
          thumbnailFromDOM || response.videoInfo.thumbnail || lastDetectedThumbnail;

        displayVideoInfo(enrichedVideoInfo);
        passwordSection.classList.add("hidden");
        if (passwordSubmitBtn) {
          passwordSubmitBtn.disabled = false;
        }

        return { success: true, videoInfo: enrichedVideoInfo };
      }

      console.error("❌ Failed to extract video info:", response?.error);
      console.error(
        "❌ Full response object:",
        JSON.stringify(response, null, 2)
      );

      const errorMessage =
        response?.error || "Failed to extract video info.";
      showStatus(errorMessage, "error");

      downloadBtn.disabled = true;
      currentVideoInfo = null;

      if (
        errorMessage.toLowerCase().includes("password") ||
        errorMessage.toLowerCase().includes("unauthorized")
      ) {
        currentPassword = null;
        passwordSection.classList.remove("hidden");
        if (passwordSubmitBtn) {
          passwordSubmitBtn.disabled = false;
        }
        if (passwordInput) {
          if (trimmedPassword) {
            passwordInput.value = trimmedPassword;
          }
          passwordInput.focus();
        }
        showStatus(
          "This video is password-protected. Please provide the password and press Enter.",
          "error"
        );
      }

      return { success: false, error: errorMessage };
    } catch (error) {
      console.error("❌ Error in extractVideoInfoForUrl:", error);
      showStatus(`Error: ${error.message}`, "error");
      downloadBtn.disabled = true;
      currentVideoInfo = null;
      currentPassword = null;
      if (passwordSubmitBtn) {
        passwordSubmitBtn.disabled = false;
      }
      return { success: false, error: error.message };
    }
  }

  async function retryExtractionWithPassword(triggerSource = "manual") {
    if (passwordRetryInProgress) {
      console.log(
        `⏳ Password retry already running (trigger: ${triggerSource}), skipping`
      );
      return;
    }

    if (!currentVideoUrl) {
      console.warn("⚠️ No current video URL to retry extraction with password");
      showStatus("No Loom video detected to unlock.", "warning");
      return;
    }

    const passwordValue = passwordInput ? passwordInput.value.trim() : "";
    if (!passwordValue) {
      showStatus("Please enter the video password first.", "error");
      return;
    }

    passwordRetryInProgress = true;
    if (passwordSubmitBtn) {
      passwordSubmitBtn.disabled = true;
    }
    try {
      // Prefetch thumbnail right before extraction to ensure preview image is present
      try {
        const embed = await chrome.runtime.sendMessage({ action: 'findLoomEmbed' });
        if (embed && embed.success && embed.embedInfo && embed.embedInfo.thumbnail) {
          lastDetectedThumbnail = embed.embedInfo.thumbnail;
        }
      } catch (_) {}

      await extractVideoInfoForUrl({
        url: currentVideoUrl,
        password: passwordValue,
        thumbnailFromDOM: lastDetectedThumbnail,
        statusMessage: "Validating password...",
      });
    } finally {
      passwordRetryInProgress = false;
      if (passwordSubmitBtn) {
        passwordSubmitBtn.disabled = false;
      }
    }
  }

  async function checkCurrentTabForVideo() {
    // Don't run video detection if download is in progress
    if (downloadInProgress) {
      console.log("⚠️ Download in progress, skipping video detection");
      return;
    }
    
    console.log("🔍 Checking current tab for Loom video...");
    
    // Auto-detect Loom URL from current tab
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      console.log("📋 Current tab:", tabs[0]?.url);
      if (
        tabs[0] &&
        tabs[0].url &&
        /loom\.com\/(share|embed)\//.test(tabs[0].url)
      ) {
        console.log("✅ Loom URL detected, auto-processing:", tabs[0].url);
        showStatus(
          "Loom video detected. Automatically extracting info...",
          "loading"
        );

        // Automatically process the detected video
        try {
          // First, try to get thumbnail from the page's video element
          console.log("🔍 First checking for video elements on the page to get thumbnail...");
          const embedResponse = await chrome.runtime.sendMessage({ action: "findLoomEmbed" });
          console.log("📥 findLoomEmbed response for direct URL:", embedResponse);
          console.log("🖼️ Thumbnail found:", embedResponse?.embedInfo?.thumbnail);

          const thumbnailFromDOM = embedResponse?.embedInfo?.thumbnail;
          lastDetectedThumbnail = thumbnailFromDOM || lastDetectedThumbnail;

          const passwordToUse =
            (passwordInput && passwordInput.value ? passwordInput.value : null) ||
            currentPassword;

          await extractVideoInfoForUrl({
            url: tabs[0].url,
            password: passwordToUse,
            thumbnailFromDOM: thumbnailFromDOM,
            statusMessage: null,
          });
        } catch (error) {
          console.error("❌ Error in auto-processing:", error);
          showStatus(`Error: ${error.message}`, "error");
        }
      } else {
        // Check for Loom embed on third-party sites
        showStatus("Checking for Loom embeds...", "loading");
        await checkForLoomEmbeds();
      }
    });
  }

  async function handleDownload() {
    console.log("⬇️ handleDownload called");

    if (!currentVideoInfo) {
      console.error("❌ No video info available for download");
      showStatus(
        "No video information available. Please navigate to a Loom video page first.",
        "error"
      );
      return;
    }

    let password = passwordInput ? passwordInput.value : null;
    if (!password && currentPassword) {
      password = currentPassword;
      if (passwordInput) {
        passwordInput.value = currentPassword;
      }
    }
    if (password && password.trim() === "") {
      password = null;
    }
    const url = currentVideoInfo?.url || currentVideoInfo?.pageUrl;
    const selectedQualityIndex = qualitySelect.value;

    console.log("📤 Starting download with:", {
      url,
      password: password ? "***" : null,
      selectedQualityIndex,
    });

    showStatus("Initiating download...", "loading");
    downloadBtn.disabled = true;
    cancelBtn.disabled = false;

    try {
      // Open the Download Manager immediately so the card is visible right away
      try { chrome.runtime.sendMessage({ action: "openDownloadManager" }); } catch {}

      // Prime a placeholder card to eliminate UI delay
      const reqId = `loom-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      lastRequestId = reqId;
      const primeName = (currentVideoInfo && currentVideoInfo.title) ? currentVideoInfo.title : 'Loom Video';
      try {
        chrome.runtime.sendMessage({
          action: 'showDownloadProgress',
          downloadId: reqId,
          filename: primeName,
          downloaded: 0,
          total: 0,
          progress: 0,
          status: 'Preparing download...'
        });
      } catch {}

      console.log("📤 Sending downloadVideo message to background");
      const response = await chrome.runtime.sendMessage({
        action: "downloadVideo",
        url: url,
        password: password,
        videoInfo: currentVideoInfo,
        selectedQualityIndex: selectedQualityIndex,
        requestId: reqId,
      });

      console.log("📥 Received download response from background:", response);

      if (response && response.success) {
        console.log("✅ Download started successfully");
        showStatus(
          response.message || "Download started successfully!",
          "success"
        );
      } else {
        console.error("❌ Download failed:", response?.error);
        showStatus(
          response?.error || "An unknown error occurred during download.",
          "error"
        );
      }
    } catch (error) {
      console.error("❌ Error in handleDownload:", error);
      showStatus(`Download Error: ${error.message}`, "error");
    } finally {
      // Don't automatically re-enable the button - let the progress tracking handle it
      console.log("🔄 Download request completed, waiting for progress updates");
    }
  }

  async function handleCancelDownload() {
    console.log("❌ User requested download cancellation");
    
    try {
      // Use a promise wrapper for better error handling
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: "cancelDownload", downloadId: lastRequestId || undefined }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
      
      if (response && response.success) {
        console.log("✅ Cancel request sent to background");
        showStatus("Cancelling download...", "warning");
        // Don't hide progress here - let the background script send DOWNLOAD_CANCELLED message
      } else {
        console.error("❌ Failed to cancel download:", response?.message || "No response");
        showStatus(response?.message || "No active download to cancel", "warning");
        // If there's nothing to cancel, disable the cancel button
        cancelBtn.disabled = true;
      }
    } catch (error) {
      console.error("❌ Error cancelling download:", error);
      showStatus("Error communicating with background script", "error");
      // If we can't communicate with background, assume no download and disable cancel button
      cancelBtn.disabled = true;
    }
  }

  // Check for Loom embeds on the current page
  async function checkForLoomEmbeds() {
    console.log("🔍 Checking for Loom embeds on current page...");

    try {
      // First, try content script for all embeds for multi-select UX
      let allEmbeds = [];
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs && tabs[0] && tabs[0].id;
        if (tabId != null) {
          allEmbeds = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, { action: 'getAllLoomEmbeds' }, (resp) => {
              if (chrome.runtime.lastError) return resolve([]);
              resolve((resp && resp.embeds) || []);
            });
          });
        }
      } catch (e) {
        console.warn('⚠️ Unable to query content script for all embeds:', e?.message || e);
      }

      if (Array.isArray(allEmbeds) && allEmbeds.length > 1) {
        // Show selection list
        try { renderMultipleEmbedsList(allEmbeds); } catch (e) { console.warn('⚠️ Failed to render multiple list:', e); }
        showStatus(`${allEmbeds.length} Loom videos found on this page. Select one to download.`, 'success');
        return;
      }

      // Fallback to background heuristic (single embed or direct share)
      const message = { action: "findLoomEmbed" };
      console.log("📤 Sending findLoomEmbed message:", message);
      const response = await chrome.runtime.sendMessage(message);

      console.log("📥 findLoomEmbed response:", response);
      console.log("🔍 findLoomEmbed response type:", typeof response);
      console.log("🔍 findLoomEmbed response success:", response?.success);

      if (response && response.success && response.embedInfo) {
        console.log("✅ Loom embed found:", response.embedInfo);

        // Show the embed detected section
        embedDetected.classList.remove("hidden");

        // Update the embed text with more specific info
        const embedText = document.querySelector(".embed-text");
        if (response.embedInfo.elementType === "video") {
          embedText.textContent = "Loom video element detected on this page!";
        } else {
          embedText.textContent = "Loom embed detected on this page!";
        }

        // Try to get video info for the embed
        const shareUrl = `https://www.loom.com/share/${response.embedInfo.videoId}`;
        currentVideoUrl = shareUrl;
        lastDetectedThumbnail = response.embedInfo.thumbnail || lastDetectedThumbnail;

        try {
          const result = await extractVideoInfoForUrl({
            url: shareUrl,
            password:
              currentPassword || (passwordInput && passwordInput.value) || null,
            thumbnailFromDOM: response.embedInfo.thumbnail,
            statusMessage: "Extracting embedded video info...",
          });

          if (result.success) {
            showStatus("Ready to download embedded video", "success");
          } else {
            showStatus("Loom embed detected! Ready to download.", "success");
            downloadBtn.disabled = false;
          }
        } catch (videoInfoError) {
          console.error(
            "❌ Error getting video info for embed:",
            videoInfoError
          );
          showStatus("Loom embed detected! Ready to download.", "success");
          // Still enable the download button even if we can't get video info
          downloadBtn.disabled = false;
        }
      } else {
        console.log("❌ No Loom embed found on page");
        embedDetected.classList.add("hidden");
        showStatus("Navigate to a Loom video page to begin.", "info");
      }
    } catch (error) {
      console.error("❌ Error checking for Loom embeds:", error);
      embedDetected.classList.add("hidden");
      showStatus("Navigate to a Loom video page to begin.", "info");
    }
  }

  function renderMultipleEmbedsList(embeds) {
    const section = document.getElementById("videoSelectionSection");
    const list = document.getElementById("videoList");
    if (!section || !list) return;

    const dedupe = new Set();
    const normalizedEmbeds = [];

    embeds.forEach((rawEmbed, index) => {
      const normalized = normalizeEmbed(rawEmbed, index);
      const dedupeKey = normalized.url || normalized.id || `idx-${index}`;
      if (dedupe.has(dedupeKey)) return;
      dedupe.add(dedupeKey);
      normalizedEmbeds.push(normalized);
    });

    list.innerHTML = "";

    if (!normalizedEmbeds.length) {
      section.classList.add("hidden");
      return;
    }

    section.classList.remove("hidden");
    embedDetected.classList.add("hidden");
    list.classList.add("video-list-grid");
    list.dataset.count = String(normalizedEmbeds.length);

    const markSelected = (targetCard) => {
      list.querySelectorAll(".video-option-card.selected").forEach((node) => {
        node.classList.remove("selected");
      });
      if (targetCard) {
        targetCard.classList.add("selected");
      }
    };

    normalizedEmbeds.forEach((embedData, index) => {
      const cardCtx = createVideoOptionCard(embedData, index);
      const cardRecord = { embed: embedData, ctx: cardCtx };

      if (embedData.thumbnail) {
        cardCtx.updateThumbnail(embedData.thumbnail);
      } else {
        cardCtx.setPlaceholderMessage("Preview loading…");
      }
      cardCtx.setDuration(null);

      list.appendChild(cardCtx.card);

      const resolvePayload = () =>
        prepareEmbedPayload(cardRecord.embed, {
          title: cardCtx.titleEl.textContent,
          thumbnail: cardCtx.currentThumbnail || cardRecord.embed.thumbnail || null,
        });

      cardCtx.previewBtn.addEventListener("click", async () => {
        const payload = resolvePayload();
        currentVideoInfo = payload;
        markSelected(cardCtx.card);
        downloadBtn.disabled = true;
        section.classList.add("hidden");

        try {
          const result = await extractVideoInfoForUrl({
            url: payload.url,
            password:
              currentPassword || (passwordInput && passwordInput.value) || null,
            thumbnailFromDOM: payload.thumbnail,
            statusMessage: "Loading video details...",
          });

          if (result?.success && result?.videoInfo) {
            if (result.videoInfo.thumbnail) {
              cardCtx.updateThumbnail(result.videoInfo.thumbnail);
            }
            if (result.videoInfo.duration) {
              cardCtx.setDuration(result.videoInfo.duration);
            }
          } else {
            section.classList.remove("hidden");
          }
        } catch (error) {
          console.warn(
            "⚠️ Failed to load embed details:",
            error?.message || error
          );
          section.classList.remove("hidden");
        }
      });

      cardCtx.quickBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        const payload = resolvePayload();
        currentVideoInfo = payload;
        markSelected(cardCtx.card);

        try {
          await handleDownload();
        } catch (error) {
          console.warn(
            "⚠️ Quick download failed:",
            error?.message || error
          );
        }
      });

      if (cardRecord.embed.id) {
        getEmbedSummary(cardRecord.embed.id)
          .then((summary) => {
            if (!summary) {
              cardCtx.setPlaceholderMessage("Preview not available");
              return;
            }

            if (summary.title) {
              cardRecord.embed.title = summary.title;
              cardCtx.setTitle(summary.title);
            }

            if (summary.thumbnail) {
              cardRecord.embed.thumbnail = summary.thumbnail;
              cardCtx.updateThumbnail(summary.thumbnail);
            }

            if (summary.duration) {
              cardCtx.setDuration(summary.duration);
            }
          })
          .catch((error) => {
            console.warn(
              "⚠️ Failed to hydrate Loom preview:",
              error?.message || error
            );
            cardCtx.setPlaceholderMessage("Preview not available");
          });
      }
    });
  }

  // Event Listeners
  if (passwordInput) {
    passwordInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        retryExtractionWithPassword("enter");
      }
    });

    passwordInput.addEventListener("change", () => {
      retryExtractionWithPassword("change");
    });
  }

  if (passwordSubmitBtn) {
    passwordSubmitBtn.addEventListener("click", (event) => {
      event.preventDefault();
      retryExtractionWithPassword("button");
    });
  }

  downloadBtn.addEventListener("click", handleDownload);
  cancelBtn.addEventListener("click", (event) => {
    console.log("🖱️ Cancel button clicked!");
    console.log("🖱️ Cancel button disabled state:", cancelBtn.disabled);
    console.log("🖱️ Download in progress:", downloadInProgress);
    if (!cancelBtn.disabled) {
      handleCancelDownload();
    } else {
      console.log("⚠️ Cancel button is disabled, ignoring click");
    }
  });
  let helpTimeout;
  helpBtn.addEventListener("click", () => {
    // Clear any existing timeout
    if (helpTimeout) {
      clearTimeout(helpTimeout);
    }

    // Show help text
    helpTextDisplay.classList.remove("hidden");
    
    // Hide help text after 5 seconds
    helpTimeout = setTimeout(() => {
      helpTextDisplay.classList.add("hidden");
    }, 5000);
  });

  activateBtn.addEventListener("click", handleActivation);

  // Initialize button states on popup load
  async function initializeButtonStates() {
    try {
      // Check if there's a download in progress using promise wrapper
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: "checkDownloadStatus" }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
      
      if (response && response.success && response.inProgress) {
        // Download is active, enable cancel button
        cancelBtn.disabled = false;
        downloadBtn.disabled = true;
        showStatus("Download in progress. Check the Downloads panel.", "loading");
      } else {
        // No download active, disable cancel button
        cancelBtn.disabled = true;
      }
    } catch (error) {
      console.log("Could not check download status:", error);
      cancelBtn.disabled = true;
    }
  }

  // Initialize on DOM load
  initializeButtonStates();

  async function handleActivation() {
    const licenseKey = licenseKeyInput.value.trim();
    const email = emailInput.value.trim();

    if (!email) {
      activationStatus.textContent = "Please enter your email.";
      activationStatus.className = "status error";
      return;
    }

    if (!licenseKey) {
      activationStatus.textContent = "Please enter a license key.";
      activationStatus.className = "status error";
      return;
    }

    activationStatus.textContent = "Verifying license key...";
    activationStatus.className = "status loading";
    activateBtn.disabled = true;

    try {
      const result = await Auth.activateLicense(licenseKey, email);
      
      if (result.success) {
        activationStatus.className = "activation-status";
        activationStatus.innerHTML = `<div class="status-banner success">Activation successful!</div>`;
        setTimeout(() => {
          activationStatus.innerHTML = `<div class="status-banner info">Loading extension...</div>`;
          setTimeout(() => {
            showActivationSuccess();
          }, 700);
        }, 700);
      } else {
        activationStatus.textContent = result.error || "License verification failed.";
        activationStatus.className = "status error";
      }
    } catch (error) {
      console.error("Error during activation:", error);
      activationStatus.textContent = "An error occurred during verification. Please try again.";
      activationStatus.className = "status error";
    } finally {
      activateBtn.disabled = false;
    }
  }

  function showActivationSuccess() {
    activationSection.classList.add("hidden");
    mainContent.classList.remove("hidden");
    showStatus("Loom Downloader activated!", "success");
    
    // Check download state first, then video detection if needed
    setTimeout(() => {
      checkDownloadState();
    }, 1000); // Small delay to let the success message show briefly
  }

  function checkDownloadState() {
    chrome.storage.local.get(["downloadInProgress", "downloadPercentage", "downloadStatus", "downloadSpeed"], (data) => {
      console.log("🔍 Checking stored download state:", data);
      if (data.downloadInProgress) {
        console.log("📥 Restoring download progress display");
        // Verify download is actually still in progress by asking background script
        try {
          chrome.runtime.sendMessage({ action: "checkDownloadStatus" }, (response) => {
            if (chrome.runtime.lastError) {
              // If we can't reach background script, assume no download and clear state
              console.log("🧹 Cannot check download status, clearing state:", chrome.runtime.lastError);
              hideProgress();
              checkCurrentTabForVideo();
              return;
            }
            
            if (response && response.inProgress) {
              showProgress(
                data.downloadPercentage || 0,
                data.downloadStatus || "Downloading...",
                data.downloadSpeed || ""
              );
            } else {
              // Download is no longer active, clear stale state and show video detection
              console.log("🧹 Clearing stale download state");
              hideProgress();
              checkCurrentTabForVideo();
            }
          });
        } catch (error) {
          // If we can't reach background script, assume no download and clear state
          console.log("🧹 Cannot check download status, clearing state:", error);
          hideProgress();
          checkCurrentTabForVideo();
        }
      } else {
        // No download in progress, run video detection
        checkCurrentTabForVideo();
      }
    });
  }

  function showMainContent() {
    activationSection.classList.add("hidden");
    mainContent.classList.remove("hidden");
    // If there is a pending URL requiring a password (from overlay), handle that first
    checkAndHandlePendingPassword().then((handled) => {
      if (!handled) {
        checkDownloadState();
      }
    });
  }

  async function checkAndHandlePendingPassword() {
    try {
      const data = await chrome.storage.local.get([
        'loomPendingUrl',
        'loomPendingSource',
        'loomPendingRequirePassword',
      ]);
      const pendingUrl = data?.loomPendingUrl || null;
      const requirePwd = !!data?.loomPendingRequirePassword;
      if (pendingUrl && requirePwd) {
        try {
          await chrome.storage.local.remove(['loomPendingUrl','loomPendingSource','loomPendingRequirePassword']);
        } catch (_) {}

        currentVideoUrl = pendingUrl;
        // Try to prefetch a thumbnail from the active tab's embed
        try {
          const embed = await chrome.runtime.sendMessage({ action: "findLoomEmbed" });
          if (embed && embed.success && embed.embedInfo && embed.embedInfo.thumbnail) {
            lastDetectedThumbnail = embed.embedInfo.thumbnail;
          }
        } catch (_) {}
        // Show password prompt UI
        passwordSection.classList.remove('hidden');
        if (passwordInput) {
          passwordInput.value = '';
          setTimeout(() => { try { passwordInput.focus(); } catch (_) {} }, 50);
        }
        downloadBtn.disabled = true;
        showStatus('This video is password-protected. Please enter the password and press Unlock.', 'warning');
        return true;
      }
    } catch (e) {
      // ignore
    }
    return false;
  }

  // Check activation status on load
  Auth.checkActivationStatus().then((status) => {
    console.log("🔍 Checking activation status:", status);
    if (status.isActivated) {
      showMainContent();
    } else {
      activationSection.classList.remove("hidden");
      mainContent.classList.add("hidden");
    }
  });

  // Listen for progress updates from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("📩 Popup received message:", message);
    
    switch (message.type) {
      case "VIDEO_INFO_UPDATE":
        try {
          if (!currentVideoInfo) currentVideoInfo = {};
          if (typeof message.duration === 'number' && message.duration > 0) {
            currentVideoInfo.duration = message.duration;
            // Refresh duration display only
            const durationBadge = document.getElementById("durationBadge");
            const videoDuration = document.getElementById("videoDuration");
            const minutes = Math.floor(message.duration / 60);
            const seconds = Math.floor(message.duration % 60);
            const text = `${minutes}:${seconds.toString().padStart(2, '0')}`;
            if (durationBadge) durationBadge.textContent = text;
            if (videoDuration) videoDuration.textContent = text;
          }
        } catch {}
        break;
      case "DOWNLOAD_PROGRESS":
        showProgress(
          message.percentage,
          message.status,
          message.speed || ""
        );
        break;
      case "DOWNLOAD_COMPLETE":
        downloadInProgress = false;
        hideProgress();
        showStatus(message.status || "Download completed!", "success");
        downloadBtn.disabled = false;
        cancelBtn.disabled = true;
        setTimeout(() => {
          checkCurrentTabForVideo();
        }, 3000);
        break;
      case "DOWNLOAD_ERROR":
        hideProgress();
        showStatus(message.error || "Download failed", "error");
        // Reset to initial state after showing error briefly
        setTimeout(() => {
          checkCurrentTabForVideo();
        }, 3000);
        break;
      case "DOWNLOAD_CANCELLED":
        console.log("✅ Download cancelled, resetting UI");
        downloadInProgress = false;
        hideProgress();
        showStatus("Download cancelled", "warning");
        downloadBtn.disabled = false;
        cancelBtn.disabled = true;
        // Reset to initial state after showing cancellation message briefly
        setTimeout(() => {
          checkCurrentTabForVideo();
        }, 2000);
        break;
    }
  });
});
