// UMP (YouTube's Universal Media Protocol) Parser and helpers (trimmed for extension)
console.log('🔧 UMP Parser loading...');

export const UMP_PART_TYPES = {
  FORMAT_INITIALIZATION_METADATA: 0x01,
  NEXT_REQUEST_POLICY: 0x02,
  MEDIA_HEADER: 0x03,
  MEDIA: 0x04,
  MEDIA_END: 0x05,
  SABR_ERROR: 0x06,
  STREAM_PROTECTION_STATUS: 0x07,
  SABR_REDIRECT: 0x08,
  SABR_CONTEXT_UPDATE: 0x09,
  SNACKBAR_MESSAGE: 0x0A
};

export class UMPParser {
  constructor() {
    this.buffer = new Uint8Array(0);
    this.position = 0;
    this.segments = [];
    this.formatInitMetadata = new Map();
    this.playbackCookie = null;
    this.redirectUrl = null;
    this.error = null;
    this.currentSegment = null;
  }
  async parseUMPResponse(data) {
    console.log(`📦 Parsing UMP response (${data.length} bytes)`);
    this.buffer = new Uint8Array([...this.buffer, ...data]);
    this.position = 0;
    const result = { segments: [], initSegments: [], playbackCookie: null, redirectUrl: null, error: null, formatMetadata: {} };
    try {
      while (this.position < this.buffer.length) {
        const part = this.readNextPart();
        if (!part) break;
        const handled = this.handleUMPPart(part);
        if (handled) Object.assign(result, handled);
      }
      console.log(`✅ UMP parsing complete: ${result.segments.length} segments, ${result.initSegments.length} init segments`);
      return result;
    } catch (e) {
      console.error('❌ UMP parsing failed:', e);
      throw new Error(`UMP parsing failed: ${e.message}`);
    }
  }
  readNextPart() {
    if (this.position >= this.buffer.length - 4) return null;
    try {
      const partType = this.buffer[this.position];
      const lengthBytes = this.buffer.slice(this.position + 1, this.position + 4);
      const partLength = (lengthBytes[0] << 16) | (lengthBytes[1] << 8) | lengthBytes[2];
      if (this.position + 4 + partLength > this.buffer.length) return null;
      const partData = this.buffer.slice(this.position + 4, this.position + 4 + partLength);
      this.position += 4 + partLength;
      return { type: partType, length: partLength, data: partData };
    } catch (e) {
      console.warn('⚠️ Error reading UMP part:', e);
      return null;
    }
  }
  handleUMPPart(part) {
    switch (part.type) {
      case UMP_PART_TYPES.FORMAT_INITIALIZATION_METADATA:
        return this.handleFormatInitMetadata(part);
      case UMP_PART_TYPES.NEXT_REQUEST_POLICY:
        return this.handleNextRequestPolicy(part);
      case UMP_PART_TYPES.MEDIA_HEADER:
        return this.handleMediaHeader(part);
      case UMP_PART_TYPES.MEDIA:
        return this.handleMedia(part);
      case UMP_PART_TYPES.MEDIA_END:
        return { mediaEnd: true };
      case UMP_PART_TYPES.SABR_ERROR:
        return { error: { type: 'SABR_ERROR', message: 'SABR error signaled' } };
      case UMP_PART_TYPES.SABR_REDIRECT:
        return { redirectUrl: new TextDecoder().decode(part.data) };
      default:
        console.log(`ℹ️ Unknown UMP part type: 0x${part.type.toString(16).padStart(2, '0')}`);
        return null;
    }
  }
  handleFormatInitMetadata(part) {
    try {
      const metadata = { itag: 0, initSegmentData: part.data, timestamp: Date.now() };
      return { initSegments: [metadata] };
    } catch (e) { console.warn('⚠️ Error parsing init metadata', e); return null; }
  }
  handleNextRequestPolicy(part) {
    try { return { playbackCookie: part.data }; } catch (e) { return null; }
  }
  handleMediaHeader(part) {
    try {
      const header = { headerId: part.data[0], startTimeMs: 0, durationMs: 0, sequenceNumber: 0 };
      this.currentSegment = { header };
      return null;
    } catch (e) { return null; }
  }
  handleMedia(part) {
    if (!this.currentSegment) this.currentSegment = {};
    this.currentSegment.data = part.data;
    const seg = this.currentSegment; this.currentSegment = null;
    return { segments: [seg] };
  }
}

export class SABRStreamingContext {
  constructor(videoId, format) {
    this.videoId = videoId;
    this.format = format;
    this.isInit = true;
    this.isSABR = true;
    this.isUMP = true;
    this.playerTimeMs = 0;
    this.playbackCookie = null;
    this.formatInitMetadata = [];
    this.streamProtectionStatus = null;
    this.mediaHeader = null;
    this.redirect = null;
    this.error = null;
  }
  createContext(options = {}) {
    const context = {
      videoId: this.videoId,
      format: this.format,
      isInit: options.isInit ?? this.isInit,
      isSABR: true,
      isUMP: true,
      playerTimeMs: options.playerTimeMs || this.playerTimeMs,
      byteRange: options.byteRange || null,
      streamInfo: {
        playbackCookie: this.playbackCookie,
        formatInitMetadata: this.formatInitMetadata,
        streamProtectionStatus: this.streamProtectionStatus,
        mediaHeader: this.mediaHeader,
        redirect: this.redirect
      },
      error: this.error
    };
    return btoa(JSON.stringify(context));
  }
  updateFromUMP(umpData) {
    if (umpData.playbackCookie) this.playbackCookie = umpData.playbackCookie;
    if (umpData.initSegments?.length) this.formatInitMetadata = umpData.initSegments;
    if (umpData.redirectUrl) this.redirect = { url: umpData.redirectUrl };
    if (umpData.error) this.error = umpData.error;
  }
}

export class SABRRequestBuilder {
  constructor(videoId, clientInfo) {
    this.videoId = videoId;
    this.clientInfo = clientInfo || { clientName: 'WEB', clientVersion: '2.20250312.04.00', osName: 'Windows', osVersion: '10.0' };
  }
  buildSABRRequest(options = {}) {
    const request = {
      clientAbrState: {
        playbackRate: options.playbackRate || 1.0,
        playerTimeMs: options.playerTimeMs || 0,
        elapsedWallTimeMs: options.elapsedWallTimeMs || 0,
        timeSinceLastSeek: options.timeSinceLastSeek || 0,
        timeSinceLastActionMs: options.timeSinceLastActionMs || 0,
        timeSinceLastManualFormatSelectionMs: options.timeSinceLastManualFormatSelectionMs || 0,
        clientViewportIsFlexible: false,
        bandwidthEstimate: options.bandwidthEstimate || 1000000,
        drcEnabled: false,
        enabledTrackTypesBitfield: options.enabledTrackTypesBitfield || 1,
        clientViewportHeight: options.clientViewportHeight || 1080,
        clientViewportWidth: options.clientViewportWidth || 1920
      },
      bufferedRanges: options.bufferedRanges || [],
      selectedFormatIds: options.selectedFormatIds || [],
      selectedAudioFormatIds: options.selectedAudioFormatIds || [],
      selectedVideoFormatIds: options.selectedVideoFormatIds || [],
      videoPlaybackUstreamerConfig: options.videoPlaybackUstreamerConfig,
      streamerContext: { poToken: options.poToken, playbackCookie: options.playbackCookie, clientInfo: this.clientInfo, field5: [], field6: [] },
      field1000: []
    };
    return new TextEncoder().encode(JSON.stringify(request));
  }
}

console.log('✅ UMP Parser loaded!');

