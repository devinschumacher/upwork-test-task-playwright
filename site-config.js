// site-config.js
// Centralized configuration for Loom extension: brand colors and service endpoints

(function () {
  const SiteConfig = {
    SITE_NAME: "Loom",
    WORKER_URL: "https://ghl-check-license-worker-v2.farleythecoder.workers.dev",
    GUMROAD_PRODUCT_ID: "OHxjL9F6j-RfWU-DNCNGOg==", // matches loom-downloader/auth.js
    GH_LICENSE_ID: "ZfdcQd6QzSQwXQ7QI4ko",
    PRODUCT_URL: "https://serp.ly/loom-video-downloader",
    LOG_LEVEL: 'error',
    LOG_MIRROR_TO_BG: true,
    COLORS: {
      brandAccent: "#625df5",
      brandAccentHover: "#5144d8",
      bgDark: "#1b1b1b",
      bgDarker: "#2a2a2a",
      borderDark: "#333333",
      inputBorder: "#555555",
      textPrimary: "#ffffff",
      textMuted: "#999999",
      textSubtle: "#cccccc",
      success: "#4caf50",
      error: "#f44336",
      info: "#2196f3",
      lightBg: "#ffffff",
      lightBorder: "#e9ecef",
      lightMutedText: "#6c757d",
      lightPanelBg: "#f8f9fa",
      lightMutedText2: "#95a5a6",
      darkTextStrong: "#2c3e50",
    },
  };

  function applyThemeVariables(doc = document) {
    try {
      const id = "loom-site-theme-vars";
      if (doc.getElementById(id)) return;
      const styleTag = doc.createElement("style");
      styleTag.id = id;
      const c = SiteConfig.COLORS;
      styleTag.textContent = `:root{\n        --brand-accent:${c.brandAccent};\n        --brand-accent-hover:${c.brandAccentHover};\n        --bg-dark:${c.bgDark};\n        --bg-darker:${c.bgDarker};\n        --border-dark:${c.borderDark};\n        --input-border:${c.inputBorder};\n        --text-primary:${c.textPrimary};\n        --text-muted:${c.textMuted};\n        --text-subtle:${c.textSubtle};\n        --success:${c.success};\n        --error:${c.error};\n        --info:${c.info};\n        --light-bg:${c.lightBg};\n        --light-border:${c.lightBorder};\n        --light-muted-text:${c.lightMutedText};\n        --light-panel-bg:${c.lightPanelBg};\n        --light-muted-text2:${c.lightMutedText2};\n        --dark-text-strong:${c.darkTextStrong};\n      }`;
      (doc.head || doc.documentElement).appendChild(styleTag);
    } catch (error) {
      console.warn('[Loom SiteConfig] Failed to apply theme variables:', error);
    }
  }

  try { globalThis.SiteConfig = SiteConfig; } catch {}
  try {
    const map = { none: 'silent', error: 'error', warn: 'warn', log: 'info', info: 'info', debug: 'debug' };
    const level = map[String(SiteConfig.LOG_LEVEL || '').toLowerCase()] || undefined;
    if (level) globalThis.LOOM_LOG_LEVEL = level;
  } catch {}
  try { globalThis.applyLoomThemeVariables = applyThemeVariables; } catch {}
  try { applyThemeVariables(document); } catch {}
})();
