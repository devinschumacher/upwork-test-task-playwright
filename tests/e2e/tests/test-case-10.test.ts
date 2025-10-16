import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, type TestInfo } from '@playwright/test';
import { test, type TestFixtures } from '../lib/fixtures';
import { inspectMedia, assertFfprobeAvailable } from '../lib/media';
import { ensureDir, listFiles, waitForFile } from '../lib/fs-utils';

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

interface YouTubeDownloadArgs extends Pick<TestFixtures,
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

async function waitForYouTubeIframe(
  page: TestFixtures['page'],
  selector: string,
  expectedUrl?: string
): Promise<void> {
  const iframeSelector = selector || 'iframe[src*="youtube.com/embed/"]';
  const iframeElement = page.locator(iframeSelector).first();

  await iframeElement.waitFor({
    state: 'attached',
    timeout: 60_000
  });

  if (expectedUrl) {
    const actualSrc = await iframeElement.getAttribute('src');
    if (actualSrc && !actualSrc.includes(expectedUrl)) {
      throw new Error(`YouTube iframe URL mismatch. Expected: ${expectedUrl}, Got: ${actualSrc}`);
    }
  }

  await iframeElement.scrollIntoViewIfNeeded();
  await iframeElement.waitFor({ state: 'visible', timeout: 30_000 });
}

async function runYouTubeDownload({
  page,
  context,
  extensionId,
  caseData,
  profileLogin,
  downloadsDir,
  ffprobePath,
  testInfo,
}: YouTubeDownloadArgs): Promise<void> {
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

    const loginForm = page.locator('form:has(input[type="email"])');
    if (profileLogin.required && await loginForm.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const { email, password, emailEnv, passwordEnv } = profileLogin;
      if (!email || !password) {
        testInfo.skip(
          true,
          `Profile credentials missing: ensure ${emailEnv ?? 'EMAIL_ENV'} and ${passwordEnv ?? 'PASSWORD_ENV'} are configured.`
        );
        return;
      }
      await page.locator('input[type="email"], input[name="email"]').fill(email);
      await page.locator('input[type="password"], input[name="password"]').fill(password);
      await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(/skool\.com/);
    }

    const detectionSelector = caseData.detect?.selector ?? 'iframe[src*="youtube.com/embed/"]';
    const detectionEmbedUrl = caseData.detect?.embedUrl;

    // Set up network monitoring for YouTube video requests
    const networkPromise = page.waitForResponse(
      response => {
        const url = response.url();
        return url.includes('googlevideo.com') ||
               url.includes('youtube.com/embed/') ||
               url.includes('ytimg.com');
      },
      { timeout: 15000 }
    ).catch(() => {
      console.log('[YouTube] No video network requests detected');
      return null;
    });

    // Click the video cover/wrapper to trigger YouTube iframe loading if needed
    console.log('[YouTube] Looking for video cover to click');
    try {
      // First try clicking the video wrapper/cover image
      const videoCover = page.locator('div.styled__CoverImage-sc-bpv3k2-4, div[class*="CoverImage"], div[class*="VideoWrapper"], div[class*="video-container"]').first();
      await videoCover.waitFor({ state: 'visible', timeout: 10000 });
      console.log('[YouTube] Found video cover, clicking it');
      await videoCover.click();
      await page.waitForTimeout(2000);
    } catch {
      // Fallback: try clicking any div that might contain the video
      try {
        const videoDiv = page.locator('div').filter({ hasText: /YouTube|Video|Watch/i }).first();
        await videoDiv.waitFor({ state: 'visible', timeout: 5000 });
        console.log('[YouTube] Found video div, clicking it');
        await videoDiv.click();
        await page.waitForTimeout(2000);
      } catch {
        console.log('[YouTube] No video cover found, continuing anyway');
      }
    }

    // Wait for network activity related to the embedded video (logs handled in catch)
    await networkPromise;

    await waitForYouTubeIframe(page, detectionSelector, detectionEmbedUrl);
    await page.waitForTimeout(3_000);

    const lessonPath = (() => {
      try {
        return new URL(caseData.url).pathname;
      } catch {
        return null;
      }
    })();

    const lessonLink = lessonPath
      ? page.locator(`a[href='${lessonPath}'], a[href='${caseData.url}']`).first()
      : page.locator(`a[href='${caseData.url}']`).first();

    if (await lessonLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await lessonLink.click({ force: true });
      await page.waitForTimeout(4_000);
    }

    await waitForYouTubeIframe(page, detectionSelector, detectionEmbedUrl);

    await panelPage.bringToFront();
    await panelPage.evaluate(async () => {
      const clientFactory = window.MediaCore?.createClient;
      if (!clientFactory) {
        return;
      }
      const client = clientFactory();
      try {
        await client.getState();
      } catch (unknownError) {
        const message = unknownError instanceof Error ? unknownError.message : String(unknownError);
        console.warn('MediaCore#getState failed', message);
      }
    });

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
    // YouTube downloads may take longer due to fallback attempts
    await expect(statusLabel).toContainText(/Completed/i, { timeout: 600_000 });

    const downloadedFile = await waitForFile(
      downloadsDir,
      fileName => {
        // YouTube downloads may be MKV or MP4 depending on which fallback succeeded
        const validExtensions = ['.mp4', '.mkv'];
        return validExtensions.some(ext => fileName.endsWith(ext)) && !beforeFiles.includes(fileName);
      },
      600_000
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
      contentType: downloadedFile.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4'
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

test.describe('YouTube case 10', () => {
  test.use({ caseId: 'youtube-about-blueprint' });

  test('downloads YouTube embedded video end-to-end', async ({
    page,
    context,
    extensionId,
    caseData,
    profileLogin,
    downloadsDir,
    ffprobePath,
  }, testInfo) => {
    await runYouTubeDownload({
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
