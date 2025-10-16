import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium, test as base, type BrowserContext, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import { getCase, type TestCase } from './case-loader';
import { createTempDir, removeDir, ensureDir } from './fs-utils';
import { defaultNativeMessagingManifest, extensionPath } from './paths';
import { locateFfprobe } from './media';
import { getProfile } from './profile-loader';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

interface Fixtures {
  caseId: string;
  caseData: TestCase;
  userDataDir: string;
  downloadsDir: string;
  context: BrowserContext;
  page: Page;
  extensionId: string;
  ffprobePath: string | null;
  profileLogin: {
    required: boolean;
    emailEnv?: string;
    passwordEnv?: string;
    email?: string;
    password?: string;
  };
}

export type TestFixtures = Fixtures;

async function resolveExtensionId(context: BrowserContext): Promise<string> {
  const existing = context.serviceWorkers();
  if (existing.length > 0) {
    return existing[0].evaluate(() => chrome.runtime.id);
  }
  const worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  return worker.evaluate(() => chrome.runtime.id);
}

export const test = base.extend<Fixtures>({
  caseId: ['loom-classroom-paid-ad-secrets', { option: true }],

  caseData: async ({ caseId }, use) => {
    await use(getCase(caseId));
  },

  // eslint-disable-next-line no-empty-pattern
  ffprobePath: async ({}, use) => {
    await use(await locateFfprobe());
  },

  profileLogin: async ({ caseData }, use) => {
    const profile = getProfile(caseData.profile);
    if (!profile || !profile.login) {
      await use({ required: false });
      return;
    }

    const { emailEnv, passwordEnv } = profile.login;
    await use({
      required: true,
      emailEnv,
      passwordEnv,
      email: emailEnv ? process.env[emailEnv] : undefined,
      password: passwordEnv ? process.env[passwordEnv] : undefined,
    });
  },
  userDataDir: async ({ caseData }, use) => {
    // Use persistent profile directory based on the profile name
    const profileName = caseData.profile || 'default';
    const persistentProfileDir = path.join(
      path.resolve(__dirname, '..', 'profiles'),
      `persist-skool-${profileName}`
    );

    // Ensure the persistent profile directory exists
    await ensureDir(persistentProfileDir);

    // Use persistent directory if USE_PERSISTENT_PROFILE env var is set,
    // otherwise use temp directory for CI/clean tests
    const usePersistent = process.env.USE_PERSISTENT_PROFILE === 'true';

    if (usePersistent) {
      await use(persistentProfileDir);
    } else {
      const dir = await createTempDir('bdl-profile');
      try {
        await use(dir);
      } finally {
        await removeDir(dir);
      }
    }
  },

  downloadsDir: async ({ caseData }, use, testInfo) => {
    const projectOutputRoot = testInfo.project?.outputDir
      ? path.resolve(testInfo.project.outputDir)
      : path.resolve(__dirname, '..', 'artifacts', 'test-results');
    const caseSlug = typeof caseData?.n === 'number'
      ? String(caseData.n)
      : caseData?.id
        ? caseData.id.replace(/[^a-zA-Z0-9-_]/g, '_')
        : `case-${testInfo.testId.replace(/[^a-zA-Z0-9-_]/g, '_')}`;
    const dir = path.join(projectOutputRoot, caseSlug);
    await ensureDir(dir);
    try {
      const entries = await fs.readdir(dir);
      await Promise.all(
        entries.map(entry =>
          fs.rm(path.join(dir, entry), { recursive: true, force: true })
        )
      );
    } catch {
      // Directory may already be empty; ignore.
    }
    await use(dir);
  },

  context: async ({ userDataDir }, use) => {
    const extPath = extensionPath();
    const manifest = defaultNativeMessagingManifest();
    const hostsDir = path.join(userDataDir, 'NativeMessagingHosts');
    await ensureDir(hostsDir);
    await fs.copyFile(manifest, path.join(hostsDir, path.basename(manifest)));

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome',
      headless: false,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        '--autoplay-policy=no-user-gesture-required',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-component-update',
        '--disable-crash-reporter',
        '--disable-features=Crashpad',
        '--noerrdialogs'
      ],
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true
    });

    try {
      await use(context);
    } finally {
      await context.close();
    }
  },

  page: async ({ context }, use) => {
    let page = context.pages()[0];
    if (!page) {
      page = await context.newPage();
    }
    await use(page);
  },

  extensionId: async ({ context }, use) => {
    const id = await resolveExtensionId(context);
    await use(id);
  }
});

export const expect = test.expect;
