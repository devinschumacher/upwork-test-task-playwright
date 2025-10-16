/**
 * Native Messaging Helper for SERP Extensions
 * 
 * This module provides a simple interface for communicating with the
 * SERP Extensions Desktop Companion App via Chrome's Native Messaging API.
 */

class NativeMessagingHelper {
  constructor() {
    this.hostName = 'com.serpcompany.extensions.companion';
    this.port = null;
    this.isConnected = false;
    this.pendingRequests = new Map();
    this.requestId = 0;
  }

  /**
   * Connect to the native companion app
   */
  async connect() {
    if (this.isConnected) {
      return true;
    }

    try {
      this.port = chrome.runtime.connectNative(this.hostName);
      
      this.port.onMessage.addListener((response) => {
        this.handleResponse(response);
      });

      this.port.onDisconnect.addListener(() => {
        this.handleDisconnect();
      });

      // Test connection with ping
      const pingResult = await this.ping();
      this.isConnected = pingResult.success;
      
      if (this.isConnected) {
        console.log('✅ Connected to SERP Extensions Companion App');
      } else {
        console.warn('⚠️ Failed to establish connection with companion app');
      }

      return this.isConnected;
    } catch (error) {
      console.error('❌ Failed to connect to companion app:', error);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Check if connected to companion app
   */
  isCompanionAppAvailable() {
    return this.isConnected;
  }

  /**
   * Send a ping to test connectivity
   */
  async ping() {
    return this.sendMessage('ping', {});
  }

  /**
   * Download a video using yt-dlp
   */
  async downloadVideo(url, options = {}) {
    if (!this.isConnected) {
      throw new Error('Not connected to companion app');
    }

    return this.sendMessage('download', {
      url,
      options: {
        outputPath: options.outputPath || this.getDefaultDownloadPath(),
        format: options.format || 'best',
        audioOnly: options.audioOnly || false,
        extractAudio: options.extractAudio || false
      }
    });
  }

  /**
   * Process a video using FFmpeg
   */
  async processVideo(inputPath, outputPath, options = {}) {
    if (!this.isConnected) {
      throw new Error('Not connected to companion app');
    }

    return this.sendMessage('process-video', {
      inputPath,
      outputPath,
      options
    });
  }

  /**
   * Get status of installed binaries
   */
  async getBinaryStatus() {
    if (!this.isConnected) {
      throw new Error('Not connected to companion app');
    }

    return this.sendMessage('get-binary-status', {});
  }

  /**
   * Install or update binaries
   */
  async installBinaries() {
    if (!this.isConnected) {
      throw new Error('Not connected to companion app');
    }

    return this.sendMessage('install-binaries', {});
  }

  /**
   * Send a message to the companion app
   */
  async sendMessage(type, payload) {
    if (!this.port) {
      throw new Error('Not connected to companion app');
    }

    const id = this.generateRequestId();
    const message = {
      type,
      id,
      ...payload
    };

    return new Promise((resolve, reject) => {
      // Store the promise resolver
      this.pendingRequests.set(id, { resolve, reject });

      try {
        this.port.postMessage(message);
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error);
      }

      // Set a timeout for the request
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000); // 30 second timeout
    });
  }

  /**
   * Handle response from companion app
   */
  handleResponse(response) {
    const { id } = response;
    
    if (!id || !this.pendingRequests.has(id)) {
      console.warn('Received response for unknown request:', response);
      return;
    }

    const { resolve, reject } = this.pendingRequests.get(id);
    this.pendingRequests.delete(id);

    if (response.success) {
      resolve(response);
    } else {
      reject(new Error(response.error || 'Unknown error'));
    }
  }

  /**
   * Handle disconnection from companion app
   */
  handleDisconnect() {
    console.warn('⚠️ Disconnected from companion app');
    
    if (chrome.runtime.lastError) {
      console.error('Connection error:', chrome.runtime.lastError.message);
    }

    this.isConnected = false;
    this.port = null;

    // Reject all pending requests
    this.pendingRequests.forEach(({ reject }) => {
      reject(new Error('Companion app disconnected'));
    });
    this.pendingRequests.clear();
  }

  /**
   * Generate unique request ID
   */
  generateRequestId() {
    return `req_${++this.requestId}_${Date.now()}`;
  }

  /**
   * Get default download path
   */
  getDefaultDownloadPath() {
    // This could be configurable or retrieved from Chrome's download API
    return null; // Let the companion app decide
  }

  /**
   * Disconnect from companion app
   */
  disconnect() {
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }
    this.isConnected = false;
  }
}

// Export for both module and script environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NativeMessagingHelper;
} else {
  globalThis.NativeMessagingHelper = NativeMessagingHelper;
}