import { INNERTUBE_CLIENTS, DEFAULT_CLIENTS, ENDPOINTS, USER_AGENTS } from './constants.js';
import { extractVideoId, sanitizeFilename } from './utils.js';
import { YouTubeSignatureDecryptor } from './signature.js';

export class SimpleYouTubeClient {
  constructor() {
    this.sig = new YouTubeSignatureDecryptor();
  }

  async extract(videoUrl) {
    const videoId = extractVideoId(videoUrl);
    if (!videoId) throw new Error('Invalid YouTube URL');

    // Fetch watch page
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': USER_AGENTS.DESKTOP, 'Accept-Language': 'en-US,en;q=0.9' }
    });
    if (!res.ok) throw new Error(`Failed watch page: ${res.status}`);
    const html = await res.text();

    const jsUrl = this.#extractJsUrl(html);
    console.log('[YT] Extract: jsUrl found?', !!jsUrl, jsUrl ? jsUrl.slice(0, 80) + '...' : '');
    this.lastJsUrl = jsUrl;
    const initialPR = this.#extractJSON(html, /var ytInitialPlayerResponse = ({.+?});var/s);
    const initialData = this.#extractJSON(html, /var ytInitialData = ({.+?});/s);
    const ytcfg = this.#extractJSON(html, /ytcfg\.set\s*\(\s*({.+?})\s*\)/);

    let playerResponse = initialPR;
    let usedClient = 'webpage';
    const visitorData = this.#extractVisitorData(ytcfg, initialData, initialPR);

    if (!playerResponse?.streamingData) {
      const api = await this.#extractViaInnertube(videoId, visitorData);
      playerResponse = api.playerResponse;
      usedClient = api.client;
    }

    const vd = playerResponse?.videoDetails || {};
    let sd = playerResponse?.streamingData || {};

    // Try API clients regardless to enrich formats (yt-dlp behavior)
    try {
      const clientsMerged = [];
      for (const cl of DEFAULT_CLIENTS) {
        try {
          const apiResult = await this.#extractViaInnertubeForced(videoId, visitorData, cl);
          const sd2 = apiResult?.playerResponse?.streamingData || {};
          const count = (sd2.formats?.length || 0) + (sd2.adaptiveFormats?.length || 0);
          if (count > 0) {
            console.log('[YT] Merging API streamingData from', apiResult.client);
            sd = {
              ...sd,
              hlsManifestUrl: sd.hlsManifestUrl || sd2.hlsManifestUrl,
              dashManifestUrl: sd.dashManifestUrl || sd2.dashManifestUrl,
              serverAbrStreamingUrl: sd.serverAbrStreamingUrl || sd2.serverAbrStreamingUrl || sd2.server_abr_streaming_url,
              formats: [ ...(sd.formats || []), ...(sd2.formats || []) ],
              adaptiveFormats: [ ...(sd.adaptiveFormats || []), ...(sd2.adaptiveFormats || []) ]
            };
            clientsMerged.push(apiResult.client);
          }
        } catch (err) {
          console.warn('[YT] Client failed', cl, err?.message);
        }
      }
      if (!clientsMerged.length) console.warn('[YT] No API clients produced streamingData');
    } catch (e) {
      console.warn('[YT] API enrich failed', e?.message);
    }

    // Recompute formatsRaw AFTER merging all client results
    const formatsRaw = [ ...(sd.formats || []), ...(sd.adaptiveFormats || []) ];
    console.log('[YT] formatsRaw counts:', { formats: sd.formats?.length || 0, adaptive: sd.adaptiveFormats?.length || 0 });

    const formats = [];
    for (const f of formatsRaw) {
      let url = f.url;
      const cipher = f.signatureCipher || f.cipher;
      if (!url && cipher && jsUrl) {
        try {
          url = await this.sig.decryptSignatureCipher(cipher, videoId, jsUrl);
        } catch (e) {
          console.warn('[YT] decryptSignatureCipher failed for itag', f.itag, e?.message);
        }
      }
      if (url && url.includes('n=')) {
        try { url = await this.sig.transformNUrl(url, jsUrl); } catch {}
      }
      if (!url) {
        console.log('[YT] skipping format without url', {
          itag: f.itag,
          hasCipher: !!cipher,
          mimeType: f.mimeType
        });
        continue;
      }

      const mime = f.mimeType || '';
      const isVideo = mime.startsWith('video/');
      const isAudio = mime.startsWith('audio/');
      // Detect progressive AV via codecs or known itags
      const codecsMatch = mime.match(/codecs=\"([^\"]+)\"/);
      const codecs = codecsMatch ? codecsMatch[1] : '';
      const hasAudioCodec = /mp4a|opus|vorbis|ec-3|ac-3|dtse/i.test(codecs) || !!f.audioChannels || !!f.audioQuality;
      const knownProgressive = [18, 22, 37, 38, 59, 78];
      const progressiveAV = knownProgressive.includes(Number(f.itag)) || (isVideo && hasAudioCodec);
      formats.push({
        itag: f.itag,
        url,
        width: f.width,
        height: f.height,
        fps: f.fps,
        bitrate: f.bitrate || f.averageBitrate,
        qualityLabel: f.qualityLabel || f.quality,
        hasVideo: !!isVideo,
        hasAudio: progressiveAV || !!isAudio,
        mimeType: mime,
        container: mime.split('/')[1]?.split(';')[0] || 'mp4'
      });
    }
    console.log('[YT] Extracted formats:', formats.length);
    if (formats.length) {
      console.log('[YT] Sample formats:', formats.slice(0, 5).map(f => ({ itag: f.itag, q: f.qualityLabel, av: `${f.hasVideo?'V':''}${f.hasAudio?'A':''}`, c: f.container })));
    }

    // Log manifest & SABR URLs for diagnostics
    if (sd.hlsManifestUrl) console.log('[YT] hlsManifestUrl present');
    if (sd.dashManifestUrl) console.log('[YT] dashManifestUrl present');
    if (sd.serverAbrStreamingUrl) console.log('[YT] serverAbrStreamingUrl present');

    console.log('[YT] usedClient', usedClient);
    return {
      id: videoId,
      title: vd.title || `YouTube Video ${videoId}`,
      duration: parseInt(vd.lengthSeconds) || 0,
      author: vd.author || '',
      thumbnail: vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      formats: this.#sortFormats(formats),
      playerUrl: jsUrl,
      usedClient,
      usedClients: DEFAULT_CLIENTS,
      hlsManifestUrl: sd.hlsManifestUrl || null,
      dashManifestUrl: sd.dashManifestUrl || null,
      sabrStreamingUrl: sd.serverAbrStreamingUrl || null,
      visitorData
    };
  }

  #extractJsUrl(html) {
    // Try multiple patterns for resilience
    const patterns = [
      /"jsUrl"\s*:\s*"([^"]+)"/,
      /'jsUrl'\s*:\s*'([^']+)'/,
      /"PLAYER_JS_URL"\s*:\s*"([^"]+)"/,
      /\"PLAYER_JS_URL\"\s*:\s*\"([^\"]+)\"/,
      /\"\/(s\/player\/[^\"]+?\/base\.js)\"/,
      /"(\/s\/player\/[^"']+?\.js)"/,
      /'(\/s\/player\/[^"']+?\.js)'/
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m && m[1]) {
        const raw = m[1].replace(/\\\//g, '/');
        return raw.startsWith('/') ? `https://www.youtube.com${raw}` : raw;
      }
    }
    return null;
  }

  #extractJSON(html, regex) {
    const m = html.match(regex);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }

  #extractVisitorData(ytcfg, initialData, pr) {
    return (
      ytcfg?.VISITOR_DATA ||
      ytcfg?.INNERTUBE_CONTEXT?.client?.visitorData ||
      initialData?.responseContext?.visitorData ||
      pr?.responseContext?.visitorData || null
    );
  }

  async #extractViaInnertube(videoId, visitorData) {
    let lastError;
    for (const client of DEFAULT_CLIENTS) {
      try {
        const cfg = INNERTUBE_CLIENTS[client];
        const body = {
          context: {
            client: { ...cfg.INNERTUBE_CONTEXT.client },
            user: { lockedSafetyMode: false },
            request: { useSsl: true }
          },
          playbackContext: {
            contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' }
          },
          contentCheckOk: true,
          racyCheckOk: true,
          videoId
        };
        if (visitorData) body.context.client.visitorData = visitorData;
        // Try to include signatureTimestamp (sts) if we can parse it from player JS
        try {
          const playerCode = await this.sig.getPlayerCode(this.lastJsUrl || '');
          const m = playerCode && playerCode.match(/(?:signatureTimestamp|sts)\s*:\s*(\d{5})/);
          const sts = m && parseInt(m[1]);
          if (sts) body.playbackContext.contentPlaybackContext.signatureTimestamp = sts;
        } catch {}
        if (cfg.PLAYER_PARAMS) body.params = cfg.PLAYER_PARAMS;
        const res = await fetch(`${ENDPOINTS.INNERTUBE_API}?key=${ENDPOINTS.INNERTUBE_API_KEY}` , {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': String(cfg.INNERTUBE_CONTEXT_CLIENT_NAME),
            'X-YouTube-Client-Version': cfg.INNERTUBE_CONTEXT.client.clientVersion,
            ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
            'Origin': 'https://www.youtube.com',
            'Referer': 'https://www.youtube.com/'
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const pr = await res.json();
        if (pr?.streamingData) return { playerResponse: pr, client };
      } catch (e) { lastError = e; }
    }
    throw lastError || new Error('All clients failed');
  }

  async #extractViaInnertubeForced(videoId, visitorData, client) {
    const cfg = INNERTUBE_CLIENTS[client];
    const body = {
      context: { client: { ...cfg.INNERTUBE_CONTEXT.client }, user: { lockedSafetyMode: false }, request: { useSsl: true } },
      playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
      contentCheckOk: true,
      racyCheckOk: true,
      videoId
    };
    if (visitorData) body.context.client.visitorData = visitorData;
    try {
      const playerCode = await this.sig.getPlayerCode(this.lastJsUrl || '');
      const m = playerCode && playerCode.match(/(?:signatureTimestamp|sts)\s*:\s*(\d{5})/);
      const sts = m && parseInt(m[1]);
      if (sts) body.playbackContext.contentPlaybackContext.signatureTimestamp = sts;
    } catch {}
    if (cfg.PLAYER_PARAMS) body.params = cfg.PLAYER_PARAMS;
    const res = await fetch(`${ENDPOINTS.INNERTUBE_API}?key=${ENDPOINTS.INNERTUBE_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': String(cfg.INNERTUBE_CONTEXT_CLIENT_NAME),
        'X-YouTube-Client-Version': cfg.INNERTUBE_CONTEXT.client.clientVersion,
        ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
        'Origin': 'https://www.youtube.com',
        'Referer': 'https://www.youtube.com/'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const pr = await res.json();
    return { playerResponse: pr, client };
  }

  #sortFormats(list) {
    return list.sort((a,b) => {
      const avA = (a.hasVideo?1:0)+(a.hasAudio?1:0);
      const avB = (b.hasVideo?1:0)+(b.hasAudio?1:0);
      if (avA !== avB) return avB-avA;
      const hA = a.height||0, hB = b.height||0;
      if (hA !== hB) return hB-hA;
      const fpsA=a.fps||0, fpsB=b.fps||0; if (fpsA!==fpsB) return fpsB-fpsA;
      return (b.bitrate||0)-(a.bitrate||0);
    });
  }
}
