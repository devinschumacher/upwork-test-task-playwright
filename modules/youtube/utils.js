// Basic YouTube helpers for the extension

export function extractVideoId(url) {
  if (!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

export function sanitizeFilename(name) {
  return (name || 'video')
    .replace(/[<>:"/\\|?*]/g, '_')
    .substring(0, 120);
}

export function cleanDownloadUrl(url) {
  try {
    const u = new URL(url);
    // Remove unstable params
    ['rn', 'rbuf'].forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return url;
  }
}

export function getPlayerCacheKey(playerUrl) {
  const m = playerUrl?.match(/\/s\/player\/([a-zA-Z0-9_-]+)\//);
  return m ? m[1] : playerUrl;
}

export function makePlayerUrlAbsolute(playerUrl) {
  if (!playerUrl) return playerUrl;
  if (playerUrl.startsWith('//')) return `https:${playerUrl}`;
  if (playerUrl.startsWith('/')) return `https://www.youtube.com${playerUrl}`;
  return playerUrl;
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

