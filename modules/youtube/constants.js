// YouTube Downloader - Shared Constants (trimmed for extension)
export const INNERTUBE_CLIENTS = {
  web: {
    INNERTUBE_CONTEXT: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20250312.04.00'
      }
    },
    INNERTUBE_CONTEXT_CLIENT_NAME: 1,
    INNERTUBE_HOST: 'www.youtube.com'
  },
  web_embedded: {
    INNERTUBE_CONTEXT: {
      client: {
        clientName: 'WEB_EMBEDDED_PLAYER',
        clientVersion: '1.20250310.01.00',
        hl: 'en',
        gl: 'US'
      }
    },
    INNERTUBE_CONTEXT_CLIENT_NAME: 56,
    INNERTUBE_HOST: 'www.youtube.com'
  },
  android: {
    INNERTUBE_CONTEXT: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        androidSdkVersion: 30,
        userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
        osName: 'Android',
        osVersion: '11',
        hl: 'en',
        gl: 'US'
      }
    },
    INNERTUBE_CONTEXT_CLIENT_NAME: 3,
    INNERTUBE_HOST: 'www.youtube.com'
  },
  ios: {
    INNERTUBE_CONTEXT: {
      client: {
        clientName: 'IOS',
        clientVersion: '20.10.4',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
        osName: 'iPhone',
        osVersion: '18.3.2.22D82',
        hl: 'en',
        gl: 'US'
      }
    },
    INNERTUBE_CONTEXT_CLIENT_NAME: 5,
    INNERTUBE_HOST: 'www.youtube.com'
  },
  mweb: {
    INNERTUBE_CONTEXT: {
      client: {
        clientName: 'MWEB',
        clientVersion: '2.20250311.03.00',
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)',
        hl: 'en',
        gl: 'US'
      }
    },
    INNERTUBE_CONTEXT_CLIENT_NAME: 2,
    INNERTUBE_HOST: 'www.youtube.com'
  },
  tv_embedded: {
    INNERTUBE_CONTEXT: {
      client: {
        clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
        clientVersion: '2.0',
        hl: 'en',
        gl: 'US',
        thirdParty: { embedUrl: 'https://www.youtube.com/' }
      }
    },
    INNERTUBE_CONTEXT_CLIENT_NAME: 85,
    INNERTUBE_HOST: 'www.youtube.com'
  }
};

export const DEFAULT_CLIENTS = [
  'web_embedded',
  'android',
  'ios',
  'mweb',
  'tv_embedded',
  'web'
];

export const ENDPOINTS = {
  INNERTUBE_API: 'https://www.youtube.com/youtubei/v1/player',
  INNERTUBE_API_KEY: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
};

export const USER_AGENTS = {
  DESKTOP: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  ANDROID: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
  IOS: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)'
};

