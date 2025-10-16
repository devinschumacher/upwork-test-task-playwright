// import fs from 'node:fs';
// import fsp from 'node:fs/promises';
// import os from 'node:os';
// import path from 'node:path';
// import { chromium, expect, test } from '@playwright/test';
// import { ensureDir } from '../lib/fs-utils';
// import { extensionPath, defaultNativeMessagingManifest } from '../lib/paths';

// interface RegressionSite {
//   id: string;
//   url: string;
//   selectVariant?: string;
//   minVariantCount?: number;
//   requireAudio?: boolean;
// }

// interface PanelSnapshotRow {
//   key: string;
//   title: string | null;
//   host: string | null;
//   hasThumbnail: boolean;
//   length: number | null;
//   streamCount: number;
//   variantCount: number;
//   audioCount: number;
//   manifestUrl: string | null;
//   selectedStreamUrl: string | null;
//   downloadRestriction: string | null;
//   isStreaming: boolean;
//   hasError: boolean;
//   source: string | null;
// }

// const regressionListPath = path.resolve(__dirname, '..', 'regression-sites.json');
// const regressionSites: RegressionSite[] = fs.existsSync(regressionListPath)
//   ? JSON.parse(fs.readFileSync(regressionListPath, 'utf-8'))
//   : [];

// declare global {
//   interface Window {
//     __SERP_PANEL_EXPORT__?: () => PanelSnapshotRow[];
//   }
// }

// async function resolveExtensionId(context: import('@playwright/test').BrowserContext): Promise<string> {
//   const [existingWorker] = context.serviceWorkers();
//   if (existingWorker) {
//     return existingWorker.evaluate(() => chrome.runtime.id);
//   }
//   const worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
//   return worker.evaluate(() => chrome.runtime.id);
// }

// async function prepareNativeMessaging(userDataDir: string): Promise<void> {
//   try {
//     const manifest = defaultNativeMessagingManifest();
//     const hostsDir = path.join(userDataDir, 'NativeMessagingHosts');
//     await ensureDir(hostsDir);
//     await fsp.copyFile(manifest, path.join(hostsDir, path.basename(manifest)));
//   } catch (error) {
//     // Native messaging host is optional for detection-only audits; log and continue.
//     console.warn('[regression-sites] Unable to provision native messaging host:', error);
//   }
// }

// test.describe.serial('Regression site audit', () => {
//   for (const site of regressionSites) {
//     test(site.id, async (_, testInfo) => {
//       const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'serp-regression-'));
//       let context: import('@playwright/test').BrowserContext | null = null;
//       try {
//         await prepareNativeMessaging(userDataDir);

//         const extPath = extensionPath();
//         context = await chromium.launchPersistentContext(userDataDir, {
//           channel: 'chrome',
//           headless: false,
//           args: [
//             `--disable-extensions-except=${extPath}`,
//             `--load-extension=${extPath}`,
//             '--autoplay-policy=no-user-gesture-required',
//             '--no-first-run',
//             '--no-default-browser-check',
//             '--disable-component-update'
//           ],
//           viewport: { width: 1280, height: 720 },
//           acceptDownloads: true
//         });

//         const extensionId = await resolveExtensionId(context);

//         const panelPage = await context.newPage();
//         await panelPage.addInitScript(() => {
//           if (typeof window !== 'undefined' && typeof window.__SERP_PANEL_EXPORT__ !== 'function') {
//             window.__SERP_PANEL_EXPORT__ = () => [];
//           }
//         });
//         await panelPage.goto(`chrome-extension://${extensionId}/panel.html`, { waitUntil: 'domcontentloaded' });
//         await panelPage.waitForSelector('#app, .media-list, article.media-item', { timeout: 60_000 }).catch(() => undefined);
//         await panelPage.waitForFunction(() => typeof window.__SERP_PANEL_EXPORT__ === 'function', null, { timeout: 60_000 });

//         const page = await context.newPage();
//         await page.goto(site.url, { waitUntil: 'domcontentloaded' });
//         await page.waitForTimeout(8_000);
//         await page.bringToFront();

//         await panelPage.bringToFront();
//         await panelPage.waitForFunction(() => {
//           const exporter = window.__SERP_PANEL_EXPORT__;
//           if (typeof exporter !== 'function') {
//             return false;
//           }
//           const rows = exporter();
//           return Array.isArray(rows) && rows.length > 0;
//         }, null, { timeout: 60_000 });

//         const rowLocator = panelPage.locator('article.media-item').first();
//         await rowLocator.waitFor({ state: 'visible', timeout: 60_000 });

//         if (site.selectVariant) {
//           const variantLabel = site.selectVariant;
//           const variantSelect = rowLocator.locator('select.media-variant-select');
//           if (await variantSelect.count() > 0) {
//             await variantSelect.selectOption({ label: variantLabel }).catch(async () => {
//               await variantSelect.selectOption(variantLabel).catch(() => {
//                 throw new Error(`Unable to select variant "${variantLabel}"`);
//               });
//             });
//           }
//         }

//         const downloadButton = rowLocator.locator('button.preview-action--download');
//         await expect(downloadButton).toBeEnabled({ timeout: 30_000 });

//         const audioButton = rowLocator.locator('button.preview-action--download-audio');
//         if (site.requireAudio) {
//           await expect(audioButton).toBeEnabled({ timeout: 30_000 });
//         }

//         const snapshot = await panelPage.evaluate<PanelSnapshotRow[]>(
//           () => window.__SERP_PANEL_EXPORT__?.() ?? []
//         );

//         expect(Array.isArray(snapshot)).toBeTruthy();
//         expect(snapshot.length).toBeGreaterThan(0);

//         const primary = snapshot[0];
//         expect(primary.title, 'Primary media item should have a title').toBeTruthy();
//         expect(primary.hasThumbnail, 'Primary media item should expose a thumbnail or preview').toBeTruthy();
//         if (typeof site.minVariantCount === 'number') {
//           expect(primary.variantCount).toBeGreaterThanOrEqual(site.minVariantCount);
//         }
//         if (site.requireAudio) {
//           expect(primary.audioCount).toBeGreaterThan(0);
//         }
//         expect(primary.hasError).toBeFalsy();

//         const snapshotsDir = path.join(testInfo.outputDir, 'regression-snapshots');
//         await ensureDir(snapshotsDir);
//         await fsp.writeFile(
//           path.join(snapshotsDir, `${site.id}.json`),
//           JSON.stringify(snapshot, null, 2),
//           'utf-8'
//         );
//       } finally {
//         if (context) {
//           await context.close();
//         }
//         await fsp.rm(userDataDir, { recursive: true, force: true });
//       }
//     });
//   }
// });
