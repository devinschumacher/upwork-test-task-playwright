// Content script for Loom video downloader
// Prevent multiple executions
if (window.loomDownloaderContentLoaded) {
  console.log("Loom downloader content script already loaded, skipping...");
} else {
  window.loomDownloaderContentLoaded = true;
  console.log("Loom downloader content script loaded");

  const BRAND_ACCENT =
    (globalThis.SiteConfig?.COLORS?.brandAccent) || "#625df5";
  // Activation gate for overlay and card download controls
  let __loomIsActivated = false;
  let __loomEnforceTimer = null;
  function readActivationState(triggerScan = false) {
    try {
      chrome.storage.local.get(['isActivated'], (data) => {
        __loomIsActivated = !!(data && data.isActivated);
        if (triggerScan && __loomIsActivated) {
          try { scanForOverlayButtons(document); } catch {}
          try { scanForLibraryCards(document); } catch {}
        }
        if (!__loomIsActivated) {
          // Proactively remove any injected controls when deactivated
          try { removeOverlayButtons(document); } catch {}
          try { removeCardButtons(document); } catch {}
        }
      });
    } catch (_) {}
  }

  // Function to extract video information from the current page
  function extractVideoInfo() {
    const url = window.location.href;
    let videoInfo = null;

    // Check if this is a Loom share URL (direct loom.com page)
    if (url.includes("loom.com/share/")) {
      const videoId = url.match(/loom\.com\/share\/([a-f0-9]{32})/)?.[1];
      if (videoId) {
        const title =
          document.title.replace(" - Loom", "").trim() ||
          `Loom Video ${videoId}`;
        videoInfo = {
          id: videoId,
          title: title,
          url: url,
          isLoomVideo: true,
          source: "direct",
        };
      }
    }

    // Check for Loom embeds on any website
    if (!videoInfo) {
      videoInfo = findLoomEmbeds();
    }

    return videoInfo;
  }

  // Function to find Loom embeds on any website
  function findLoomEmbeds() {
    const loomEmbeds = [];

    // Look for Loom iframes FIRST (highest priority for embeds)
    const iframes = document.querySelectorAll("iframe");
    iframes.forEach((iframe) => {
      const src = iframe.src;
      if (src && src.includes("loom.com/embed/")) {
        const videoId = src.match(/loom\.com\/embed\/([a-f0-9]{32})/)?.[1];
        if (videoId) {
          loomEmbeds.push({
            id: videoId,
            title:
              iframe.title ||
              iframe.getAttribute("aria-label") ||
              `Loom Video ${videoId}`,
            url: `https://www.loom.com/share/${videoId}`,
            embedSrc: src,
            element: iframe,
            isLoomVideo: true,
            source: "embed",
          });
        }
      }
    });

    // If we found an iframe embed, return it immediately (prioritize proper embeds)
    if (loomEmbeds.length > 0) {
      console.log(`Found ${loomEmbeds.length} Loom iframe embeds (prioritized):`, loomEmbeds);
      return loomEmbeds[0];
    }

    // Look for Loom video elements with data-loom-video-id only if no iframe found
    const videoElements = document.querySelectorAll(
      "video[data-loom-video-id]"
    );
    videoElements.forEach((video) => {
      const videoId = video.getAttribute("data-loom-video-id");
      if (videoId && videoId.length === 32) {
        // Only accept 32-character IDs for video elements
        loomEmbeds.push({
          id: videoId,
          title:
            video.getAttribute("title") ||
            video.getAttribute("aria-label") ||
            `Loom Video ${videoId}`,
          url: `https://www.loom.com/share/${videoId}`,
          element: video,
          isLoomVideo: true,
          source: "video-element",
        });
      }
    });

    // Look for other Loom video elements by class or ID
    const loomVideoElements = document.querySelectorAll(
      'video[id*="Loom"], video[class*="loom"], video[class*="Loom"]'
    );
    loomVideoElements.forEach((video) => {
      const src = video.src || video.getAttribute("src");
      if (src && src.includes("loom.com")) {
        const videoId = src.match(/([a-f0-9]{32})/)?.[1];
        if (videoId) {
          // Check if we already found this video
          const existingEmbed = loomEmbeds.find((embed) => embed.id === videoId);
          if (!existingEmbed) {
            loomEmbeds.push({
              id: videoId,
              title:
                video.getAttribute("title") ||
                video.getAttribute("aria-label") ||
                `Loom Video ${videoId}`,
              url: `https://www.loom.com/share/${videoId}`,
              element: video,
              isLoomVideo: true,
              source: "video-src",
            });
          }
        }
      }
    });

    // Look for Loom links in the page
    const links = document.querySelectorAll('a[href*="loom.com/share/"]');
    links.forEach((link) => {
      const href = link.href;
      const videoId = href.match(/loom\.com\/share\/([a-f0-9]{32})/)?.[1];
      if (videoId) {
        // Check if we already found this video in an embed
        const existingEmbed = loomEmbeds.find((embed) => embed.id === videoId);
        if (!existingEmbed) {
          loomEmbeds.push({
            id: videoId,
            title:
              link.textContent.trim() ||
              link.getAttribute("aria-label") ||
              `Loom Video ${videoId}`,
            url: href,
            element: link,
            isLoomVideo: true,
            source: "link",
          });
        }
      }
    });

    // Look for Loom embeds in script tags or data attributes
    const scripts = document.querySelectorAll("script");
    scripts.forEach((script) => {
      const content = script.textContent || script.innerHTML;
      if (content.includes("loom.com")) {
        const matches = content.match(
          /loom\.com\/(?:embed|share)\/([a-f0-9]{32})/g
        );
        if (matches) {
          matches.forEach((match) => {
            const videoId = match.match(/([a-f0-9]{32})/)?.[1];
            if (videoId) {
              // Check if we already found this video
              const existingEmbed = loomEmbeds.find(
                (embed) => embed.id === videoId
              );
              if (!existingEmbed) {
                loomEmbeds.push({
                  id: videoId,
                  title: `Loom Video ${videoId}`,
                  url: `https://www.loom.com/share/${videoId}`,
                  isLoomVideo: true,
                  source: "script",
                });
              }
            }
          });
        }
      }
    });

    console.log(`Found ${loomEmbeds.length} Loom embeds on page:`, loomEmbeds);

    // Return the first found embed, or null if none found
    return loomEmbeds.length > 0 ? loomEmbeds[0] : null;
  }

  // Function to get all Loom embeds (for popup use)
  function getAllLoomEmbeds() {
    const url = window.location.href;
    const allEmbeds = [];

    // Check if this is a direct Loom page
    if (url.includes("loom.com/share/")) {
      const videoId = url.match(/loom\.com\/share\/([a-f0-9]{32})/)?.[1];
      if (videoId) {
        const title =
          document.title.replace(" - Loom", "").trim() ||
          `Loom Video ${videoId}`;
        allEmbeds.push({
          id: videoId,
          title: title,
          url: url,
          isLoomVideo: true,
          source: "direct",
        });
      }
    }

    // Find all embeds using the existing function logic
    const loomEmbeds = [];

    // Look for Loom iframes FIRST (highest priority for embeds)
    const iframes = document.querySelectorAll("iframe");
    iframes.forEach((iframe) => {
      const src = iframe.src;
      if (src && src.includes("loom.com/embed/")) {
        const videoId = src.match(/loom\.com\/embed\/([a-f0-9]{32})/)?.[1];
        if (videoId) {
          loomEmbeds.push({
            id: videoId,
            title:
              iframe.title ||
              iframe.getAttribute("aria-label") ||
              `Loom Video ${videoId}`,
            url: `https://www.loom.com/share/${videoId}`,
            embedSrc: src,
            element: iframe,
            isLoomVideo: true,
            source: "embed",
          });
        }
      }
    });

    // Look for Loom video elements with data-loom-video-id only if not already found
    const videoElements = document.querySelectorAll(
      "video[data-loom-video-id]"
    );
    videoElements.forEach((video) => {
      const videoId = video.getAttribute("data-loom-video-id");
      if (videoId && videoId.length === 32) {
        // Only accept 32-character IDs for video elements
        // Check if we already found this video
        const existingEmbed = loomEmbeds.find((embed) => embed.id === videoId);
        if (!existingEmbed) {
          loomEmbeds.push({
            id: videoId,
            title:
              video.getAttribute("title") ||
              video.getAttribute("aria-label") ||
              `Loom Video ${videoId}`,
            url: `https://www.loom.com/share/${videoId}`,
            element: video,
            isLoomVideo: true,
            source: "video-element",
          });
        }
      }
    });

    // Look for other Loom video elements by class or ID in getAllLoomEmbeds too
    const loomVideoElements = document.querySelectorAll(
      'video[id*="Loom"], video[class*="loom"], video[class*="Loom"]'
    );
    loomVideoElements.forEach((video) => {
      const src = video.src || video.getAttribute("src");
      if (src && src.includes("loom.com")) {
        const videoId = src.match(/([a-f0-9]{32})/)?.[1];
        if (videoId) {
          // Check if we already found this video
          const existingEmbed = loomEmbeds.find((embed) => embed.id === videoId);
          if (!existingEmbed) {
            loomEmbeds.push({
              id: videoId,
              title:
                video.getAttribute("title") ||
                video.getAttribute("aria-label") ||
                `Loom Video ${videoId}`,
              url: `https://www.loom.com/share/${videoId}`,
              element: video,
              isLoomVideo: true,
              source: "video-src",
            });
          }
        }
      }
    });

    // Look for Loom links in the page
    const links = document.querySelectorAll('a[href*="loom.com/share/"]');
    links.forEach((link) => {
      const href = link.href;
      const videoId = href.match(/loom\.com\/share\/([a-f0-9]{32})/)?.[1];
      if (videoId) {
        // Check if we already found this video in an embed
        const existingEmbed = loomEmbeds.find((embed) => embed.id === videoId);
        if (!existingEmbed) {
          loomEmbeds.push({
            id: videoId,
            title:
              link.textContent.trim() ||
              link.getAttribute("aria-label") ||
              `Loom Video ${videoId}`,
            url: href,
            element: link,
            isLoomVideo: true,
            source: "link",
          });
        }
      }
    });

    // Look for Loom embeds in script tags or data attributes
    const scripts = document.querySelectorAll("script");
    scripts.forEach((script) => {
      const content = script.textContent || script.innerHTML;
      if (content.includes("loom.com")) {
        const matches = content.match(
          /loom\.com\/(?:embed|share)\/([a-f0-9]{32})/g
        );
        if (matches) {
          matches.forEach((match) => {
            const videoId = match.match(/([a-f0-9]{32})/)?.[1];
            if (videoId) {
              // Check if we already found this video
              const existingEmbed = loomEmbeds.find(
                (embed) => embed.id === videoId
              );
              if (!existingEmbed) {
                loomEmbeds.push({
                  id: videoId,
                  title: `Loom Video ${videoId}`,
                  url: `https://www.loom.com/share/${videoId}`,
                  isLoomVideo: true,
                  source: "script",
                });
              }
            }
          });
        }
      }
    });

    allEmbeds.push(...loomEmbeds);

    return allEmbeds;
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getVideoInfo") {
      const videoInfo = extractVideoInfo();
      sendResponse({ success: true, videoInfo });
    } else if (request.action === "getAllLoomEmbeds") {
      const allEmbeds = getAllLoomEmbeds();
      sendResponse({ success: true, embeds: allEmbeds });
    }
  });

  // Cross-tab UI synchronization and DOM bridge
  async function requestDownloadSnapshot() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'getDownloadSnapshot' });
      if (resp && resp.success) {
        try {
          window.dispatchEvent(new CustomEvent('loomDownloader:stateSnapshot', { detail: resp.snapshot }));
        } catch (_) {}
      }
    } catch (e) {
      // ignore
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      requestDownloadSnapshot();
    }
  });

  window.addEventListener('loomDownloader:requestSnapshot', () => {
    requestDownloadSnapshot();
  });

  window.addEventListener('loomDownloader:cancelDownload', (ev) => {
    try {
      const detail = ev?.detail || {};
      const downloadId = detail.downloadId != null ? String(detail.downloadId) : null;
      if (!downloadId) return;
      chrome.runtime.sendMessage({ action: 'cancelDownload', downloadId });
    } catch (_) {}
  });

  window.addEventListener('loomDownloader:clearCompleted', () => {
    try {
      chrome.runtime.sendMessage({ action: 'downloadManagerRemoveEntries' });
    } catch (_) {}
  });

  window.addEventListener('loomDownloader:openManager', () => {
    try { chrome.runtime.sendMessage({ action: 'openDownloadManager' }); } catch (_) {}
  });

  // Function to periodically check for new Loom embeds (for dynamic content)
  function checkForNewEmbeds() {
    const videoInfo = extractVideoInfo();
    if (videoInfo) {
      console.log("Loom video detected:", videoInfo);

      // Optionally notify the background script about new embeds
      try {
        if (chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({
            action: "loomEmbedDetected",
            videoInfo: videoInfo,
          }).catch((err) => {
            // Ignore errors if background script isn't listening
            console.log("Background script not available:", err);
          });
        }
      } catch (err) {
        // Extension context invalidated, ignore
        console.log("Extension context invalidated:", err);
      }
    }
  }

  // ===========================
  // Inline overlay download button (mirrors Vimeo behaviour)
  // ===========================
  const OVERLAY_BUTTON_ID = "loom-download-overlay-btn";
  const OVERLAY_ACCENT = BRAND_ACCENT;
  const overlayInjected = new WeakSet();

  function findOverlayContainers(root = document) {
    const selectors = [
      ".video-container",
      "[data-testid='video-container']",
      ".loom-video-container",
      ".loom-player-container",
      ".loomVideoPlayer",
      "[data-loom-player]",
    ];
    const results = new Set();

    try {
      selectors.forEach((selector) => {
        try {
          root.querySelectorAll(selector).forEach((el) => {
            if (el instanceof Element) results.add(el);
          });
        } catch (e) {
          // Ignore invalid selectors
        }
      });

      // Explicitly support plain Loom embed iframes
      try {
        const iframeList = root.querySelectorAll("iframe[src*='loom.com/embed/']");
        iframeList.forEach((iframe) => {
          if (!(iframe instanceof Element)) return;
          // Prefer a known player container ancestor; fall back to parent element
          const container = iframe.closest(
            ".video-container, [data-testid='video-container'], .loom-video-container, .loom-player-container, .loomVideoPlayer, [data-loom-player]"
          ) || iframe.parentElement || iframe;
          if (container instanceof Element) results.add(container);
        });
      } catch (_) {}

      root.querySelectorAll("video[data-loom-video-id]").forEach((videoEl) => {
        if (videoEl instanceof Element) {
          const parent = videoEl.closest(".video-container") || videoEl.parentElement;
          if (parent instanceof Element) {
            results.add(parent);
          }
        }
      });
    } catch (error) {
      console.warn("⚠️ Error locating Loom video containers:", error);
    }

    return Array.from(results);
  }

  function ensureOverlayPositioning(container) {
    try {
      const style = getComputedStyle(container);
      if (!style.position || style.position === "static") {
        container.style.position = "relative";
      }
    } catch {}
  }

  function resolveVideoUrlFromContainer(container) {
    if (!container) return null;

    const attrUrl =
      container.getAttribute("data-share-url") ||
      (container.dataset ? container.dataset.shareUrl : null);
    if (attrUrl) return attrUrl;

    const iframe = container.querySelector("iframe[src*='loom.com']");
    if (iframe && iframe.src) {
      const match = iframe.src.match(/([a-f0-9]{32})/i);
      if (match && match[1]) {
        return `https://www.loom.com/share/${match[1]}`;
      }
    }

    const video = container.querySelector("video[data-loom-video-id]");
    if (video) {
      const videoId = video.getAttribute("data-loom-video-id");
      if (videoId) {
        return `https://www.loom.com/share/${videoId}`;
      }
    }

    const dataVideoId =
      container.getAttribute("data-video-id") ||
      (container.dataset ? container.dataset.videoId : null);
    if (dataVideoId) {
      return `https://www.loom.com/share/${dataVideoId}`;
    }

    return null;
  }

  function createOverlayButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = `${OVERLAY_BUTTON_ID}-${Math.random().toString(36).slice(2, 7)}`;
    btn.textContent = "Download";
    btn.title = "Download this Loom video";
    btn.style.cssText = [
      "position:absolute",
      "top:12px",
      "right:12px",
      "z-index:2147483647",
      "padding:7px 12px",
      "font-size:12px",
      "font-weight:600",
      `background:${OVERLAY_ACCENT}`,
      "color:#fff",
      "border:none",
      "border-radius:8px",
      "box-shadow:0 2px 10px rgba(0,0,0,0.35)",
      "cursor:pointer",
      "opacity:0.94",
      "transition:opacity .2s ease, transform .1s ease",
      "user-select:none",
      "pointer-events:auto",
    ].join(";");
    btn.onmouseenter = () => (btn.style.opacity = "1");
    btn.onmouseleave = () => (btn.style.opacity = "0.94");
    btn.onmousedown = () => (btn.style.transform = "scale(0.97)");
    btn.onmouseup = () => (btn.style.transform = "scale(1)");
    return btn;
  }

  function attachOverlayButton(container) {
    if (!__loomIsActivated) return;
    if (!container || overlayInjected.has(container)) return;

    if (container.querySelector(`[id^='${OVERLAY_BUTTON_ID}']`)) {
      overlayInjected.add(container);
      return;
    }

    ensureOverlayPositioning(container);
    const btn = createOverlayButton();

    btn.addEventListener(
      "click",
      async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const previousLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Starting...";

        try {
          // Ensure the download manager is visible
          try {
            if (globalThis.globalDownloadManager) {
              globalThis.globalDownloadManager.show();
            } else {
              chrome.runtime.sendMessage({ action: "openDownloadManager" });
            }
          } catch {}

          const videoInfo =
            typeof extractVideoInfo === "function"
              ? extractVideoInfo()
              : null;
          const fallbackUrl = resolveVideoUrlFromContainer(container);
          const targetUrl =
            (videoInfo && videoInfo.url) || fallbackUrl || window.location.href;

          // Preflight: if password is required, open popup to collect it
          try {
            const resp = await chrome.runtime.sendMessage({ action: "extractVideoInfo", url: targetUrl });
            if (resp && resp.success) {
              await chrome.runtime.sendMessage({
                action: "downloadVideo",
                url: targetUrl,
                videoInfo: videoInfo || resp.videoInfo || undefined,
                selectedQualityIndex: null,
              });
            } else if (resp && /password|protected|unauthorized/i.test(String(resp.error || ''))) {
              try {
                await chrome.runtime.sendMessage({ action: 'openPopupForPassword', url: targetUrl, source: 'overlay' });
              } catch (_) {}
            } else {
              // Fallback to attempting download; background will handle errors
              await chrome.runtime.sendMessage({
                action: "downloadVideo",
                url: targetUrl,
                videoInfo: videoInfo || undefined,
                selectedQualityIndex: null,
              });
            }
          } catch (e) {
            // If preflight fails due to permissions, still attempt direct download
            await chrome.runtime.sendMessage({
              action: "downloadVideo",
              url: targetUrl,
              videoInfo: videoInfo || undefined,
              selectedQualityIndex: null,
            });
          }
        } catch (error) {
          console.warn("⚠️ Failed to start Loom download from overlay:", error);
        } finally {
          btn.disabled = false;
          btn.textContent = previousLabel;
        }
      },
      { capture: true }
    );

    container.appendChild(btn);
    overlayInjected.add(container);
  }

  function scanForOverlayButtons(root = document) {
    if (!__loomIsActivated) return;
    try {
      const containers = findOverlayContainers(root);
      containers.forEach((container) => attachOverlayButton(container));
    } catch (error) {
      console.warn("⚠️ Error scanning for Loom overlay containers:", error);
    }
  }

  function removeOverlayButtons(root = document) {
    try {
      root.querySelectorAll(`[id^='${OVERLAY_BUTTON_ID}']`).forEach((el) => { try { el.remove(); } catch (_) {} });
    } catch (_) {}
  }

  // ===========================
  // Library card download button
  // ===========================
  const CARD_BUTTON_CLASS = "loom-download-card-button";
  let cardButtonStyleInjected = false;

  function ensureCardButtonStyles() {
    if (cardButtonStyleInjected) return;
    try {
      const head = document.head || document.documentElement;
      if (!head) return;
      const existing = head.querySelector(
        `style[data-loom-button='card']`
      );
      if (existing) {
        cardButtonStyleInjected = true;
        return;
      }
      const style = document.createElement("style");
      style.type = "text/css";
      style.setAttribute("data-loom-button", "card");
      style.textContent = `
.${CARD_BUTTON_CLASS} {
  position: absolute;
  bottom: 12px;
  right: 12px;
  width: 40px;
  height: 40px;
  border-radius: 9999px;
  background: ${BRAND_ACCENT};
  color: #fff;
  border: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  cursor: pointer;
  opacity: 0.94;
  transition: opacity 0.2s ease, transform 0.15s ease, box-shadow 0.15s ease;
  z-index: 2147483646;
  padding: 0;
}
.${CARD_BUTTON_CLASS}:hover {
  opacity: 1;
  transform: translateY(-1px);
  box-shadow: 0 10px 20px rgba(0, 0, 0, 0.35);
}
.${CARD_BUTTON_CLASS}:active {
  transform: scale(0.94);
}
.${CARD_BUTTON_CLASS}:disabled {
  opacity: 0.6;
  cursor: progress;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.2);
}
.${CARD_BUTTON_CLASS} svg {
  width: 18px;
  height: 18px;
  pointer-events: none;
}
`;
      head.appendChild(style);
      cardButtonStyleInjected = true;
    } catch (error) {
      console.warn("⚠️ Unable to inject Loom card button styles:", error);
    }
  }

  function resolveLibraryCardUrl(article, fallbackContainer) {
    const explicitId = article?.getAttribute("data-videoid");
    if (explicitId && explicitId.length >= 16) {
      return `https://www.loom.com/share/${explicitId}`;
    }

    const dataShare =
      article?.getAttribute("data-share-url") ||
      article?.dataset?.shareUrl ||
      fallbackContainer?.getAttribute("data-share-url") ||
      fallbackContainer?.dataset?.shareUrl;
    if (dataShare) return dataShare;

    const videoEl = article?.querySelector("video[data-loom-video-id]");
    const embeddedId = videoEl?.getAttribute("data-loom-video-id");
    if (embeddedId) {
      return `https://www.loom.com/share/${embeddedId}`;
    }

    if (videoEl?.src) {
      const match = videoEl.src.match(/([a-f0-9]{32})/i);
      if (match && match[1]) {
        return `https://www.loom.com/share/${match[1]}`;
      }
    }

    return null;
  }

  function attachCardDownloadButton(article) {
    if (!__loomIsActivated) return;
    if (!(article instanceof HTMLElement)) return;
    if (article.querySelector(`.${CARD_BUTTON_CLASS}`)) return;

    const videoEl = article.querySelector("video");
    if (!videoEl) return;

    const anchorCandidate =
      videoEl.closest("[class*='relative']") ||
      videoEl.closest("[class*='ThumbnailWrapper']") ||
      videoEl.parentElement ||
      article;

    if (!(anchorCandidate instanceof HTMLElement)) return;

    ensureOverlayPositioning(anchorCandidate);
    ensureCardButtonStyles();

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = CARD_BUTTON_CLASS;
    btn.title = "Download this Loom video";
    btn.setAttribute("aria-label", "Download this Loom video");
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M6 18h12"/></svg>';

    const videoTitle =
      article.querySelector("h3, [data-testid='video-title'], [data-loom-title]")?.textContent?.trim() || null;

    btn.addEventListener(
      "click",
      async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const targetUrl = resolveLibraryCardUrl(article, anchorCandidate) || window.location.href;
        if (!targetUrl) return;

        btn.disabled = true;

        try {
          try {
            if (globalThis.globalDownloadManager) {
              globalThis.globalDownloadManager.show();
            } else {
              chrome.runtime.sendMessage({ action: "openDownloadManager" });
            }
          } catch (_) {}

          const matchedId = targetUrl.match(/([a-f0-9]{32})/i)?.[1] || null;
          const videoInfo = matchedId
            ? { id: matchedId, title: videoTitle || undefined, url: targetUrl, isLoomVideo: true, source: "library-card" }
            : undefined;

          try {
            const resp = await chrome.runtime.sendMessage({ action: 'extractVideoInfo', url: targetUrl });
            if (resp && resp.success) {
              await chrome.runtime.sendMessage({ action: 'downloadVideo', url: targetUrl, videoInfo: videoInfo || resp.videoInfo || undefined, selectedQualityIndex: null });
            } else if (resp && /password|protected|unauthorized/i.test(String(resp.error || ''))) {
              try { await chrome.runtime.sendMessage({ action: 'openPopupForPassword', url: targetUrl, source: 'library-card' }); } catch {}
            } else {
              await chrome.runtime.sendMessage({ action: 'downloadVideo', url: targetUrl, videoInfo, selectedQualityIndex: null });
            }
          } catch (e) {
            await chrome.runtime.sendMessage({ action: 'downloadVideo', url: targetUrl, videoInfo, selectedQualityIndex: null });
          }
        } catch (error) {
          console.warn("⚠️ Failed to start Loom download from library card:", error);
        } finally {
          btn.disabled = false;
        }
      },
      { capture: true }
    );

    anchorCandidate.appendChild(btn);
  }

  function scanForLibraryCards(root = document) {
    if (!__loomIsActivated) return;
    try {
      root
        .querySelectorAll("article[data-videoid], [data-loom-video-card]")
        .forEach((article) => attachCardDownloadButton(article));
    } catch (error) {
      console.warn("⚠️ Error scanning for Loom library cards:", error);
    }
  }

  function removeCardButtons(root = document) {
    try {
      root.querySelectorAll(`.${CARD_BUTTON_CLASS}`).forEach((el) => { try { el.remove(); } catch (_) {} });
    } catch (_) {}
  }

  // Initial pass for any already-rendered players
  try {
    // Ensure a clean slate until activation is confirmed
    removeOverlayButtons(document);
    removeCardButtons(document);
    readActivationState(true);
    // Light enforcement loop: keep cleanup running until activated, then stop
    if (!__loomEnforceTimer) {
      __loomEnforceTimer = setInterval(() => {
        if (__loomIsActivated) { clearInterval(__loomEnforceTimer); __loomEnforceTimer = null; return; }
        try { removeOverlayButtons(document); } catch {}
        try { removeCardButtons(document); } catch {}
      }, 800);
    }
  } catch {}

  // Auto-detect when page loads
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(checkForNewEmbeds, 1000);
      setTimeout(() => scanForOverlayButtons(document), 1100);
      setTimeout(() => scanForLibraryCards(document), 1200);
    });
  } else {
    setTimeout(checkForNewEmbeds, 1000);
    setTimeout(() => scanForOverlayButtons(document), 1100);
    setTimeout(() => scanForLibraryCards(document), 1200);
  }

  // Also check for dynamically loaded content
  let lastEmbedCheck = Date.now();
  let lastOverlayScan = Date.now();
  let lastLibraryScan = Date.now();
  const observer = new MutationObserver(() => {
    // Throttle checks to avoid performance issues
    const now = Date.now();
    if (now - lastEmbedCheck > 2000) {
      lastEmbedCheck = now;
      setTimeout(checkForNewEmbeds, 500);
    }
    if (now - lastOverlayScan > 800) {
      lastOverlayScan = now;
      requestAnimationFrame(() => scanForOverlayButtons(document));
    }
    if (now - lastLibraryScan > 800) {
      lastLibraryScan = now;
      requestAnimationFrame(() => scanForLibraryCards(document));
    }
  });

  // Start observing changes to the DOM
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Clean up observer when page unloads
  window.addEventListener("beforeunload", () => {
    observer.disconnect();
  });

  // React to activation changes live
  try {
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'isActivated')) {
          __loomIsActivated = !!changes.isActivated.newValue;
          if (__loomIsActivated) {
            try { scanForOverlayButtons(document); } catch {}
            try { scanForLibraryCards(document); } catch {}
          } else {
            try { removeOverlayButtons(document); } catch {}
            try { removeCardButtons(document); } catch {}
          }
        }
      });
    }
  } catch (_) {}
} // End of guard condition
