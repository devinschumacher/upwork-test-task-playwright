# Loom Downloader - Permissions Justification

This document provides a detailed justification for each permission requested in the Loom Downloader extension manifest.

## Used Permissions

### 1. downloads
**Justification**: Required for downloading Loom videos to the user's computer.
**Usage**:
- `background-enhanced.js:460, 539, 781, 934, 975, 988` - Chrome downloads API calls to initiate file downloads
- `background-enhanced.js:481` - Download progress tracking with chrome.downloads.search()
- `background-enhanced.js:1872` - Event listener for download state changes

### 2. activeTab
**Justification**: Required to interact with the currently active tab for video detection and URL extraction.
**Usage**:
- `background-enhanced.js:1419` - Gets current active tab for Loom embed detection
- `popup-enhanced.js:195` - Auto-detects Loom URL from current tab
- `popup.js:33, 45, 99, 260` - Gets current tab, sends messages to content scripts, opens help documentation

### 3. storage
**Justification**: Required to store user activation status, license information, and download progress data.
**Usage**:
- `auth.js:95, 113, 133` - Stores/retrieves license activation data
- `popup.js:73, 239` - Checks and sets activation status
- `popup-enhanced.js:44, 75, 557` - Manages download progress tracking data
- `background-enhanced.js:1624` - License verification

### 4. tabs
**Justification**: Required for tab communication, management, and opening help documentation.
**Usage**:
- `popup.js:33, 45, 99, 260` - Tab queries, sending messages to content scripts, creating new tabs
- `background-enhanced.js:1419` - Querying active tab for embed detection
- `popup-enhanced.js:195` - Auto-detection functionality for current tab

### 5. scripting
**Justification**: Required to dynamically inject content scripts and execute scripts for Loom video detection.
**Usage**:
- `background-enhanced.js:1437` - Executes script to find Loom iframe elements on third-party websites
- `popup.js:92` - Injects content script when not already loaded

### 6. offscreen
**Justification**: Required to run offscreen media processing (FastStream/HLS2MP4 + MediaBunny) in a dedicated worker context.
**Usage**:
- `background-enhanced.js:~90-120` - Creates/closes offscreen document for processing
- Used for merging audio and video segments downloaded from Loom via offscreen.js

## Host Permissions

### Used Host Permissions
- `https://www.loom.com/*` - Primary Loom domain for content script injection
- `https://*.loom.com/*` - Loom subdomains
- `https://*.loomcdn.com/*` - Loom CDN for video files
- `https://*.cloudfront.net/*` - AWS CloudFront CDN used by Loom for content delivery
- `https://unpkg.com/*` - Package delivery network for dependencies
- `https://api.gumroad.com/*` - License verification API

## Recommended to Delete (Unused Permissions)

### webNavigation
**Status**: UNUSED
**Location**: `manifest.json:13`
**Reason**: The extension declares the webNavigation permission but does not implement any chrome.webNavigation API calls. No web navigation event listeners or related functionality exists in the codebase.
**Recommendation**: Remove this permission to follow the principle of least privilege.
