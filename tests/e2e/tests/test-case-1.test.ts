import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, type TestInfo } from '@playwright/test';
import { test, type TestFixtures } from '../lib/fixtures';
import { inspectMedia, assertFfprobeAvailable } from '../lib/media';
import { ensureDir, listFiles, waitForFile } from '../lib/fs-utils';
import { waitForLoomIframe } from './helpers/loom-utils';

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

interface LoomDownloadArgs extends Pick<TestFixtures,
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

async function runLoomDownload({
  page,
  context,
  extensionId,
  caseData,
  profileLogin,
  downloadsDir,
  ffprobePath,
  testInfo,
}: LoomDownloadArgs): Promise<void> {
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

    const detectionSelector = caseData.detect?.selector ?? 'iframe[src*="loom.com/embed/"]';
    const detectionEmbedUrl = caseData.detect?.embedUrl;
    await waitForLoomIframe(page, detectionSelector, detectionEmbedUrl);
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

    await waitForLoomIframe(page, detectionSelector, detectionEmbedUrl);

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

    const previewWrapper = rowLocator.locator('.media-preview-wrapper').first();
    await previewWrapper.hover({ timeout: 30_000 }); // Reveal overlay so download button receives real click

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

test.describe('Loom case 1', () => {
  test.use({ caseId: 'loom-classroom-paid-ad-secrets' });

  test('downloads Loom classroom video end-to-end', async ({
    page,
    context,
    extensionId,
    caseData,
    profileLogin,
    downloadsDir,
    ffprobePath,
  }, testInfo) => {
    await runLoomDownload({
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
