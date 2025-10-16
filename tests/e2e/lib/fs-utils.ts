import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function createTempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

export async function removeDir(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true });
}

export async function ensureDir(target: string): Promise<void> {
  await fsp.mkdir(target, { recursive: true });
}

export function watchFileTail(filePath: string, onLine: (line: string) => void): fs.FSWatcher {
  return fs.watch(filePath, { encoding: 'utf8' }, () => {
    void (async () => {
      try {
        const content = await fsp.readFile(filePath, 'utf8');
        const lines = content.trim().split(/\r?\n/);
        const last = lines[lines.length - 1];
        if (last) {
          onLine(last);
        }
      } catch {
        // ignore read errors (file might not exist yet)
      }
    })();
  });
}

export async function listFiles(targetDir: string): Promise<string[]> {
  try {
    return await fsp.readdir(targetDir);
  } catch {
    return [];
  }
}

export async function waitForFile(
  targetDir: string,
  predicate: (fileName: string) => boolean,
  timeoutMs = 120_000,
  pollIntervalMs = 1_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await listFiles(targetDir);
    const match = entries.find(predicate);
    if (match) {
      return path.join(targetDir, match);
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for file in ${targetDir}`);
}
