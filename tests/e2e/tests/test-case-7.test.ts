import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, type TestInfo } from '@playwright/test';
import { test, type TestFixtures } from '../lib/fixtures';
import { inspectMedia, assertFfprobeAvailable } from '../lib/media';
import { ensureDir, listFiles, waitForFile } from '../lib/fs-utils';
import { waitForWistiaEmbed } from './helpers/wistia-utils';

type MediaCoreUpdateResult = {
  ok?: boolean;
  error?: string;
};

type MediaCoreClient = {
  updateSettings: (settings: { downloadDirectory: string }) => Promise<MediaCoreUpdateResult> | MediaCoreUpdateResult;
  resumeDetection?: () => Promise<void> | void;
  getState: () => Promise<unknown>;
};

declare global {
  interface Window {
    MediaCore?: {
      createClient?: () => MediaCoreClient;
    };
  }
}

interface WistiaDownloadArgs extends Pick<TestFixtures,
  'page' |
  'context' |
  'extensionId' |
  'caseData' |
  'profileLogin' |
  'downloadsDir' |
  'ffprobePath'
> {
  testInfo: TestInfo;
}

async function runWistiaDownload({
  page,
  context,
  extensionId,
  caseData,
  profileLogin,
  downloadsDir,
  ffprobePath,
  testInfo,
}: WistiaDownloadArgs): Promise<void> {
  await ensureDir(downloadsDir);
  await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded' });

  const panelUrl = `chrome-extension://${extensionId}/panel.html`;
  const panelPage = await context.newPage();
  try {
    await panelPage.goto(panelUrl);
    await panelPage.waitForLoadState('domcontentloaded');
    await panelPage.waitForFunction(() => typeof window.MediaCore?.createClient === 'function');

    const updateResult = await panelPage.evaluate(async (dir: string) => {
      const clientFactory = window.MediaCore?.createClient;
      if (!clientFactory) {
        return { ok: false, error: 'MediaCore client unavailable' } satisfies MediaCoreUpdateResult;
      }

      const client = clientFactory();
      const result = await client.updateSettings({ downloadDirectory: dir });
      if (client.resumeDetection) {
        await client.resumeDetection();
      }
      return result ?? { ok: true };
    }, downloadsDir);

    if (!updateResult?.ok) {
      testInfo.skip(true, `Unable to update companion settings: ${updateResult?.error || 'unknown error'}`);
      return;
    }

    await page.bringToFront();
    await page.waitForTimeout(500);
    await page.goto(caseData.url, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/skool\.com/);

    // Check if we need to login
    const loginButton = page.getByRole('button', { name: 'Log In' });
    if (profileLogin.required && await loginButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const { email, password, emailEnv, passwordEnv } = profileLogin;
      if (!email || !password) {
        testInfo.skip(
          true,
          `Profile credentials missing: ensure ${emailEnv ?? 'EMAIL_ENV'} and ${passwordEnv ?? 'PASSWORD_ENV'} are configured.`
        );
        return;
      }

      // Click Log In button to show the login form
      await loginButton.click();

      // Fill in credentials using the specific selectors from codegen
      await page.locator('#email').click();
      await page.locator('#email').fill(email);
      await page.locator('#password').click();
      await page.locator('#password').fill(password);

      // Click the Log In button in the form
      await page.locator('form').getByRole('button', { name: 'Log In', exact: true }).click();

      // Wait for login to complete
      await page.waitForTimeout(3000); // Give login time to fully process

      // Navigate back to the Wistia URL after successful login
      await page.goto(caseData.url, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(/skool\.com/);
    }

    const detectionSelector = caseData.detect?.selector ?? 'iframe[src*="wistia"], iframe[src*="wi.st/"]';
    const detectionEmbedUrl = caseData.detect?.embedUrl;

    // Set up network monitoring for m3u8/video requests
    const networkPromise = page.waitForResponse(
      response => {
        const url = response.url();
        return url.includes('.m3u8') ||
               url.includes('wistia.com') && (url.includes('/deliveries/') || url.includes('/assets/'));
      },
      { timeout: 15000 }
    ).catch(() => {
      console.log('[Wistia] No m3u8/video network requests detected');
      return null;
    });

    // Click the video cover/wrapper to make the Wistia iframe appear
    console.log('[Wistia] Looking for video cover to click');
    try {
      // First try clicking the video wrapper/cover image that contains the time overlay
      const videoCover = page.locator('div.styled__CoverImage-sc-bpv3k2-4, div[class*="CoverImage"], div[class*="VideoWrapper"]').first();
      await videoCover.waitFor({ state: 'visible', timeout: 10000 });
      console.log('[Wistia] Found video cover, clicking it');
      await videoCover.click();
      await page.waitForTimeout(2000);
    } catch {
      // Fallback: try clicking the time duration div specifically (12:31)
      try {
        const timeDiv = page.locator('div').filter({ hasText: /^12:31$/ }).nth(2);
        await timeDiv.waitFor({ state: 'visible', timeout: 5000 });
        console.log('[Wistia] Found time div 12:31, clicking it');
        await timeDiv.click();
        await page.waitForTimeout(2000);
      } catch {
        // Final fallback: any time div
        try {
          const anyTimeDiv = page.locator('div').filter({ hasText: /^\d+:\d+$/ }).first();
          await anyTimeDiv.waitFor({ state: 'visible', timeout: 5000 });
          console.log('[Wistia] Found time div, clicking it');
          await anyTimeDiv.click();
          await page.waitForTimeout(2000);
        } catch {
          console.log('[Wistia] No video overlay found, will try to detect iframe anyway');
        }
      }
    }

    await waitForWistiaEmbed(page, detectionSelector, detectionEmbedUrl);
    await page.locator(detectionSelector).first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);

    const networkResponse = await networkPromise;
    if (networkResponse) {
      console.log('[Wistia] Detected video network request:', networkResponse.url());
    }

    await page.waitForTimeout(5_000);

    // Debug: Check what's in the panel
    console.log('[Panel] Checking for media items...');
    await panelPage.waitForTimeout(5000); // Give time for detection

    const mediaCount = await panelPage.locator('article.media-item').count();
    console.log('[Panel] Found media items:', mediaCount);

    const panelContent = await panelPage.locator('#media-list').textContent();
    console.log('[Panel] Panel content:', panelContent);

    const rowLocator = panelPage.locator('article.media-item').first();
    await rowLocator.waitFor({ state: 'visible', timeout: 120_000 });

    const downloadButton = rowLocator.locator('button.preview-action--download').first();
    await downloadButton.waitFor({ state: 'attached', timeout: 120_000 });
    await downloadButton.scrollIntoViewIfNeeded();
    await downloadButton.waitFor({ state: 'visible', timeout: 60_000 });
    await expect(downloadButton).toBeEnabled({ timeout: 120_000 });

    const beforeFiles = await listFiles(downloadsDir);
    await downloadButton.click({ timeout: 30_000, force: true });

    const statusLabel = rowLocator.locator('.media-status');
    await expect(statusLabel).toContainText(/Completed/i, { timeout: 420_000 });

    const downloadedFile = await waitForFile(
      downloadsDir,
      fileName => fileName.endsWith(`.${caseData.expects.ext || 'mp4'}`) && !beforeFiles.includes(fileName),
      420_000
    );

    const stats = await fs.stat(downloadedFile);
    expect(stats.size).toBeGreaterThan(0);

    assertFfprobeAvailable(ffprobePath);
    const mediaInfo = await inspectMedia(ffprobePath, downloadedFile);

    if (caseData.expects.hasAudio) {
      expect(mediaInfo.hasAudio).toBeTruthy();
    }
    if (caseData.expects.hasVideo) {
      expect(mediaInfo.hasVideo).toBeTruthy();
    }

    testInfo.attachments.push({
      name: path.basename(downloadedFile),
      path: downloadedFile,
      contentType: 'video/mp4'
    });
  } finally {
    await panelPage.evaluate(async () => {
      const clientFactory = window.MediaCore?.createClient;
      if (!clientFactory) {
        return;
      }
      const client = clientFactory();
      try {
        await client.updateSettings({ downloadDirectory: '' });
      } catch (error) {
        console.warn('Failed to reset download directory', error);
      }
    }).catch(() => undefined);

    await panelPage.close({ runBeforeUnload: false });
  }
}

test.describe('Wistia download via VDH recipe', () => {
  test.use({ caseId: 'wistia-classroom-blueprint' });

  test('downloads Wistia lesson end-to-end', async ({
    page,
    context,
    extensionId,
    caseData,
    profileLogin,
    downloadsDir,
    ffprobePath,
  }, testInfo) => {
    await runWistiaDownload({
      page,
      context,
      extensionId,
      caseData,
      profileLogin,
      downloadsDir,
      ffprobePath,
      testInfo,
    });
  });
});
