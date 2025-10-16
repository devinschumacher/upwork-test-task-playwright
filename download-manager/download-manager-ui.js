/**
 * Download Manager UI (Loom)
 */

export class DownloadManagerUI {
  constructor(config = {}) {
    this.config = config;
    this.panel = null;
    this.elements = {};
  }

  createPanel() {
    if (this.panel) return this.panel;

    const existingPanel = document.getElementById('loom-download-manager');
    if (existingPanel) {
      this.panel = existingPanel;
      this.cacheElements();
      this.bindEvents();
      return this.panel;
    }

    this.panel = document.createElement('div');
    this.panel.id = 'loom-download-manager';
    this.panel.style.cssText = this.generatePanelStyles();
    this.panel.innerHTML = this.generatePanelHTML();

    const parent = document.querySelector(this.config.integration?.parentSelector || 'body');
    parent.appendChild(this.panel);

    this.cacheElements();
    this.bindEvents();
    return this.panel;
  }

  generatePanelStyles() {
    const isSmallScreen = typeof window !== 'undefined' && window.innerWidth < 500;
    const panelWidth = isSmallScreen ? Math.min(window.innerWidth - 40, 340) : 380;
    const maxHeight = typeof window !== 'undefined' ? Math.min(window.innerHeight - 80, 500) : 500;
    const styles = this.config.styles || {};
    const border = styles.border || `2px solid ${styles.primaryColor || '#625df5'}`;
    const boxShadow = styles.boxShadow || '0 4px 16px rgba(0,0,0,0.5)';
    const textColor = styles.textColor || '#fff';
    const fontFamily = styles.fontFamily || "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif";
    const fontSize = styles.fontSize || '13px';
    const backgroundColor = styles.backgroundColor || '#1b1b1b';

    return `
      position: fixed;
      top: 20px;
      right: 20px;
      width: ${panelWidth}px;
      max-height: ${maxHeight}px;
      background: ${backgroundColor};
      border: ${border};
      border-radius: 8px;
      box-shadow: ${boxShadow};
      z-index: ${this.config.integration?.zIndexBase || 2147483647};
      isolation: isolate;
      pointer-events: auto;
      font-family: ${fontFamily};
      font-size: ${fontSize};
      color: ${textColor};
      overflow: hidden;
      transform: translateX(100%);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    `;
  }

  generatePanelHTML() {
    const cssPrefix = this.config.integration?.cssPrefix || 'loom';
    const labels = this.config.labels || {};
    const styles = this.config.styles || {};
    const headerBg = styles.headerBackground || 'linear-gradient(135deg, #333, #222)';
    const headerBorder = styles.headerBorder || '1px solid #444';
    const accent = styles.primaryColor || '#625df5';
    const accentHover = '#5144d8';
    const maxHeight = typeof window !== 'undefined' ? Math.min(window.innerHeight - 80, 500) : 500;

    return `
      <div id="${cssPrefix}-download-manager-header" style="
        background: ${headerBg};
        color: white;
        padding: 8px 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-weight: bold;
        cursor: pointer;
        user-select: none;
        border-bottom: ${headerBorder};
      ">
        <div id="${cssPrefix}-download-manager-title">${labels.title || '📥 Downloads'} (0 active)</div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <button id="${cssPrefix}-download-manager-cancel-all" title="${labels.cancelAll || 'Cancel all active downloads'}" style="
            background: #d32f2f;
            border: none;
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            transition: background 0.2s ease;
            display: none;
          " onmouseover="this.style.background='#b71c1c'" onmouseout="this.style.background='#d32f2f'">${labels.cancelAll || 'Cancel All'}</button>
          <button id="${cssPrefix}-download-manager-clear" title="${labels.clearCompleted || 'Clear completed'}" style="
            background: ${accent};
            border: none;
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            transition: background 0.2s ease;
          " onmouseover="this.style.background='${accentHover}'" onmouseout="this.style.background='${accent}'">${labels.clearCompleted || 'Clear'}</button>
          <button id="${cssPrefix}-download-manager-collapse" title="${labels.collapse || 'Collapse'}" style="
            background: rgba(255,255,255,0.1);
            border: none;
            color: white;
            font-size: 16px;
            cursor: pointer;
            padding: 0;
            width: 20px;
            height: 20px;
            border-radius: 3px;
            transition: background 0.2s ease;
          " onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">−</button>
        </div>
      </div>
      <div id="${cssPrefix}-download-manager-content" style="
        max-height: ${maxHeight - 50}px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: #666 transparent;
        background: #1b1b1b;
      "></div>
      <style>
        #${cssPrefix}-download-manager-content::-webkit-scrollbar { width: 6px; }
        #${cssPrefix}-download-manager-content::-webkit-scrollbar-track { background: #1b1b1b; }
        #${cssPrefix}-download-manager-content::-webkit-scrollbar-thumb { background: #666; border-radius: 3px; }
        #${cssPrefix}-download-manager-content::-webkit-scrollbar-thumb:hover { background: #888; }
      </style>
    `;
  }

  cacheElements() {
    const cssPrefix = this.config.integration?.cssPrefix || 'loom';
    this.elements.header = document.getElementById(`${cssPrefix}-download-manager-header`);
    this.elements.title = document.getElementById(`${cssPrefix}-download-manager-title`);
    this.elements.content = document.getElementById(`${cssPrefix}-download-manager-content`);
    this.elements.clearBtn = document.getElementById(`${cssPrefix}-download-manager-clear`);
    this.elements.cancelAllBtn = document.getElementById(`${cssPrefix}-download-manager-cancel-all`);
    this.elements.collapseBtn = document.getElementById(`${cssPrefix}-download-manager-collapse`);
  }

  bindEvents() {
    const cssPrefix = this.config.integration?.cssPrefix || 'loom';
    if (this.elements.collapseBtn) {
      this.elements.collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hidePanel();
      });
    }
    if (this.elements.header) {
      this.elements.header.addEventListener('click', () => {
        if (this.panel.style.transform === 'translateX(0%)') {
          this.hidePanel();
        } else {
          this.showPanel();
        }
      });
    }
    if (this.elements.clearBtn) {
      this.elements.clearBtn.addEventListener('click', () => {
        if (typeof this.onClearCompleted === 'function') this.onClearCompleted();
      });
    }
    if (this.elements.cancelAllBtn) {
      this.elements.cancelAllBtn.addEventListener('click', () => {
        if (typeof this.onCancelAll === 'function') this.onCancelAll();
      });
    }
  }

  showPanel() {
    this.panel.style.transform = 'translateX(0%)';
    this.panel.style.opacity = '1';
  }
  hidePanel() {
    this.panel.style.transform = 'translateX(100%)';
    this.panel.style.opacity = '0';
  }

  updateHeader(stats) {
    const labels = this.config.labels || {};
    const activeText = stats.active > 0 ? (labels.activeDownloads || '({count} active)').replace('{count}', stats.active) : (labels.noActiveDownloads || '(none)');
    if (this.elements.title) {
      this.elements.title.textContent = `${labels.title || '📥 Downloads'} ${activeText}`;
    }
    if (this.elements.cancelAllBtn) {
      this.elements.cancelAllBtn.style.display = stats.active > 1 ? 'inline-block' : 'none';
    }
  }

  addOrUpdateItem(id, info) {
    const cssPrefix = this.config.integration?.cssPrefix || 'loom';
    const existing = this.elements.content.querySelector(`[data-id="${id}"]`);
    const accent = (this.config.styles && this.config.styles.primaryColor) || '#625df5';
    const accentHover = '#5144d8';
    const createItemHTML = (inf) => {
      return `
        <div class="dm-item" data-id="${id}" style="
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 8px;
          border-bottom: 1px solid #333;
          padding: 10px 12px;
        ">
          <div>
            <div class="dm-fn" style="color:#fff; font-weight:600; font-size:13px;">${(inf.filename || 'Video').toString().replace(/</g,'&lt;')}</div>
            <div class="dm-st" style="color:#aaa; font-size:12px; margin-top:3px;">${inf.status || 'Downloading...'}</div>
            <div class="dm-pb" style="height:6px; background:#2a2a2a; border-radius:3px; overflow:hidden; margin-top:8px;">
              <div class="dm-pf" style="height:100%; width:${Math.max(0, Math.min(100, inf.progress || 0))}%; background:${accent};"></div>
            </div>
          </div>
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="dm-cancel" title="Cancel" style="
              background:#d32f2f; color:#fff; border:none; border-radius:4px; padding:4px 8px; font-size:11px; cursor:pointer;"
              onmouseover="this.style.background='#b71c1c'" onmouseout="this.style.background='#d32f2f'">✕</button>
            <button class="dm-remove" title="Remove" style="
              background:${accent}; color:#fff; border:none; border-radius:4px; padding:4px 8px; font-size:11px; cursor:pointer;"
              onmouseover="this.style.background='${accentHover}'" onmouseout="this.style.background='${accent}'">✔</button>
          </div>
        </div>
      `;
    };

    if (existing) {
      // Update
      existing.querySelector('.dm-fn').textContent = info.filename || 'Video';
      existing.querySelector('.dm-st').textContent = info.status || '';
      const pf = existing.querySelector('.dm-pf');
      pf.style.width = `${Math.max(0, Math.min(100, info.progress || 0))}%`;
      if (info.isCompleted) {
        existing.querySelector('.dm-st').textContent = this.config.labels?.completed || 'Completed';
      }
    } else {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = createItemHTML(info);
      const node = wrapper.firstElementChild;
      this.elements.content.prepend(node);

      // Bind per-item actions
      node.querySelector('.dm-cancel').addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof this.onCancelItem === 'function') this.onCancelItem(id);
      });
      node.querySelector('.dm-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof this.onRemoveItem === 'function') this.onRemoveItem(id);
      });
    }
  }

  removeDownloadItem(id) {
    const el = this.elements.content?.querySelector(`[data-id="${id}"]`);
    if (el) el.remove();
  }

  renderDownloads(downloadsMap) {
    // Ensure items exist and are updated
    downloadsMap.forEach((info, id) => this.addOrUpdateItem(id, info));
    // Remove stale DOM nodes
    const currentIds = new Set(Array.from(downloadsMap.keys()));
    this.elements.content.querySelectorAll('[data-id]')?.forEach((node) => {
      const id = node.getAttribute('data-id');
      if (!currentIds.has(id)) node.remove();
    });
  }

  updateUI(stats, downloadsMap) {
    this.updateHeader(stats);
    this.renderDownloads(downloadsMap);
  }
}
