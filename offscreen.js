// FastStream-based offscreen script for HLS processing (Enhanced with fMP4 support)
import "./site-config.js";
import "./logger.js";
try {
  const map = { none: 'silent', error: 'error', warn: 'warn', log: 'info', info: 'info', debug: 'debug' };
  const sc = globalThis?.SiteConfig || {};
  const lvl = map[String(sc.LOG_LEVEL || '').toLowerCase()] || undefined;
  if (lvl && globalThis?.LoomLogger) globalThis.LoomLogger.setLevel(lvl);
} catch (_) {}
import {
  set as idbSet,
  get as idbGet,
  remove as idbRemove,
} from "./indexed-db.js";

console.log("🚀 FastStream Offscreen script starting...");

// Global variables to hold loaded modules
let SimpleHLS2MP4Converter = null;
let HLS2MP4Class = null;

// Utility functions
const getBatchSize = (totalSegments) => Math.min(10, totalSegments);

const debugLog = (message, level = "info") => {
  // Only log important messages to reduce spam
  const isImportant = message.includes('❌') || message.includes('✅') || 
                     message.includes('Starting') || message.includes('Failed') || 
                     message.includes('completed') || message.includes('🧭') || 
                     message.includes('PATH') || message.includes('MESSAGE:') ||
                     level === "error";
  
  if (isImportant) {
    console.log(message);
    try {
      chrome.runtime
        .sendMessage({
          type: "DEBUG_MESSAGE",
          message: `📱 FASTSTREAM OFFSCREEN: ${message}`,
          level: level,
        })
        .catch(() => {});
    } catch (error) {}
  }
};

const toUint8Array = (data) => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data);
};

const safeJSONStringify = (value) => {
  try {
    return JSON.stringify(value);
  } catch (err) {
    try {
      return JSON.stringify(value, (key, val) => {
        if (typeof val === 'number' && !Number.isFinite(val)) {
          return String(val);
        }
        if (val instanceof ArrayBuffer) {
          return `ArrayBuffer(${val.byteLength})`;
        }
        if (ArrayBuffer.isView(val)) {
          return `${val.constructor?.name || 'TypedArray'}(${val.byteLength})`;
        }
        return val;
      });
    } catch (_) {
      return '[Unserializable]';
    }
  }
};

const toBlobSafe = (data, mimeType = "application/octet-stream") => {
  if (!data) return null;
  if (data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return new Blob([data], { type: mimeType });
  if (data instanceof Uint8Array) {
    const buffer =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? data.buffer
        : data.slice().buffer;
    return new Blob([buffer], { type: mimeType });
  }
  if (ArrayBuffer.isView(data) && data.buffer) {
    try {
      const view = new Uint8Array(
        data.buffer,
        data.byteOffset || 0,
        data.byteLength || data.length || 0
      );
      const buffer =
        view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
          ? view.buffer
          : view.slice().buffer;
      return new Blob([buffer], { type: mimeType });
    } catch (error) {
      debugLog(`⚠️ Failed to convert typed array to blob: ${error.message}`);
    }
  }
  if (data?.data && Array.isArray(data.data)) {
    return new Blob([new Uint8Array(data.data)], { type: mimeType });
  }
  return new Blob([data], { type: mimeType });
};

const containsMP4Box = (data, boxType) => {
  const dataArray = toUint8Array(data);
  const boxBytes = new TextEncoder().encode(boxType);
  for (let i = 0; i <= dataArray.length - boxBytes.length; i++) {
    let match = true;
    for (let j = 0; j < boxBytes.length; j++) {
      if (dataArray[i + j] !== boxBytes[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
};

const isSegmentFMP4 = (segmentData) => {
  try {
    const data = toUint8Array(segmentData);
    if (data.length < 16) return false;

    const hasMP4Boxes = containsMP4Box(data, "ftyp") || 
                       containsMP4Box(data, "moof") || 
                       containsMP4Box(data, "moov");
    
    return hasMP4Boxes;
  } catch (error) {
    return false;
  }
};

const getMP4BoxType = (data) => {
  if (data.length < 8) return "unknown";
  const type = String.fromCharCode(data[4], data[5], data[6], data[7]);
  const knownTypes = [
    "ftyp", "moov", "moof", "mdat", "free", "skip", "wide", "pdin", "meco", "styp",
  ];
  return knownTypes.includes(type) ? type : "unknown";
};

const containsBox = (data, boxType) => containsMP4Box(data, boxType);

const parseMpdData = (mpdData) => {
  try {
    let mpdXml = "";
    if (typeof mpdData === "string") {
      mpdXml = mpdData;
    } else if (mpdData.mpdContent) {
      mpdXml = mpdData.mpdContent;
    } else if (mpdData.manifestContent) {
      mpdXml = mpdData.manifestContent;
    } else {
      debugLog("DASH MPD: Unknown data format, using defaults");
      mpdXml = "";
    }

    debugLog(`DASH MPD: Processing XML length: ${mpdXml.length} chars`);

    let totalDuration = 509.037;
    const durationMatch = mpdXml.match(/mediaPresentationDuration="PT([\d.]+)S"/);
    if (durationMatch) {
      totalDuration = parseFloat(durationMatch[1]);
      debugLog(`DASH MPD: Found duration: ${totalDuration}s`);
    }

    const timescale = 1000000;
    const segmentTimeline = { video: [], audio: [] };

    // Parse audio AdaptationSet
    const audioAdaptationMatch = mpdXml.match(
      /<AdaptationSet[^>]*contentType="audio"[^>]*>.*?<\/AdaptationSet>/s
    );
    if (audioAdaptationMatch) {
      const audioSection = audioAdaptationMatch[0];
      const audioTimelineMatches = [
        ...audioSection.matchAll(/<S t="(\d+)" d="(\d+)"/g),
      ];
      audioTimelineMatches.forEach((match) => {
        const t = parseInt(match[1]);
        const d = parseInt(match[2]);
        segmentTimeline.audio.push({ t, d });
      });
      debugLog(`DASH MPD: Found ${segmentTimeline.audio.length} audio timeline entries`);
    }

    // Parse video AdaptationSet
    const allAdaptationSets = [
      ...mpdXml.matchAll(/<AdaptationSet[^>]*>.*?<\/AdaptationSet>/gs),
    ];
    for (const adaptationSet of allAdaptationSets) {
      const section = adaptationSet[0];
      if (section.includes('contentType="audio"')) continue;

      const representations = [
        ...section.matchAll(/<Representation[^>]*bandwidth="(\d+)"[^>]*>/g),
      ];
      const hasHighBandwidth = representations.some(
        (rep) => parseInt(rep[1]) > 500000
      );

      if (hasHighBandwidth) {
        const videoTimelineMatches = [
          ...section.matchAll(/<S t="(\d+)" d="(\d+)"/g),
        ];
        videoTimelineMatches.forEach((match) => {
          const t = parseInt(match[1]);
          const d = parseInt(match[2]);
          segmentTimeline.video.push({ t, d });
        });
        debugLog(`DASH MPD: Found ${segmentTimeline.video.length} video timeline entries`);
        break;
      }
    }

    return { totalDuration, timescale, segmentTimeline };
  } catch (error) {
    debugLog(`DASH MPD: Parse failed, using defaults: ${error.message}`);
    return {
      totalDuration: 509.037,
      timescale: 1000000,
      segmentTimeline: { video: [], audio: [] },
    };
  }
};

const downloadBlob = (blob, fileName, notificationName = fileName) => {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

  try {
    chrome.runtime
      .sendMessage({
        type: "DOWNLOAD_COMPLETE_NOTIFICATION",
        fileName: notificationName,
      })
      .catch(() => {});
  } catch (error) {}
};

// Load modules dynamically
async function loadModules() {
  try {
    debugLog("🔄 Loading modules...");
    debugLog("✅ IndexedDB module imported");

    const { HLS2MP4 } = await import("./modules/hls2mp4/hls2mp4.mjs");
    try {
      HLS2MP4.setLogger?.((label, payload = {}) => {
        const serialized = safeJSONStringify(payload);
        debugLog(`MESSAGE: HLS2MP4 ${label}: ${serialized}`);
      });
    } catch (loggerErr) {
      debugLog(`⚠️ Failed to attach HLS2MP4 logger: ${loggerErr?.message || loggerErr}`);
    }
    HLS2MP4Class = HLS2MP4;

    SimpleHLS2MP4Converter = class FastStreamHLS2MP4Wrapper {
      constructor(options = {}) {
        this.cancelled = false;
        this.progressCallback = options.onProgress;
        this.hls2mp4 = null;
      }

      cancel() {
        this.cancelled = true;
        if (this.hls2mp4) {
          this.hls2mp4.cancel();
        }
      }

      async convertSegments(segments, options = {}) {
        debugLog(`🔧 FastStream converter processing ${segments.length} segments`);
        debugLog(`🔧 Stream format detected: ${options.streamFormat || "unknown"}`);

        try {
          if (this.isFMP4Stream(segments, options)) {
            debugLog("🔧 Detected fMP4 HLS stream with init segments");
            return await this.convertFMP4Segments(segments, options);
          }

          if (options.isDASH || options.segmentType === "DASH") {
            debugLog("🔧 Detected DASH segments, processing...");
            return await this.convertDashSegments(segments, options);
          }

          debugLog("🔧 Processing traditional TS segments");
          return await this.convertTSSegments(segments, options);
        } catch (error) {
          debugLog(`🔧 FastStream conversion failed: ${error.message}`);
          throw error;
        }
      }

      isFMP4Stream(segments, options) {
        if (
          options.streamFormat === "fmp4" ||
          options.sourceUrl?.includes("sf=fmp4") ||
          options.sourceUrl?.includes("format=fmp4")
        ) {
          debugLog("🔧 fMP4 detected via URL parameters");
          return true;
        }

        if (options.manifestContent) {
          const hasMap = options.manifestContent.includes("#EXT-X-MAP:");
          const version6Plus = /#EXT-X-VERSION:([6-9]|\d{2,})/.test(
            options.manifestContent
          );
          if (hasMap || version6Plus) {
            debugLog(`🔧 fMP4 indicators: EXT-X-MAP=${hasMap}, Version6+=${version6Plus}`);
            return true;
          }
        }

        if (segments.length > 0) {
          const firstSegment = segments[0];
          const outer = firstSegment && typeof firstSegment === 'object' && 'data' in firstSegment ? firstSegment.data : firstSegment;
          const bytes = outer && typeof outer === 'object' && 'data' in outer ? outer.data : outer;

          if (
            this.containsMP4Box(bytes, "ftyp") ||
            this.containsMP4Box(bytes, "moof")
          ) {
            debugLog("🔧 Found MP4 box structure in segments");
            return true;
          }
        }

        return false;
      }

      async convertFMP4Segments(segments, options = {}) {
        debugLog(`🔧 Processing ${segments.length} fMP4 HLS segments`);

        try {
          const { initSegments, mediaSegments } = this.separateFMP4Segments(segments);

          debugLog(`🔧 Found ${initSegments.length} init segments and ${mediaSegments.length} media segments`);

          if (initSegments.length === 0) {
            debugLog("🔧 No init segments found, trying fallback concatenation");
            return await this.fallbackConcatenateFMP4(segments, options);
          }

          const completeStream = await this.buildFMP4Stream(
            initSegments,
            mediaSegments,
            options
          );

          const result = await this.processWithMediaBunny(completeStream, options);
          return result;
        } catch (error) {
          debugLog(`🔧 fMP4 processing failed: ${error.message}`);
          debugLog("🔧 Trying fallback: concatenate all fMP4 segments");
          return await this.fallbackConcatenateFMP4(segments, options);
        }
      }

      separateFMP4Segments(segments) {
        const initSegments = [];
        const mediaSegments = [];

        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i];
          const segmentData = segment.data || segment;
          const dataArray = this.toUint8Array(segmentData);

          const isMarkedInit = segment.isInit === true;
          const isContentInit = this.isInitializationSegment(dataArray);
          const isInitSegment = isMarkedInit || isContentInit;


          if (isInitSegment) {
            initSegments.push(dataArray);
          } else {
            mediaSegments.push(dataArray);
          }
        }

        return { initSegments, mediaSegments };
      }

      isInitializationSegment(data) {
        if (data.length < 16) return false;

        const hasFtyp = this.containsMP4Box(data, "ftyp");
        const hasMoov = this.containsMP4Box(data, "moov");
        const hasMoof = this.containsMP4Box(data, "moof");

        if ((hasFtyp || hasMoov) && !hasMoof) {
          return true;
        }

        if (data.length < 10000 && (hasFtyp || hasMoov)) {
          return true;
        }

        return false;
      }

      async buildFMP4Stream(initSegments, mediaSegments, options) {
        debugLog("🔧 Building complete fMP4 stream");

        const initSegment = initSegments.reduce((largest, current) =>
          current.length > largest.length ? current : largest
        );

        debugLog(`🔧 Using init segment: ${initSegment.length} bytes`);

        const totalSize =
          initSegment.length +
          mediaSegments.reduce((sum, seg) => sum + seg.length, 0);

        const completeStream = new Uint8Array(totalSize);
        let offset = 0;

        completeStream.set(initSegment, offset);
        offset += initSegment.length;

        for (const mediaSegment of mediaSegments) {
          completeStream.set(mediaSegment, offset);
          offset += mediaSegment.length;
        }

        debugLog(`🔧 Complete fMP4 stream built: ${completeStream.length} bytes`);
        return completeStream;
      }

      async processWithMediaBunny(streamData, options) {
        debugLog(`🔧 Processing fMP4 with MediaBunny: ${streamData.length} bytes`);

        try {
          const {
            Input,
            Output,
            Conversion,
            ALL_FORMATS,
            BufferSource,
            BufferTarget,
            Mp4OutputFormat,
          } = await import("./modules/mediabunny/dist/modules/src/index.js");

          const input = new Input({
            source: new BufferSource(streamData.buffer),
            formats: ALL_FORMATS,
          });

          const output = new Output({
            format: new Mp4OutputFormat({
              fastStart: "in-memory",
            }),
            target: new BufferTarget(),
          });

          debugLog("🔧 Starting MediaBunny conversion...");

          const conversion = await Conversion.init({
            input: input,
            output: output,
          });

          await conversion.execute();

          const outputBuffer = output.target.buffer;
          if (!outputBuffer || outputBuffer.byteLength === 0) {
            throw new Error(
              "MediaBunny conversion failed - output buffer is empty"
            );
          }

          const outputBlob = new Blob([outputBuffer], { type: "video/mp4" });

          debugLog(`🔧 MediaBunny conversion successful: ${(
              outputBlob.size /
              1024 /
              1024
            ).toFixed(2)} MB`);

          return outputBlob;
        } catch (error) {
          debugLog(`🔧 MediaBunny processing failed: ${error.message}`);
          throw error;
        }
      }

      async fallbackConcatenateFMP4(segments, options) {
        debugLog(`🔧 Fallback: concatenating ${segments.length} fMP4 segments`);

        try {
          const totalSize = segments.reduce((sum, segment) => {
            const segmentData = segment.data || segment;
            const dataArray = this.toUint8Array(segmentData);
            return sum + dataArray.length;
          }, 0);

          const concatenated = new Uint8Array(totalSize);
          let offset = 0;

          for (const segment of segments) {
            const segmentData = segment.data || segment;
            const dataArray = this.toUint8Array(segmentData);
            concatenated.set(dataArray, offset);
            offset += dataArray.length;
          }

          const resultBlob = new Blob([concatenated], { type: "video/mp4" });

          debugLog(`🔧 Fallback concatenation complete: ${(
              resultBlob.size /
              1024 /
              1024
            ).toFixed(2)} MB`);

          return resultBlob;
        } catch (error) {
          debugLog(`🔧 Fallback concatenation failed: ${error.message}`);
          throw error;
        }
      }

      async convertTSSegments(segments, options = {}) {
        debugLog("🔧 Processing traditional TS segments with FastStream HLS2MP4");

        this.hls2mp4 = new HLS2MP4Class ? new HLS2MP4Class() : new (await import("./modules/hls2mp4/hls2mp4.mjs")).HLS2MP4();

        if (this.progressCallback) {
          this.hls2mp4.on("progress", this.progressCallback);
        }

        const finalDuration =
          options.totalDuration || options.duration || segments.length * 2;

        const level = {
          audioCodec: options.audioCodec || "mp4a.40.2",
          videoCodec: options.videoCodec || "avc1.42E01E",
          details: {
            totalduration: finalDuration,
          },
        };

        const zippedFragments = [];

        for (let i = 0; i < segments.length; i++) {
          if (this.cancelled) {
            throw new Error("Conversion cancelled");
          }

          // Unwrap potential wrappers: segment may be { data: { data: Uint8Array, ... } } or similar
          const seg = segments[i];
          const outer = seg && typeof seg === 'object' && 'data' in seg ? seg.data : seg;
          const inner = outer && typeof outer === 'object' && 'data' in outer ? outer.data : outer;

          let arrayBuffer;
          if (inner instanceof ArrayBuffer) {
            arrayBuffer = inner;
          } else if (inner instanceof Uint8Array) {
            // Slice to a tight buffer to avoid including the full underlying ArrayBuffer
            arrayBuffer = inner.byteOffset === 0 && inner.byteLength === inner.buffer.byteLength
              ? inner.buffer
              : inner.slice().buffer;
          } else if (inner instanceof Blob) {
            arrayBuffer = await inner.arrayBuffer();
          } else if (inner && inner.buffer && inner.byteLength !== undefined) {
            // Typed array-like
            try {
              arrayBuffer = new Uint8Array(inner.buffer, inner.byteOffset || 0, inner.byteLength).slice().buffer;
            } catch {
              const blob = new Blob([inner]);
              arrayBuffer = await blob.arrayBuffer();
            }
          } else {
            // Last resort: try to coerce into a Blob then ArrayBuffer
            const blob = new Blob([inner]);
            arrayBuffer = await blob.arrayBuffer();
          }

          const fragment = {
            track: 0,
            fragment: {
              sn: i,
              cc: 0,
            },
            async getEntry() {
              return {
                async getDataFromBlob() {
                  return arrayBuffer;
                },
              };
            },
          };

          zippedFragments.push(fragment);
        }

        debugLog(`🔧 Starting FastStream TS conversion with ${zippedFragments.length} fragments`);

        const resultBlob = await this.hls2mp4.convert(
          level,
          null,
          null,
          null,
          zippedFragments
        );

        debugLog(`🔧 FastStream TS conversion complete: ${(
            resultBlob.size /
            1024 /
            1024
          ).toFixed(2)} MB`);

        return resultBlob;
      }

      toUint8Array = toUint8Array;

      containsMP4Box = containsMP4Box;

      async convertDashSegments(segments, options = {}) {
        debugLog(`🔧 DASH: Processing ${segments.length} DASH segments with proper muxing`);

        try {
          const result = await processDashSegments(
            segments,
            options.mpdData || {}
          );

          if (result.videoBlob && result.audioBlob) {
            debugLog(`🔧 DASH: Successfully created separate files - Video: ${(
                result.videoBlob.size /
                1024 /
                1024
              ).toFixed(2)} MB, Audio: ${(
                result.audioBlob.size /
                1024 /
                1024
              ).toFixed(2)} MB`);
            return result;
          } else if (result.videoBlob) {
            debugLog(`🔧 DASH: Successfully created video file: ${(
                result.videoBlob.size /
                1024 /
                1024
              ).toFixed(2)} MB (no audio)`);
            return result;
          } else {
            debugLog(`🔧 DASH: Successfully created ${(
                result.size /
                1024 /
                1024
              ).toFixed(2)} MB file`);
            return result;
          }
        } catch (error) {
          debugLog(`🔧 DASH: Processing failed: ${error.message}`);
          throw error;
        }
      }

      destroy() {
        if (this.hls2mp4) {
          this.hls2mp4.destroy();
          this.hls2mp4 = null;
        }
      }
    };

    debugLog("✅ All modules loaded successfully");
    return true;
  } catch (error) {
    debugLog(`❌ Failed to load modules: ${error.message}`);
    console.error("Failed to load modules:", error);
    return false;
  }
}

// Load all segments at once
async function loadAllSegments(segmentsKey, totalSegments) {
  debugLog(`🔍 Loading all ${totalSegments} segments...`);

  const segments = [];
  const BATCH_SIZE = getBatchSize(totalSegments);

  for (let i = 0; i < totalSegments; i += BATCH_SIZE) {
    const batchEnd = Math.min(i + BATCH_SIZE, totalSegments);
    const batchPromises = [];

    for (let j = i; j < batchEnd; j++) {
      const segmentKey = `${segmentsKey}_${j}`;
      batchPromises.push(
        idbGet(segmentKey).then(async (segmentData) => {
          if (segmentData) {
            await idbRemove(segmentKey);
            return {
              index: j,
              data: segmentData,
            };
          }
          return null;
        })
      );
    }

    const batchResults = await Promise.all(batchPromises);

    for (const result of batchResults) {
      if (result && result.data) {
        segments.push(result);
      }
    }

    const loadedCount = batchResults.filter((r) => r && r.data).length;
    debugLog(`🔍 Batch ${
        Math.floor(i / BATCH_SIZE) + 1
      }: Loaded ${loadedCount} segments`);
  }

  segments.sort((a, b) => a.index - b.index);
  debugLog(`🔍 ✅ Successfully loaded ${segments.length} segments total`);

  return segments;
}

// Load separate A/V segments
async function loadSeparateAVSegments(
  segmentsKey,
  totalSegments,
  videoCount,
  audioCount
) {
  debugLog(`🔍 Loading ${videoCount} video and ${audioCount} audio segments...`);

  const videoSegments = [];
  const audioSegments = [];
  const BATCH_SIZE = getBatchSize(totalSegments);

  // Load video segments (indices 0 to videoCount-1)
  for (let i = 0; i < videoCount; i += BATCH_SIZE) {
    const batchEnd = Math.min(i + BATCH_SIZE, videoCount);
    const batchPromises = [];

    for (let j = i; j < batchEnd; j++) {
      const segmentKey = `${segmentsKey}_${j}`;
      batchPromises.push(
        idbGet(segmentKey).then(async (segmentData) => {
          if (segmentData) {
            await idbRemove(segmentKey);
            return {
              index: j,
              data: segmentData.data || segmentData,
              isInitSegment: segmentData.isInitSegment || false,
              isInit:
                segmentData.isInit === true || segmentData.isInitSegment === true,
              segmentType: segmentData.segmentType || 'video',
              segmentIndex: segmentData.segmentIndex || j,
              mimeType: segmentData.mimeType || 'video/mp4',
              sequenceNumber:
                typeof segmentData.sequenceNumber === 'number'
                  ? segmentData.sequenceNumber
                  : segmentData.segmentIndex || j,
              discontinuitySequence:
                typeof segmentData.discontinuitySequence === 'number'
                  ? segmentData.discontinuitySequence
                  : 0,
              duration: segmentData.duration || null,
            };
          }
          return null;
        })
      );
    }

    const batchResults = await Promise.all(batchPromises);
    for (const result of batchResults) {
      if (result && result.data) {
        videoSegments.push(result);
      }
    }
  }

  // Load audio segments (indices videoCount to totalSegments-1)
  for (let i = videoCount; i < totalSegments; i += BATCH_SIZE) {
    const batchEnd = Math.min(i + BATCH_SIZE, totalSegments);
    const batchPromises = [];

    for (let j = i; j < batchEnd; j++) {
      const segmentKey = `${segmentsKey}_${j}`;
      batchPromises.push(
        idbGet(segmentKey).then(async (segmentData) => {
          if (segmentData) {
            await idbRemove(segmentKey);
            return {
              index: j - videoCount,
              data: segmentData.data || segmentData,
              isInitSegment: segmentData.isInitSegment || false,
              isInit:
                segmentData.isInit === true || segmentData.isInitSegment === true,
              segmentType: segmentData.segmentType || 'audio',
              segmentIndex: segmentData.segmentIndex || (j - videoCount),
              mimeType: segmentData.mimeType || 'audio/mp4',
              sequenceNumber:
                typeof segmentData.sequenceNumber === 'number'
                  ? segmentData.sequenceNumber
                  : segmentData.segmentIndex || (j - videoCount),
              discontinuitySequence:
                typeof segmentData.discontinuitySequence === 'number'
                  ? segmentData.discontinuitySequence
                  : 0,
              duration: segmentData.duration || null,
            };
          }
          return null;
        })
      );
    }

    const batchResults = await Promise.all(batchPromises);
    for (const result of batchResults) {
      if (result && result.data) {
        audioSegments.push(result);
      }
    }
  }

  videoSegments.sort((a, b) => a.index - b.index);
  audioSegments.sort((a, b) => a.index - b.index);

  debugLog(`🔍 ✅ Loaded ${videoSegments.length} video and ${audioSegments.length} audio segments`);

  return { videoSegments, audioSegments };
}

async function loadDashSegments(audioKeys = [], videoKeys = []) {
  debugLog(
    `🔍 Loading DASH segments: ${videoKeys.length} video, ${audioKeys.length} audio`
  );

  const allSegments = [];
  const videoSegments = [];
  const audioSegments = [];

  const processKeys = async (keys, type) => {
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      try {
        const segmentData = await idbGet(key);
        if (!segmentData) continue;

        const raw = segmentData?.data || segmentData;
        const dataArray = toUint8Array(raw);

        const entry = {
          data: dataArray,
          segmentType: type,
          mimeType: type === "video" ? "video/mp4" : "audio/mp4",
          isInitSegment: index === 0,
          segmentIndex: index,
        };

        if (type === "video") {
          videoSegments.push(entry);
        } else {
          audioSegments.push(entry);
        }

        allSegments.push(entry);

        await idbRemove(key).catch(() => {});
      } catch (error) {
        debugLog(
          `🔍 Failed to load ${type} DASH segment at ${index}: ${error.message}`
        );
      }
    }
  };

  await processKeys(videoKeys || [], "video");
  await processKeys(audioKeys || [], "audio");

  debugLog(
    `🔍 ✅ Loaded DASH segments: ${videoSegments.length} video, ${audioSegments.length} audio`
  );

  return { segments: allSegments, videoSegments, audioSegments };
}

async function muxDashStreamsWithMediaBunny(videoBlob, audioBlob) {
  debugLog("🔧 MUXING: Using EncodedVideoPacketSource with proper metadata...");

  try {
    const {
      Input,
      Output,
      ALL_FORMATS,
      BufferSource,
      BufferTarget,
      Mp4OutputFormat,
      EncodedVideoPacketSource,
      EncodedAudioPacketSource,
      EncodedPacketSink,
    } = await import("./modules/mediabunny/dist/modules/src/index.js");

    const videoBuffer = await videoBlob.arrayBuffer();
    const audioBuffer = await audioBlob.arrayBuffer();

    const videoInput = new Input({
      source: new BufferSource(videoBuffer),
      formats: ALL_FORMATS,
    });

    const audioInput = new Input({
      source: new BufferSource(audioBuffer),
      formats: ALL_FORMATS,
    });

    const videoTrack = await videoInput.getPrimaryVideoTrack();
    const audioTrack = await audioInput.getPrimaryAudioTrack();

    if (!videoTrack) throw new Error("No video track found");

    const videoWidth = videoTrack.codedWidth || videoTrack.displayWidth || 1920;
    const videoHeight =
      videoTrack.codedHeight || videoTrack.displayHeight || 1080;
    const audioChannels = audioTrack ? audioTrack.numberOfChannels || 2 : 2;
    const audioSampleRate = audioTrack ? audioTrack.sampleRate || 48000 : 48000;

    const videoDecoderConfig = await videoTrack.getDecoderConfig();
    const audioDecoderConfig = audioTrack
      ? await audioTrack.getDecoderConfig()
      : null;

    debugLog(`🔧 MUXING: Video: ${videoWidth}x${videoHeight}, Audio: ${audioChannels}ch @ ${audioSampleRate}Hz`);

    const output = new Output({
      format: new Mp4OutputFormat({
        fastStart: "in-memory",
      }),
      target: new BufferTarget(),
    });

    const videoSource = new EncodedVideoPacketSource(videoTrack.codec);

    let audioSource = null;
    if (audioTrack) {
      audioSource = new EncodedAudioPacketSource(audioTrack.codec);
    }

    output.addVideoTrack(videoSource);
    if (audioSource) {
      output.addAudioTrack(audioSource);
    }

    await output.start();

    const videoSink = new EncodedPacketSink(videoTrack);
    let videoCount = 0;
    let isFirstVideoPacket = true;

    debugLog("🔧 MUXING: Processing video packets...");

    for await (const packet of videoSink.packets()) {
      videoCount++;

      try {
        if (isFirstVideoPacket) {
          await videoSource.add(packet, {
            decoderConfig: videoDecoderConfig,
          });
          isFirstVideoPacket = false;
          debugLog("🔧 MUXING: Added first video packet with decoder config");
        } else {
          await videoSource.add(packet);
        }
      } catch (methodError) {
        debugLog(`🔧 MUXING: Error with video packet ${videoCount}: ${methodError.message}`);
        if (videoCount === 1) {
          throw methodError;
        }
      }

      if (videoCount % 100 === 0) {
        debugLog(`🔧 MUXING: Processed ${videoCount} video packets...`);
      }
    }

    debugLog(`🔧 MUXING: Processed ${videoCount} video packets total`);

    if (audioTrack && audioSource) {
      debugLog("🔧 MUXING: Processing audio packets...");

      const audioSink = new EncodedPacketSink(audioTrack);
      let audioCount = 0;
      let isFirstAudioPacket = true;

      for await (const packet of audioSink.packets()) {
        audioCount++;

        try {
          if (isFirstAudioPacket) {
            await audioSource.add(packet, {
              decoderConfig: audioDecoderConfig,
            });
            isFirstAudioPacket = false;
            debugLog("🔧 MUXING: Added first audio packet with decoder config");
          } else {
            await audioSource.add(packet);
          }
        } catch (methodError) {
          debugLog(`🔧 MUXING: Error with audio packet ${audioCount}: ${methodError.message}`);
          if (audioCount === 1) {
            throw methodError;
          }
        }

        if (audioCount % 100 === 0) {
          debugLog(`🔧 MUXING: Processed ${audioCount} audio packets...`);
        }
      }

      debugLog(`🔧 MUXING: Processed ${audioCount} audio packets total`);
    }

    await output.finalize();

    const muxedBuffer = output.target.buffer;
    if (!muxedBuffer || muxedBuffer.byteLength === 0) {
      throw new Error("Output buffer is empty");
    }

    const muxedBlob = new Blob([muxedBuffer], { type: "video/mp4" });
    debugLog(`🔧 MUXING: Success! Created ${(muxedBlob.size / 1024 / 1024).toFixed(2)} MB MP4`);

    // Skip additional rewrap step; MediaBunny output already contains proper timing metadata
    return muxedBlob;
  } catch (error) {
    debugLog(`🔧 MUXING: Failed: ${error.message}`);
    throw error;
  }
}

async function processDashSegments(segments, mpdData) {
  debugLog(`🔧 MEDIABUNNY: Processing ${segments.length} DASH segments using Conversion API`);

  let videoBlob = null;
  let audioBlob = null;

  try {
    const { totalDuration, timescale, segmentTimeline } = parseMpdData(mpdData);

    debugLog(`🔧 MEDIABUNNY: Total duration: ${totalDuration}s, Timescale: ${timescale}`);

    const {
      Input,
      Output,
      Conversion,
      ALL_FORMATS,
      BufferSource,
      WebMOutputFormat,
      BufferTarget,
      Mp4OutputFormat,
    } = await import("./modules/mediabunny/dist/modules/src/index.js");

    debugLog("🔧 MEDIABUNNY: Analyzing segment structure...");

    let videoInit = null;
    let audioInit = null;
    const videoMediaSegments = [];
    const audioMediaSegments = [];

    segments.forEach((segment, index) => {
      const segmentData = segment.data || segment;

      let dataArray;
      if (segmentData instanceof Uint8Array) {
        dataArray = segmentData;
      } else if (segmentData instanceof ArrayBuffer) {
        dataArray = new Uint8Array(segmentData);
      } else {
        dataArray = new Uint8Array(segmentData);
      }

      const boxType = getMP4BoxType(dataArray);
      const containsFtyp = boxType === "ftyp" || containsBox(dataArray, "ftyp");
      const containsMoov = containsBox(dataArray, "moov");
      const isInitSegment =
        containsFtyp ||
        containsMoov ||
        segment.isInitSegment ||
        segment.url?.includes("init") ||
        (segment.range && segment.range.includes("0-")) ||
        dataArray.length < 10000;

      const isVideoSegment =
        segment.segmentType === "video" || segment.mimeType?.includes("video");
      const isAudioSegment =
        segment.segmentType === "audio" || segment.mimeType?.includes("audio");

      const likelyAudioBySize =
        dataArray.length < 100000 && dataArray.length > 1000;
      const likelyVideoBySize = dataArray.length > 200000;

      debugLog(`🔧 MEDIABUNNY: Segment ${index}: ${
          dataArray.length
        } bytes, box: ${boxType}, init: ${isInitSegment}, type: ${
          segment.segmentType || "unknown"
        }, audioSize: ${likelyAudioBySize}, videoSize: ${likelyVideoBySize}`);

      if (isInitSegment) {
        if (isVideoSegment) {
          videoInit = dataArray;
          debugLog(`🔧 MEDIABUNNY: Found VIDEO init segment at index ${index}: ${dataArray.length} bytes (by metadata)`);
        } else if (isAudioSegment) {
          if (!audioInit) {
            audioInit = dataArray;
            debugLog(`🔧 MEDIABUNNY: Found FIRST AUDIO init segment at index ${index}: ${dataArray.length} bytes (by metadata)`);
          } else {
            debugLog(`🔧 MEDIABUNNY: Skipping additional audio init segment at index ${index}: ${dataArray.length} bytes (already have audio init)`);
          }
        } else if (likelyVideoBySize && !videoInit) {
          videoInit = dataArray;
          debugLog(`🔧 MEDIABUNNY: Found VIDEO init segment (size fallback) at index ${index}: ${dataArray.length} bytes`);
        } else if (likelyAudioBySize && !audioInit) {
          audioInit = dataArray;
          debugLog(`🔧 MEDIABUNNY: Found AUDIO init segment (size fallback) at index ${index}: ${dataArray.length} bytes`);
        }
      } else {
        if (isVideoSegment) {
          videoMediaSegments.push(dataArray);
          debugLog(`🔧 MEDIABUNNY: Added video media segment ${index}: ${dataArray.length} bytes (by metadata)`);
        } else if (isAudioSegment) {
          audioMediaSegments.push(dataArray);
          debugLog(`🔧 MEDIABUNNY: Added audio media segment ${index}: ${dataArray.length} bytes (by metadata)`);
        } else if (likelyVideoBySize || dataArray.length > 100000) {
          videoMediaSegments.push(dataArray);
          debugLog(`🔧 MEDIABUNNY: Added video media segment ${index}: ${dataArray.length} bytes (by size fallback)`);
        } else if (likelyAudioBySize || dataArray.length < 100000) {
          audioMediaSegments.push(dataArray);
          debugLog(`🔧 MEDIABUNNY: Added audio media segment ${index}: ${dataArray.length} bytes (by size fallback)`);
        }
      }
    });

    debugLog(`🔧 MEDIABUNNY: Found ${videoMediaSegments.length} video segments and ${audioMediaSegments.length} audio segments`);

    if (!videoInit) {
      debugLog("🔧 MEDIABUNNY: No video init found by structure analysis, trying fallback...");

      for (let i = 0; i < Math.min(5, segments.length); i++) {
        const segment = segments[i];
        const segmentData = segment.data || segment;
        const dataArray =
          segmentData instanceof Uint8Array
            ? segmentData
            : new Uint8Array(segmentData);

        if (dataArray.length < 100000) {
          videoInit = dataArray;
          debugLog(`🔧 MEDIABUNNY: Using segment ${i} as video init (${dataArray.length} bytes)`);

          const index = videoMediaSegments.findIndex(
            (seg) => seg.length === dataArray.length
          );
          if (index >= 0) {
            videoMediaSegments.splice(index, 1);
            debugLog("🔧 MEDIABUNNY: Removed from video media segments");
          }
          break;
        }
      }
    }

    if (!audioInit && audioMediaSegments.length > 0) {
      debugLog("🔧 MEDIABUNNY: No audio init found, looking for FIRST audio init segment...");

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const segmentData = segment.data || segment;
        const dataArray =
          segmentData instanceof Uint8Array
            ? segmentData
            : new Uint8Array(segmentData);

        if (dataArray.length < 50000 && dataArray.length > 100) {
          const boxType = getMP4BoxType(dataArray);
          const containsFtyp =
            boxType === "ftyp" || containsBox(dataArray, "ftyp");
          const containsMoov = containsBox(dataArray, "moov");

          if (containsFtyp || containsMoov) {
            audioInit = dataArray;
            debugLog(`🔧 MEDIABUNNY: Found FIRST AUDIO init segment at index ${i}: ${dataArray.length} bytes`);

            const mediaIndex = audioMediaSegments.findIndex(
              (seg) => seg.length === dataArray.length
            );
            if (mediaIndex >= 0) {
              audioMediaSegments.splice(mediaIndex, 1);
              debugLog("🔧 MEDIABUNNY: Removed audio init from media segments");
            }
            break;
          }
        }
      }
    }

    if (!videoInit) {
      throw new Error("No video initialization segment found - unable to process DASH stream");
    }

    if (!audioInit && audioMediaSegments.length > 0) {
      throw new Error("No audio initialization segment found - cannot create playable audio MP4");
    }

    if (videoMediaSegments.length === 0) {
      throw new Error("No video media segments found");
    }

    debugLog("🔧 MEDIABUNNY: Creating complete video MP4...");

    const videoDataSize = videoMediaSegments.reduce(
      (total, seg) => total + seg.length,
      0
    );
    const videoMP4Size = videoInit.length + videoDataSize;
    const videoMP4Data = new Uint8Array(videoMP4Size);

    videoMP4Data.set(videoInit, 0);
    let offset = videoInit.length;

    for (const segment of videoMediaSegments) {
      videoMP4Data.set(segment, offset);
      offset += segment.length;
    }

    debugLog(`🔧 MEDIABUNNY: Complete video MP4: ${videoMP4Data.length} bytes`);

    let audioMP4Data = null;
    if (audioInit && audioMediaSegments.length > 0) {
      debugLog("🔧 MEDIABUNNY: Creating complete audio MP4...");

      const audioDataSize = audioMediaSegments.reduce(
        (total, seg) => total + seg.length,
        0
      );
      const audioMP4Size = audioInit.length + audioDataSize;
      audioMP4Data = new Uint8Array(audioMP4Size);

      audioMP4Data.set(audioInit, 0);
      offset = audioInit.length;

      for (const segment of audioMediaSegments) {
        audioMP4Data.set(segment, offset);
        offset += segment.length;
      }

      debugLog(`🔧 MEDIABUNNY: Complete audio MP4: ${audioMP4Data.length} bytes`);
    }

    debugLog("🔧 MEDIABUNNY: Creating separate video and audio outputs...");

    try {
      const videoInput = new Input({
        source: new BufferSource(videoMP4Data.buffer),
        formats: ALL_FORMATS,
      });

      const videoOutput = new Output({
        format: new Mp4OutputFormat({
          fastStart: "in-memory",
        }),
        target: new BufferTarget(),
      });

      debugLog("🔧 MEDIABUNNY: Converting video MP4...");

      const videoConversion = await Conversion.init({
        input: videoInput,
        output: videoOutput,
      });

    await videoConversion.execute();

    const videoOutputBuffer = videoOutput.target.buffer;
    if (!videoOutputBuffer || videoOutputBuffer.byteLength === 0) {
      throw new Error("MediaBunny video conversion failed - output buffer is empty");
    }

    videoBlob = new Blob([videoOutputBuffer], { type: "video/mp4" });

    debugLog(`🔧 MEDIABUNNY: Video conversion completed! Created ${(
        videoBlob.size /
        1024 /
        1024
      ).toFixed(2)} MB MP4`);

    if (audioMP4Data) {
      debugLog("🔧 MEDIABUNNY: Processing audio with Media Bunny...");

      try {
        const audioInput = new Input({
          source: new BufferSource(audioMP4Data.buffer),
          formats: ALL_FORMATS,
        });

        const audioOutput = new Output({
          format: new Mp4OutputFormat({
            fastStart: "in-memory",
          }),
          target: new BufferTarget(),
        });

        debugLog("🔧 MEDIABUNNY: Converting audio to MP4 format...");

        const audioConversion = await Conversion.init({
          input: audioInput,
          output: audioOutput,
        });

        await audioConversion.execute();

        const audioOutputBuffer = audioOutput.target.buffer;
        if (!audioOutputBuffer || audioOutputBuffer.byteLength === 0) {
          throw new Error("MediaBunny audio conversion failed - output buffer is empty");
        }

        audioBlob = new Blob([audioOutputBuffer], { type: "audio/mp4" });

        debugLog(`🔧 MEDIABUNNY: Audio conversion completed! Created ${(
            audioBlob.size /
            1024 /
            1024
          ).toFixed(2)} MB MP4`);
      } catch (audioError) {
        debugLog(`🔧 MEDIABUNNY: Audio MP4 conversion failed: ${audioError.message}`);
        debugLog("🔧 MEDIABUNNY: Trying alternative MP4 format fallback...");

        try {
          const audioInput = new Input({
            source: new BufferSource(audioMP4Data.buffer),
            formats: ALL_FORMATS,
          });

          const audioOutput = new Output({
            format: new Mp4OutputFormat({
              fastStart: "in-memory",
            }),
            target: new BufferTarget(),
          });

          const audioConversion = await Conversion.init({
            input: audioInput,
            output: audioOutput,
          });

          await audioConversion.execute();

          const audioOutputBuffer = audioOutput.target.buffer;
          if (!audioOutputBuffer || audioOutputBuffer.byteLength === 0) {
            throw new Error("MediaBunny audio MP4 conversion failed - output buffer is empty");
          }

          audioBlob = new Blob([audioOutputBuffer], { type: "audio/mp4" });

          debugLog(`🔧 MEDIABUNNY: Audio MP4 fallback completed! Created ${(
              audioBlob.size /
              1024 /
              1024
            ).toFixed(2)} MB MP4`);
        } catch (mp4Error) {
          debugLog(`🔧 MEDIABUNNY: Audio MP4 fallback also failed: ${mp4Error.message}`);
          throw new Error(`Audio processing failed - Media Bunny cannot process the audio format. WebM error: ${audioError.message}, MP4 error: ${mp4Error.message}`);
        }
      }
    }

    } catch (mediaBunnyError) {
      debugLog(`🔧 MEDIABUNNY: MediaBunny processing failed: ${mediaBunnyError.message}`);
      debugLog("🔧 MEDIABUNNY: Falling back to direct file download approach...");
      
      videoBlob = new Blob([videoMP4Data], { type: "video/mp4" });
      audioBlob = audioMP4Data ? new Blob([audioMP4Data], { type: "audio/mp4" }) : null;
      
      debugLog(`🔧 MEDIABUNNY: Fallback - Video file: ${(videoBlob.size / 1024 / 1024).toFixed(2)} MB`);
      if (audioBlob) {
        debugLog(`🔧 MEDIABUNNY: Fallback - Audio file: ${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`);
      }
      
      return { 
        videoBlob, 
        audioBlob,
        success: true,
        message: "Processed as separate video and audio files (MediaBunny fallback)"
      };
    }

    if (videoBlob && audioBlob) {
      try {
        debugLog("🔧 MEDIABUNNY: Attempting to mux video and audio MP4s using media sources...");
        const muxedBlob = await muxDashStreamsWithMediaBunny(videoBlob, audioBlob);
        if (muxedBlob && muxedBlob.size > 0) {
          debugLog(`🔧 MEDIABUNNY: Successfully muxed! Returning single combined MP4 (${(
              muxedBlob.size /
              1024 /
              1024
            ).toFixed(2)} MB)`);
          return muxedBlob;
        }
      } catch (muxError) {
        debugLog(`🔧 MEDIABUNNY: Muxing failed: ${muxError.message}, falling back to separate files`);
      }
    }

    return { videoBlob, audioBlob };
  } catch (error) {
    debugLog(`🔧 MEDIABUNNY: Conversion failed: ${error.message}`);
    debugLog(`🔧 MEDIABUNNY: Error stack: ${error.stack}`);
    throw error;
  }
}

// Enhanced segment processing function that detects stream format
async function processSegmentsWithFastStream(
  segments,
  fileName,
  totalDuration = null,
  options = {}
) {
  debugLog(`🔍 Processing ${segments.length} segments with Enhanced FastStream`);
  debugLog(
    `🧭 PATH-CHECK: HLS single-stream start (isDASH=${!!options.isDASH}, streamFormat=${options.streamFormat || 'unknown'})`
  );

  const baseFileName = fileName.replace(/\.(webm|mkv|avi|ts|mp4)$/i, "");
  const outputFileName = `${baseFileName}.mp4`;

  try {
    const converter = new SimpleHLS2MP4Converter({
      onProgress: (progress) => {
        const progressPercent = (progress * 100).toFixed(1);
        if (progressPercent % 10 === 0 || progressPercent == 100) {
          debugLog(`🔍 Conversion progress: ${progressPercent}%`);
        }
      },
    });

    // Normalize to raw byte-like payloads if possible
    const segmentBuffers = segments.map((segment) => {
      const outer = segment && typeof segment === 'object' && 'data' in segment ? segment.data : segment;
      const inner = outer && typeof outer === 'object' && 'data' in outer ? outer.data : outer;
      return inner ?? outer ?? segment;
    });

    if (segmentBuffers.length > 0) {
      const firstSegment = segmentBuffers[0];
      debugLog("🔍 📊 SEGMENT FORMAT ANALYSIS:");
      debugLog(`🔍 📊 - Total segments: ${segmentBuffers.length}`);
      debugLog(`🔍 📊 - First segment type: ${firstSegment?.constructor?.name || typeof firstSegment}`);
      debugLog(`🔍 📊 - First segment size: ${firstSegment?.byteLength || firstSegment?.length || 'unknown'} bytes`);
      
      let headerBytes = null;
      if (firstSegment instanceof ArrayBuffer) {
        headerBytes = new Uint8Array(firstSegment.slice(0, 32));
      } else if (firstSegment instanceof Uint8Array) {
        headerBytes = firstSegment.slice(0, 32);
      } else if (firstSegment?.buffer) {
        headerBytes = new Uint8Array(firstSegment.buffer.slice(0, 32));
      }
      
      if (headerBytes) {
        const hexString = Array.from(headerBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const asciiString = Array.from(headerBytes).map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
        debugLog(`🔍 📊 - First 32 bytes (hex): ${hexString}`);
        debugLog(`🔍 📊 - First 32 bytes (ascii): ${asciiString}`);
        
        const header = headerBytes.slice(0, 16);
        if (header[0] === 0x47) {
          debugLog("🔍 📊 - Format detected: MPEG-TS (Transport Stream) - starts with sync byte 0x47");
        } else if (header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70) {
          debugLog("🔍 📊 - Format detected: MP4/fMP4 - contains 'ftyp' box");
        } else if (header[4] === 0x6D && header[5] === 0x6F && header[6] === 0x6F && header[7] === 0x66) {
          debugLog("🔍 📊 - Format detected: fMP4 - contains 'moof' box");
        } else if (header[0] === 0x00 && header[1] === 0x00 && header[2] === 0x00) {
          debugLog("🔍 📊 - Format detected: Possible MP4 box structure");
        } else {
          debugLog("🔍 📊 - Format detected: UNKNOWN - header doesn't match common patterns");
        }
      }
    }

    const startTime = performance.now();

    const segmentDurationSum = segments.reduce((sum, segment) => {
      const duration = segment?.duration || 0;
      if (duration) {
        debugLog(
          `🔍 Segment duration contribution: ${duration}s (sn: ${
            segment?.sequenceNumber ?? 'unknown'
          })`
        );
      }
      return sum + duration;
    }, 0);

    // Prefer durations derived from segment metadata; fall back to provided
    const derivedDuration =
      (segmentDurationSum > 0 ? segmentDurationSum : null) || totalDuration || null;

    debugLog(
      "🔍 Duration stats before conversion:",
      JSON.stringify(
        {
          providedTotalDuration: totalDuration,
          segmentDurationSum,
          derivedDuration,
          segmentCount: segments.length,
        },
        null,
        2
      )
    );

    const outputBlob = await converter.convertSegments(segmentBuffers, {
      videoCodec: options.videoCodec || "avc1.42E01E",
      audioCodec: options.audioCodec || "mp4a.40.2",
      totalDuration: derivedDuration || totalDuration,
      duration:
        derivedDuration ||
        totalDuration ||
        segmentBuffers.length * 2,
      isDASH: options.isDASH,
      segmentType: options.segmentType,
      streamFormat: options.streamFormat,
      sourceUrl: options.sourceUrl,
      manifestContent: options.manifestContent,
      videoMimeType: options.videoMimeType,
      audioMimeType: options.audioMimeType,
      videoInitSegment: options.videoInitSegment,
      audioInitSegment: options.audioInitSegment,
    });

    const endTime = performance.now();
    debugLog(`🔍 ✅ Enhanced FastStream conversion completed in ${(
        endTime - startTime
      ).toFixed(2)}ms`);
    debugLog(`🔍 Output file size: ${(outputBlob.size / 1024 / 1024).toFixed(2)} MB`);

    // Handle different result types
    if (outputBlob.videoBlob || outputBlob.audioBlob) {
      const baseFileName = fileName.replace(/\.(webm|mkv|avi|ts|mp4)$/i, "");
      let totalSize = 0;

      if (outputBlob.videoBlob && outputBlob.videoBlob instanceof Blob) {
        const videoFileName = `${baseFileName}_video.mp4`;
        downloadBlob(outputBlob.videoBlob, videoFileName);
        totalSize += outputBlob.videoBlob.size;
        debugLog(`🔍 Downloaded video file: ${videoFileName}`);
      }

      if (outputBlob.audioBlob && outputBlob.audioBlob instanceof Blob) {
        const audioExtension = outputBlob.audioBlob.type.includes("webm")
          ? "webm"
          : "mp4";
        const audioFileName = `${baseFileName}_audio.${audioExtension}`;
        downloadBlob(outputBlob.audioBlob, audioFileName);
        totalSize += outputBlob.audioBlob.size;
        debugLog(`🔍 Downloaded audio file: ${audioFileName}`);
      }

      return {
        fileName: `${baseFileName}_video.mp4 + ${baseFileName}_audio.mp4`,
        size: totalSize,
        success: true,
      };
    } else {
      downloadBlob(outputBlob, outputFileName);
      debugLog(`🔍 ✅ Download initiated for ${outputFileName}`);

      converter.destroy();

      return {
        fileName: outputFileName,
        size: outputBlob.size,
        success: true,
      };
    }
  } catch (error) {
    debugLog(`🔍 ❌ Enhanced FastStream processing failed: ${error.message}`);
    throw error;
  }
}

// Process A/V segments with FastStream
  async function processAVSegmentsWithFastStream(
    videoSegments,
    audioSegments,
    fileName,
    totalDuration = null,
    options = {}
  ) {
  debugLog(`🔍 Processing ${videoSegments.length} video and ${audioSegments.length} audio segments with FastStream`);
  debugLog(
    `🧭 PATH-CHECK: HLS A/V start (isDASH=${!!options.isDASH}, streamFormat=${options.streamFormat || 'unknown'})`
  );

  const baseFileName = fileName.replace(/\.(webm|mkv|avi|ts|mp4)$/i, "");
  const outputFileName = `${baseFileName}.mp4`;

  try {
    if (options.isDASH) {
      debugLog("🔍 Detected DASH A/V segments, using proper DASH processing");
      const analyzedSegments = [
        ...videoSegments.map((segment) => ({
          data: segment.data,
          segmentType: segment.segmentType || 'video',
          mimeType: segment.mimeType || 'video/mp4',
          isInitSegment: segment.isInitSegment || false,
          segmentIndex: segment.segmentIndex || 0
        })),
        ...audioSegments.map((segment) => ({
          data: segment.data,
          segmentType: segment.segmentType || 'audio',
          mimeType: segment.mimeType || 'audio/mp4',
          isInitSegment: segment.isInitSegment || false,
          segmentIndex: segment.segmentIndex || 0
        }))
      ];
      debugLog(`🔍 Analyzed ${analyzedSegments.length} segments with proper metadata`);
      const result = await processDashSegments(
        analyzedSegments,
        options.mpdData || {}
      );

      const baseFileName = fileName.replace(/\.(webm|mkv|avi|ts|mp4)$/i, "");
      let totalSize = 0;

      if (result.videoBlob || result.audioBlob) {
        debugLog("🔍 DASH A/V: Downloading separate video and audio files");

        if (result.videoBlob && result.videoBlob instanceof Blob) {
          const videoFileName = `${baseFileName}_video.mp4`;
          debugLog(`🔍 DASH A/V: Creating video download URL for ${result.videoBlob.size} bytes...`);
          downloadBlob(result.videoBlob, videoFileName);
          totalSize += result.videoBlob.size;
          debugLog(`🔍 DASH A/V: Downloaded video file: ${videoFileName}`);
        }

        if (result.audioBlob && result.audioBlob instanceof Blob) {
          const audioExtension = result.audioBlob.type.includes("webm") ? "webm" : "mp4";
          const audioFileName = `${baseFileName}_audio.${audioExtension}`;
          debugLog(`🔍 DASH A/V: Creating audio download URL for ${result.audioBlob.size} bytes (${result.audioBlob.type})...`);
          downloadBlob(result.audioBlob, audioFileName);
          totalSize += result.audioBlob.size;
          debugLog(`🔍 DASH A/V: Downloaded audio file: ${audioFileName}`);
        }

        return {
          fileName: `${baseFileName}_video.mp4 + ${baseFileName}_audio.mp4`,
          size: totalSize,
          success: true,
        };
      } else {
        const outputFileName = baseFileName + ".webm";
        downloadBlob(result, outputFileName);

        return {
          fileName: outputFileName,
          size: result.size,
          success: true,
        };
      }
    }

    const isFMP4Stream = 
      options.streamFormat === "fmp4" ||
      options.sourceUrl?.includes("sf=fmp4") ||
      options.sourceUrl?.includes("format=fmp4") ||
      (videoSegments.length > 0 && isSegmentFMP4(videoSegments[0].data));

    if (isFMP4Stream) {
      debugLog("🧭 PATH: HLS A/V → fMP4 (MediaBunny)");
      debugLog("🔍 Detected FMP4 A/V segments, using MediaBunny proper conversion");
      
      let videoSize = 0;
      videoSegments.forEach(segment => {
        if (segment.data instanceof ArrayBuffer) {
          videoSize += segment.data.byteLength;
        } else if (segment.data instanceof Uint8Array) {
          videoSize += segment.data.byteLength;
        } else {
          videoSize += segment.data.size || 0;
        }
      });
      
      let audioSize = 0;
      audioSegments.forEach(segment => {
        if (segment.data instanceof ArrayBuffer) {
          audioSize += segment.data.byteLength;
        } else if (segment.data instanceof Uint8Array) {
          audioSize += segment.data.byteLength;
        } else {
          audioSize += segment.data.size || 0;
        }
      });
      
      const videoBuffer = new Uint8Array(videoSize);
      let videoOffset = 0;
      
      for (const segment of videoSegments) {
        let data;
        if (segment.data instanceof ArrayBuffer) {
          data = new Uint8Array(segment.data);
        } else if (segment.data instanceof Uint8Array) {
          data = segment.data;
        } else if (segment.data instanceof Blob) {
          data = new Uint8Array(await segment.data.arrayBuffer());
        } else {
          data = new Uint8Array(segment.data);
        }
        
        videoBuffer.set(data, videoOffset);
        videoOffset += data.byteLength;
      }
      
      const audioBuffer = new Uint8Array(audioSize);
      let audioOffset = 0;
      
      for (const segment of audioSegments) {
        let data;
        if (segment.data instanceof ArrayBuffer) {
          data = new Uint8Array(segment.data);
        } else if (segment.data instanceof Uint8Array) {
          data = segment.data;
        } else if (segment.data instanceof Blob) {
          data = new Uint8Array(await segment.data.arrayBuffer());
        } else {
          data = new Uint8Array(segment.data);
        }
        
        audioBuffer.set(data, audioOffset);
        audioOffset += data.byteLength;
      }
      
      debugLog(`🔍 Created separate video buffer: ${(videoBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
      debugLog(`🔍 Created separate audio buffer: ${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
      
      try {
        debugLog("🔍 Loading MediaBunny for proper FMP4 conversion");
        
        const {
          Input,
          Output, 
          Conversion,
          ALL_FORMATS,
          BufferSource,
          Mp4OutputFormat,
          BufferTarget,
          EncodedVideoPacketSource,
          EncodedAudioPacketSource,
          EncodedPacketSink
        } = await import("./modules/mediabunny/dist/modules/src/index.js");
        
        debugLog("🔍 MediaBunny loaded successfully, creating separate video and audio inputs");
        
        const videoInput = new Input({
          formats: ALL_FORMATS,
          source: new BufferSource(videoBuffer.buffer),
        });
        
        const audioInput = new Input({
          formats: ALL_FORMATS,
          source: new BufferSource(audioBuffer.buffer),
        });
        
        const output = new Output({
          format: new Mp4OutputFormat(),
          target: new BufferTarget(),
        });
        
        debugLog("🔍 Getting video and audio tracks from separate inputs");
        
        const videoTrack = await videoInput.getPrimaryVideoTrack();
        const audioTrack = await audioInput.getPrimaryAudioTrack();
        
        if (!videoTrack) {
          throw new Error('No video track found in video input');
        }
        if (!audioTrack) {
          throw new Error('No audio track found in audio input');
        }
        
        debugLog("🔍 Starting MediaBunny muxing with separate tracks");
        debugLog(`🔍 Video track codec: ${videoTrack.codec}, Audio track codec: ${audioTrack.codec}`);
        
        const videoSource = new EncodedVideoPacketSource(videoTrack.codec);
        output.addVideoTrack(videoSource);
        debugLog("🔍 Added video track to output");
        
        const audioSource = new EncodedAudioPacketSource(audioTrack.codec);
        output.addAudioTrack(audioSource);
        debugLog("🔍 Added audio track to output");
        
        debugLog(`🔍 Starting output with ${output.tracks?.length || 'unknown'} tracks`);
        await output.start();
        debugLog("🔍 Output started successfully");
        
        const videoSink = new EncodedPacketSink(videoTrack);
        const videoDecoderConfig = await videoTrack.getDecoderConfig();
        let isFirstVideoPacket = true;
        
        for await (const packet of videoSink.packets()) {
          if (isFirstVideoPacket) {
            await videoSource.add(packet, {
              decoderConfig: videoDecoderConfig
            });
            isFirstVideoPacket = false;
          } else {
            await videoSource.add(packet);
          }
        }
        await videoSource.close();
        
        const audioSink = new EncodedPacketSink(audioTrack);
        const audioDecoderConfig = await audioTrack.getDecoderConfig();
        let isFirstAudioPacket = true;
        
        for await (const packet of audioSink.packets()) {
          if (isFirstAudioPacket) {
            await audioSource.add(packet, {
              decoderConfig: audioDecoderConfig
            });
            isFirstAudioPacket = false;
          } else {
            await audioSource.add(packet);
          }
        }
        await audioSource.close();
        
        await output.finalize();
        
        debugLog("🔍 MediaBunny conversion completed successfully");
        
        const resultBuffer = output.target.buffer;
        const resultBlob = new Blob([resultBuffer], { type: 'video/mp4' });
        
        downloadBlob(resultBlob, outputFileName);
        debugLog(`🔍 ✅ MediaBunny FMP4 Download initiated for ${outputFileName}`);

        return {
          fileName: outputFileName,
          size: resultBlob.size,
          success: true,
        };
        
      } catch (error) {
        debugLog(`🔍 MediaBunny conversion failed: ${error.message}`);
        debugLog("🔍 Falling back to simple concatenation");
        
        const combinedSize = videoBuffer.byteLength + audioBuffer.byteLength;
        const combinedBuffer = new Uint8Array(combinedSize);
        combinedBuffer.set(videoBuffer, 0);
        combinedBuffer.set(audioBuffer, videoBuffer.byteLength);
        
        const resultBlob = new Blob([combinedBuffer], { type: 'video/mp4' });
        
        downloadBlob(resultBlob, outputFileName);
        debugLog(`🔍 ✅ Fallback FMP4 Download initiated for ${outputFileName}`);

        return {
          fileName: outputFileName,
          size: resultBlob.size,
          success: true,
        };
      }
    }

    // Create converter with progress tracking (for consistency with single-stream flow)
    const converter = new SimpleHLS2MP4Converter({
      onProgress: (progress) => {
        const progressPercent = (progress * 100).toFixed(1);
        if (progressPercent % 10 === 0 || progressPercent == 100) {
          debugLog(`🔍 A/V Conversion progress: ${progressPercent}%`);
        }
      },
    });

    debugLog("🧭 PATH: HLS A/V → TS (HLS2MP4 single-pass)");
    debugLog("🔍 Setting up separate A/V conversion");

    if (!HLS2MP4Class) {
      const mod = await import("./modules/hls2mp4/hls2mp4.mjs");
      HLS2MP4Class = mod.HLS2MP4;
    }
    const hls2mp4 = new HLS2MP4Class();

    hls2mp4.on("progress", (progress) => {
      const progressPercent = (progress * 100).toFixed(1);
      if (progressPercent % 10 === 0 || progressPercent == 100) {
        debugLog(`🔍 A/V FastStream progress: ${progressPercent}%`);
      }
    });

    const videoDurationFromSegments = videoSegments.reduce((sum, segment) => {
      const duration = segment?.duration || 0;
      if (duration) {
        debugLog(
          `🔍 VIDEO segment duration contribution: ${duration}s (sn: ${
            segment?.sequenceNumber ?? 'unknown'
          })`
        );
      }
      return sum + duration;
    }, 0);
    const audioDurationFromSegments = audioSegments.reduce((sum, segment) => {
      const duration = segment?.duration || 0;
      if (duration) {
        debugLog(
          `🔍 AUDIO segment duration contribution: ${duration}s (sn: ${
            segment?.sequenceNumber ?? 'unknown'
          })`
        );
      }
      return sum + duration;
    }, 0);
    const inferredDuration = Math.max(
      videoDurationFromSegments,
      audioDurationFromSegments
    );

    const calculatedDuration =
      (inferredDuration > 0
        ? inferredDuration
        : (totalDuration || Math.max(videoSegments.length, audioSegments.length) * 2));

    debugLog(
      "🔍 A/V duration stats:",
      JSON.stringify(
        {
          providedTotalDuration: totalDuration,
          videoDurationFromSegments,
          audioDurationFromSegments,
          inferredDuration,
          calculatedDuration,
        },
        null,
        2
      )
    );

    // Try to sniff actual codecs from TS segments if not provided
    const pickFirstData = (segments) => {
      for (const seg of segments || []) {
        const d = seg?.data;
        if (!d) continue;
        if (d instanceof Uint8Array) return d;
        if (d instanceof ArrayBuffer) return new Uint8Array(d);
        if (ArrayBuffer.isView(d) && d.buffer) {
          try { return new Uint8Array(d.buffer, d.byteOffset || 0, d.byteLength); } catch {}
        }
      }
      return null;
    };

    const sniffAvc1 = (bytes) => {
      if (!bytes) return null;
      // Search Annex B start codes and SPS (NAL type 7)
      for (let i = 0; i < Math.min(bytes.length - 6, 200000); i++) {
        const start3 = bytes[i] === 0x00 && bytes[i+1] === 0x00 && bytes[i+2] === 0x01;
        const start4 = bytes[i] === 0x00 && bytes[i+1] === 0x00 && bytes[i+2] === 0x00 && bytes[i+3] === 0x01;
        if (!start3 && !start4) continue;
        const off = start3 ? i+3 : i+4;
        const nalHeader = bytes[off];
        const nalType = nalHeader & 0x1f;
        if (nalType === 7 && off + 3 < bytes.length) {
          const profile = bytes[off+1];
          const constraints = bytes[off+2];
          const level = bytes[off+3];
          const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
          return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
        }
      }
      return null;
    };

    const sniffAac = (bytes) => {
      if (!bytes) return null;
      for (let i = 0; i < Math.min(bytes.length - 7, 200000); i++) {
        if (bytes[i] === 0xFF && (bytes[i+1] & 0xF0) === 0xF0) {
          const aot = ((bytes[i+2] & 0xC0) >> 6) + 1; // ADTS: 2 bits + 1
          return `mp4a.40.${aot}`; // 2 => AAC-LC typical
        }
      }
      return null;
    };

    const vidBytes = pickFirstData(videoSegments);
    const audBytes = pickFirstData(audioSegments);
    const sniffedVideoCodec = options.videoCodec || sniffAvc1(vidBytes);
    const sniffedAudioCodec = options.audioCodec || sniffAac(audBytes);

    // Log first-bytes header for both tracks to help format identification
    const logHeaderBytes = (label, bytes) => {
      try {
        if (!bytes) return;
        const header = bytes.slice(0, 32);
        const hex = Array.from(header).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(header).map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
        debugLog(`MESSAGE: 🔎 ${label} first 32 bytes (hex): ${hex}`);
        debugLog(`MESSAGE: 🔎 ${label} first 32 bytes (ascii): ${ascii}`);
        if (header[0] === 0x47) debugLog(`MESSAGE: 🔎 ${label} appears to be MPEG-TS (0x47 sync)`);
      } catch (_) {}
    };
    logHeaderBytes('VIDEO TS', vidBytes);
    logHeaderBytes('AUDIO TS', audBytes);

    const resolvedVideoCodec = sniffedVideoCodec || "avc1.42E01E";
    const resolvedAudioCodec = sniffedAudioCodec || "mp4a.40.2";
    debugLog(`MESSAGE: 🧪 Codec resolution: video=${resolvedVideoCodec} (sniff=${sniffedVideoCodec || 'n/a'}), audio=${resolvedAudioCodec} (sniff=${sniffedAudioCodec || 'n/a'})`);

    // Align with FastStream's SimpleHLS2MP4 behavior: when providing a separate
    // audio track, leave the video-level audioCodec empty so the primary
    // transmuxer doesn't expect audio in the video TS stream.
    const videoLevel = {
      audioCodec: audioSegments.length > 0 ? '' : resolvedAudioCodec,
      videoCodec: resolvedVideoCodec,
      details: {
        totalduration: calculatedDuration,
      },
    };

    const audioLevel = {
      audioCodec: resolvedAudioCodec,
      videoCodec: "",
      details: {
        totalduration: calculatedDuration,
      },
      };

    // Preferred path for classic TS HLS A/V: single-pass mux via HLS2MP4 (no MediaBunny)
    if (!HLS2MP4Class) {
      const mod = await import("./modules/hls2mp4/hls2mp4.mjs");
      HLS2MP4Class = mod.HLS2MP4;
    }

    const buildZipped = async (segments, track) => {
      const zipped = [];
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const segmentData = segment.data;
        let arrayBuffer;
        if (segmentData instanceof ArrayBuffer) {
          arrayBuffer = segmentData;
        } else if (segmentData instanceof Uint8Array) {
          arrayBuffer =
            segmentData.byteOffset === 0 &&
            segmentData.byteLength === segmentData.buffer.byteLength
              ? segmentData.buffer
              : segmentData.slice().buffer;
        } else if (segmentData instanceof Blob) {
          arrayBuffer = await segmentData.arrayBuffer();
        } else if (segmentData && segmentData.buffer && segmentData.byteLength !== undefined) {
          try {
            arrayBuffer = new Uint8Array(
              segmentData.buffer,
              segmentData.byteOffset || 0,
              segmentData.byteLength
            ).slice().buffer;
          } catch {
            const blob = new Blob([segmentData]);
            arrayBuffer = await blob.arrayBuffer();
          }
        } else {
          const blob = new Blob([segmentData]);
          arrayBuffer = await blob.arrayBuffer();
        }

        zipped.push({
          track,
          fragment: {
            sn:
              typeof segment.sequenceNumber === "number"
                ? segment.sequenceNumber
                : i,
            cc:
              typeof segment.discontinuitySequence === "number"
                ? segment.discontinuitySequence
                : 0,
          },
          async getEntry() {
            return {
              async getDataFromBlob() {
                return arrayBuffer;
              },
            };
          },
        });
      }
      return zipped;
    };

    const videoFragments = await buildZipped(videoSegments, 0);
    const audioFragments = await buildZipped(audioSegments, 1);
    // Log simple segment stats
    try {
      const durStats = (segs) => {
        const ds = segs.map(s => s?.fragment?.duration || s?.duration || 0);
        const sum = ds.reduce((a,b)=>a+b,0);
        const min = ds.length ? Math.min(...ds) : 0;
        const max = ds.length ? Math.max(...ds) : 0;
        const avg = ds.length ? sum/ds.length : 0;
        return {count: ds.length, sum, min, max, avg};
      };
      debugLog(`MESSAGE: 📊 Video segment stats: ${JSON.stringify(durStats(videoSegments))}`);
      debugLog(`MESSAGE: 📊 Audio segment stats: ${JSON.stringify(durStats(audioSegments))}`);
    } catch(_) {}
    if (videoFragments.length) {
      debugLog(`🔎 Built video fragments: ${videoFragments.length}, first sn=${videoFragments[0].fragment?.sn}`);
    }
    if (audioFragments.length) {
      debugLog(`🔎 Built audio fragments: ${audioFragments.length}, first sn=${audioFragments[0].fragment?.sn}`);
    }

    // Interleave fragments by sequence number to improve MP4 interleaving and seeking
    const combinedFragments = [];
    let vi = 0,
      ai = 0;
    while (vi < videoFragments.length || ai < audioFragments.length) {
      const vf = vi < videoFragments.length ? videoFragments[vi] : null;
      const af = ai < audioFragments.length ? audioFragments[ai] : null;

      if (vf && af) {
        const vsn = vf.fragment?.sn ?? vi;
        const asn = af.fragment?.sn ?? ai;
        if (vsn <= asn) {
          combinedFragments.push(vf);
          vi++;
        } else {
          combinedFragments.push(af);
          ai++;
        }
      } else if (vf) {
        combinedFragments.push(vf);
        vi++;
      } else if (af) {
        combinedFragments.push(af);
        ai++;
      }
    }

    // Try direct MediaBunny TS->MP4 remux if requested (bypasses HLS2MP4)
    if (options.forceMediaBunnyTsRemux) {
      try {
        debugLog("🧭 PATH: HLS A/V → MediaBunny direct TS remux (experimental)");

        const concatBuffers = async (segments) => {
          let total = 0;
          const bufs = [];
          for (const seg of segments) {
            const d = seg?.data;
            let u8;
            if (d instanceof Uint8Array) u8 = d;
            else if (d instanceof ArrayBuffer) u8 = new Uint8Array(d);
            else if (d instanceof Blob) u8 = new Uint8Array(await d.arrayBuffer());
            else if (ArrayBuffer.isView(d) && d.buffer) u8 = new Uint8Array(d.buffer, d.byteOffset || 0, d.byteLength);
            else u8 = new Uint8Array(await new Blob([d]).arrayBuffer());
            bufs.push(u8);
            total += u8.byteLength;
          }
          const out = new Uint8Array(total);
          let off = 0;
          for (const u8 of bufs) { out.set(u8, off); off += u8.byteLength; }
          return out;
        };

        const videoTs = await concatBuffers(videoSegments);
        const audioTs = await concatBuffers(audioSegments);
        debugLog(`🔍 TS sizes -> video: ${(videoTs.byteLength/1024/1024).toFixed(2)} MB, audio: ${(audioTs.byteLength/1024/1024).toFixed(2)} MB`);

        const convertTsWithMB = async (tsU8, trackType) => {
          const { Input, Output, Conversion, ALL_FORMATS, BufferSource, BufferTarget, Mp4OutputFormat } = await import("./modules/mediabunny/dist/modules/src/index.js");
          const input = new Input({ source: new BufferSource(tsU8.buffer), formats: ALL_FORMATS });
          const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
          const conv = await Conversion.init({ input, output });
          await conv.execute();
          const buf = output.target.buffer;
          if (!buf || buf.byteLength === 0) throw new Error("MB TS conversion produced empty buffer");
          return new Blob([buf], { type: trackType === 'audio' ? 'audio/mp4' : 'video/mp4' });
        };

        const videoOnlyMb = await convertTsWithMB(videoTs, 'video');
        const audioOnlyMb = await convertTsWithMB(audioTs, 'audio');
        debugLog(`🎞️ MB video-only: ${(videoOnlyMb.size/1024/1024).toFixed(2)} MB, 🔊 MB audio-only: ${(audioOnlyMb.size/1024/1024).toFixed(2)} MB`);

        if (options.dumpIntermediates) {
          const baseName = fileName.replace(/\.(webm|mkv|avi|ts|mp4)$/i, "");
          downloadBlob(videoOnlyMb, `${baseName}_videoOnly_MB.mp4`);
          downloadBlob(audioOnlyMb, `${baseName}_audioOnly_MB.mp4`);
        }

        const muxed = await muxDashStreamsWithMediaBunny(videoOnlyMb, audioOnlyMb);
        if (muxed && muxed.size > 0) {
          downloadBlob(muxed, outputFileName);
          debugLog(`🔍 ✅ MB TS path initiated download for ${outputFileName}`);
          return { fileName: outputFileName, size: muxed.size, success: true };
        } else {
          debugLog("⚠️ MB TS path produced empty mux; will try HLS2MP4 paths");
        }
      } catch (mbTsErr) {
        debugLog(`⚠️ MB TS path failed: ${mbTsErr.message}; will try HLS2MP4 paths`);
      }
    }

    // Dual-pass: convert video-only and audio-only TS into separate MP4s, then mux
    // Skip dual-pass if single-pass is preferred
    if (options.preferSinglePass) {
      debugLog("🧭 PATH: Skipping dual-pass due to preferSinglePass=true");
    } else {
    try {
      debugLog("🧭 PATH: HLS A/V → Dual-pass (per-track MP4 + MediaBunny mux)");

      // Video-only MP4 from TS
      const videoOnlyLevel = {
        audioCodec: '',
        videoCodec: resolvedVideoCodec,
        details: { totalduration: calculatedDuration },
      };
      const hls2mp4Video = new HLS2MP4Class();
      // Only flatten CTS offsets if explicitly requested; B-frame streams rely on CTS for seeking
      if (options.forceZeroCts === true) {
        hls2mp4Video.forceZeroCts = true;
      }
      if (options.noEdts === true || options.dumpIntermediates === true) {
        hls2mp4Video.noEdts = true;
      }
      const videoOnlyBlob = await hls2mp4Video.convert(
        videoOnlyLevel,
        null,
        null,
        null,
        videoFragments
      );
      debugLog(`🎞️ Video-only MP4 size: ${(videoOnlyBlob.size / 1024 / 1024).toFixed(2)} MB`);
      if (options.dumpIntermediates) {
        const baseName = fileName.replace(/\.(webm|mkv|avi|ts|mp4)$/i, "");
        const videoOnlyName = `${baseName}_videoOnly.mp4`;
        debugLog(`💾 Dumping intermediate: ${videoOnlyName}`);
        downloadBlob(videoOnlyBlob, videoOnlyName);
        try {
          const polished = await convertSingleStreamWithMediaBunny(videoOnlyBlob, "video");
          if (polished && polished.size > 0) {
            const polishedName = `${baseName}_videoOnly_polished.mp4`;
            debugLog(`💾 Dumping polished video-only: ${polishedName}`);
            downloadBlob(polished, polishedName);
          }
        } catch (polishErr) {
          debugLog(`⚠️ Skipping polished video-only dump: ${polishErr.message}`);
        }

        // Analyze videoOnlyBlob using MediaBunny to inspect key packets and timing
        try {
          debugLog("🧪 Analyzing video-only MP4 with MediaBunny (key packets, duration, codec)…");
          const { Input, ALL_FORMATS, BufferSource, EncodedPacketSink } = await import("./modules/mediabunny/dist/modules/src/index.js");
          const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(await videoOnlyBlob.arrayBuffer()) });
          const vtrack = await input.getPrimaryVideoTrack();
          if (vtrack) {
            const mime = await vtrack.getCodecParameterString?.().catch(()=>null);
            const duration = await vtrack.computeDuration().catch(()=>null);
            const sink = new EncodedPacketSink(vtrack);
            let totalPackets = 0, keyPackets = 0;
            for await (const pkt of sink.packets()) {
              totalPackets++;
              if (pkt.type === 'key') keyPackets++;
            }
          debugLog(`MESSAGE: 🧪 MB video-only analysis: codec=${mime || vtrack.codec || 'n/a'}, duration=${duration || 'n/a'}s, packets=${totalPackets}, keyPackets=${keyPackets}`);
        } else {
            debugLog("MESSAGE: 🧪 MB video-only analysis: no primary video track found");
        }
      } catch (mbAnalyzeErr) {
          debugLog(`MESSAGE: 🧪 MB analysis failed: ${mbAnalyzeErr.message}`);
      }
      }

      // Audio-only MP4 from TS
      const dummyLevelForAudio = {
        audioCodec: '',
        videoCodec: '',
        details: { totalduration: calculatedDuration },
      };
      const audioOnlyLevel = {
        audioCodec: resolvedAudioCodec,
        videoCodec: '',
        details: { totalduration: calculatedDuration },
      };
      const hls2mp4Audio = new HLS2MP4Class();
      if (options.noEdts === true) {
        hls2mp4Audio.noEdts = true;
      }
      const audioOnlyBlob = await hls2mp4Audio.convert(
        dummyLevelForAudio,
        null,
        audioOnlyLevel,
        null,
        audioFragments
      );
      debugLog(`🔊 Audio-only MP4 size: ${(audioOnlyBlob.size / 1024 / 1024).toFixed(2)} MB`);
      if (options.dumpIntermediates) {
        const baseName = fileName.replace(/\.(webm|mkv|avi|ts|mp4)$/i, "");
        const audioOnlyName = `${baseName}_audioOnly.mp4`;
        debugLog(`💾 Dumping intermediate: ${audioOnlyName}`);
        downloadBlob(audioOnlyBlob, audioOnlyName);
      }

      // Mux them using MediaBunny (same muxer we use for DASH)
      debugLog("🔧 Muxing per-track MP4s with MediaBunny...");
      const muxedBlob = await muxDashStreamsWithMediaBunny(videoOnlyBlob, audioOnlyBlob);
      if (muxedBlob && muxedBlob.size > 0) {
        debugLog(`✅ Dual-pass mux success: ${(muxedBlob.size / 1024 / 1024).toFixed(2)} MB`);
        downloadBlob(muxedBlob, outputFileName);
        debugLog(`🔍 ✅ Download initiated for ${outputFileName}`);

        return {
          fileName: outputFileName,
          size: muxedBlob.size,
          success: true,
        };
      }
      debugLog("⚠️ Dual-pass mux produced empty file; falling back to single-pass");
    } catch (dualErr) {
      debugLog(`⚠️ Dual-pass path failed: ${dualErr.message}; falling back to single-pass`);
    }
    }

    let outputBlob = await hls2mp4.convert(
      videoLevel,
      null,
      audioLevel,
      null,
      combinedFragments
    );

    debugLog("🔍 ✅ A/V FastStream conversion completed");
    debugLog(`🔍 Output file size: ${(outputBlob.size / 1024 / 1024).toFixed(2)} MB`);

    // Optional MP4 re-mux for better VLC compatibility
    try {
      debugLog("🔍 Performing VLC-compat MP4 remux (MediaBunny)...");
      const remuxed = await convertSingleStreamWithMediaBunny(outputBlob, "video");
      if (remuxed && remuxed.size > 0) {
        debugLog(`🔍 VLC-compat remux success: ${(remuxed.size / 1024 / 1024).toFixed(2)} MB`);
        outputBlob = remuxed;
      } else {
        debugLog("🔍 VLC-compat remux produced empty output, using original blob");
      }
    } catch (e) {
      debugLog(`🔍 VLC-compat remux skipped/failed: ${e.message}`);
    }

    downloadBlob(outputBlob, outputFileName);
    debugLog(`🔍 ✅ Download initiated for ${outputFileName}`);

    hls2mp4.destroy();

    return {
      fileName: outputFileName,
      size: outputBlob.size,
      success: true,
    };
  } catch (error) {
    debugLog(`🔍 A/V Processing failed: ${error.message}`);
    throw error;
  }
}

// HLS segments merge using FastStream
async function mergeSegmentsWithFastStream(request, options = {}) {
  debugLog("🔄 Starting FastStream segments merge...");

  const {
    requestId,
    segmentsKey,
    fileName,
    totalSegments,
    totalDuration,
    isDashStream,
    streamFormat,
    sourceUrl,
    manifestContent,
  } = request;

  console.log("🕐 FastStream received totalDuration:", totalDuration);

  try {
    chrome.runtime
      .sendMessage({
        type: "DEBUG_MESSAGE",
        message: `🔄 FASTSTREAM OFFSCREEN: Starting HLS merge for ${totalSegments} segments`,
      })
      .catch(() => {});
  } catch (error) {}

  try {
    if (options?.isCancelled && options.isCancelled(requestId)) {
      debugLog("⏹️ Merge cancelled before loading segments");
      try { chrome.runtime.sendMessage({ type: "MERGE_SEGMENTS_RESPONSE", success: false, requestId, error: { message: 'cancelled' } }).catch(() => {}); } catch (_) {}
      return;
    }
    const segments = await loadAllSegments(segmentsKey, totalSegments);

    if (segments.length === 0) {
      throw new Error("No segments found");
    }

    if (options?.isCancelled && options.isCancelled(requestId)) {
      debugLog("⏹️ Merge cancelled before processing segments");
      try { chrome.runtime.sendMessage({ type: "MERGE_SEGMENTS_RESPONSE", success: false, requestId, error: { message: 'cancelled' } }).catch(() => {}); } catch (_) {}
      return;
    }
    const result = await processSegmentsWithFastStream(
      segments,
      fileName,
      totalDuration,
      {
        isDASH: isDashStream,
        streamFormat: streamFormat,
        sourceUrl: sourceUrl,
        manifestContent: manifestContent,
      }
    );

    debugLog("🔍 ✅ FastStream merge completed successfully");

    try {
      chrome.runtime
        .sendMessage({
          type: "MERGE_SEGMENTS_RESPONSE",
          success: true,
          requestId: requestId,
          downloadInitiated: true,
          splitIntoMultipleParts: false,
          totalParts: 1,
          successfulParts: 1,
          failedParts: 0,
          results: [result],
        })
        .catch(() => {});
    } catch (error) {}
  } catch (error) {
    debugLog(`🔍 ❌ FastStream merge failed: ${error.message}`);
    console.error("❌ FastStream segments merge failed:", error);

    try {
      chrome.runtime
        .sendMessage({
          type: "MERGE_SEGMENTS_RESPONSE",
          success: false,
          requestId: requestId,
          error: {
            message: error.message,
            stack: error.stack,
            name: error.name,
          },
        })
        .catch(() => {});
    } catch (error) {}
  }
}

async function mergeDashSegmentsWithFastStream(request, options = {}) {
  debugLog("🔄 Starting FastStream DASH merge...");

  const {
    requestId,
    audioKeys = [],
    videoKeys = [],
    fileName = "dash-download.mp4",
  } = request;

  try {
    chrome.runtime
      .sendMessage({
        type: "DEBUG_MESSAGE",
        message: `🔄 FASTSTREAM OFFSCREEN: Processing DASH merge (video: ${videoKeys.length}, audio: ${audioKeys.length})`,
      })
      .catch(() => {});
  } catch (error) {}

  try {
    if (options?.isCancelled && options.isCancelled(requestId)) {
      debugLog("⏹️ DASH merge cancelled before loading segments");
      try { chrome.runtime.sendMessage({ type: "MERGE_DASH_SEGMENTS_RESPONSE", success: false, requestId, error: { message: 'cancelled' } }).catch(() => {}); } catch (_) {}
      return;
    }
    const { segments } = await loadDashSegments(audioKeys, videoKeys);

    if (!segments || segments.length === 0) {
      throw new Error("No DASH segments found");
    }

    const baseFileName = (
      fileName && typeof fileName === "string"
        ? fileName.replace(/\.[^/.]+$/, "")
        : "dash-download"
    ).trim() || "dash-download";

    if (options?.isCancelled && options.isCancelled(requestId)) {
      debugLog("⏹️ DASH merge cancelled before processing");
      try { chrome.runtime.sendMessage({ type: "MERGE_DASH_SEGMENTS_RESPONSE", success: false, requestId, error: { message: 'cancelled' } }).catch(() => {}); } catch (_) {}
      return;
    }
    const result = await processDashSegments(segments, {});
    let downloadInitiated = false;

    const triggerDownload = (
      blob,
      fileLabel,
      fallbackExt = ".mp4",
      defaultMime = "video/mp4"
    ) => {
      if (!(blob instanceof Blob)) return;
      const label = fileLabel || `${baseFileName}${fallbackExt}`;
      const finalName = label.includes(".") ? label : `${label}${fallbackExt}`;
      const typedBlob = blob.type ? blob : new Blob([blob], { type: defaultMime });
      downloadBlob(typedBlob, finalName, finalName);
      downloadInitiated = true;
    };

    if (result instanceof Blob) {
      triggerDownload(result, `${baseFileName}.mp4`);
    } else if (result && typeof result === "object") {
      if (result.videoBlob && result.audioBlob) {
        triggerDownload(result.videoBlob, `${baseFileName}_video.mp4`);
        const audioExt = result.audioBlob.type?.includes("webm") ? ".webm" : ".mp4";
        triggerDownload(
          result.audioBlob,
          `${baseFileName}_audio${audioExt}`,
          audioExt,
          result.audioBlob.type || (audioExt === ".webm" ? "audio/webm" : "audio/mp4")
        );
      } else if (result.videoBlob) {
        triggerDownload(result.videoBlob, `${baseFileName}.mp4`);
      } else if (result.audioBlob) {
        const audioExt = result.audioBlob.type?.includes("webm") ? ".webm" : ".mp4";
        triggerDownload(
          result.audioBlob,
          `${baseFileName}_audio${audioExt}`,
          audioExt,
          result.audioBlob.type || (audioExt === ".webm" ? "audio/webm" : "audio/mp4")
        );
      }
    }

    if (!downloadInitiated) {
      throw new Error("DASH processing produced no downloadable output");
    }

    try {
      chrome.runtime
        .sendMessage({
          type: "MERGE_DASH_SEGMENTS_RESPONSE",
          success: true,
          requestId,
          downloadInitiated,
        })
        .catch(() => {});
    } catch (error) {}
  } catch (error) {
    debugLog(`❌ FastStream DASH merge failed: ${error.message}`);
    console.error("❌ FastStream DASH merge failed:", error);

    try {
      chrome.runtime
        .sendMessage({
          type: "MERGE_DASH_SEGMENTS_RESPONSE",
          success: false,
          requestId,
          error: {
            message: error.message,
            stack: error.stack,
            name: error.name,
          },
        })
        .catch(() => {});
    } catch (error) {}
  }
}

async function mergeAudioVideoWithFastStream(request) {
  debugLog("🔄 Starting FastStream audio/video merge...");

  const { requestId, audioKey, videoKey, mergedKey } = request;

  try {
    chrome.runtime
      .sendMessage({
        type: "DEBUG_MESSAGE",
        message: "🔄 FASTSTREAM OFFSCREEN: Processing audio/video merge",
      })
      .catch(() => {});
  } catch (error) {}

  try {
    if (!videoKey) {
      throw new Error("Video key is required for merging");
    }

    const videoData = await idbGet(videoKey);
    if (!videoData) {
      throw new Error("Video data not found in storage");
    }

    const audioData = audioKey ? await idbGet(audioKey) : null;

    let videoBlob = toBlobSafe(videoData, "video/mp4");
    let audioBlob = audioData ? toBlobSafe(audioData, "audio/mp4") : null;

    let videoMp4 = null;
    let audioMp4 = null;
    let mergedBlob = null;

    try {
      videoMp4 = await convertSingleStreamWithMediaBunny(videoBlob, "video");
      debugLog(
        `🔧 MEDIABUNNY: Video stream converted (${(
          videoMp4.size /
          1024 /
          1024
        ).toFixed(2)} MB)`
      );
    } catch (error) {
      debugLog(
        `⚠️ MEDIABUNNY: Video conversion failed, using original blob: ${error.message}`
      );
      videoMp4 = videoBlob;
    }

    if (audioBlob) {
      try {
        audioMp4 = await convertSingleStreamWithMediaBunny(audioBlob, "audio");
        debugLog(
          `🔧 MEDIABUNNY: Audio stream converted (${(
            audioMp4.size /
            1024 /
            1024
          ).toFixed(2)} MB)`
        );
      } catch (error) {
        debugLog(
          `⚠️ MEDIABUNNY: Audio conversion failed, attempting to continue without audio: ${error.message}`
        );
        audioMp4 = null;
      }
    }

    if (videoMp4 && audioMp4) {
      try {
        mergedBlob = await muxDashStreamsWithMediaBunny(videoMp4, audioMp4);
      } catch (error) {
        debugLog(
          `⚠️ MEDIABUNNY: Muxing failed, falling back to video-only output: ${error.message}`
        );
      }
    }

    if (!mergedBlob) {
      mergedBlob = videoMp4 || videoBlob;
    }

    if (!(mergedBlob instanceof Blob)) {
      throw new Error("Unable to create merged output blob");
    }

    if (mergedKey) {
      await idbSet(mergedKey, mergedBlob);
    }

    try {
      chrome.runtime
        .sendMessage({
          type: "MERGE_RESPONSE",
          success: true,
          requestId,
        })
        .catch(() => {});
    } catch (error) {}
  } catch (error) {
    debugLog(`❌ FastStream audio/video merge failed: ${error.message}`);
    console.error("❌ FastStream audio/video merge failed:", error);

    try {
      chrome.runtime
        .sendMessage({
          type: "MERGE_RESPONSE",
          success: false,
          requestId,
          error: {
            message: error.message,
            stack: error.stack,
            name: error.name,
          },
        })
        .catch(() => {});
    } catch (error) {}
  }
}

async function convertSingleStreamWithMediaBunny(blob, trackType = "video") {
  if (!(blob instanceof Blob)) {
    return null;
  }

  try {
    const {
      Input,
      Output,
      Conversion,
      ALL_FORMATS,
      BufferSource,
      BufferTarget,
      Mp4OutputFormat,
    } = await import("./modules/mediabunny/dist/modules/src/index.js");

    const input = new Input({
      source: new BufferSource(await blob.arrayBuffer()),
      formats: ALL_FORMATS,
    });

    const output = new Output({
      format: new Mp4OutputFormat({
        fastStart: "in-memory",
      }),
      target: new BufferTarget(),
    });

    const conversion = await Conversion.init({
      input,
      output,
    });

    await conversion.execute();

    const buffer = output.target.buffer;
    if (!buffer || buffer.byteLength === 0) {
      throw new Error("Converted buffer is empty");
    }

    return new Blob([buffer], {
      type: trackType === "audio" ? "audio/mp4" : "video/mp4",
    });
  } catch (error) {
    debugLog(
      `🔧 MEDIABUNNY: Failed to convert ${trackType} stream: ${error.message}`
    );
    throw error;
  }
}

// A/V segments merge using FastStream
async function mergeSeparateAVSegmentsWithFastStream(request, options = {}) {
  debugLog("🔄 Starting FastStream A/V segments merge...");

  const {
    requestId,
    segmentsKey,
    fileName,
    totalSegments,
    videoCount,
    audioCount,
    totalDuration,
    isDashStream,
    mpdContent,
    streamFormat,
    sourceUrl,
    manifestContent,
    videoCodec,
    audioCodec,
    debugDumpIntermediates = false,
    forceMediaBunnyTsRemux = false,
    forceNoEdts = false,
  } = request;

  try {
    chrome.runtime
      .sendMessage({
        type: "DEBUG_MESSAGE",
        message: `🔄 FASTSTREAM OFFSCREEN: Starting A/V merge (${videoCount} video, ${audioCount} audio)`,
      })
      .catch(() => {});
  } catch (error) {}

  try {
    if (options?.isCancelled && options.isCancelled(requestId)) {
      debugLog("⏹️ A/V merge cancelled before loading segments");
      try { chrome.runtime.sendMessage({ type: "MERGE_SEPARATE_AV_RESPONSE", success: false, requestId, error: { message: 'cancelled' } }).catch(() => {}); } catch (_) {}
      return;
    }
    const { videoSegments, audioSegments } = await loadSeparateAVSegments(
      segmentsKey,
      totalSegments,
      videoCount,
      audioCount
    );

    if (videoSegments.length === 0) {
      throw new Error("No video segments found");
    }

    if (options?.isCancelled && options.isCancelled(requestId)) {
      debugLog("⏹️ A/V merge cancelled before processing");
      try { chrome.runtime.sendMessage({ type: "MERGE_SEPARATE_AV_RESPONSE", success: false, requestId, error: { message: 'cancelled' } }).catch(() => {}); } catch (_) {}
      return;
    }
    const result = await processAVSegmentsWithFastStream(
      videoSegments,
      audioSegments,
      fileName,
      totalDuration,
      {
        isDASH: isDashStream,
        mpdData: mpdContent,
        streamFormat: streamFormat,
        sourceUrl: sourceUrl,
        manifestContent: manifestContent,
        videoCodec,
        audioCodec,
        dumpIntermediates: !!debugDumpIntermediates,
        forceMediaBunnyTsRemux: !!forceMediaBunnyTsRemux,
        noEdts: !!forceNoEdts,
      }
    );

    debugLog("🔍 ✅ FastStream A/V merge completed successfully");

    try {
      chrome.runtime
        .sendMessage({
          type: "MERGE_SEPARATE_AV_RESPONSE",
          success: true,
          requestId: requestId,
          downloadInitiated: true,
          splitIntoMultipleParts: false,
          totalParts: 1,
          successfulParts: 1,
          failedParts: 0,
          results: [result],
        })
        .catch(() => {});
    } catch (error) {}
  } catch (error) {
    console.error("❌ FastStream A/V merge failed:", error);
    try {
      chrome.runtime
        .sendMessage({
          type: "MERGE_SEPARATE_AV_RESPONSE",
          success: false,
          requestId: requestId,
          error: {
            message: error.message,
            stack: error.stack,
            name: error.name,
          },
        })
        .catch(() => {});
    } catch (error) {}
  }
}

// Initialize the module
async function initialize() {
  debugLog("🔄 Initializing FastStream offscreen document...");

  const success = await loadModules();
  if (!success) {
    debugLog("❌ Module loading failed");
    try {
      chrome.runtime
        .sendMessage({
          type: "OFFSCREEN_ERROR",
          error: { message: "Module loading failed" },
        })
        .catch(() => {});
    } catch (error) {}
    return;
  }

  const __offscreenCancelMap = new Map(); // requestId -> { cancelled: true }

  function markCancelled(requestId) {
    if (!requestId) return;
    __offscreenCancelMap.set(String(requestId), { cancelled: true });
  }

  function isCancelled(requestId) {
    if (!requestId) return false;
    return !!__offscreenCancelMap.get(String(requestId))?.cancelled;
  }

  function clearCancelled(requestId) {
    if (!requestId) return;
    __offscreenCancelMap.delete(String(requestId));
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Offscreen only handles merge/PING messages; ignore everything else to avoid racing other listeners.
    const t = request?.type;

    // Lightweight ignore list for broadcast/progress messages
    const ignoreTypes = new Set([
      "DOWNLOAD_PROGRESS",
      "DOWNLOAD_COMPLETE",
      "DOWNLOAD_COMPLETE_NOTIFICATION",
      "DOWNLOAD_ERROR",
      "DOWNLOAD_CANCELLED",
      "VIDEO_INFO_UPDATE",
      "DEBUG_MESSAGE",
      "OFFSCREEN_DOCUMENT_READY",
      "OFFSCREEN_ERROR",
      "MERGE_SEGMENTS_RESPONSE",
      "MERGE_SEPARATE_AV_RESPONSE",
      "MERGE_DASH_SEGMENTS_RESPONSE",
      "MERGE_RESPONSE",
    ]);

    // If another context sends action-based messages, do not respond from offscreen
    if (request && request.action) {
      return false;
    }

    if (t && ignoreTypes.has(t)) {
      return false;
    }

    if (t === "MERGE_AUDIO_VIDEO") {
      mergeAudioVideoWithFastStream(request);
      return false; // fire-and-forget; do not keep channel open
    }
    if (t === "MERGE_SEGMENTS") {
      mergeSegmentsWithFastStream(request, { isCancelled });
      return false; // fire-and-forget
    }
    if (t === "MERGE_SEPARATE_AV") {
      mergeSeparateAVSegmentsWithFastStream(request, { isCancelled });
      return false; // fire-and-forget
    }
    if (t === "MERGE_DASH_SEGMENTS") {
      mergeDashSegmentsWithFastStream(request, { isCancelled });
      return false; // fire-and-forget
    }
    if (t === "CANCEL_OFFSCREEN_REQUEST") {
      try { markCancelled(request.requestId); } catch (_) {}
      return false;
    }
    if (t === "PING") {
      try { sendResponse({ type: "PONG", testId: request.testId }); } catch (_) {}
      return true; // this one responds synchronously
    }

    // Unknown or missing type: ignore silently to avoid stealing responses
    return false;
  });

  console.log("✅ FastStream Offscreen document ready");
  try {
    chrome.runtime
      .sendMessage({ type: "OFFSCREEN_DOCUMENT_READY" })
      .catch(() => {});
  } catch (error) {}
}

initialize();
