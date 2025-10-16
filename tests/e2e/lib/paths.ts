import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export function repoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

export function extensionPath(): string {
  const override = process.env.PLAYWRIGHT_EXTENSION_PATH;
  const candidate = override ? path.resolve(override) : path.resolve(repoRoot(), 'sidepanel-downloader');
  const manifestPath = path.join(candidate, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Extension manifest not found at ${manifestPath}. Set PLAYWRIGHT_EXTENSION_PATH or build sidepanel-downloader.`);
  }
  const requiredAssets = [
    'build/service-worker-wrapper.global.js',
    'build/extension-core/index.global.js',
    'build/panel.global.js',
    'build/content-injector.global.js',
    'build/dom-extractor.global.js'
  ];
  for (const asset of requiredAssets) {
    const assetPath = path.join(candidate, asset);
    if (!fs.existsSync(assetPath)) {
      throw new Error(`Missing extension bundle asset ${assetPath}. Run "npm run build:sidepanel" before executing tests.`);
    }
  }
  return candidate;
}

export function defaultNativeMessagingManifest(): string {
  const manifestPath = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Chromium',
    'NativeMessagingHosts',
    'com.serpcompanion.co.json'
  );
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Native messaging manifest not found at ${manifestPath}. Run serpcompanion install-host first.`);
  }
  return manifestPath;
}

export function defaultCompanionDownloadDir(): string {
  return path.join(os.homedir(), 'Downloads', 'serpcompanion');
}
