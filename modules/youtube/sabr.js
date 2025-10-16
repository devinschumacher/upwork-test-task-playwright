import { UMPParser, SABRStreamingContext, SABRRequestBuilder } from './ump.js';
import { MediaAssembler } from './media-assembler.js';

export class SABRDownloadManager {
  constructor(utils) {
    this.utils = utils;
  }

  async download(videoId, sabrUrl, baseName, options = {}, downloadId) {
    const format = { itag: options.itag || 0 };
    const sabrInfo = await this.#buildSabrInfo(videoId, sabrUrl, options);
    const streamingContext = new SABRStreamingContext(videoId, format);
    const umpParser = new UMPParser();
    const requestBuilder = new SABRRequestBuilder(videoId, { clientName: 'WEB', clientVersion: '2.20250312.04.00' });

    const segments = [];
    const initSegments = [];
    let segIndex = 0;
    const MAX = options.maxSegments || 200;

    while (segIndex < MAX) {
      const req = this.#buildRequest(sabrInfo, streamingContext, requestBuilder, segIndex, options);
      const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      if (!res.ok) throw new Error(`SABR HTTP ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      if (!/application\/vnd\.yt-ump/.test(ct)) {
        if (segIndex === 0 && (/video\//.test(ct) || /octet-stream/.test(ct))) {
          // Regular stream fallback
          const blob = await res.blob();
          await this.#saveBlob(blob, `${baseName}.mp4`, downloadId);
          return { success: true, regular: true };
        }
        throw new Error(`Unexpected content-type ${ct}`);
      }
      const data = new Uint8Array(await res.arrayBuffer());
      const ump = await umpParser.parseUMPResponse(data);
      streamingContext.updateFromUMP(ump);
      if (ump.redirectUrl) { sabrInfo.serverAbrStreamingUrl = ump.redirectUrl; continue; }
      if (ump.initSegments?.length) initSegments.push(...ump.initSegments);
      if (ump.segments?.length) {
        for (const s of ump.segments) {
          segments.push({ index: segIndex, data: s.data, header: s.header });
          segIndex++;
          const pct = 15 + Math.round((segIndex / MAX) * 70);
          this.utils?.sendProgressToPopup?.(Math.min(pct, 90), `SABR downloading ${segIndex}/${MAX}...`, '', downloadId);
        }
      } else {
        break;
      }
    }

    const assembler = new MediaAssembler();
    const assembled = await assembler.assembleMediaFile(segments, initSegments, format, {});
    await this.#saveBlob(new Blob([assembled.data], { type: assembled.mimeType }), `${baseName}.mp4`, downloadId);
    return { success: true, sabr: true };
  }

  async #saveBlob(blob, fileName, downloadId) {
    const url = URL.createObjectURL(blob);
    await new Promise((resolve) => {
      chrome.downloads.download({ url, filename: fileName, saveAs: true }, () => { setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 10000); resolve(); });
    });
    this.utils?.sendProgressToPopup?.(100, 'Download started in browser', '', downloadId);
  }

  async #buildSabrInfo(videoId, serverAbrStreamingUrl, options) {
    const u = new URL(serverAbrStreamingUrl);
    if (!u.searchParams.has('sabr')) u.searchParams.set('sabr', '1');
    if (!u.searchParams.has('rqh')) u.searchParams.set('rqh', '1');
    u.searchParams.set('c', 'WEB');
    u.searchParams.set('cver', '2.20250312.04.00');
    if (options.visitorData) u.searchParams.set('visitor_data', options.visitorData);
    if (options.poToken) u.searchParams.set('po_token', options.poToken);
    return { videoId, serverAbrStreamingUrl: u.toString() };
  }

  #buildRequest(sabrInfo, streamingContext, requestBuilder, segmentIndex, options) {
    const u = new URL(sabrInfo.serverAbrStreamingUrl);
    u.searchParams.set('ump', '1');
    u.searchParams.set('srfvp', '1');
    const payload = requestBuilder.buildSABRRequest({
      playerTimeMs: segmentIndex * 2000,
      poToken: options.poToken || undefined,
      playbackCookie: streamingContext.playbackCookie
    });
    return {
      url: u.toString(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Accept': 'application/vnd.yt-ump',
        'Origin': 'https://www.youtube.com',
        'Referer': `https://www.youtube.com/watch?v=${sabrInfo.videoId}`,
        'X-Streaming-Context': streamingContext.createContext({ isInit: segmentIndex === 0, playerTimeMs: segmentIndex * 2000 })
      },
      body: payload
    };
  }
}

