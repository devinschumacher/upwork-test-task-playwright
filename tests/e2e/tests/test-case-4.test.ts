import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';
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

interface DownloadArgs extends Pick<TestFixtures,
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

async function waitForIframe(page: Page, selector: string, target?: string | null): Promise<void> {
  await page.waitForFunction<boolean, { selector: string; target?: string | null }>(
    ({ selector, target }) => {
      const nodes = Array.from(document.querySelectorAll(selector));
      if (nodes.length === 0) {
        return false;
      }
      if (!target) {
        return nodes.some(node => node instanceof HTMLIFrameElement);
      }
      return nodes.some(node => node instanceof HTMLIFrameElement && node.src.includes(target));
    },
    { selector, target: target ?? undefined },
    { timeout: 120_000 }
  );
}


async function runDownload({
  page,
  context,
  extensionId,
  caseData,
  profileLogin,
  downloadsDir,
  ffprobePath,
  testInfo,
}: DownloadArgs): Promise<void> {
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

    const domDetect = caseData.methods?.find(method => method?.detect?.selector);
    const detectionSelector = domDetect?.detect?.selector ?? 'iframe[src*="player.vimeo.com/"]';
    const detectionEmbedUrl = domDetect?.detect?.embedUrl;

    // Click the time overlay to make the iframe appear
    console.log('[runDownload] Looking for video overlay to click');
    try {
      // Use the exact selector from codegen
      const timeDiv = page.locator('div').filter({ hasText: /^0:36$/ }).nth(2);
      await timeDiv.waitFor({ state: 'visible', timeout: 10000 });
      console.log('[runDownload] Found time div 0:36, clicking it');
      await timeDiv.click();
      await page.waitForTimeout(2000);
    } catch {
      // Try fallback - any time div
      try {
        const anyTimeDiv = page.locator('div').filter({ hasText: /^\d+:\d+$/ }).first();
        await anyTimeDiv.waitFor({ state: 'visible', timeout: 5000 });
        console.log('[runDownload] Found time div, clicking it');
        await anyTimeDiv.click();
        await page.waitForTimeout(2000);
      } catch {
        console.log('[runDownload] No time overlay found, will try to detect iframe anyway');
      }
    }

    // NOW wait for the iframe to appear after clicking
    await waitForIframe(page, detectionSelector, detectionEmbedUrl ?? null);
    await page.locator(detectionSelector).first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);

    // The video should auto-play after clicking, but give it extra time for network traffic
    await page.waitForTimeout(5_000);

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

    await waitForIframe(page, detectionSelector, detectionEmbedUrl ?? null);

    await panelPage.bringToFront();
    await panelPage.evaluate(async () => {
      const clientFactory = window.MediaCore?.createClient;
      if (!clientFactory) {
        return;
      }
      const client = clientFactory();
      if (client.resumeDetection) {
        await Promise.resolve(client.resumeDetection()).catch(() => undefined);
      }
    }).catch(() => undefined);
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

test.describe('Vimeo case 4', () => {
  test.use({ caseId: 'vimeo-about-aspinallway' });

  test('downloads Vimeo about page video end-to-end', async ({
    page,
    context,
    extensionId,
    caseData,
    profileLogin,
    downloadsDir,
    ffprobePath,
  }, testInfo) => {
    await runDownload({
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
