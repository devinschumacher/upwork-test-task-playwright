import { spawn } from 'node:child_process';
import which from 'which';

export interface MediaCheck {
  hasAudio: boolean;
  hasVideo: boolean;
  format: string | null;
}

export async function locateFfprobe(): Promise<string | null> {
  try {
    return await which('ffprobe');
  } catch {
    return null;
  }
}

export function assertFfprobeAvailable(ffprobePath: string | null): asserts ffprobePath is string {
  if (!ffprobePath) {
    throw new Error('ffprobe not found on PATH. Install FFmpeg (brew install ffmpeg) to enable media assertions.');
  }
}

export async function inspectMedia(ffprobePath: string, target: string): Promise<MediaCheck> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    let stderrOutput = '';

    const subprocess = spawn(ffprobePath, [
      '-v', 'error',
      '-show_streams',
      '-of', 'json',
      target
    ]);

    subprocess.stdout.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    subprocess.stderr.on('data', (chunk: Buffer | string) => {
      stderrOutput += typeof chunk === 'string' ? chunk : chunk.toString();
    });

    subprocess.once('error', (error: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    subprocess.once('close', code => {
      if (code !== 0) {
        return reject(new Error(stderrOutput || `ffprobe exited with code ${code}`));
      }
      try {
        const payload = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8'));
        const streams = Array.isArray(payload?.streams) ? payload.streams : [];
        const hasAudio = streams.some((stream: { codec_type?: string }) => stream.codec_type === 'audio');
        const hasVideo = streams.some((stream: { codec_type?: string }) => stream.codec_type === 'video');
        resolve({
          hasAudio,
          hasVideo,
          format: payload?.format?.format_name ?? null
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
