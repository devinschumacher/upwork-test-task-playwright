import type { Page } from '@playwright/test';

export function buildEmbedFragment(url?: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').pop()?.split('?')[0] ?? null;
  } catch {
    return url;
  }
}

type WaitArgs = {
  selector: string;
  target: string | null;
};

export async function waitForLoomIframe(page: Page, selector: string, embedUrl?: string | null): Promise<void> {
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
