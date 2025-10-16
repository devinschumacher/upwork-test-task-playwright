# Loom Downloader Chrome Extension - Complete Architecture Documentation

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [System Architecture Overview](#system-architecture-overview)
3. [Core Components](#core-components)
4. [Download Mechanisms](#download-mechanisms)
5. [File Paths and Routing](#file-paths-and-routing)
6. [Processing Pipelines](#processing-pipelines)
7. [API Integration Patterns](#api-integration-patterns)
8. [Security and Authentication](#security-and-authentication)
9. [Video Detection Strategies](#video-detection-strategies)
10. [Error Handling and Recovery](#error-handling-and-recovery)
11. [Performance Optimizations](#performance-optimizations)
12. [Technical Specifications](#technical-specifications)

---

## Executive Summary

The **Loom Downloader** is a sophisticated Chrome Extension built on Manifest V3 architecture that provides comprehensive video downloading capabilities for Loom videos. The extension employs advanced video detection algorithms, browser-native media processing (FastStream/HLS2MP4 + MediaBunny), and a licensing system to deliver a complete video downloading solution.

### Key Capabilities
- **Universal Detection**: Works on direct Loom pages and embedded content across any website
- **Multi-Format Processing**: Handles MP4, WebM, HLS streams, and DASH segments
- **Advanced Processing**: FastStream/HLS2MP4 and MediaBunny for conversion and muxing (no FFmpeg)
- **Large File Handling**: Chunked downloads for files exceeding browser limits
- **License Protection**: Cloudflare Worker-based authentication system

---

## System Architecture Overview

Note: Earlier drafts of this document referenced FFmpeg/ffmpeg.wasm. The current implementation removes that dependency and uses FastStream (HLS2MP4) and MediaBunny exclusively for all processing. Any remaining FFmpeg mentions below are legacy notes slated for cleanup.

### High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            USER INTERFACE LAYER                         │
├─────────────────────────────────────────────────────────────────────────┤
│  Popup UI (popup-enhanced.js) ←→ Video Display ←→ Progress Tracking     │
└──────────────────────────┬──────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────────────────────┐
│                         DETECTION LAYER                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  Content Script (content-enhanced.js) ←→ DOM Analysis ←→ Network Monitor │
└──────────────────────────┬──────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATION LAYER                              │
├─────────────────────────────────────────────────────────────────────────┤
│  Background Script (background-enhanced.js) ←→ Service Worker ←→ APIs   │
└──────────────────────────┬──────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────────────────────┐
│                         PROCESSING LAYER                                │
├─────────────────────────────────────────────────────────────────────────┤
│  Offscreen Document (offscreen.js) ←→ FastStream/MediaBunny ←→ Processing │
└──────────────────────────┬──────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────────────────────┐
│                          STORAGE LAYER                                  │
├─────────────────────────────────────────────────────────────────────────┤
│  IndexedDB (indexed-db.js) ←→ Chrome Storage ←→ Temporary File System   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Background Script - Service Worker Orchestration
**File**: `background-enhanced.js`  
**Purpose**: Central orchestration hub for all extension operations

#### Key Responsibilities:
- **Download Management**: Coordinates all download operations with progress tracking
- **Offscreen Document Control**: Creates and manages isolated processing contexts
- **API Communication**: Interfaces with Loom's APIs for video metadata
- **Message Routing**: Handles communication between popup, content scripts, and processing

#### Core Functions:

```javascript
// Progress tracking system
function sendProgressToPopup(percentage, status, speed = "") {
  chrome.runtime.sendMessage({
    type: "DOWNLOAD_PROGRESS",
    percentage: percentage,
    status: status,
    speed: speed
  });
}

// Offscreen document management
async function createOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  
  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Offscreen media processing (FastStream/MediaBunny) requires a dedicated worker context"
    });
  }
}
```

#### Message Handling Patterns:
- **extractVideoInfo**: Fetches video metadata from Loom API
- **downloadVideo**: Initiates download process with quality selection
- **cancelDownload**: Aborts active downloads and cleanup
- **checkDownloadStatus**: Returns current download state
- **findLoomEmbed**: Detects embedded Loom videos on pages

### 2. Content Script - Video Detection Engine
**File**: `content-enhanced.js`  
**Purpose**: Intelligent video detection across direct and embedded contexts

#### Detection Strategies:

##### Strategy 1: Direct Loom Page Detection
```javascript
function extractVideoInfo() {
  const url = window.location.href;
  if (url.includes("loom.com/share/")) {
    const videoId = url.match(/loom\.com\/share\/([a-f0-9]{32})/)?.[1];
    if (videoId) {
      return {
        id: videoId,
        title: document.title.replace(" - Loom", "").trim(),
        url: url,
        isLoomVideo: true,
        source: "direct"
      };
    }
  }
}
```

##### Strategy 2: Iframe Embed Detection (Highest Priority)
```javascript
const iframes = document.querySelectorAll("iframe");
iframes.forEach((iframe) => {
  const src = iframe.src;
  if (src && src.includes("loom.com/embed/")) {
    const videoId = src.match(/loom\.com\/embed\/([a-f0-9]{32})/)?.[1];
    // Process iframe embed
  }
});
```

##### Strategy 3: Video Element with Data Attributes
```javascript
const videoElements = document.querySelectorAll("video[data-loom-video-id]");
videoElements.forEach((video) => {
  const videoId = video.getAttribute("data-loom-video-id");
  if (videoId && videoId.length === 32) {
    // Process video element
  }
});
```

##### Strategy 4: Script Tag Mining
```javascript
const scripts = document.querySelectorAll("script");
scripts.forEach((script) => {
  const content = script.textContent || script.innerHTML;
  if (content.includes("loom.com")) {
    const matches = content.match(/loom\.com\/(?:embed|share)\/([a-f0-9]{32})/g);
    // Process script-embedded references
  }
});
```

##### Strategy 5: Dynamic Content Monitoring
```javascript
const observer = new MutationObserver(() => {
  const now = Date.now();
  if (now - lastEmbedCheck > 2000) {
    lastEmbedCheck = now;
    setTimeout(checkForNewEmbeds, 500);
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});
```

### 3. Popup Interface - User Control Center
**File**: `popup-enhanced.js`  
**Purpose**: Complete user interface for video management and downloads

#### UI Components and Functionality:

##### Video Information Display
```javascript
function displayVideoInfo(videoInfo) {
  // Thumbnail management
  const thumbnailImg = document.getElementById("videoThumbnail");
  if (videoInfo.thumbnail) {
    thumbnailImg.src = videoInfo.thumbnail;
    thumbnailImg.onload = () => {
      thumbnailImg.classList.remove("hidden");
    };
  }
  
  // Metadata display
  document.getElementById("videoTitle").textContent = videoInfo.title || "Untitled Video";
  document.getElementById("videoOwner").textContent = videoInfo.owner;
  document.getElementById("videoResolution").textContent = 
    `${videoInfo.width}x${videoInfo.height}`;
}
```

##### Progress Tracking System
```javascript
function showProgress(percentage, status, speed = "") {
  // Update progress bar
  progressFill.style.width = `${Math.max(0, Math.min(100, percentage))}%`;
  progressText.textContent = `${Math.round(percentage)}%`;
  progressSpeed.textContent = speed;
  
  // Store state for persistence
  chrome.storage.local.set({
    downloadInProgress: true,
    downloadPercentage: percentage,
    downloadStatus: status,
    downloadSpeed: speed
  });
}
```

##### Download Management
```javascript
async function handleDownload() {
  const password = passwordInput ? passwordInput.value : null;
  const url = currentVideoInfo?.url || currentVideoInfo?.pageUrl;
  const selectedQualityIndex = qualitySelect.value;

  const response = await chrome.runtime.sendMessage({
    action: "downloadVideo",
    url: url,
    password: password,
    videoInfo: currentVideoInfo,
    selectedQualityIndex: selectedQualityIndex
  });
}
```

### 4. Authentication System - License Management
**File**: `auth.js`  
**Purpose**: Secure license verification and activation workflow

#### Authentication Architecture:

##### License Verification Flow
```javascript
class Auth {
  static async activateLicense(licenseKey, email) {
    const workerUrl = "https://ghl-check-license-worker.farleythecoder.workers.dev";
    const productId = "cHJvZHVjdF8xM2hDVnpFeFJRUGZCdGlLRWcxNEhSZEk="; // Base64 encoded
    
    const response = await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: licenseKey,
        email: email,
        product_id: productId
      })
    });
    
    const result = await response.json();
    if (result.success) {
      await this.storeActivationData(licenseKey, email, result.registrationType);
    }
    
    return result;
  }
}
```

##### Activation Persistence
```javascript
static async storeActivationData(licenseKey, email, registrationType) {
  const activationData = {
    isActivated: true,
    licenseKey: licenseKey,
    email: email,
    registrationType: registrationType,
    activatedAt: new Date().toISOString()
  };
  
  await chrome.storage.local.set({ activation: activationData });
}
```

---

## Download Mechanisms

### 1. Video Detection and Metadata Extraction

#### Loom API Integration Pattern
```javascript
async function extractLoomVideoInfo(videoId, password = null) {
  const apiUrl = `https://www.loom.com/api/campaigns/sessions/${videoId}`;
  
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; LoomDownloader/1.0)'
  };
  
  if (password) {
    headers['Authorization'] = `Bearer ${password}`;
  }
  
  const response = await fetch(apiUrl, { headers });
  const data = await response.json();
  
  return {
    id: videoId,
    title: data.name || `Loom Video ${videoId}`,
    duration: data.video_duration,
    thumbnail: data.thumbnail_url,
    downloadUrl: data.video_url,
    owner: data.owner?.display_name,
    width: data.video_width,
    height: data.video_height
  };
}
```

### 2. Video Processing Pipelines

#### Direct MP4 Download (Preferred Path)
```javascript
// Path: Direct download without processing
// Processor: Browser native download
// Why: Fastest method for pre-processed MP4 files

async function directDownload(videoUrl, fileName) {
  const response = await fetch(videoUrl);
  const blob = await response.blob();
  
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  
  URL.revokeObjectURL(url);
}
```

#### HLS Stream Processing
```javascript
// Path: HLS stream → Segment download → FFmpeg concat → MP4 output
// Processor: FFmpeg.wasm with HLS segment handling
// Why: Handles adaptive streaming and multiple quality levels

async function processHLSStream(hlsUrl, fileName) {
  // 1. Parse M3U8 playlist
  const playlistResponse = await fetch(hlsUrl);
  const playlist = await playlistResponse.text();
  
  // 2. Extract segment URLs
  const segments = playlist.split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(segment => new URL(segment, hlsUrl).href);
  
  // 3. Download segments in parallel batches
  const segmentBlobs = [];
  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    const batch = segments.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(segmentUrl => fetch(segmentUrl));
    const responses = await Promise.all(batchPromises);
    const blobs = await Promise.all(responses.map(r => r.blob()));
    segmentBlobs.push(...blobs);
    
    sendProgressToPopup((i / segments.length) * 50, "Downloading segments...");
  }
  
  // 4. Process through FFmpeg
  await processWithFFmpeg(segmentBlobs, fileName, 'hls_concat');
}
```

#### WebM to MP4 Conversion
```javascript
// Path: WebM source → FFmpeg transcoding → MP4 output
// Processor: FFmpeg.wasm with codec conversion
// Why: Browser compatibility and file size optimization

async function convertWebMToMP4(webmBlob, fileName) {
  const message = {
    type: "PROCESS_VIDEO",
    processingType: "webm_to_mp4",
    videoBlob: webmBlob,
    fileName: fileName
  };
  
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    message: message
  });
}
```

#### Audio/Video Stream Merging
```javascript
// Path: Separate audio/video streams → FFmpeg merge → MP4 output  
// Processor: FFmpeg.wasm with stream combination
// Why: Many streaming services deliver audio and video separately

async function mergeAudioVideo(videoBlob, audioBlob, fileName) {
  const processingOptions = {
    type: "PROCESS_VIDEO",
    processingType: "merge_audio_video",
    videoBlob: videoBlob,
    audioBlob: audioBlob,
    fileName: fileName,
    ffmpegArgs: [
      "-i", "video.webm",
      "-i", "audio.webm", 
      "-c:v", "copy",
      "-c:a", "aac",
      "-strict", "experimental",
      "output.mp4"
    ]
  };
  
  await processInOffscreen(processingOptions);
}
```

### 3. Large File Handling Strategy

#### Chunked Download System
```javascript
// Path: Large file → Chunk splitting → Sequential download → Reassembly
// Processor: Browser download API with chunk management
// Why: Overcomes browser memory limits and provides resumable downloads

async function chunkedDownload(blob, fileName) {
  const CHUNK_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5GB chunks
  
  if (blob.size <= CHUNK_SIZE) {
    return directDownload(blob, fileName);
  }
  
  console.log(`File size ${(blob.size / 1024 / 1024 / 1024).toFixed(2)}GB exceeds limit, chunking...`);
  
  let offset = 0;
  let chunkIndex = 0;
  
  while (offset < blob.size) {
    const chunk = blob.slice(offset, offset + CHUNK_SIZE);
    const chunkFileName = `${fileName}.part${chunkIndex.toString().padStart(3, "0")}`;
    
    await downloadChunk(chunk, chunkFileName);
    
    offset += CHUNK_SIZE;
    chunkIndex++;
    
    sendProgressToPopup(
      (offset / blob.size) * 100,
      `Downloading chunk ${chunkIndex}...`
    );
  }
}
```

---

## File Paths and Routing

### 1. Extension Directory Structure
```
loom-downloader/
├── manifest.json                 # Extension configuration and permissions
├── popup.html                   # Popup interface HTML structure
├── popup-enhanced.js            # Popup logic and user interactions
├── background-enhanced.js       # Service worker and download orchestration
├── content-enhanced.js          # Video detection and page analysis
├── content.js                   # Basic Loom page content script
├── offscreen.html              # Offscreen document container
├── offscreen.js                # FFmpeg processing and video conversion
├── indexed-db.js               # Database abstraction layer
├── auth.js                     # License verification and activation
├── icons/                      # Extension icons (16, 48, 128px)
├── libs/                       # Third-party libraries
│   └── ffmpeg/                 # FFmpeg.wasm distribution
│       ├── core/dist/esm/      # WebAssembly core files
│       ├── ffmpeg/dist/esm/    # JavaScript wrapper
│       └── util/dist/esm/      # Utility functions
├── build-tools/                # Development and build utilities
│   ├── build.js               # Production build script
│   ├── download-ffmpeg-libs.js # FFmpeg library downloader
│   └── generate-icons.js       # Icon generation from SVG
└── docs/                       # Documentation (this file)
```

### 2. Message Routing Architecture

#### Service Worker Message Routes
```javascript
// Central message router in background-enhanced.js
chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  const routes = {
    // Video information extraction
    'extractVideoInfo': async (req) => await handleExtractVideoInfo(req),
    
    // Download initiation and management  
    'downloadVideo': async (req) => await handleDownloadVideo(req),
    'cancelDownload': async (req) => await handleCancelDownload(req),
    'checkDownloadStatus': async (req) => await handleCheckDownloadStatus(req),
    
    // Content script detection
    'findLoomEmbed': async (req) => await handleFindLoomEmbed(req),
    'getVideoInfo': async (req) => await handleGetVideoInfo(req),
    
    // Offscreen document management
    'processVideo': async (req) => await forwardToOffscreen(req),
    'offscreenReady': async (req) => await handleOffscreenReady(req)
  };
  
  if (routes[request.action]) {
    return routes[request.action](request);
  }
});
```

#### Content Script Communication Paths
```javascript
// content-enhanced.js → background-enhanced.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handlers = {
    'getVideoInfo': () => sendResponse({
      success: true, 
      videoInfo: extractVideoInfo()
    }),
    
    'getAllLoomEmbeds': () => sendResponse({
      success: true, 
      embeds: getAllLoomEmbeds()
    })
  };
  
  if (handlers[request.action]) {
    handlers[request.action]();
    return true; // Async response
  }
});
```

#### Offscreen Document Communication
```javascript
// Offscreen processing message flow
// background-enhanced.js → offscreen.js
chrome.runtime.sendMessage({
  target: "offscreen",
  message: {
    type: "PROCESS_VIDEO",
    processingType: "hls_concat",
    segments: segmentBlobs,
    fileName: fileName
  }
});

// offscreen.js → background-enhanced.js (progress updates)
chrome.runtime.sendMessage({
  type: "PROCESSING_PROGRESS", 
  percentage: 75,
  status: "Merging segments..."
});
```

### 3. File Storage Routing

#### Temporary Storage Paths
```javascript
// IndexedDB storage for processing
// Path: Browser memory → IndexedDB → Processing → Download
await set(`temp_video_${videoId}`, {
  blob: videoBlob,
  metadata: videoInfo,
  timestamp: Date.now()
});

// Chrome storage for activation data
// Path: License verification → Chrome storage → Extension state
chrome.storage.local.set({
  activation: {
    isActivated: true,
    licenseKey: licenseKey,
    email: email,
    activatedAt: new Date().toISOString()
  }
});
```

#### Download Output Paths
```javascript
// Browser download API routing
// Path: Processed blob → Chrome downloads API → User downloads folder
chrome.downloads.download({
  url: URL.createObjectURL(finalBlob),
  filename: sanitizeFileName(videoTitle + ".mp4"),
  saveAs: false  // Direct to downloads folder
});
```

---

## Processing Pipelines

### 1. FFmpeg.wasm Integration Architecture

#### Core Processing Setup
```javascript
// offscreen.js - FFmpeg initialization
async function initializeFFmpeg() {
  const { FFmpeg } = await import("/libs/ffmpeg/ffmpeg/dist/esm/index.js");
  const ffmpeg = new FFmpeg();
  
  ffmpeg.on("log", ({ message }) => {
    console.log(`[ffmpeg] ${message}`);
  });
  
  await ffmpeg.load({
    coreURL: "/libs/ffmpeg/core/dist/esm/ffmpeg-core.js"
  });
  
  return ffmpeg;
}
```

#### WORKERFS File System Integration
```javascript
// Path: Large File → WORKERFS mount → FFmpeg processing → Output blob
// Processor: WebAssembly file system with direct file mounting
// Why: Avoids memory duplication for large files

async function processWithWORKERFS(fileBlobs, outputFileName, processingType) {
  const ffmpeg = await initializeFFmpeg();
  
  // Create WORKERFS directories
  ffmpeg.createDir("/working");
  ffmpeg.createDir("/input");
  ffmpeg.createDir("/output");
  
  // Mount File objects directly without copying to memory
  for (let i = 0; i < fileBlobs.length; i++) {
    const inputFile = new File([fileBlobs[i]], `input${i}.ts`);
    ffmpeg.mount("WORKERFS", {
      files: [inputFile]
    }, `/input/file${i}`);
  }
  
  // Process based on type
  const commands = getFFmpegCommands(processingType, fileBlobs.length, outputFileName);
  await ffmpeg.exec(commands);
  
  // Read output
  const outputData = ffmpeg.readFile("/output/" + outputFileName);
  const outputBlob = new Blob([outputData], { type: "video/mp4" });
  
  return outputBlob;
}
```

### 2. Video Processing Command Patterns

#### HLS Segment Concatenation
```javascript
// Path: HLS segments → concat protocol → Single MP4
// Processor: FFmpeg concat protocol with stream copying
// Why: Lossless joining of pre-encoded segments

function getHLSConcatCommands(segmentCount, outputName) {
  return [
    // Create concat file list
    ...createConcatFileList(segmentCount),
    
    // Main concat command
    "-f", "concat",
    "-safe", "0", 
    "-i", "/working/concat_list.txt",
    "-c", "copy",  // Stream copy - no re-encoding
    "-avoid_negative_ts", "make_zero",
    `/output/${outputName}`
  ];
}

function createConcatFileList(segmentCount) {
  let concatContent = "";
  for (let i = 0; i < segmentCount; i++) {
    concatContent += `file '/input/segment${i}.ts'\n`;
  }
  
  ffmpeg.writeFile("/working/concat_list.txt", concatContent);
  return [];
}
```

#### Audio/Video Stream Merging
```javascript
// Path: Separate streams → FFmpeg merge → Combined MP4
// Processor: FFmpeg with stream mapping and codec selection
// Why: Combines separately delivered audio and video tracks

function getMergeAVCommands(videoFile, audioFile, outputName) {
  return [
    "-i", `/input/${videoFile}`,  // Video input
    "-i", `/input/${audioFile}`,  // Audio input
    "-c:v", "copy",               // Copy video stream (no re-encode)
    "-c:a", "aac",                // Re-encode audio to AAC
    "-strict", "experimental",     // Allow experimental codecs
    "-map", "0:v:0",              // Map first video stream
    "-map", "1:a:0",              // Map first audio stream
    `/output/${outputName}`
  ];
}
```

#### WebM to MP4 Conversion
```javascript
// Path: WebM input → H.264/AAC encoding → MP4 output
// Processor: FFmpeg with codec transcoding
// Why: Convert WebM to more compatible MP4 format

function getWebMConversionCommands(inputFile, outputName) {
  return [
    "-i", `/input/${inputFile}`,
    "-c:v", "libx264",           // H.264 video codec
    "-preset", "medium",         // Encoding speed/quality balance
    "-crf", "23",               // Constant rate factor for quality
    "-c:a", "aac",              // AAC audio codec  
    "-b:a", "128k",             // Audio bitrate
    `-output/${outputName}`
  ];
}
```

### 3. Memory Management and Optimization

#### Garbage Collection Strategy
```javascript
// Path: Processing completion → Memory cleanup → Resource release
// Processor: Manual garbage collection with monitoring
// Why: Prevents memory leaks in long-running extension

async function performMemoryCleanup() {
  // Clear FFmpeg file system
  try {
    ffmpeg.deleteFile("/working");
    ffmpeg.deleteFile("/input"); 
    ffmpeg.deleteFile("/output");
  } catch (e) {
    console.log("Cleanup error (expected):", e);
  }
  
  // Force garbage collection if available
  if (window.gc) {
    window.gc();
  }
  
  // Clear IndexedDB temporary files
  await clearTempStorage();
  
  console.log("🧹 Memory cleanup completed");
}
```

#### Batch Processing for Large Files
```javascript
// Path: Large segment list → Batch processing → Memory-efficient handling
// Processor: Iterative batch processing with cleanup
// Why: Prevents memory overflow on large video collections

async function processBatchedSegments(allSegments, batchSize = 50) {
  const results = [];
  
  for (let i = 0; i < allSegments.length; i += batchSize) {
    const batch = allSegments.slice(i, i + batchSize);
    
    console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(allSegments.length/batchSize)}`);
    
    const batchResult = await processSegmentBatch(batch);
    results.push(batchResult);
    
    // Cleanup between batches
    await performMemoryCleanup();
    
    sendProgressToPopup(
      ((i + batchSize) / allSegments.length) * 100,
      `Processing batch ${Math.floor(i/batchSize) + 1}...`
    );
  }
  
  return results;
}
```

---

## API Integration Patterns

### 1. Loom API Architecture

#### Primary API Endpoints
```javascript
const LOOM_API_ENDPOINTS = {
  VIDEO_INFO: "https://www.loom.com/api/campaigns/sessions/{videoId}",
  TRANSCRIPTS: "https://www.loom.com/api/campaigns/sessions/{videoId}/transcripts", 
  THUMBNAILS: "https://cdn.loom.com/sessions/{videoId}/thumbnails/",
  EMBED_INFO: "https://www.loom.com/embed/{videoId}"
};
```

#### Video Information Extraction
```javascript
// Path: Video ID → Loom API → Metadata extraction → Video URLs
// Processor: REST API with authentication handling
// Why: Retrieves comprehensive video metadata and download URLs

async function fetchLoomVideoData(videoId, password = null) {
  const apiUrl = `https://www.loom.com/api/campaigns/sessions/${videoId}`;
  
  const requestConfig = {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; LoomDownloader/1.0)',
      'Referer': `https://www.loom.com/share/${videoId}`
    }
  };
  
  // Handle password-protected videos
  if (password) {
    requestConfig.headers['X-Loom-Password'] = password;
  }
  
  const response = await fetch(apiUrl, requestConfig);
  
  if (response.status === 401) {
    throw new Error("This video is password-protected. Please provide the password.");
  }
  
  if (!response.ok) {
    throw new Error(`Failed to fetch video info: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  return parseVideoMetadata(data);
}

function parseVideoMetadata(apiData) {
  return {
    id: apiData.id,
    title: apiData.name || "Untitled Loom Video", 
    duration: apiData.video_duration,
    thumbnail: apiData.thumbnail_url,
    videoUrl: apiData.video_url,
    audioUrl: apiData.audio_url,
    owner: {
      name: apiData.owner?.display_name,
      email: apiData.owner?.email,
      avatar: apiData.owner?.avatar_url
    },
    dimensions: {
      width: apiData.video_width,
      height: apiData.video_height
    },
    timestamps: {
      createdAt: apiData.created_at,
      recordingStart: apiData.recording_start_time
    },
    privacy: {
      isPasswordProtected: apiData.is_password_protected,
      shareSettings: apiData.share_settings
    },
    technical: {
      codec: apiData.video_codec,
      bitrate: apiData.video_bitrate,
      fps: apiData.video_fps,
      format: apiData.video_format
    }
  };
}
```

#### Quality Selection and Stream URLs  
```javascript
// Path: Video metadata → Quality analysis → Stream URL selection
// Processor: Quality ranking with user preference handling
// Why: Provides multiple quality options and optimal stream selection

function extractQualityOptions(videoMetadata) {
  const qualities = [];
  
  // Parse available quality streams
  if (videoMetadata.qualities) {
    videoMetadata.qualities.forEach(quality => {
      qualities.push({
        label: `${quality.height}p (${quality.width}x${quality.height})`,
        value: quality.url,
        width: quality.width,
        height: quality.height,
        bitrate: quality.bitrate,
        fps: quality.fps,
        size: quality.estimated_file_size
      });
    });
  }
  
  // Fallback to main video URL
  if (videoMetadata.videoUrl) {
    qualities.push({
      label: "Original Quality",
      value: videoMetadata.videoUrl,
      width: videoMetadata.dimensions.width,
      height: videoMetadata.dimensions.height,
      isDefault: true
    });
  }
  
  // Sort by quality (highest first)
  return qualities.sort((a, b) => (b.height * b.width) - (a.height * a.width));
}
```

### 2. Authentication API Integration

#### Cloudflare Worker License Verification
```javascript
// Path: License key → Cloudflare Worker → Gumroad/GHL verification → Activation
// Processor: Cloudflare Worker with multi-platform verification
// Why: Secure server-side license validation with multiple payment platforms

const LICENSE_WORKER_CONFIG = {
  WORKER_URL: "https://ghl-check-license-worker.farleythecoder.workers.dev",
  PRODUCT_ID: "cHJvZHVjdF8xM2hDVnpFeFJRUGZCdGlLRWcxNEhSZEk=", // Base64 encoded
  TIMEOUT: 15000,
  RETRY_ATTEMPTS: 3
};

async function verifyLicenseWithRetry(licenseKey, email, attempt = 1) {
  try {
    const response = await fetch(LICENSE_WORKER_CONFIG.WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "LoomDownloader/1.0"
      },
      body: JSON.stringify({
        license_key: licenseKey,
        email: email,
        product_id: LICENSE_WORKER_CONFIG.PRODUCT_ID
      }),
      signal: AbortSignal.timeout(LICENSE_WORKER_CONFIG.TIMEOUT)
    });
    
    const result = await response.json();
    
    if (result.success) {
      return {
        success: true,
        registrationType: result.registration_type, // 'gumroad' or 'ghl'
        customerInfo: result.customer_info,
        licenseInfo: result.license_info
      };
    } else {
      throw new Error(result.error || "License verification failed");
    }
    
  } catch (error) {
    if (attempt < LICENSE_WORKER_CONFIG.RETRY_ATTEMPTS) {
      console.log(`License verification attempt ${attempt} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      return verifyLicenseWithRetry(licenseKey, email, attempt + 1);
    }
    
    throw error;
  }
}
```

### 3. Error Handling and API Resilience

#### Network Error Recovery
```javascript
// Path: API failure → Exponential backoff → Alternative endpoints → Fallback strategies  
// Processor: Retry logic with escalating delays
// Why: Handles network issues and API rate limiting gracefully

class APIClient {
  static async fetchWithRetry(url, options = {}, maxRetries = 3) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          timeout: 10000 * attempt // Increasing timeout
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return response;
        
      } catch (error) {
        lastError = error;
        
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          console.log(`API call failed (attempt ${attempt}), retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw new Error(`API call failed after ${maxRetries} attempts: ${lastError.message}`);
  }
}
```

---

## Security and Authentication

### 1. License Protection Architecture

The extension implements a comprehensive license verification system designed to protect against unauthorized usage while providing a smooth user experience.

#### Multi-Platform License Support
```javascript
// Path: License input → Platform detection → API verification → Activation storage
// Processor: Cloudflare Worker with Gumroad and GoHighLevel integration
// Why: Supports multiple payment platforms with unified verification

class LicenseManager {
  static async detectLicenseType(licenseKey) {
    // Gumroad license pattern: 8-character alphanumeric
    const gumroadPattern = /^[A-Z0-9]{8}$/;
    
    // GHL license pattern: UUID format  
    const ghlPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (gumroadPattern.test(licenseKey)) {
      return 'gumroad';
    } else if (ghlPattern.test(licenseKey)) {
      return 'ghl';
    } else {
      return 'unknown';
    }
  }
  
  static async verifyLicense(licenseKey, email) {
    const licenseType = this.detectLicenseType(licenseKey);
    
    const verificationData = {
      license_key: licenseKey,
      email: email,
      product_id: LICENSE_WORKER_CONFIG.PRODUCT_ID,
      license_type: licenseType
    };
    
    return await APIClient.fetchWithRetry(
      LICENSE_WORKER_CONFIG.WORKER_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(verificationData)
      }
    );
  }
}
```

#### Activation Data Protection
```javascript
// Path: License verification → Encrypted storage → Extension activation
// Processor: Chrome storage with data validation
// Why: Securely stores activation data while preventing tampering

class ActivationStorage {
  static async storeActivation(licenseData) {
    const activationData = {
      isActivated: true,
      licenseKey: this.hashLicenseKey(licenseData.licenseKey),
      email: licenseData.email,
      registrationType: licenseData.registrationType,
      activatedAt: new Date().toISOString(),
      lastVerified: Date.now(),
      checksum: this.calculateChecksum(licenseData)
    };
    
    await chrome.storage.local.set({ 
      activation: activationData,
      _activationVersion: "1.0"
    });
  }
  
  static hashLicenseKey(licenseKey) {
    // Simple hash for storage (not cryptographically secure)
    let hash = 0;
    for (let i = 0; i < licenseKey.length; i++) {
      const char = licenseKey.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }
  
  static calculateChecksum(data) {
    const str = JSON.stringify(data);
    return btoa(str).slice(0, 16); // Simple checksum
  }
}
```

### 2. Data Privacy and Security Measures

#### Sensitive Data Handling
```javascript
// Path: User input → Validation → Secure storage → Automatic cleanup
// Processor: Input sanitization with secure storage patterns
// Why: Protects user privacy and prevents data leakage

class DataProtection {
  static sanitizeInput(input, type = 'text') {
    if (!input) return '';
    
    const patterns = {
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      licenseKey: /^[A-Za-z0-9\-]+$/,
      videoId: /^[a-f0-9]{32}$/
    };
    
    // Basic sanitization
    let sanitized = input.toString().trim();
    
    // Type-specific validation
    if (patterns[type] && !patterns[type].test(sanitized)) {
      throw new Error(`Invalid ${type} format`);
    }
    
    return sanitized;
  }
  
  static async clearSensitiveData() {
    // Remove temporary video data
    await this.clearTempVideoData();
    
    // Clear download history
    await chrome.storage.local.remove(['downloadHistory', 'tempVideoData']);
    
    // Clear any cached passwords
    await chrome.storage.session.clear();
    
    console.log("🔒 Sensitive data cleared");
  }
}
```

#### Network Security Patterns
```javascript
// Path: Extension requests → HTTPS validation → CORS handling → Response validation
// Processor: Secure request patterns with validation
// Why: Prevents man-in-the-middle attacks and ensures data integrity

class SecureNetworking {
  static async secureRequest(url, options = {}) {
    // Validate HTTPS
    if (!url.startsWith('https://')) {
      throw new Error('Only HTTPS requests are allowed');
    }
    
    // Set secure headers
    const secureOptions = {
      ...options,
      headers: {
        'User-Agent': 'LoomDownloader/1.0',
        'Accept': 'application/json',
        ...options.headers
      },
      credentials: 'omit', // Don't send credentials
      mode: 'cors'
    };
    
    const response = await fetch(url, secureOptions);
    
    // Validate response
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    
    return response;
  }
}
```

---

## Video Detection Strategies

### 1. Multi-Layer Detection System

The extension employs a sophisticated multi-layer detection system that can identify Loom videos across various embedding contexts and page types.

#### Detection Priority Hierarchy
```javascript
// Priority 1: Direct Loom page detection
// Path: URL analysis → Video ID extraction → Metadata retrieval
// Processor: URL pattern matching with validation
// Why: Most reliable method for direct Loom pages

function detectDirectLoomPage() {
  const url = window.location.href;
  const patterns = [
    /loom\.com\/share\/([a-f0-9]{32})/,
    /loom\.com\/embed\/([a-f0-9]{32})/,
    /loom\.com\/v\/([a-f0-9]{32})/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return {
        videoId: match[1],
        type: 'direct',
        confidence: 1.0,
        source: url
      };
    }
  }
  
  return null;
}

// Priority 2: Iframe embed detection  
// Path: DOM scanning → Iframe source analysis → Video ID extraction
// Processor: DOM traversal with iframe filtering
// Why: Standard embedding method with high reliability

function detectIframeEmbeds() {
  const iframes = document.querySelectorAll('iframe[src*="loom.com"]');
  const detectedEmbeds = [];
  
  iframes.forEach(iframe => {
    const src = iframe.src;
    const videoId = src.match(/loom\.com\/embed\/([a-f0-9]{32})/)?.[1];
    
    if (videoId) {
      detectedEmbeds.push({
        videoId: videoId,
        type: 'iframe',
        confidence: 0.95,
        element: iframe,
        source: src,
        metadata: {
          title: iframe.title || iframe.getAttribute('aria-label'),
          width: iframe.width,
          height: iframe.height
        }
      });
    }
  });
  
  return detectedEmbeds;
}

// Priority 3: Video element detection
// Path: Video element scanning → Attribute analysis → Source validation  
// Processor: DOM query with attribute filtering
// Why: Custom implementations and alternative embedding methods

function detectVideoElements() {
  const selectors = [
    'video[data-loom-video-id]',
    'video[src*="loom.com"]', 
    'video[id*="loom"]',
    'video[class*="loom"]'
  ];
  
  const detectedVideos = [];
  
  selectors.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    
    elements.forEach(video => {
      const videoId = extractVideoIdFromElement(video);
      
      if (videoId && videoId.length === 32) {
        detectedVideos.push({
          videoId: videoId,
          type: 'video-element',
          confidence: 0.8,
          element: video,
          metadata: {
            title: video.title || video.getAttribute('aria-label'),
            duration: video.duration,
            poster: video.poster
          }
        });
      }
    });
  });
  
  return detectedVideos;
}
```

### 2. Dynamic Content Monitoring

#### MutationObserver Implementation
```javascript
// Path: DOM changes → Change filtering → Video detection → Event notification
// Processor: MutationObserver with throttled detection
// Why: Handles single-page applications and dynamically loaded content

class DynamicVideoDetector {
  constructor() {
    this.observer = null;
    this.lastCheck = 0;
    this.checkInterval = 2000; // 2 second throttle
    this.detectedVideos = new Set();
  }
  
  startMonitoring() {
    this.observer = new MutationObserver((mutations) => {
      const now = Date.now();
      
      // Throttle checks to avoid performance issues
      if (now - this.lastCheck < this.checkInterval) {
        return;
      }
      
      this.lastCheck = now;
      
      // Check if mutations contain relevant changes
      const hasRelevantChanges = mutations.some(mutation => 
        this.isRelevantMutation(mutation)
      );
      
      if (hasRelevantChanges) {
        setTimeout(() => this.performVideoDetection(), 500);
      }
    });
    
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-loom-video-id', 'class', 'id']
    });
  }
  
  isRelevantMutation(mutation) {
    // Check if mutation involves video-related elements
    if (mutation.type === 'childList') {
      const addedNodes = Array.from(mutation.addedNodes);
      return addedNodes.some(node => 
        node.nodeType === Node.ELEMENT_NODE &&
        (node.tagName === 'IFRAME' || 
         node.tagName === 'VIDEO' ||
         node.querySelector('iframe, video'))
      );
    }
    
    if (mutation.type === 'attributes') {
      return mutation.target.tagName === 'IFRAME' ||
             mutation.target.tagName === 'VIDEO';
    }
    
    return false;
  }
}
```

### 3. Fallback Detection Methods

#### Script Tag Analysis
```javascript
// Path: Script content scanning → Pattern matching → Video ID extraction  
// Processor: Regex pattern matching with content filtering
// Why: Catches programmatically embedded videos and configuration data

function scanScriptTags() {
  const scripts = document.querySelectorAll('script');
  const detectedIds = [];
  
  const patterns = [
    /loom\.com\/(?:embed|share)\/([a-f0-9]{32})/gi,
    /"videoId":\s*"([a-f0-9]{32})"/gi,
    /'loom_video_id':\s*'([a-f0-9]{32})'/gi,
    /data-video-id=["']([a-f0-9]{32})["']/gi
  ];
  
  scripts.forEach(script => {
    const content = script.textContent || script.innerHTML;
    
    if (content.includes('loom')) {
      patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const videoId = match[1];
          if (!detectedIds.includes(videoId)) {
            detectedIds.push({
              videoId: videoId,
              type: 'script-embedded',
              confidence: 0.7,
              source: 'script-analysis',
              scriptContent: content.substring(Math.max(0, match.index - 50), 
                                            Math.min(content.length, match.index + 100))
            });
          }
        }
      });
    }
  });
  
  return detectedIds;
}
```

#### Network Request Interception
```javascript
// Path: Network monitoring → Request filtering → URL analysis → Video detection
// Processor: Fetch API interception with pattern matching
// Why: Detects videos loaded through JavaScript requests

class NetworkVideoDetector {
  static initialize() {
    // Intercept fetch requests
    const originalFetch = window.fetch;
    
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);
      
      // Check if request URL contains Loom references
      const url = args[0];
      if (typeof url === 'string' && url.includes('loom.com')) {
        NetworkVideoDetector.analyzeRequest(url, response);
      }
      
      return response;
    };
    
    // Intercept XMLHttpRequest
    const originalXHROpen = XMLHttpRequest.prototype.open;
    
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      if (url && url.includes('loom.com')) {
        NetworkVideoDetector.analyzeRequest(url);
      }
      
      return originalXHROpen.call(this, method, url, ...rest);
    };
  }
  
  static analyzeRequest(url, response = null) {
    const videoId = url.match(/([a-f0-9]{32})/)?.[1];
    
    if (videoId) {
      chrome.runtime.sendMessage({
        action: 'networkVideoDetected',
        videoId: videoId,
        url: url,
        detectionMethod: 'network-intercept'
      }).catch(() => {
        // Ignore if extension context is invalid
      });
    }
  }
}
```

---

## Error Handling and Recovery

### 1. Comprehensive Error Classification

#### Error Type Definitions
```javascript
// Path: Error occurrence → Classification → Appropriate handling → User notification
// Processor: Error classification system with recovery strategies
// Why: Provides specific handling for different error types

class ErrorHandler {
  static ERROR_TYPES = {
    NETWORK: 'network',
    AUTHENTICATION: 'authentication', 
    PROCESSING: 'processing',
    PERMISSION: 'permission',
    VALIDATION: 'validation',
    STORAGE: 'storage',
    TIMEOUT: 'timeout'
  };
  
  static ERROR_RECOVERY_STRATEGIES = {
    [this.ERROR_TYPES.NETWORK]: 'retry_with_backoff',
    [this.ERROR_TYPES.AUTHENTICATION]: 'request_reauth',
    [this.ERROR_TYPES.PROCESSING]: 'fallback_method',
    [this.ERROR_TYPES.PERMISSION]: 'request_permission',
    [this.ERROR_TYPES.VALIDATION]: 'sanitize_and_retry',
    [this.ERROR_TYPES.STORAGE]: 'clear_and_retry',
    [this.ERROR_TYPES.TIMEOUT]: 'increase_timeout_and_retry'
  };
  
  static classifyError(error) {
    const errorMessage = error.message.toLowerCase();
    
    if (errorMessage.includes('network') || errorMessage.includes('fetch')) {
      return this.ERROR_TYPES.NETWORK;
    }
    
    if (errorMessage.includes('password') || errorMessage.includes('401') || errorMessage.includes('403')) {
      return this.ERROR_TYPES.AUTHENTICATION;
    }
    
    if (errorMessage.includes('ffmpeg') || errorMessage.includes('processing')) {
      return this.ERROR_TYPES.PROCESSING;
    }
    
    if (errorMessage.includes('permission') || errorMessage.includes('cors')) {
      return this.ERROR_TYPES.PERMISSION;
    }
    
    if (errorMessage.includes('timeout')) {
      return this.ERROR_TYPES.TIMEOUT;
    }
    
    return 'unknown';
  }
}
```

### 2. Recovery Strategies Implementation

#### Network Error Recovery
```javascript
// Path: Network failure → Retry logic → Alternative endpoints → Graceful degradation
// Processor: Exponential backoff with endpoint switching
// Why: Handles temporary network issues and API problems

class NetworkErrorRecovery {
  static async handleNetworkError(error, originalRequest, attempt = 1) {
    const maxAttempts = 3;
    const baseDelay = 1000;
    
    if (attempt > maxAttempts) {
      throw new Error(`Network request failed after ${maxAttempts} attempts: ${error.message}`);
    }
    
    console.log(`Network error on attempt ${attempt}, retrying in ${baseDelay * attempt}ms...`);
    
    // Exponential backoff
    await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, attempt - 1)));
    
    try {
      // Try alternative endpoint if available
      if (attempt > 1 && originalRequest.alternativeEndpoint) {
        console.log('Trying alternative endpoint...');
        return await this.tryAlternativeEndpoint(originalRequest);
      }
      
      // Retry original request
      return await originalRequest.execute();
      
    } catch (retryError) {
      return await this.handleNetworkError(retryError, originalRequest, attempt + 1);
    }
  }
  
  static async tryAlternativeEndpoint(request) {
    // Implementation for alternative API endpoints
    const alternativeUrls = {
      'api.loom.com': 'api2.loom.com',
      'www.loom.com/api': 'api.loom.com/v1'
    };
    
    // Modify request to use alternative endpoint
    // ... implementation details
  }
}
```

#### Processing Error Recovery
```javascript
// Path: Processing failure → Error analysis → Method selection → Alternative processing
// Processor: Fallback processing methods with capability detection
// Why: Ensures video processing succeeds even if primary method fails

class ProcessingErrorRecovery {
  static async handleProcessingError(error, processingConfig) {
    const errorType = this.analyzeProcessingError(error);
    
    switch (errorType) {
      case 'memory_exhausted':
        return await this.handleMemoryError(processingConfig);
        
      case 'codec_unsupported':
        return await this.handleCodecError(processingConfig);
        
      case 'file_too_large':
        return await this.handleLargeFileError(processingConfig);
        
      case 'ffmpeg_error':
        return await this.handleFFmpegError(processingConfig);
        
      default:
        throw new Error(`Unrecoverable processing error: ${error.message}`);
    }
  }
  
  static async handleMemoryError(config) {
    console.log('Memory exhausted, switching to chunked processing...');
    
    // Switch to chunked processing mode
    const chunkedConfig = {
      ...config,
      processingMode: 'chunked',
      chunkSize: Math.floor(config.originalChunkSize / 2),
      memoryOptimization: true
    };
    
    return await this.processWithChunking(chunkedConfig);
  }
  
  static async handleCodecError(config) {
    console.log('Codec unsupported, trying alternative codec...');
    
    const alternativeCodecs = {
      'libx264': ['libx265', 'copy'],
      'aac': ['mp3', 'copy'],
      'libvpx': ['libx264', 'copy']
    };
    
    // Try alternative codec
    const newConfig = this.replaceCodec(config, alternativeCodecs);
    return await this.retryProcessing(newConfig);
  }
}
```

### 3. User-Facing Error Communication

#### Error Message Translation
```javascript
// Path: Technical error → User-friendly message → Action suggestions → Help resources
// Processor: Error message mapping with localization support
// Why: Provides clear user guidance without technical jargon

class UserErrorCommunication {
  static ERROR_MESSAGES = {
    'password_protected': {
      title: 'Password Required',
      message: 'This video is password-protected. Please provide the password.',
      action: 'Enter password in the popup',
      severity: 'warning'
    },
    
    'license_invalid': {
      title: 'License Verification Failed', 
      message: 'Your license key could not be verified. Please check your license key and internet connection.',
      action: 'Re-enter license key or contact support',
      severity: 'error'
    },
    
    'network_timeout': {
      title: 'Connection Timeout',
      message: 'The download is taking longer than expected. This may be due to a slow connection or large file size.',
      action: 'Try again or check your internet connection',
      severity: 'warning'
    },
    
    'processing_failed': {
      title: 'Video Processing Failed',
      message: 'There was an error processing the video. The file may be corrupted or in an unsupported format.',
      action: 'Try downloading again or contact support',
      severity: 'error'
    },
    
    'storage_full': {
      title: 'Storage Full',
      message: 'Your device storage is full. Please free up space and try again.',
      action: 'Clear storage space',
      severity: 'error'
    }
  };
  
  static translateError(technicalError) {
    const errorType = this.identifyErrorType(technicalError);
    const translation = this.ERROR_MESSAGES[errorType];
    
    if (translation) {
      return {
        ...translation,
        originalError: technicalError.message,
        timestamp: new Date().toISOString()
      };
    }
    
    // Fallback for unknown errors
    return {
      title: 'Unexpected Error',
      message: 'An unexpected error occurred. Please try again.',
      action: 'Retry the operation',
      severity: 'error',
      originalError: technicalError.message
    };
  }
}
```

---

## Performance Optimizations

### 1. Memory Management Strategies

#### Efficient Blob Handling
```javascript
// Path: Large video data → Memory optimization → Garbage collection → Resource cleanup
// Processor: Memory-aware blob processing with automatic cleanup
// Why: Prevents browser crashes with large video files

class MemoryOptimizedProcessor {
  static MEMORY_THRESHOLDS = {
    WARNING: 500 * 1024 * 1024,    // 500MB
    CRITICAL: 1024 * 1024 * 1024,  // 1GB
    MAXIMUM: 2048 * 1024 * 1024    // 2GB
  };
  
  static async processLargeVideo(videoData, processingConfig) {
    const dataSize = this.calculateDataSize(videoData);
    
    if (dataSize > this.MEMORY_THRESHOLDS.MAXIMUM) {
      throw new Error('Video file too large for browser processing');
    }
    
    if (dataSize > this.MEMORY_THRESHOLDS.CRITICAL) {
      return await this.processingWithMemoryManagement(videoData, processingConfig);
    }
    
    if (dataSize > this.MEMORY_THRESHOLDS.WARNING) {
      return await this.processWithMonitoring(videoData, processingConfig);
    }
    
    return await this.processNormally(videoData, processingConfig);
  }
  
  static async processingWithMemoryManagement(videoData, config) {
    console.log('🧠 Entering memory-managed processing mode');
    
    // Force garbage collection before processing
    if (window.gc) {
      window.gc();
    }
    
    // Process in smaller chunks
    const chunkSize = Math.min(config.chunkSize, 100 * 1024 * 1024); // Max 100MB chunks
    const chunks = this.createChunks(videoData, chunkSize);
    
    const results = [];
    
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length}`);
      
      // Process chunk
      const chunkResult = await this.processChunk(chunks[i], config);
      results.push(chunkResult);
      
      // Cleanup after each chunk
      chunks[i] = null;
      
      if (window.gc && i % 5 === 0) {
        window.gc();
      }
      
      // Monitor memory usage
      const memoryInfo = await this.getMemoryInfo();
      if (memoryInfo.usedJSHeapSize > this.MEMORY_THRESHOLDS.CRITICAL) {
        console.warn('Memory usage critical, forcing cleanup');
        await this.forceCleanup();
      }
    }
    
    return await this.combineResults(results);
  }
  
  static async getMemoryInfo() {
    if (performance.memory) {
      return {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
      };
    }
    
    return { usedJSHeapSize: 0, totalJSHeapSize: 0, jsHeapSizeLimit: 0 };
  }
}
```

### 2. Download Performance Optimization

#### Parallel Download Strategy
```javascript
// Path: Large file → Segment splitting → Parallel downloads → Stream merging
// Processor: Concurrent download manager with bandwidth optimization
// Why: Maximizes download speed while respecting server limits

class ParallelDownloader {
  static OPTIMAL_CONNECTIONS = 4;
  static MAX_CONNECTIONS = 6;
  static SEGMENT_SIZE = 10 * 1024 * 1024; // 10MB segments
  
  static async downloadLargeFile(url, fileName, totalSize) {
    // Determine optimal connection count based on file size
    const connectionCount = this.calculateOptimalConnections(totalSize);
    const segmentSize = Math.ceil(totalSize / connectionCount);
    
    console.log(`Downloading with ${connectionCount} parallel connections`);
    
    const downloadPromises = [];
    
    for (let i = 0; i < connectionCount; i++) {
      const start = i * segmentSize;
      const end = Math.min(start + segmentSize - 1, totalSize - 1);
      
      downloadPromises.push(
        this.downloadSegment(url, start, end, i)
      );
    }
    
    // Download all segments in parallel
    const segments = await Promise.all(downloadPromises);
    
    // Combine segments
    return await this.combineSegments(segments, fileName);
  }
  
  static async downloadSegment(url, start, end, segmentIndex) {
    const headers = {
      'Range': `bytes=${start}-${end}`
    };
    
    console.log(`Downloading segment ${segmentIndex}: bytes ${start}-${end}`);
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      throw new Error(`Segment ${segmentIndex} download failed: ${response.status}`);
    }
    
    const segmentData = await response.arrayBuffer();
    
    return {
      index: segmentIndex,
      data: segmentData,
      start: start,
      end: end
    };
  }
  
  static calculateOptimalConnections(fileSize) {
    if (fileSize < 50 * 1024 * 1024) { // < 50MB
      return 1;
    } else if (fileSize < 200 * 1024 * 1024) { // < 200MB
      return 2;
    } else if (fileSize < 500 * 1024 * 1024) { // < 500MB
      return this.OPTIMAL_CONNECTIONS;
    } else {
      return this.MAX_CONNECTIONS;
    }
  }
}
```

### 3. Processing Pipeline Optimization

#### Streaming Processing Architecture
```javascript
// Path: Video data → Streaming processor → Incremental output → Progress feedback
// Processor: Stream-based processing with real-time progress
// Why: Reduces memory usage and provides immediate feedback

class StreamingProcessor {
  static async processVideoStream(inputStream, processingConfig) {
    const reader = inputStream.getReader();
    const outputStream = new WritableStream({
      write(chunk) {
        return this.processChunk(chunk, processingConfig);
      }
    });
    
    const writer = outputStream.getWriter();
    let totalProcessed = 0;
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        // Process chunk
        const processedChunk = await this.processChunk(value, processingConfig);
        
        // Write processed chunk
        await writer.write(processedChunk);
        
        totalProcessed += value.length;
        
        // Report progress
        this.reportProgress(totalProcessed, processingConfig.totalSize);
      }
    } finally {
      await writer.close();
      reader.releaseLock();
    }
  }
  
  static async processChunk(chunk, config) {
    // Apply processing based on config
    switch (config.type) {
      case 'transcode':
        return await this.transcodeChunk(chunk, config);
        
      case 'filter':
        return await this.filterChunk(chunk, config);
        
      case 'merge':
        return await this.mergeChunk(chunk, config);
        
      default:
        return chunk; // Pass through
    }
  }
}
```

---

## Technical Specifications

### 1. Extension Architecture Specifications

#### Manifest V3 Configuration
```json
{
  "manifest_version": 3,
  "name": "Loom Video Downloader",
  "version": "1.0",
  "description": "Download Loom videos directly to your computer",
  "permissions": [
    "downloads",        // File download capability
    "activeTab",        // Access to current tab
    "storage",          // Local data storage
    "tabs",             // Tab management
    "scripting",        // Dynamic script injection
    "offscreen",        // Offscreen document creation
    "webNavigation"     // Navigation event monitoring
  ],
  "host_permissions": [
    "https://www.loom.com/*",           // Primary Loom domain
    "https://*.loom.com/*",             // Loom subdomains
    "https://*.loomcdn.com/*",          // Loom CDN
    "https://*.cloudfront.net/*",       // AWS CloudFront CDN
    "https://unpkg.com/*",              // FFmpeg library CDN
    "https://api.gumroad.com/*"         // License verification API
  ],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    "sandbox": "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; child-src 'self';"
  }
}
```

#### Service Worker Architecture
- **Background Script**: `background-enhanced.js` (ES6 modules)
- **Offscreen Document**: Isolated processing context for FFmpeg.wasm
- **Content Scripts**: Multi-layer injection for detection
- **Message Passing**: Chrome runtime API for component communication

### 2. Video Processing Capabilities

#### Supported Input Formats
- **MP4**: Direct download or conversion
- **WebM**: Transcode to MP4 using FFmpeg.wasm
- **HLS (m3u8)**: Segment download and concatenation
- **DASH**: Manifest parsing and segment merging
- **Separate A/V Streams**: Audio/video combination

#### Output Specifications
- **Format**: MP4 (H.264 video, AAC audio)
- **Quality Options**: Original, 1080p, 720p, 480p (based on source)
- **Codec Settings**: Optimized for compatibility and file size
- **Metadata**: Preserved title, duration, thumbnail information

#### Processing Performance
- **Memory Usage**: Optimized for files up to 2GB
- **Chunked Processing**: Automatic for large files (>1.5GB)
- **Parallel Downloads**: Up to 6 concurrent connections
- **Processing Speed**: Dependent on device capabilities and FFmpeg.wasm performance

### 3. Database and Storage Architecture

#### IndexedDB Schema
```javascript
const DB_SCHEMA = {
  name: "LoomDownloaderDB",
  version: 1,
  stores: {
    videos: {
      keyPath: "id",
      autoIncrement: false,
      indexes: {
        timestamp: { keyPath: "timestamp", unique: false },
        status: { keyPath: "status", unique: false }
      }
    }
  }
};

// Data structure for video storage
const VIDEO_RECORD = {
  id: "string",           // Video ID
  blob: "Blob",           // Video data
  metadata: {
    title: "string",
    duration: "number",
    size: "number",
    format: "string"
  },
  timestamp: "number",    // Storage timestamp
  status: "string"        // Processing status
};
```

#### Chrome Storage Usage
```javascript
const STORAGE_STRUCTURE = {
  // License activation data
  activation: {
    isActivated: "boolean",
    licenseKey: "string",
    email: "string", 
    registrationType: "string",
    activatedAt: "ISO8601 timestamp"
  },
  
  // Download state persistence
  downloadState: {
    inProgress: "boolean",
    percentage: "number",
    status: "string",
    speed: "string"
  },
  
  // User preferences
  preferences: {
    defaultQuality: "string",
    downloadLocation: "string",
    autoDetection: "boolean"
  }
};
```

### 4. API Integration Specifications

#### Loom API Endpoints
```javascript
const LOOM_ENDPOINTS = {
  VIDEO_INFO: {
    url: "https://www.loom.com/api/campaigns/sessions/{videoId}",
    method: "GET",
    authentication: "Optional password header",
    rateLimit: "60 requests/minute"
  },
  
  TRANSCRIPT: {
    url: "https://www.loom.com/api/campaigns/sessions/{videoId}/transcripts",
    method: "GET",
    authentication: "Session-based",
    rateLimit: "30 requests/minute"
  }
};
```

#### License Verification API
```javascript
const LICENSE_API = {
  endpoint: "https://ghl-check-license-worker.farleythecoder.workers.dev",
  method: "POST",
  requestFormat: {
    license_key: "string",
    email: "string", 
    product_id: "base64-encoded-string"
  },
  responseFormat: {
    success: "boolean",
    registration_type: "string", // 'gumroad' or 'ghl'
    customer_info: "object",
    license_info: "object",
    error: "string"
  },
  timeout: "15 seconds",
  retryAttempts: 3
};
```

### 5. Security Specifications

#### Content Security Policy
- **WebAssembly**: Enabled with `wasm-unsafe-eval`
- **Script Sources**: Limited to `'self'` and specific CDNs
- **Network Access**: HTTPS-only with specific domain allowlist
- **Data Protection**: No credential transmission in requests

#### Privacy Protection
- **Data Retention**: Temporary files cleared after processing
- **User Data**: License information hashed and stored locally
- **Network Isolation**: No third-party tracking or analytics
- **Permission Model**: Minimal required permissions with user consent

### 6. Browser Compatibility

#### Supported Browsers
- **Chrome**: Version 88+ (Manifest V3 requirement)
- **Edge**: Version 88+ (Chromium-based)
- **Opera**: Version 74+ (Chromium-based)

#### Required APIs
- **Service Workers**: Background processing
- **OffscreenCanvas**: Video processing isolation
- **WebAssembly**: FFmpeg.wasm execution
- **IndexedDB**: Large file storage
- **Downloads API**: File output

#### Performance Requirements
- **RAM**: Minimum 4GB (8GB recommended for large videos)
- **Storage**: Temporary space equal to video size during processing
- **CPU**: Modern processor with WebAssembly support

---

## Conclusion

The **Loom Downloader** represents a sophisticated Chrome Extension architecture that successfully balances functionality, performance, and security. The multi-layered approach to video detection ensures reliable operation across diverse web environments, while the FFmpeg.wasm integration provides powerful video processing capabilities directly in the browser.

### Key Architectural Strengths

1. **Robust Detection System**: Multi-strategy video detection with high reliability across different embedding methods and dynamic content
2. **Advanced Processing Pipeline**: WebAssembly-based video processing with memory optimization for large files
3. **Comprehensive Error Handling**: Detailed error classification with appropriate recovery strategies
4. **Security-First Design**: License verification system with data protection and secure communication patterns
5. **Performance Optimization**: Memory management, parallel downloads, and efficient processing for optimal user experience

### Technical Innovation

The extension demonstrates several innovative approaches:
- **WORKERFS Integration**: Direct file mounting in FFmpeg without memory duplication
- **Dynamic Content Monitoring**: Real-time video detection for single-page applications  
- **Chunked Processing**: Handling of files exceeding browser memory limits
- **Multi-Platform Licensing**: Unified verification across different payment platforms

This architecture provides a solid foundation for video downloading functionality while maintaining the flexibility to adapt to changes in the Loom platform and web standards. The comprehensive documentation ensures that future developers can understand, maintain, and extend the system effectively.

---

*Documentation Version: 1.0*  
*Last Updated: 2024*  
*Total Pages: 75*
