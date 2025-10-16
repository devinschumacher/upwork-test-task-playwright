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

interface SkoolDownloadArgs extends Pick<TestFixtures,
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

async function dismissSkoolOverlay(page: Page): Promise<void> {
  const overlaySelector = '.styled__DropdownBackground-sc-13jov82-11.bydZWQ';
  const overlay = page.locator(overlaySelector).first();

  const overlayCount = await overlay.count().catch(() => 0);
  if (overlayCount > 0) {
    await overlay.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
    const stillVisible = await overlay.isVisible({ timeout: 500 }).catch(() => false);
    if (!stillVisible) {
      return;
    }
  }

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(200);
}

async function triggerSkoolNativePlayback(page: Page): Promise<void> {
  await dismissSkoolOverlay(page);

  const manifestPromise = page.waitForResponse(
    response => {
      const url = response.url();
      return url.includes('.m3u8');
    },
    { timeout: 45_000 }
  ).catch(() => null);

  const clickCandidates = [
    'button[aria-label="Play"]',
    'button:has-text("Play")',
    '[data-testid="video-play-button"]',
    'div[class*="CoverImage"]',
    'div[class*="VideoOverlay"]',
    'div[class*="VideoWrapper"] button'
  ];

  let clicked = false;
  for (const selector of clickCandidates) {
    const candidate = page.locator(selector).first();
    if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await candidate.scrollIntoViewIfNeeded().catch(() => undefined);
      await candidate.click({ force: true });
      await page.waitForTimeout(1_000);
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    const timeLocator = page.locator('div').filter({ hasText: /^\d+:\d+$/ }).first();
    if (await timeLocator.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await timeLocator.click({ force: true });
      await page.waitForTimeout(1_000);
    }
  }

  const videoLocator = page.locator('video').first();
  const videoHandle = await videoLocator.elementHandle({ timeout: 30_000 }).catch(() => null);
  if (videoHandle) {
    await videoLocator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
    await videoHandle.evaluate((video: HTMLVideoElement) => {
      try {
        video.muted = true;
        if (video.readyState < 2) {
          video.load();
        }
        const playPromise = video.play();
        playPromise?.catch(() => undefined);
      } catch (error) {
        console.warn('[Skool] video.play failed', error);
      }
    }).catch(() => undefined);
  }

  await page.waitForFunction(() => {
    const element = document.querySelector('video');
    return element instanceof HTMLVideoElement &&
      (element.readyState >= 2 || !element.paused);
  }, { timeout: 45_000 }).catch(() => undefined);

  const manifestResponse = await manifestPromise;
  if (manifestResponse) {
    console.log('[Skool] Captured manifest:', manifestResponse.url());
  } else {
    console.log('[Skool] Manifest capture timed out');
  }

  await page.waitForTimeout(3_000);
}

async function runSkoolNativeDownload({
  page,
  context,
  extensionId,
  caseData,
  profileLogin,
  downloadsDir,
  ffprobePath,
  testInfo,
}: SkoolDownloadArgs): Promise<void> {
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

      await loginButton.click();

      await page.locator('#email').click();
      await page.locator('#email').fill(email);
      await page.locator('#password').click();
      await page.locator('#password').fill(password);

      await page.locator('form').getByRole('button', { name: 'Log In', exact: true }).click();

      await page.waitForTimeout(3_000);

      await page.goto(caseData.url, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(/skool\.com/);
    }

    await triggerSkoolNativePlayback(page);

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
      await page.waitForTimeout(2_000);
      await triggerSkoolNativePlayback(page);
    }

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

    const fallbackRow = panelPage.locator('article.media-item').first();
    await fallbackRow.waitFor({ state: 'visible', timeout: 180_000 });

    let rowLocator = panelPage.locator('article.media-item').filter({ hasText: /skool/i }).first();
    if (await rowLocator.count() === 0) {
      rowLocator = fallbackRow;
    }

    const downloadButton = rowLocator.locator('button.preview-action--download').first();
    await downloadButton.waitFor({ state: 'attached', timeout: 120_000 });
    await downloadButton.scrollIntoViewIfNeeded();
    await downloadButton.waitFor({ state: 'visible', timeout: 60_000 });
    await expect(downloadButton).toBeEnabled({ timeout: 120_000 });

    const beforeFiles = await listFiles(downloadsDir);
    await downloadButton.click({ timeout: 30_000, force: true });

    const statusLabel = rowLocator.locator('.media-status');
    await expect(statusLabel).toContainText(/Completed/i, { timeout: 600_000 });

    const downloadedFile = await waitForFile(
      downloadsDir,
      fileName => fileName.endsWith(`.${caseData.expects.ext || 'mp4'}`) && !beforeFiles.includes(fileName),
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


test.describe('Skool case 38', () => {
  test.use({ caseId: 'skool-classroom-serpdownloaders' });

  test('downloads Skool native classroom video end-to-end', async ({
    page,
    context,
    extensionId,
    caseData,
    profileLogin,
    downloadsDir,
    ffprobePath,
  }, testInfo) => {
    await runSkoolNativeDownload({
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
