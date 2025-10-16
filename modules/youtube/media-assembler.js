// Minimal media assembler placeholder for SABR (concatenate segments)
console.log('🔧 Media Assembler loading...');

export class MediaAssembler {
  async assembleMediaFile(segments, initSegments, format, options = {}) {
    const ordered = segments.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const initBytes = (initSegments || []).reduce((sum, s) => sum + (s.initSegmentData?.length || s.data?.length || 0), 0);
    const mediaBytes = ordered.reduce((sum, s) => sum + (s.data?.length || 0), 0);
    const total = initBytes + mediaBytes;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const i of (initSegments || [])) {
      const data = i.initSegmentData || i.data;
      if (data) { out.set(data, pos); pos += data.length; }
    }
    for (const s of ordered) {
      if (s.data) { out.set(s.data, pos); pos += s.data.length; }
    }
    return { data: out, mimeType: 'video/mp4', size: total, duration: null, segments: ordered.length, format };
  }
}

console.log('✅ Media Assembler ready');

