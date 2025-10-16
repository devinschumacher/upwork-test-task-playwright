import type { Page } from '@playwright/test';

const WISTIA_IFRAME_SELECTOR = 'iframe[src*="wistia"], iframe[src*="wi.st/"]';

const PLAY_BUTTON_SELECTORS = [
  'button[aria-label*="Play" i]',
  '.wistia_play_button',
  '.w-css-reset-button',
  '.wistia_click_to_play',
  '.w-big-play-button',
  '.wistia__playback__button',
  'svg[aria-label*="Play" i]'
];

type WaitArgs = {
  selector: string;
  target: string | null;
};

export async function waitForWistiaEmbed(page: Page, selector: string, embedUrl?: string | null): Promise<void> {
  await page.waitForFunction<boolean, WaitArgs>(
    ({ selector: sel, target }) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      if (nodes.length === 0) {
        return false;
      }
      if (!target) {
        return nodes.some(node => node instanceof HTMLIFrameElement);
      }
      return nodes.some(node => node instanceof HTMLIFrameElement && node.src.includes(target));
    },
    { selector, target: embedUrl ?? null },
    { timeout: 120_000 }
  );
}

export async function triggerWistiaPlayback(page: Page): Promise<void> {
  const iframeLocator = page.locator(WISTIA_IFRAME_SELECTOR);
  await iframeLocator.first().waitFor({ state: 'attached', timeout: 120_000 });

  for (const selector of PLAY_BUTTON_SELECTORS) {
    const button = page.locator(selector).first();
    const visible = await button.isVisible({ timeout: 500 }).catch(() => false);
    if (!visible) {
      continue;
    }
    await button.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1_000);
    break;
  }

  await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLIFrameElement) || !element.contentWindow) {
      return;
    }
    try {
      element.contentWindow.postMessage({ method: 'play' }, '*');
      element.contentWindow.postMessage({ method: 'playback', value: 'play' }, '*');
    } catch (error) {
      console.debug('Wistia postMessage play failed', error);
    }
  }, WISTIA_IFRAME_SELECTOR).catch(() => undefined);

  await page.waitForTimeout(4_000);
}
